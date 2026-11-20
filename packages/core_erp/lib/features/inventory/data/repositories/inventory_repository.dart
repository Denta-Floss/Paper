import '../../domain/create_parent_material_input.dart';
import '../../domain/effective_group_schema.dart';
import '../../domain/group_property_draft.dart';
import '../../domain/inventory_control_tower.dart';
import '../../domain/inventory_set_definition.dart';
import '../../domain/material_activity_event.dart';
import '../../domain/material_control_tower_detail.dart';
import '../../domain/material_group_configuration.dart';
import '../../domain/material_inputs.dart';
import '../../domain/material_record.dart';

import '../../domain/variation_stock_record.dart';

/// What GET /api/inventory/overview answers: the inventory screen's four
/// reads at once.
///
/// [materials] is null when they were not asked for (a local replica already
/// holds them); [health] is null when the server could not work the tiles out,
/// which the provider answers with its own estimate, as it always has.
class InventoryOverview {
  const InventoryOverview({
    required this.materials,
    required this.variationStock,
    required this.sets,
    required this.health,
  });

  final List<MaterialRecord>? materials;
  final List<VariationStockRecord> variationStock;
  final List<InventorySetDefinition> sets;
  final InventoryHealthSnapshot? health;

  InventoryOverview withMaterials(List<MaterialRecord> value) => InventoryOverview(
        materials: value,
        variationStock: variationStock,
        sets: sets,
        health: health,
      );
}

/// A repository that can answer the inventory screen in one round trip.
///
/// Its own interface rather than a member of [InventoryRepository], so the
/// many test fakes and the demo store that implement that one keep compiling;
/// the provider uses this when it is there and the four reads when it is not.
abstract class InventoryOverviewReader {
  Future<InventoryOverview> getOverview({bool includeMaterials = true});
}

abstract class InventoryRepository {
  Future<void> init();
  Future<void> seedIfEmpty();
  Future<List<VariationStockRecord>> getVariationStock();
  Future<SaveParentResult> saveParentWithChildren(
    CreateParentMaterialInput input,
  );
  Future<MaterialRecord?> getMaterialByBarcode(String barcode);
  Future<List<MaterialRecord>> getAllMaterials();
  Future<MaterialRecord?> incrementScanCount(String barcode);
  Future<MaterialRecord?> resetScanTrace(String barcode);
  Future<MaterialRecord> createChildMaterial(CreateChildMaterialInput input);
  Future<MaterialRecord> updateMaterial(UpdateMaterialInput input);
  Future<void> deleteMaterial(String barcode);
  Future<MaterialRecord> linkMaterialToGroup(String barcode, int groupId);
  Future<MaterialRecord> linkMaterialToItem(
    String barcode,
    int itemId, {
    int? variationLeafNodeId,
  });
  Future<MaterialRecord> unlinkMaterial(String barcode);
  Future<List<MaterialActivityEvent>> getMaterialActivity(String barcode);
  Future<InventoryHealthSnapshot> getInventoryHealth();
  Future<MaterialControlTowerDetail?> getMaterialControlTowerDetail(
    String barcode,
  );
  Future<MaterialControlTowerDetail> createInventoryMovement(
    CreateInventoryMovementInput input,
  );
  Future<MaterialGroupConfiguration> getGroupConfiguration(String barcode);
  Future<EffectiveGroupSchema> getEffectiveSchema(int groupId);
  Future<MaterialGroupConfiguration> updateGroupConfiguration(
    String barcode, {
    required bool inheritanceEnabled,
    required List<int> selectedItemIds,
    required List<GroupPropertyDraft> propertyDrafts,
    required List<GroupUnitGovernance> unitGovernance,
    required GroupUiPreferences uiPreferences,
    required List<String> discardedPropertyKeys,
  });
  Future<List<InventorySetDefinition>> getSets();
  Future<InventorySetDefinition> saveSet(SaveInventorySetInput input);
  Future<void> deleteSet(int setId);
}

class SaveParentResult {
  const SaveParentResult({
    required this.parentBarcode,
    required this.childBarcodes,
  });

  final String parentBarcode;
  final List<String> childBarcodes;
}
