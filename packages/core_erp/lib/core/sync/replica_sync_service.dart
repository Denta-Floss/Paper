import 'dart:async';

import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../database/local_database_helper.dart';
import '../database/sync_metadata_store.dart';
import 'delta_sync_engine.dart';
import 'replica_bindings.dart';
import 'replica_catch_up.dart';
import 'replica_freshness.dart';

/// Keeps the local replica current.
///
/// Owns the loop that Tier 3 turns on: open this user's replica, remember where
/// the replay got to, ask the server only for what changed since, and tell
/// whoever is on screen which tables moved.
///
/// It does **not** serve reads. Repositories do that, straight off the replica.
/// Keeping the two apart means a screen never waits on a sync: it paints from
/// whatever is on disk, and this quietly makes that better.
class ReplicaSyncService {
  ReplicaSyncService({
    required RecordFetcher fetchRecord,
    required ListFetcher fetchList,
    required Future<List<TableChange>> Function(int since) fetchChangesSince,
    ChangesPageFetcher? fetchChangesPage,
    BootstrapFetcher? fetchBootstrap,
    LocalDatabaseHelper? helper,
    Duration batchWindow = const Duration(milliseconds: 250),
    Set<String>? tables,
  }) : _scope = tables,
       _fetchRecord = fetchRecord,
       _fetchList = fetchList,
       _fetchChangesSince = fetchChangesSince,
       _fetchChangesPage = fetchChangesPage,
       _fetchBootstrap = fetchBootstrap,
       _helper = helper ?? LocalDatabaseHelper.instance,
       _batchWindow = batchWindow;

  /// The server tables this replica holds, or null for all of them. The phone
  /// keeps only what its screens read; a change to anything else is not
  /// fetched.
  final Set<String>? _scope;

  bool _holds(String serverTable) {
    final scope = _scope;
    if (scope == null) return true;
    if (scope.contains(serverTable)) return true;
    final parent = kReplicaBindings[serverTable]?.parentTable;
    return parent != null && scope.contains(parent);
  }

  /// The changelog with what the server says about it (more to come, the
  /// oldest it holds, its head). Without it, the plain list above is used and
  /// a pruned cursor or a long gap cannot be noticed.
  final ChangesPageFetcher? _fetchChangesPage;

  /// A cold replica's lists in one request. Without it, one request per list.
  final BootstrapFetcher? _fetchBootstrap;

  /// True while a catch-up runs. Live changes are applied meanwhile but do not
  /// move the cursor: a live id far ahead of the replay would otherwise mark
  /// everything between as done, and a quit before the replay reached it
  /// would skip it for good.
  bool _catchingUp = false;

  final RecordFetcher _fetchRecord;
  final ListFetcher _fetchList;

  /// Replays the changelog from a position. Used to catch up after the app has
  /// been closed, which is the case a persisted cursor exists for.
  final Future<List<TableChange>> Function(int since) _fetchChangesSince;

  final LocalDatabaseHelper _helper;
  final Duration _batchWindow;

  DeltaSyncEngine? _engine;
  SyncMetadataStore? _cursor;

  final _changed = StreamController<Set<String>>.broadcast();

  /// Which local tables just changed. A provider listens and re-reads only what
  /// it cares about, instead of every provider refreshing on every event.
  Stream<Set<String>> get changedTables => _changed.stream;

  final List<TableChange> _pending = <TableChange>[];
  Timer? _batchTimer;
  bool _started = false;

  /// True once the replica holds a first copy. Until then a repository should
  /// delegate to the network rather than serve an empty list, which would look
  /// like a workspace with nothing in it.
  ///
  /// False while a catch-up runs, too. A replica whose cursor survived the last
  /// session is a copy as of then: until the replay of what changed meanwhile
  /// is in, a screen loading from it would show yesterday's data, and nothing
  /// re-reads when the replay lands. Offline, the catch-up fails at once and
  /// the copy serves.
  bool get isHydrated => _hydrated && !_catchingUp;
  bool _hydrated = false;

  Future<void> start(String userNamespace) async {
    await stop();
    ReplicaFreshness.instance.reset();
    await _helper.useNamespace(userNamespace);
    final db = await _helper.database;
    _cursor = SyncMetadataStore(db);
    _engine = DeltaSyncEngine(
      database: db,
      fetchRecord: _fetchRecord,
      fetchList: _fetchList,
    );
    _hydrated = await _looksHydrated(db);
    _started = true;
  }

  /// Whether anything has ever been written here.
  ///
  /// A cursor above zero is the honest signal: rows could legitimately be empty
  /// (a brand-new workspace), but a cursor means a sync has completed at least
  /// once and an empty list is then the truth rather than a gap.
  Future<bool> _looksHydrated(Database db) async {
    final position = await SyncMetadataStore(db).lastChangelogId();
    return position > 0;
  }

