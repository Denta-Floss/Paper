import 'dart:async';

import 'package:core_erp/features/items/data/repositories/item_repository.dart';
import 'package:core_erp/features/items/domain/item_definition.dart';
import 'package:core_erp/features/items/presentation/providers/items_provider.dart';
import 'package:flutter_test/flutter_test.dart';

// B50: the phone's item list follows the replica. An item changed anywhere is
// re-read once the phone's copy holds the change, without a restart.

class _CountingRepository implements ItemRepository {
  int reads = 0;
  Completer<void>? gate;

  @override
  Future<void> init() async {}

  @override
  Future<List<ItemDefinition>> getItems() async {
    reads += 1;
    if (gate != null) await gate!.future;
    return const <ItemDefinition>[];
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<void> _settle() => Future<void>.delayed(const Duration(milliseconds: 10));

void main() {
  late StreamController<Set<String>> changes;
  late _CountingRepository repository;
  late ItemsProvider provider;

  setUp(() {
    changes = StreamController<Set<String>>.broadcast();
    repository = _CountingRepository();
    provider = ItemsProvider(repository: repository, replicaChanges: changes.stream);
  });

  tearDown(() async {
    provider.dispose();
    await changes.close();
  });

  test('the items table changing in the copy re-reads the list', () async {
    changes.add(<String>{'local_items', 'local_orders'});
    await _settle();
    expect(repository.reads, 1);
  });

  test('another table changing does not', () async {
    changes.add(<String>{'local_vendors'});
    await _settle();
    expect(repository.reads, 0);
  });

  test('a burst during one re-read costs one more, not one each', () async {
    repository.gate = Completer<void>();
    changes.add(<String>{'local_items'});
    await _settle();
    for (var i = 0; i < 5; i++) {
      changes.add(<String>{'local_items'});
    }
    await _settle();
    expect(repository.reads, 1);
    repository.gate!.complete();
    repository.gate = null;
    await _settle();
    expect(repository.reads, 2);
  });

  test('without a replica stream nothing listens (the desktop uses socket events)', () async {
    final own = _CountingRepository();
    final plain = ItemsProvider(repository: own);
    changes.add(<String>{'local_items'});
    await _settle();
    expect(own.reads, 0);
    plain.dispose();
  });
}
