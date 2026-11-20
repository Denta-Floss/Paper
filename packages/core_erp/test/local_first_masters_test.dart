import 'dart:convert';

import 'package:core_erp/core/database/local_database_helper.dart';
import 'package:core_erp/core/sync/replica_freshness.dart';
import 'package:core_erp/features/vendors/data/repositories/api_vendor_repository.dart';
import 'package:core_erp/features/vendors/data/repositories/local_first_vendor_repository.dart';
import 'package:core_erp/features/vendors/domain/vendor_inputs.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

// The masters read from the replica they were already written to (stage 2e,
// step 6) — and from the network whenever the replica is known to be behind.
// Vendors stand for all seven: the decorators share one shape.

void main() {
  late Database db;
  late List<String> requests;
  late LocalFirstVendorRepository repository;
  var hydrated = true;

  setUp(() async {
    sqfliteFfiInit();
    db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    for (final statement in LocalDatabaseHelper.schemaStatements) {
      await db.execute(statement);
    }
    for (final row in <Map<String, dynamic>>[
      <String, dynamic>{'id': 2, 'name': 'Zinc Works', 'isArchived': false},
      <String, dynamic>{'id': 1, 'name': 'Old Steel', 'isArchived': true},
      <String, dynamic>{'id': 3, 'name': 'Alu Mart', 'isArchived': false},
    ]) {
      await db.insert('local_vendors', <String, Object?>{
        'id': row['id'],
        'name': row['name'],
        'raw_payload_json': jsonEncode(row),
      });
    }
    ReplicaFreshness.instance.reset();
    hydrated = true;
    requests = <String>[];
    final client = MockClient((request) async {
      requests.add('${request.method} ${request.url.path}');
      if (request.method == 'GET' && request.url.path == '/api/vendors') {
        return http.Response(jsonEncode(<String, dynamic>{
          'success': true,
          'vendors': <Map<String, dynamic>>[<String, dynamic>{'id': 9, 'name': 'From The Server'}],
        }), 200);
      }
      if (request.method == 'POST' && request.url.path == '/api/vendors') {
        return http.Response(jsonEncode(<String, dynamic>{
          'success': true,
          'vendor': <String, dynamic>{'id': 9, 'name': 'From The Server'},
        }), 201);
      }
      return http.Response('{"success":false}', 404);
    });
    final remote = ApiVendorRepository(client: client, baseUrl: 'http://paper.test');
    repository = LocalFirstVendorRepository(
      remote: remote,
      replica: () async => db,
      isHydrated: () => hydrated,
      fromJson: remote.vendorFromJson,
    );
  });

  tearDown(() async {
    ReplicaFreshness.instance.reset();
    await db.close();
  });

  test('a hydrated replica answers without a request, in the server order', () async {
    final vendors = await repository.getVendors();
    expect(requests, isEmpty);
    expect(vendors.map((v) => v.name), <String>['Alu Mart', 'Zinc Works', 'Old Steel'],
        reason: 'live first by name, archived last, as the server sorts');
    expect((await repository.getVendor(2))?.name, 'Zinc Works');
    expect(requests, isEmpty);
  });

  test('after a write the list comes from the network until the replica applies it', () async {
    await repository.createVendor(const CreateVendorInput(name: 'From The Server'));
    requests.clear();

    final vendors = await repository.getVendors();
    expect(requests, <String>['GET /api/vendors'], reason: 'the replica has not applied the write yet');
    expect(vendors.single.name, 'From The Server');

    // The sync service's drain applies it and clears the mark.
    ReplicaFreshness.instance.caughtUp(ReplicaFreshness.instance.snapshot(<String>['local_vendors']));
    requests.clear();
    await repository.getVendors();
    expect(requests, isEmpty, reason: 'caught up, the replica answers again');
  });

  test('a replica that is not hydrated (or mid catch-up) is not asked', () async {
    hydrated = false;
    await repository.getVendors();
    expect(requests, <String>['GET /api/vendors']);
  });
}
