import 'dart:convert';
import 'dart:io';

import 'package:core_erp/core/sync/outbox.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

// The client outbox (Phase 3, Track 2 B): writes made without the server are
// kept and sent later, oldest first, each with its own idempotency key.

/// A server that applies a write once per key, like backend/kernel/idempotency.js:
/// a second send of a key gets the first answer back and creates nothing.
class _Server {
  bool reachable = true;

  /// Commit the next write, then lose its answer on the way back.
  bool dropNextAnswer = false;

  /// Refuse writes to this path with 409 (insufficient stock, say).
  String? refusePath;

  int failNext5xx = 0;
  final List<String> received = <String>[];
  final List<String?> keys = <String?>[];
  final Map<String, http.Response> kept = <String, http.Response>{};
  final List<Map<String, dynamic>> created = <Map<String, dynamic>>[];

  late final MockClient client = MockClient((request) async {
    if (!reachable) throw const SocketException('Network is unreachable');
    final key = request.headers['X-Idempotency-Key'];
    received.add('${request.method} ${request.url.path}');
    keys.add(key);
    if (key != null && kept.containsKey(key)) return kept[key]!;
    if (failNext5xx > 0) {
      failNext5xx -= 1;
      return http.Response('{"success":false,"error":"boom"}', 500);
    }
    if (refusePath != null && request.url.path == refusePath) {
      return http.Response('{"success":false,"code":"insufficient_stock","error":"Only 4 sheets of MS 1.2 left."}', 409);
    }
    final id = created.length + 100;
    created.add(<String, dynamic>{'id': id, 'path': request.url.path, 'body': jsonDecode(request.body)});
    final answer = http.Response(jsonEncode(<String, dynamic>{'success': true, 'challan': <String, dynamic>{'id': id, 'challanNo': 'DC-$id'}}), 201);
    if (key != null) kept[key] = answer;
    if (dropNextAnswer) {
      dropNextAnswer = false;
      throw const SocketException('Connection reset by peer');
    }
    return answer;
  });
}

