import 'dart:async';

import 'package:core_erp/features/inventory/data/repositories/inventory_repository.dart';
import 'package:core_erp/features/inventory/domain/inventory_control_tower.dart';
import 'package:core_erp/features/inventory/domain/inventory_set_definition.dart';
import 'package:core_erp/features/inventory/domain/material_record.dart';
import 'package:core_erp/features/inventory/domain/variation_stock_record.dart';
import 'package:core_erp/features/inventory/presentation/providers/inventory_provider.dart';
import 'package:flutter_test/flutter_test.dart';

// The inventory screen's four reads, on the wire.
//
// They were awaited one after another, so a refresh cost four round trips in
// a row; and every socket event — three arrive for one generated challan —
// started a whole new refresh. Both pinned here with a repository that
// answers only when told to.

class _GatedRepository implements InventoryRepository {
  int materialsCalls = 0;
  int stockCalls = 0;
  int setsCalls = 0;
  int healthCalls = 0;
  final List<Completer<void>> gates = <Completer<void>>[];

  /// A gate every read waits on; opened by the test.
  Completer<void> gate() {
    final c = Completer<void>();
    gates.add(c);
    return c;
  }

  @override
  Future<void> init() async {}

  @override
  Future<void> seedIfEmpty() async {}

  @override
  Future<List<MaterialRecord>> getAllMaterials() async {
    materialsCalls += 1;
    await gate().future;
    return const <MaterialRecord>[];
  }

  @override
  Future<List<VariationStockRecord>> getVariationStock() async {
    stockCalls += 1;
    await gate().future;
    return const <VariationStockRecord>[];
  }

  @override
  Future<List<InventorySetDefinition>> getSets() async {
    setsCalls += 1;
    await gate().future;
    return const <InventorySetDefinition>[];
  }

  @override
  Future<InventoryHealthSnapshot> getInventoryHealth() async {
    healthCalls += 1;
    return const InventoryHealthSnapshot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError(
        '${invocation.memberName} is not part of this test',
      );
}

void main() {
  test('the three list reads are in flight together', () async {
    final repository = _GatedRepository();
    final provider = InventoryProvider(repository: repository);

    final refresh = provider.refresh();
    await Future<void>.delayed(Duration.zero);

    expect(repository.materialsCalls, 1);
    expect(repository.stockCalls, 1);
    expect(repository.setsCalls, 1, reason: 'all three started before any answered');
    expect(repository.healthCalls, 0, reason: 'health waits for the materials it falls back on');

    for (final gate in repository.gates) {
      gate.complete();
    }
    await refresh;
    expect(repository.healthCalls, 1);
    expect(provider.isLoading, isFalse);
  });

  test('refreshes asked for during a refresh share one follow-up run', () async {
    final repository = _GatedRepository();
    final provider = InventoryProvider(repository: repository);

    final first = provider.refresh();
    await Future<void>.delayed(Duration.zero);
    // A challan generated raises three socket events in a row.
    final burst = <Future<void>>[provider.refresh(), provider.refresh(), provider.refresh()];
    expect(repository.materialsCalls, 1, reason: 'nothing starts while one is running');

    for (final gate in repository.gates.toList()) {
      gate.complete();
    }
    await first;
    await Future<void>.delayed(Duration.zero);
    expect(repository.materialsCalls, 2, reason: 'one follow-up, not three');

    for (final gate in repository.gates.toList()) {
      if (!gate.isCompleted) gate.complete();
    }
    await Future.wait(burst);
    expect(repository.materialsCalls, 2);
    expect(provider.isLoading, isFalse);

    // And after everything settled, the next refresh is a new run.
    final later = provider.refresh();
    await Future<void>.delayed(Duration.zero);
    for (final gate in repository.gates.toList()) {
      if (!gate.isCompleted) gate.complete();
    }
    await later;
    expect(repository.materialsCalls, 3);
  });
}
