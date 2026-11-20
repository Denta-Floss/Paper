import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'outbox.dart';

/// The API contract this build was written against — the server's
/// `apiVersion` (backend/kernel/system-routes.js). Bumped together with it.
const int kPaperApiVersion = 1;

/// Whether this app and the server it reached can work together.
///
/// Each side answers its own version and the one before it, so either can be
/// rolled back one release without the other noticing (N / N-1).
enum ApiCompatibility {
  /// Same version.
  same,

  /// The server is a version ahead; it still answers this app.
  appOneBehind,

  /// The app is a version ahead (say, the server was rolled back); the app
  /// still speaks to it.
  serverOneBehind,

  /// More than one version apart: one side needs updating.
  incompatible,

  /// The server could not be asked.
  unknown,
}

ApiCompatibility compatibilityOf({required int app, required int? server, int? serverMinimum}) {
  if (server == null) return ApiCompatibility.unknown;
  final minimum = serverMinimum ?? server - 1;
  if (app == server) return ApiCompatibility.same;
  if (app < server) return app >= minimum ? ApiCompatibility.appOneBehind : ApiCompatibility.incompatible;
  return server >= app - 1 ? ApiCompatibility.serverOneBehind : ApiCompatibility.incompatible;
}

/// One reading of everything the Sync Health screen shows.
class SyncHealthReading {
  const SyncHealthReading({
    required this.at,
    required this.reachable,
    this.pingMs,
    this.error,
    this.serverVersion,
    this.serverRelease,
    this.serverApiVersion,
    this.serverMinClientApiVersion,
    this.serverHead,
    this.localCursor,
    this.lastSyncedAt,
    this.outboxWaiting = 0,
    this.outboxSending = 0,
    this.outboxConflicts = 0,
    this.outboxNextAttempt,
    this.outboxLastError,
    this.hasOutbox = false,
    required this.appVersion,
    this.appApiVersion = kPaperApiVersion,
  });

  final DateTime at;

  /// The server answered this time. A copy served from the response cache
  /// because the server could not be reached does not count.
  final bool reachable;
  final int? pingMs;
  final String? error;

  final String? serverVersion;
  final String? serverRelease;
  final int? serverApiVersion;
  final int? serverMinClientApiVersion;

  /// The newest changelog id on the server, and the newest this device's copy
  /// has applied.
  final int? serverHead;
  final int? localCursor;
  final DateTime? lastSyncedAt;

  final int outboxWaiting;
  final int outboxSending;
  final int outboxConflicts;
  final DateTime? outboxNextAttempt;
  final String? outboxLastError;

  /// False when there is no outbox (demo build, not signed in).
  final bool hasOutbox;

  final String appVersion;
  final int appApiVersion;

  /// How many changes this copy has not applied yet; null when either side is
  /// unknown.
  int? get changesBehind {
    final head = serverHead;
    final cursor = localCursor;
    if (head == null || cursor == null) return null;
    return head > cursor ? head - cursor : 0;
  }

  ApiCompatibility get compatibility => compatibilityOf(
        app: appApiVersion,
        server: serverApiVersion,
        serverMinimum: serverMinClientApiVersion,
      );
}

/// Takes [SyncHealthReading]s. Separate from the screen so each figure can be
/// tested against a fake server.
class SyncHealthProbe {
  SyncHealthProbe({
    required http.Client client,
    required String baseUrl,
    required Future<String> Function() appVersion,
    Future<int?> Function()? localCursor,
    DateTime? Function()? lastSyncedAt,
    OutboxSyncEngine? Function()? outbox,
    DateTime Function()? now,
    Duration timeout = const Duration(seconds: 5),
  })  : _client = client,
        _appVersion = appVersion,
        _baseUrl = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl,
        _localCursor = localCursor ?? (() async => null),
        _lastSyncedAt = lastSyncedAt ?? (() => null),
        _outbox = outbox ?? (() => null),
        _now = now ?? DateTime.now,
        _timeout = timeout;

  final http.Client _client;
  final String _baseUrl;
  /// The running build's version (package_info_plus in each app); asked once.
  final Future<String> Function() _appVersion;
  String? _appVersionRead;
  final Future<int?> Function() _localCursor;
  final DateTime? Function() _lastSyncedAt;
  final OutboxSyncEngine? Function() _outbox;
  final DateTime Function() _now;
  final Duration _timeout;

