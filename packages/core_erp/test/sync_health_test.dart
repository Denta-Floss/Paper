import 'dart:convert';
import 'dart:io';

import 'package:core_erp/core/sync/outbox.dart';
import 'package:core_erp/core/sync/sync_health.dart';
import 'package:core_erp/features/sync_health/sync_health_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

// Track 3: the Sync Health screen — connection, the copy against the server's
// head, the outbox, and whether the two sides' versions work together.

Map<String, dynamic> _status({int head = 120, int api = kPaperApiVersion}) => <String, dynamic>{
      'success': true, 'serverVersion': '1.4.0', 'release': 'r42', 'apiVersion': api,
      'minClientApiVersion': api - 1, 'changelogHead': head, 'serverTime': '2026-11-20T10:00:00Z',
    };

void main() {
  group('compatibility (N / N-1 each way)', () {
    test('same, one behind either way, two apart', () {
      expect(compatibilityOf(app: 3, server: 3), ApiCompatibility.same);
      expect(compatibilityOf(app: 2, server: 3, serverMinimum: 2), ApiCompatibility.appOneBehind);
      expect(compatibilityOf(app: 4, server: 3), ApiCompatibility.serverOneBehind, reason: 'a server rolled back one release');
      expect(compatibilityOf(app: 1, server: 3, serverMinimum: 2), ApiCompatibility.incompatible);
      expect(compatibilityOf(app: 5, server: 3), ApiCompatibility.incompatible);
      expect(compatibilityOf(app: 3, server: null), ApiCompatibility.unknown);
    });
  });

  group('SyncHealthProbe', () {
    late Database db;
    late OutboxSyncEngine engine;
    late List<String> sent;
    var serverUp = true;

    setUp(() async {
      sqfliteFfiInit();
      db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
      for (final statement in OutboxStore.schemaStatements) {
        await db.execute(statement);
      }
      sent = <String>[];
      serverUp = true;
    });

    tearDown(() async {
      engine.dispose();
      await db.close();
    });

    MockClient server({Map<String, String> headers = const <String, String>{}}) => MockClient((request) async {
          if (!serverUp) throw const SocketException('Network is unreachable');
          if (request.url.path == '/api/system/status') {
            return http.Response(jsonEncode(_status()), 200, headers: headers);
          }
          sent.add('${request.method} ${request.url.path}');
          return http.Response('{"success":true,"data":{"id":9}}', 201);
        });

    test('online: round trip, head against the copy, versions', () async {
      final client = server();
      engine = OutboxSyncEngine(store: OutboxStore(db), client: client, baseUrl: 'http://srv');
      final probe = SyncHealthProbe(
        client: client, baseUrl: 'http://srv', appVersion: () async => '1.0.0+1',
        localCursor: () async => 117, lastSyncedAt: () => DateTime.utc(2026, 11, 20, 9), outbox: () => engine,
      );
      final reading = await probe.read();
      expect(reading.reachable, isTrue);
      expect(reading.pingMs, isNotNull);
      expect(reading.serverHead, 120);
      expect(reading.localCursor, 117);
      expect(reading.changesBehind, 3);
      expect(reading.serverVersion, '1.4.0');
      expect(reading.compatibility, ApiCompatibility.same);
      expect(reading.hasOutbox, isTrue);
      expect(reading.outboxWaiting, 0);
    });

    test('a copy the response cache served while the server was away is not a ping', () async {
      final client = server(headers: const <String, String>{'x-paper-cache': 'stale'});
      engine = OutboxSyncEngine(store: OutboxStore(db), client: client, baseUrl: 'http://srv');
      final reading = await SyncHealthProbe(client: client, baseUrl: 'http://srv', appVersion: () async => '1').read();
      expect(reading.reachable, isFalse);
      expect(reading.pingMs, isNull);
      expect(reading.serverHead, isNull, reason: 'a remembered head is not the server\'s head now');
      expect(reading.compatibility, ApiCompatibility.unknown);
    });

    test('offline: the queue is counted; Flush now sends it without waiting out the backoff', () async {
      final client = server();
      var clock = DateTime.utc(2026, 11, 20, 9);
      engine = OutboxSyncEngine(store: OutboxStore(db), client: client, baseUrl: 'http://srv', now: () => clock);
      serverUp = false;
      await engine.submit(operationType: 'create_challan', method: 'POST', endpoint: '/api/challans', body: <String, dynamic>{'n': 1});
      await engine.submit(operationType: 'create_challan', method: 'POST', endpoint: '/api/challans', body: <String, dynamic>{'n': 2});
      final probe = SyncHealthProbe(client: client, baseUrl: 'http://srv', appVersion: () async => '1', outbox: () => engine, now: () => clock);

      var reading = await probe.read();
      expect(reading.reachable, isFalse);
      expect(reading.outboxWaiting, 2);
      expect(reading.outboxNextAttempt, isNotNull, reason: 'the head is backing off');
      expect(reading.outboxLastError, isNotNull);

      serverUp = true; // back, but the head's backoff has not ended
      await engine.drain();
      expect(sent, isEmpty, reason: 'a plain drain respects the backoff');
      await probe.flushNow();
      expect(sent, <String>['POST /api/challans', 'POST /api/challans'], reason: 'oldest first, both');
      reading = await probe.read();
      expect(reading.outboxWaiting, 0);
    });

    test('flush leaves a conflict for a person', () async {
      final client = MockClient((request) async {
        if (request.url.path == '/api/system/status') return http.Response(jsonEncode(_status()), 200);
        sent.add(request.url.path);
        return http.Response('{"success":false,"error":"Pick a vendor."}', 400);
      });
      engine = OutboxSyncEngine(store: OutboxStore(db), client: client, baseUrl: 'http://srv');
      await engine.submit(operationType: 'create_challan', method: 'POST', endpoint: '/api/challans', body: <String, dynamic>{});
      final probe = SyncHealthProbe(client: client, baseUrl: 'http://srv', appVersion: () async => '1', outbox: () => engine);
      await probe.flushNow();
      expect(sent, hasLength(1), reason: 'sent once when made, not again by Flush now');
      expect((await probe.read()).outboxConflicts, 1);
    });
  });

  group('SyncHealthScreen', () {
    // Tall enough for all four cards: a ListView builds only what is on screen.
    void tall(WidgetTester tester) {
      tester.view.physicalSize = const Size(900, 2200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
    }

    testWidgets('shows the four readings, and Flush now is drawn disabled with its reason when nothing waits', (tester) async {
      tall(tester);
      final client = MockClient((request) async => http.Response(jsonEncode(_status(head: 50)), 200));
      final probe = SyncHealthProbe(client: client, baseUrl: 'http://srv', appVersion: () async => '2.1.0', localCursor: () async => 50);
      await tester.pumpWidget(MaterialApp(home: SyncHealthScreen(probe: probe, interval: const Duration(hours: 1))));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();

      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('Up to date'), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('sync_health_head'))).data, '50');
      expect(find.text('Not in use'), findsOneWidget, reason: 'no outbox in this build');
      expect(tester.widget<Text>(find.byKey(const Key('sync_health_app_version'))).data, '2.1.0 · API $kPaperApiVersion');
      expect(find.text('Compatible'), findsOneWidget);
      final flush = tester.widget<ButtonStyleButton>(find.byKey(const Key('sync_health_flush')));
      expect(flush.onPressed, isNull);
      expect(find.byTooltip('There is no outbox on this device.'), findsOneWidget);
    });

    testWidgets('embedded in a pane that already scrolls, it lays out at its own height', (tester) async {
      tall(tester);
      final client = MockClient((request) async => http.Response(jsonEncode(_status(head: 50)), 200));
      final probe = SyncHealthProbe(client: client, baseUrl: 'http://srv', appVersion: () async => '1', localCursor: () async => 40);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: Column(children: [SyncHealthScreen(probe: probe, embedded: true, interval: const Duration(hours: 1))]),
          ),
        ),
      ));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.text('10 behind'), findsOneWidget);
      expect(find.byType(AppBar), findsNothing, reason: 'the pane has its own title');
    });

    testWidgets('offline and two versions apart say so', (tester) async {
      tall(tester);
      final client = MockClient((request) async => http.Response(jsonEncode(_status(api: kPaperApiVersion + 2)), 200));
      final probe = SyncHealthProbe(client: client, baseUrl: 'http://srv', appVersion: () async => '1');
      await tester.pumpWidget(MaterialApp(home: SyncHealthScreen(probe: probe, interval: const Duration(hours: 1))));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      expect(find.text('Incompatible'), findsOneWidget);

      final offline = SyncHealthProbe(
        client: MockClient((_) async => throw const SocketException('down')), baseUrl: 'http://srv', appVersion: () async => '1',
      );
      await tester.pumpWidget(MaterialApp(home: SyncHealthScreen(key: UniqueKey(), probe: offline, interval: const Duration(hours: 1))));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      expect(find.text('Offline'), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('sync_health_head'))).data, 'unknown while offline');
    });
  });
}