  /// Catches up everything that happened while the app was closed.
  ///
  /// Returns the number of changes replayed. A replica with no position — or
  /// one whose position the server has pruned past — takes a fresh copy
  /// instead: one bootstrap request when the server has it, the lists four at
  /// a time when it does not. Either way the head it is a copy as of is
  /// recorded, so the next launch replays from there rather than downloading
  /// everything again.
  Future<int> catchUp() async {
    final engine = _engine;
    final cursor = _cursor;
    if (engine == null || cursor == null) return 0;

    _catchingUp = true;
    try {
      final result = await ReplicaCatchUp(
        engine: engine,
        cursor: cursor,
        fetchChangesPage: _fetchChangesPage ??
            (since) async => ChangesPage(changes: await _fetchChangesSince(since)),
        fetchBootstrap: _fetchBootstrap,
        listTables: _listTables,
        inScope: _scope == null ? null : (change) => _holds(change.table),
      ).run();
      if (result.hydrated) {
        _hydrated = true;
        _announce(<TableChange>[
          for (final table in _listTables)
            TableChange(table: table, recordId: 0, action: 'INSERT'),
        ]);
      }
      if (result.replayed.isNotEmpty) _announce(result.replayed);
      return result.replayed.length;
    } catch (_) {
      // Offline. The replica is stale but usable, which is the entire point of
      // having it — far better than a screen that cannot paint.
      return 0;
    } finally {
      _catchingUp = false;
    }
  }

  /// The tables a list can fill. `viaParent` and `ignore` bindings have no list
  /// of their own; their rows arrive with their parents.
  List<String> get _listTables => <String>[
    for (final entry in kReplicaBindings.entries)
      if (entry.value.localTable != null &&
          entry.value.strategy != DeltaStrategy.viaParent &&
          _holds(entry.key))
        entry.key,
  ];

  /// Feeds a live change in. Batched, because a single user action announces
  /// several rows and applying each separately would fetch the same record more
  /// than once.
  void onTableChange(TableChange change) {
    if (!_started || !_holds(change.table)) return;
    // Behind from now until a drain applies it, so a provider refreshing on
    // this same event reads the network rather than the row as it was.
    final local = _localTableFor(change.table);
    if (local != null) ReplicaFreshness.instance.markBehind(local);
    _pending.add(change);
    _batchTimer?.cancel();
    _batchTimer = Timer(_batchWindow, _drain);
  }

  Future<void> _drain() async {
    final engine = _engine;
    if (engine == null || _pending.isEmpty) return;
    final batch = List<TableChange>.from(_pending);
    _pending.clear();
    final marks = ReplicaFreshness.instance.snapshot(
      batch.map((change) => _localTableFor(change.table)).whereType<String>(),
    );
    await engine.apply(batch, cursor: _catchingUp ? null : _cursor);
    ReplicaFreshness.instance.caughtUp(marks);
    _announce(batch);
  }

  /// The local table a server table's changes land in: its own, or its
  /// parent's for a table that arrives inside its parent's payload.
  static String? _localTableFor(String serverTable) {
    final binding = kReplicaBindings[serverTable];
    return binding?.localTable ?? kReplicaBindings[binding?.parentTable]?.localTable;
  }

  void _announce(Iterable<TableChange> changes) {
    final tables = <String>{};
    for (final change in changes) {
      final binding = kReplicaBindings[change.table];
      final local = binding?.localTable ??
          kReplicaBindings[binding?.parentTable]?.localTable;
      if (local != null) tables.add(local);
    }
    if (tables.isNotEmpty && !_changed.isClosed) _changed.add(tables);
  }

  /// Throws the replica away and starts again.
  ///
  /// For when it cannot be trusted — a cursor pointing at history the server
  /// has pruned, or a schema this build no longer understands. Always available
  /// because the server can rebuild it, which is what makes the whole design
  /// safe to get wrong occasionally.
  Future<void> resync() async {
    await _cursor?.reset();
    await _helper.destroy();
    _hydrated = false;
    final db = await _helper.database;
    _cursor = SyncMetadataStore(db);
    _engine = DeltaSyncEngine(
      database: db,
      fetchRecord: _fetchRecord,
      fetchList: _fetchList,
    );
    await catchUp();
  }

  Future<void> stop() async {
    _batchTimer?.cancel();
    _batchTimer = null;
    _pending.clear();
    _started = false;
    _engine = null;
    _cursor = null;
  }

  Future<void> dispose() async {
    await stop();
    await _changed.close();
  }
}
