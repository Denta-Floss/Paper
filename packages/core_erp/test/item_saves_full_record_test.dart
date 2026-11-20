import 'package:core_erp/features/items/data/repositories/item_repository.dart';
import 'package:core_erp/features/items/domain/item_definition.dart';
import 'package:core_erp/features/items/domain/item_inputs.dart';
import 'package:core_erp/features/items/presentation/providers/items_provider.dart';
import 'package:flutter_test/flutter_test.dart';

// B42: a whole-item save is a full replace — the request carries attachments,
// unit conversions, die and machine links, the CAD file and the tree every
// time. It used to be built from the copy in the list, so a field the list did
// not carry was written away, and a list older than someone else's edit undid
// it. Every such save now starts from the server's full record.

ItemDefinition _part({
  String cadFileKey = '',
  List<ItemAttachmentDefinition> attachments = const <ItemAttachmentDefinition>[],
  String pipeline = '',
}) =>
    ItemDefinition(
      id: 7,
      name: 'Patti',
      alias: '',
      displayName: 'Patti',
      quantity: 0,
      groupId: 1,
      unitId: 1,
      isArchived: false,
      usageCount: 0,
      createdAt: DateTime.utc(2026, 1, 1),
      updatedAt: DateTime.utc(2026, 1, 1),
      variationTree: const <ItemVariationNodeDefinition>[],
      cadFileKey: cadFileKey,
      cadFileName: cadFileKey.isEmpty ? '' : 'patti.dxf',
      attachments: attachments,
      defaultPipelineId: pipeline.isEmpty ? null : pipeline,
    );

class _Server implements ItemRepository {
  /// What the list (or the replica the list filled) holds: no CAD file, no
  /// attachments — as a slimmed list would, or as a list from before someone
  /// attached them.
  final ItemDefinition listed = _part();

  /// What the server holds.
  ItemDefinition full = _part(
    cadFileKey: 'cad/patti.dxf',
    attachments: const <ItemAttachmentDefinition>[
      ItemAttachmentDefinition(id: 1, label: 'Drawing', objectKey: 'att/1.pdf', fileName: 'drawing.pdf'),
    ],
  );

  bool offline = false;
  UpdateItemInput? saved;
  int freshReads = 0;

  @override
  Future<void> init() async {}

  @override
  Future<List<ItemDefinition>> getItems() async => <ItemDefinition>[listed];

  @override
  Future<ItemDefinition?> getItemFresh(int id) async {
    freshReads += 1;
    if (offline) throw StateError('no connection');
    return id == full.id ? full : null;
  }

  @override
  Future<ItemDefinition> updateItem(UpdateItemInput input) async {
    saved = input;
    return full;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  late _Server server;
  late ItemsProvider provider;

  setUp(() async {
    server = _Server();
    provider = ItemsProvider(repository: server);
    await provider.refresh();
    expect(provider.items.single.cadFileKey, isEmpty, reason: 'the list copy lacks them');
  });

  test('a one-field save carries what the server holds, not what the list lacks', () async {
    await provider.setItemPipeline(7, 'pipe-1');

    final saved = server.saved!;
    expect(server.freshReads, 1);
    expect(saved.defaultPipelineId, 'pipe-1');
    expect(saved.cadFileKey, 'cad/patti.dxf', reason: 'not erased because the list did not carry it');
    expect(saved.attachments.map((a) => a.objectKey), <String>['att/1.pdf']);
  });

  test("a save does not undo someone else's newer edit the list has not seen", () async {
    server.full = _part(cadFileKey: 'cad/patti-rev-b.dxf');
    await provider.setItemPipeline(7, 'pipe-1');
    expect(server.saved!.cadFileKey, 'cad/patti-rev-b.dxf');
  });

  test('with the server out of reach, nothing is saved, and the reason is given', () async {
    server.offline = true;
    final result = await provider.setItemPipeline(7, 'pipe-1');

    expect(result, isNull);
    expect(server.saved, isNull, reason: 'a save from the list copy could erase what it lacks');
    expect(provider.errorMessage, contains('could not be read from the server'));
  });

  test('a part deleted on the server is reported as not found', () async {
    server.full = _part().copyWithId(99);
    final result = await provider.setItemPipeline(7, 'pipe-1');
    expect(result, isNull);
    expect(server.saved, isNull);
    expect(provider.errorMessage, 'Item not found.');
  });
}

extension on ItemDefinition {
  ItemDefinition copyWithId(int id) => ItemDefinition(
        id: id,
        name: name,
        alias: alias,
        displayName: displayName,
        quantity: quantity,
        groupId: groupId,
        unitId: unitId,
        isArchived: isArchived,
        usageCount: usageCount,
        createdAt: createdAt,
        updatedAt: updatedAt,
        variationTree: variationTree,
      );
}