  Future<SyncHealthReading> read() async {
    final results = await Future.wait<Object?>(<Future<Object?>>[
      _ping(),
      _safe(_localCursor),
      _outboxCounts(),
      _version(),
    ]);
    final ping = results[0]! as _Ping;
    final cursor = results[1] as int?;
    final outbox = results[2] as _OutboxCounts?;
    final status = ping.body;
    return SyncHealthReading(
      at: _now(),
      reachable: ping.reachable,
      pingMs: ping.ms,
      error: ping.error,
      serverVersion: status?['serverVersion']?.toString(),
      serverRelease: status?['release']?.toString(),
      serverApiVersion: _int(status?['apiVersion']),
      serverMinClientApiVersion: _int(status?['minClientApiVersion']),
      serverHead: _int(status?['changelogHead']),
      localCursor: cursor,
      lastSyncedAt: _lastSyncedAt(),
      hasOutbox: outbox != null,
      outboxWaiting: outbox?.waiting ?? 0,
      outboxSending: outbox?.sending ?? 0,
      outboxConflicts: outbox?.conflicts ?? 0,
      outboxNextAttempt: outbox?.nextAttempt,
      outboxLastError: outbox?.lastError,
      appVersion: results[3]! as String,
    );
  }

  Future<String> _version() async {
    final known = _appVersionRead;
    if (known != null) return known;
    try {
      return _appVersionRead = await _appVersion();
    } catch (_) {
      return 'unknown';
    }
  }

  /// Sends what is waiting now, without waiting out its backoff.
  Future<void> flushNow() async => _outbox()?.flushNow();

  Future<_Ping> _ping() async {
    final watch = Stopwatch()..start();
    try {
      final response = await _client
          .get(Uri.parse('$_baseUrl/api/system/status'), headers: const <String, String>{'Accept': 'application/json'})
          .timeout(_timeout);
      watch.stop();
      // The response cache answers with its last copy when the server cannot
      // be reached; that is not the server answering.
      if (response.headers['x-paper-cache'] == 'stale') {
        return const _Ping(reachable: false, error: 'The server cannot be reached.');
      }
      if (response.statusCode == 401) {
        return _Ping(reachable: true, ms: watch.elapsedMilliseconds, error: 'Signed out: sign in again.');
      }
      if (response.statusCode != 200) {
        return _Ping(reachable: true, ms: watch.elapsedMilliseconds, error: 'The server answered ${response.statusCode}.');
      }
      final decoded = jsonDecode(response.body);
      return _Ping(
        reachable: true,
        ms: watch.elapsedMilliseconds,
        body: decoded is Map<String, dynamic> ? decoded : null,
      );
    } on TimeoutException {
      return _Ping(reachable: false, error: 'No answer in ${_timeout.inSeconds} s.');
    } catch (error) {
      return _Ping(reachable: false, error: 'The server cannot be reached.');
    }
  }

  Future<_OutboxCounts?> _outboxCounts() async {
    final engine = _outbox();
    if (engine == null) return null;
    try {
      final entries = await engine.store.unsettled();
      var waiting = 0;
      var sending = 0;
      var conflicts = 0;
      DateTime? next;
      String? lastError;
      for (final entry in entries) {
        if (entry.status == OutboxStatus.conflict) {
          conflicts += 1;
          continue;
        }
        if (entry.status == OutboxStatus.inFlight) {
          sending += 1;
        } else {
          waiting += 1;
        }
        // The head decides when the queue moves; its reason is the queue's.
        if (waiting + sending == 1) {
          next = entry.nextAttemptAt;
          lastError = entry.lastError;
        }
      }
      return _OutboxCounts(waiting, sending, conflicts, next, lastError);
    } catch (_) {
      return null;
    }
  }

  static Future<Object?> _safe(Future<int?> Function() read) async {
    try {
      return await read();
    } catch (_) {
      return null;
    }
  }

  static int? _int(Object? value) => value is num ? value.toInt() : int.tryParse('${value ?? ''}');
}

class _Ping {
  const _Ping({required this.reachable, this.ms, this.error, this.body});

  final bool reachable;
  final int? ms;
  final String? error;
  final Map<String, dynamic>? body;
}

class _OutboxCounts {
  const _OutboxCounts(this.waiting, this.sending, this.conflicts, this.nextAttempt, this.lastError);

  final int waiting;
  final int sending;
  final int conflicts;
  final DateTime? nextAttempt;
  final String? lastError;
}
