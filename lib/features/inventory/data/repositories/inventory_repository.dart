import '../../domain/create_parent_material_input.dart';
import '../../domain/material_inputs.dart';
import '../../domain/material_record.dart';

abstract class InventoryRepository {
  Future<void> init();
  Future<void> seedIfEmpty();
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
  Future<MaterialRecord> linkMaterialToItem(String barcode, int itemId);
  Future<MaterialRecord> unlinkMaterial(String barcode);
}

class SaveParentResult {
  const SaveParentResult({
    required this.parentBarcode,
    required this.childBarcodes,
  });

  final String parentBarcode;
  final List<String> childBarcodes;
}
