import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../services/socket_service.dart';
import 'outbox.dart';

/// The signed-in user's outbox, for the whole app (desktop and phone alike).
///
/// Opened at sign-in, beside the replica; drained whenever the change stream
/// comes up (the connection is back) as well as on every new write and on its
/// own backoff timer.
class OutboxSession {
  OutboxSession._();

  static final OutboxSession instance = OutboxSession._();

  OutboxSyncEngine? _engine;
  String? _namespace;
  final StreamController<void> _changes = StreamController<void>.broadcast();
  StreamSubscription<void>? _relay;

  /// Null until [start] has opened this user's outbox.
  OutboxSyncEngine? get engine => _engine;

  /// The outbox moved: a write queued, sent, refused, retried or discarded.
  Stream<void> get changes => _changes.stream;

  Future<void> start({
    required http.Client client,
    required String baseUrl,
    required String namespace,
  }) async {
    if (_engine != null && _namespace == namespace) {
      unawaited(_engine!.drain());
      return;
    }
    try {
      await _relay?.cancel();
      _engine?.dispose();
      final store = await OutboxStore.open(namespace);
      await store.prune(DateTime.now());
      _namespace = namespace;
      _engine = OutboxSyncEngine(store: store, client: client, baseUrl: baseUrl);
      _relay = _engine!.changes.listen((_) => _changes.add(null));
      SocketService.instance.streamLive.removeListener(_onLive);
      SocketService.instance.streamLive.addListener(_onLive);
      _changes.add(null);
      unawaited(_engine!.drain());
    } catch (error) {
      // No outbox means writes behave as before: online, or an error.
      debugPrint('Outbox unavailable: $error');
    }
  }

  void _onLive() {
    if (SocketService.instance.streamLive.value) unawaited(_engine?.drain());
  }
}
