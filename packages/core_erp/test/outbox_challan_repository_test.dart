import 'dart:convert';
import 'dart:io';

import 'package:core_erp/core/sync/outbox.dart';
import 'package:core_erp/features/delivery_challans/data/delivery_challan_repository.dart';
import 'package:core_erp/features/delivery_challans/data/local_first_challan_repository.dart';
import 'package:core_erp/features/delivery_challans/domain/delivery_challan.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

// A challan made on the shop floor with no signal: kept, shown as pending,
// issued when the server has it, and made exactly once.

class _NoList implements ChallanRepository {
  @override
  Future<List<DeliveryChallan>> getChallans({
    ChallanType? type, DeliveryChallanStatus? status, String search = '', DateTime? dateFrom,
    DateTime? dateTo, int? orderId, int? itemId, int? variationLeafNodeId, bool mineOnly = false,
  }) async => const <DeliveryChallan>[];

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Unreachable extends _NoList {
  @override
  Future<List<DeliveryChallan>> getChallans({
    ChallanType? type, DeliveryChallanStatus? status, String search = '', DateTime? dateFrom,
    DateTime? dateTo, int? orderId, int? itemId, int? variationLeafNodeId, bool mineOnly = false,
  }) async => throw const SocketException('Connection refused');
}

class _Refusing extends _NoList {
  @override
  Future<List<DeliveryChallan>> getChallans({
    ChallanType? type, DeliveryChallanStatus? status, String search = '', DateTime? dateFrom,
    DateTime? dateTo, int? orderId, int? itemId, int? variationLeafNodeId, bool mineOnly = false,
  }) async => throw ChallanApiException('Not allowed');
}

Map<String, dynamic> _challanJson(int id, String no, String status) => <String, dynamic>{
      'id': id, 'type': 'delivery', 'challanNo': no, 'challan_no': no, 'status': status,
      'date': '2026-11-20', 'items': <dynamic>[], 'orderIds': <dynamic>[],
    };

void main() {
  late Database db;
  late OutboxSyncEngine engine;
  late LocalFirstChallanRepository repository;
  late List<String> received;
  late Set<String> seenKeys;
  var reachable = false;
  var refuse = false;

  setUp(() async {
    sqfliteFfiInit();
    db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    for (final statement in OutboxStore.schemaStatements) {
      await db.execute(statement);
    }
    received = <String>[];
    seenKeys = <String>{};
    reachable = false;
    refuse = false;
    var clock = DateTime.utc(2026, 11, 20, 9);
    final client = MockClient((request) async {
      if (!reachable) throw const SocketException('offline');
      received.add('${request.method} ${request.url.path}');
      seenKeys.add(request.headers['X-Idempotency-Key']!);
      if (refuse) return http.Response('{"success":false,"error":"Pick a customer."}', 400);
      if (request.url.path == '/api/challans') {
        if (jsonDecode(request.body)['customer_name'] != 'Ravi Traders') return http.Response('{"error":"body changed"}', 400);
        return http.Response(jsonEncode(<String, dynamic>{'success': true, 'data': _challanJson(41, 'DC-0041', 'draft')}), 201);
      }
      return http.Response(jsonEncode(<String, dynamic>{'success': true, 'data': _challanJson(41, 'DC-0041', 'issued')}), 200);
    });
    engine = OutboxSyncEngine(store: OutboxStore(db), client: client, baseUrl: 'http://srv', now: () => clock = clock.add(const Duration(minutes: 1)));
    repository = LocalFirstChallanRepository(
      remote: _NoList(),
      replica: () async => null,
      isHydrated: () => false,
      outbox: () => engine,
    );
  });

  tearDown(() async {
    engine.dispose();
    await db.close();
  });

  final draft = ChallanDraftInput(
    type: ChallanType.delivery, challanNo: '', orderId: 0, orderIds: const <int>[], vendorId: 0,
    date: DateTime(2026, 11, 20), location: 'Bay 2', sourceReference: '', notes: '', maintainStocks: true,
    customerName: 'Ravi Traders', customerGstin: '', vendorName: '', vendorGstin: '', items: const [],
  );

  test('offline: created and issued, shown as pending, nothing lost', () async {
    final created = await repository.createChallan(draft);
    expect(created.isPendingSync, isTrue);
    expect(created.id, isNegative);
    expect(created.challanNo, 'Pending upload', reason: 'the number is the server\'s to give');

    final issued = await repository.issueChallan(created.id);
    expect(issued.isPendingSync, isTrue);
    expect(issued.status, DeliveryChallanStatus.issued);

    final list = await repository.getChallans();
    expect(list.single.customerName, 'Ravi Traders');
    expect(list.single.isPendingSync, isTrue);
    expect(received, isEmpty);
  });

  test('offline, the book (mine only) still shows the pending challan when the server read fails', () async {
    final offlineList = LocalFirstChallanRepository(
      remote: _Unreachable(), replica: () async => null, isHydrated: () => false, outbox: () => engine,
    );
    await offlineList.createChallan(draft);
    final mine = await offlineList.getChallans(mineOnly: true);
    expect(mine.single.isPendingSync, isTrue);
  });

  test('offline, the book reads this user\'s past challans from the copy, after what is waiting (B53)', () async {
    final copy = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    await copy.execute('CREATE TABLE local_delivery_challans (id INTEGER PRIMARY KEY, challan_date TEXT, raw_payload_json TEXT)');
    Future<void> put(int id, String no, String date, int by, String type) => copy.insert('local_delivery_challans', <String, Object?>{
          'id': id, 'challan_date': date,
          'raw_payload_json': jsonEncode(<String, dynamic>{..._challanJson(id, no, 'issued'), 'date': date, 'created_by': by, 'type': type}),
        });
    await put(7, 'DC-0007', '2026-11-18', 1, 'delivery');
    await put(8, 'DC-0008', '2026-11-19', 2, 'delivery'); // someone else's
    await put(9, 'RC-0009', '2026-11-19', 1, 'reception');
    final offline = LocalFirstChallanRepository(
      remote: _Unreachable(), replica: () async => copy, isHydrated: () => true, outbox: () => engine,
      currentUserId: () => 1,
    );
    await offline.createChallan(draft);

    final mine = await offline.getChallans(mineOnly: true);
    expect(mine.map((c) => c.challanNo), <String>['Pending upload', 'RC-0009', 'DC-0007'],
        reason: 'waiting first, then the copy newest first, and not user 2\'s');
    final deliveries = await offline.getChallans(mineOnly: true, type: ChallanType.delivery);
    expect(deliveries.map((c) => c.challanNo), <String>['Pending upload', 'DC-0007']);

    final noUser = LocalFirstChallanRepository(
      remote: _Unreachable(), replica: () async => copy, isHydrated: () => true,
    );
    await expectLater(noUser.getChallans(mineOnly: true), throwsA(isA<SocketException>()),
        reason: 'with no user to match, "mine" is not guessed');
    await copy.close();
  });

  test('a refusal from the server is not mistaken for being offline', () async {
    final copy = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    final refused = LocalFirstChallanRepository(
      remote: _Refusing(), replica: () async => copy, isHydrated: () => true, currentUserId: () => 1,
    );
    await expectLater(refused.getChallans(mineOnly: true), throwsA(isA<ChallanApiException>()));
    await copy.close();
  });

  test('back online: sent in order, issued on the challan the server made, then off the pending list', () async {
    final created = await repository.createChallan(draft);
    await repository.issueChallan(created.id);

    reachable = true;
    await Future<void>.delayed(Duration.zero);
    await engine.drain();
    expect(received, <String>['POST /api/challans', 'POST /api/challans/41/issue']);
    expect(seenKeys, hasLength(2), reason: 'each write its own key');
    expect(await repository.getChallans(), isEmpty, reason: 'the server\'s copy replaces the pending one');
  });

  test('online: the server\'s challan comes straight back, number and all', () async {
    reachable = true;
    final created = await repository.createChallan(draft);
    expect(created.isPendingSync, isFalse);
    expect(created.id, 41);
    expect(created.challanNo, 'DC-0041');
  });

  test('a refusal while the worker is still on the form is shown there, and nothing is left queued', () async {
    reachable = true;
    refuse = true;
    await expectLater(repository.createChallan(draft), throwsA(isA<ChallanApiException>()
        .having((e) => e.message, 'message', 'Pick a customer.')));
    expect(await engine.store.unsettled(), isEmpty);
  });
}
