import 'package:core_erp/features/inventory/domain/material_record.dart';

class BarcodeInput {
  const BarcodeInput({
    required this.barcode,
    required this.materialName,
    required this.materialType,
    required this.scanCount,
    this.quantity,
    this.unit,
    this.sourceKind = 'barcode',
    this.sheetWeight,
  });

  final String barcode;
  final String materialName;
  final String materialType;
  final int scanCount;
  final double? quantity;
  final String? unit;

  /// What this input is: 'barcode' (a material), 'sheet' (a vendor sheet tag)
  /// or 'quantity' (an amount of an item with no barcode behind it). The
  /// server sends it; older rows without it are materials.
  final String sourceKind;

  /// The whole weight of a vendor sheet. [quantity] is how much of it was used,
  /// once someone has said the sheet was only part-used.
  final double? sheetWeight;

  bool get isSheet => sourceKind == 'sheet';

  factory BarcodeInput.fromJson(Map<String, dynamic> json) {
    return BarcodeInput(
      barcode: json['barcode'] as String? ?? '',
      materialName: json['materialName'] as String? ?? '',
      materialType: json['materialType'] as String? ?? '',
      scanCount: json['scanCount'] as int? ?? 0,
      quantity: (json['quantity'] as num?)?.toDouble(),
      unit: json['unit'] as String?,
      sourceKind: json['sourceKind'] as String? ?? 'barcode',
      sheetWeight: (json['sheetWeight'] as num?)?.toDouble(),
    );
  }

  factory BarcodeInput.fromMaterialRecord(MaterialRecord record, {double? quantity}) {
    return BarcodeInput(
      barcode: record.barcode,
      materialName: record.name,
      materialType: record.type,
      scanCount: record.scanCount,
      quantity: quantity,
      unit: record.unit,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'barcode': barcode,
      'materialName': materialName,
      'materialType': materialType,
      'scanCount': scanCount,
      if (quantity != null) 'quantity': quantity,
      if (unit != null) 'unit': unit,
      'sourceKind': sourceKind,
      if (sheetWeight != null) 'sheetWeight': sheetWeight,
    };
  }
}