void main() {
  late Database db;
  late _Server server;
  late OutboxSyncEngine engine;
  late DateTime clock;

  setUp(() async {
    sqfliteFfiInit();
    db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    for (final statement in OutboxStore.schemaStatements) {
      await db.execute(statement);
    }
    server = _Server();
    clock = DateTime.utc(2026, 11, 20, 9);
    engine = OutboxSyncEngine(store: OutboxStore(db), client: server.client, baseUrl: 'http://srv', now: () => clock);
  });

  tearDown(() async {
    engine.dispose();
    await db.close();
  });

  Future<OutboxEntry> submit(String name, {String endpoint = '/api/challans'}) => engine.submit(
        operationType: 'create_challan', method: 'POST', endpoint: endpoint, body: <String, dynamic>{'name': name},
      );

  test('online, a write is sent at once with its id as the key', () async {
    final entry = await submit('first');
    expect(entry.status, OutboxStatus.synced);
    expect(entry.serverId, 100);
    expect(server.keys.single, entry.id);
  });

  test('three writes made offline are sent in the order they were made', () async {
    server.reachable = false;
    final a = await submit('a');
    clock = clock.add(const Duration(minutes: 1));
    final b = await submit('b');
    final c = await submit('c');
    expect([a.status, b.status, c.status], everyElement(OutboxStatus.pending));
    expect(server.created, isEmpty);

    server.reachable = true;
    clock = clock.add(const Duration(minutes: 5)); // past every backoff
    await engine.drain();
    expect(server.created.map((w) => w['body']['name']), <String>['a', 'b', 'c']);
    expect(server.keys, <String?>[a.id, b.id, c.id]);
  });

  test('an answer lost on the way back: the retry carries the same key, and one record exists', () async {
    server.dropNextAnswer = true; // committed on the server, answer lost
    final entry = await submit('only once');
    expect(entry.status, OutboxStatus.pending, reason: 'the client cannot know it landed');
    expect(server.created, hasLength(1));

    clock = clock.add(const Duration(seconds: 5));
    await engine.drain();
    final after = (await engine.store.entry(entry.id))!;
    expect(after.status, OutboxStatus.synced);
    expect(server.keys, <String?>[entry.id, entry.id], reason: 'the same key, both times');
    expect(server.created, hasLength(1), reason: 'the server replayed its answer; nothing was made twice');
    expect(after.serverId, 100);
  });

  test('a server failure backs off 1 s, 2 s, 4 s … and holds the queue behind it', () async {
    server.failNext5xx = 2;
    final first = await submit('first');
    final second = await submit('second');
    var e = (await engine.store.entry(first.id))!;
    expect(e.retryCount, 1);
    expect(e.nextAttemptAt, clock.add(const Duration(seconds: 1)));
    expect((await engine.store.entry(second.id))!.status, OutboxStatus.pending,
        reason: 'nothing overtakes the head of the queue');
    expect(server.received, hasLength(1), reason: 'the second was not sent ahead of the first');

    clock = clock.add(const Duration(seconds: 1));
    await engine.drain();
    e = (await engine.store.entry(first.id))!;
    expect(e.retryCount, 2);
    expect(e.nextAttemptAt, clock.add(const Duration(seconds: 2)));

    clock = clock.add(const Duration(seconds: 2));
    await engine.drain();
    expect((await engine.store.entry(first.id))!.status, OutboxStatus.synced);
    expect((await engine.store.entry(second.id))!.status, OutboxStatus.synced);
    expect(OutboxSyncEngine.backoff(4), const Duration(seconds: 8));
    expect(OutboxSyncEngine.backoff(12), const Duration(seconds: 30), reason: 'capped');
  });

  test('a refusal becomes a conflict for a person, is not retried alone, and does not block the rest', () async {
    server.refusePath = '/api/inventory/movements';
    final move = await submit('issue 6 sheets', endpoint: '/api/inventory/movements');
    final next = await submit('next');
    final refused = (await engine.store.entry(move.id))!;
    expect(refused.status, OutboxStatus.conflict);
    expect(refused.lastError, 'Only 4 sheets of MS 1.2 left.');
    expect(next.status, OutboxStatus.synced);

    await engine.drain();
    expect(server.received.where((r) => r.contains('movements')), hasLength(1), reason: 'never sent again on its own');

    server.refusePath = null;
    await engine.retry(move.id);
    expect((await engine.store.entry(move.id))!.status, OutboxStatus.synced, reason: 'sent again once a person says so');
  });

  test('an issue queued for a challan that was itself queued is sent to the challan the server made', () async {
    server.reachable = false;
    final create = await submit('challan');
    final issue = await submit('issue', endpoint: '/api/challans/{ref:${create.id}}/issue');
    server.reachable = true;
    clock = clock.add(const Duration(minutes: 1));
    await engine.drain();
    expect(server.received, <String>['POST /api/challans', 'POST /api/challans/100/issue']);
    expect((await engine.store.entry(issue.id))!.status, OutboxStatus.synced);
  });

  test('and when the challan is refused, its issue is not sent at all', () async {
    server.refusePath = '/api/challans';
    final create = await submit('challan');
    final issue = await submit('issue', endpoint: '/api/challans/{ref:${create.id}}/issue');
    expect((await engine.store.entry(issue.id))!.status, OutboxStatus.conflict);
    expect((await engine.store.entry(issue.id))!.lastError, contains('refused'));
    expect(server.received, <String>['POST /api/challans']);
  });

  test('a send cut off by the app closing goes back in the queue, with the same key', () async {
    server.reachable = false;
    final entry = await submit('x');
    await engine.store.update(entry.id, <String, Object?>{'status': OutboxStatus.inFlight});
    await engine.store.recover();
    expect((await engine.store.entry(entry.id))!.status, OutboxStatus.pending);
  });
}
