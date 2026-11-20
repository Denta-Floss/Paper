import 'dart:convert';

import 'package:core_erp/core/database/local_database_helper.dart';
import 'package:core_erp/core/sync/replica_freshness.dart';
import 'package:core_erp/core/sync/replica_reader.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

// The replica answers for a table only when it is not known to be behind.
//
// The trap this closes: a provider refreshes on the same live event the replica
// is told about, and again after its own writes — both times before the
// replica has applied the change, so the screen showed the row as it was.

void main() {
  late Database db;
  late ReplicaFreshness freshness;
  late ReplicaReader reader;

  setUp(() async {
    sqfliteFfiInit();
    db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    for (final statement in LocalDatabaseHelper.schemaStatements) {
      await db.execute(statement);
    }
    await db.insert('local_vendors', <String, Object?>{
      'id': 7,
      'name': 'Steel Co',
      'raw_payload_json': jsonEncode(<String, dynamic>{'id': 7, 'name': 'Steel Co'}),
    });
    freshness = ReplicaFreshness();
    reader = ReplicaReader(replica: () async => db, isHydrated: () => true, freshness: freshness);
  });

  tearDown(() => db.close());

  Future<List<String>?> names() => reader.readAll<String>(
        'local_vendors',
        orderBy: 'id',
        fromJson: (json) => json['name'] as String?,
      );

  test('a table nobody has changed is read from the replica', () async {
    expect(await names(), <String>['Steel Co']);
  });

  test('a table with a change not yet applied is read from the network', () async {
    freshness.markBehind('local_vendors');
    expect(await names(), isNull, reason: 'null means: ask the network');
    expect(
      await reader.readOne<String>('local_vendors', keyColumn: 'id', key: 7, fromJson: (json) => json['name'] as String?),
      isNull,
    );
  });

  test('a write marks its table behind until the replica applies it', () async {
    reader.wrote('local_vendors');
    expect(await names(), isNull);

    final marks = freshness.snapshot(<String>['local_vendors']);
    freshness.caughtUp(marks);
    expect(await names(), <String>['Steel Co']);
  });

  test('a drain does not clear a change heard while it was running', () async {
    freshness.markBehind('local_vendors');
    final marks = freshness.snapshot(<String>['local_vendors']);
    // Another change arrives mid-drain.
    freshness.markBehind('local_vendors');
    freshness.caughtUp(marks);
    expect(freshness.isBehind('local_vendors'), isTrue);
    expect(await names(), isNull);
  });

  test('other tables are not affected', () async {
    freshness.markBehind('local_clients');
    expect(await names(), <String>['Steel Co']);
  });
}
