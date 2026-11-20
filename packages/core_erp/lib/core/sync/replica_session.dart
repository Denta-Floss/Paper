import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../database/local_database_helper.dart';
import '../database/sync_metadata_store.dart';
import '../services/socket_service.dart';
import 'delta_sync_engine.dart';
import 'replica_api.dart';
import 'replica_sync_service.dart';

/// The signed-in user's replica, for the whole app.
///
/// One place that opens it, wires the change stream into it and catches it
/// up, so the desktop and the phone run the same code — the replica's traps
/// (the cursor that never moved, the copy read mid-replay, the row read before
/// its change landed) were each fixed once and must stay fixed in both.
class ReplicaSession {
  ReplicaSession._();

  static final ReplicaSession instance = ReplicaSession._();

  ReplicaSyncService? _service;
  Set<String>? _tables;

  /// Null until [start] has run once.
  ReplicaSyncService? get service => _service;

  /// Whether a local-first repository may read the replica now.
  bool get isHydrated => _service?.isHydrated ?? false;

  /// When the replica last caught up, as the server's own clock does not
  /// matter here: it is "how old is what this screen shows".
  final ValueNotifier<DateTime?> lastSyncedAt = ValueNotifier<DateTime?>(null);

  /// Opens [namespace]'s replica and follows the changelog.
  ///
  /// [tables] limits it to the server tables a client's screens read (the
  /// phone's); null holds everything. Failure is survivable on purpose: a
  /// replica that never opened leaves `isHydrated` false, and every local-first
  /// repository then reads the network, as the app did before it had one.
  Future<void> start({
    required http.Client client,
    required String baseUrl,
    required String namespace,
    Set<String>? tables,
  }) async {
    try {
      final api = ReplicaApi(client: client, baseUrl: baseUrl);
      if (_service == null || !setEquals(_tables, tables)) {
        await _service?.stop();
        _tables = tables;
        _service = ReplicaSyncService(
          fetchRecord: api.fetchRecord,
          fetchList: api.fetchList,
          fetchChangesSince: api.fetchChangesSince,
          fetchChangesPage: api.fetchChangesPage,
          fetchBootstrap: () => api.fetchBootstrap(tables: tables),
          tables: tables,
        );
      }
      final service = _service!;
      await service.start(namespace);
      SocketService.instance.off('table-change', _onTableChange);
      SocketService.instance.on('table-change', _onTableChange);
      await service.catchUp();
      await _readLastSync();
    } catch (error) {
      debugPrint('Replica unavailable, staying on the network: $error');
    }
  }

  Future<void> _readLastSync() async {
    try {
      final db = await LocalDatabaseHelper.instance.database;
      final raw = await SyncMetadataStore(db).read(SyncMetadataStore.lastSyncAtKey);
      lastSyncedAt.value = raw == null ? null : DateTime.tryParse(raw)?.toLocal();
    } catch (_) {
      // Unknown is shown as unknown; nothing depends on it.
    }
  }

  void _onTableChange(dynamic data) {
    if (data is! Map) return;
    final table = '${data['table'] ?? ''}';
    if (table.isEmpty) return;
    final changelogId = data['changelogId'];
    _service?.onTableChange(
      TableChange(
        table: table,
        recordId: data['id'] ?? 0,
        action: '${data['action'] ?? 'UPDATE'}',
        changelogId: changelogId is num ? changelogId.toInt() : 0,
      ),
    );
    lastSyncedAt.value = DateTime.now();
  }
}
