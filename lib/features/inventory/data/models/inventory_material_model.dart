import 'dart:convert';

import '../../domain/material_record.dart';

class InventoryMaterialModel {
  const InventoryMaterialModel({
    required this.id,
    required this.barcode,
    required this.name,
    required this.type,
    required this.grade,
    required this.thickness,
    required this.supplier,
    required this.location,
    required this.unitId,
    required this.unit,
    required this.notes,
    required this.groupMode,
    required this.inheritanceEnabled,
    required this.createdAt,
    required this.kind,
    required this.parentBarcode,
    required this.numberOfChildren,
    required this.linkedChildBarcodes,
    required this.scanCount,
    required this.linkedGroupId,
    required this.linkedItemId,
    required this.displayStock,
    required this.createdBy,
    required this.workflowStatus,
    required this.updatedAt,
    required this.lastScannedAt,
  });

  final int? id;
  final String barcode;
  final String name;
  final String type;
  final String grade;
  final String thickness;
  final String supplier;
  final String location;
  final int? unitId;
  final String unit;
  final String notes;
  final String? groupMode;
  final bool inheritanceEnabled;
  final DateTime createdAt;
  final String kind;
  final String? parentBarcode;
  final int numberOfChildren;
  final List<String> linkedChildBarcodes;
  final int scanCount;
  final int? linkedGroupId;
  final int? linkedItemId;
  final String displayStock;
  final String createdBy;
  final String workflowStatus;
  final DateTime updatedAt;
  final DateTime? lastScannedAt;

  factory InventoryMaterialModel.fromMap(Map<String, Object?> map) {
    final rawLinked = map['linked_child_barcodes'] as String?;
    return InventoryMaterialModel(
      id: map['id'] as int?,
      barcode: map['barcode'] as String,
      name: map['name'] as String,
      type: map['type'] as String,
      grade: map['grade'] as String? ?? '',
      thickness: map['thickness'] as String? ?? '',
      supplier: map['supplier'] as String? ?? '',
      location: map['location'] as String? ?? '',
      unitId: map['unit_id'] as int?,
      unit: map['unit'] as String? ?? '',
      notes: map['notes'] as String? ?? '',
      groupMode: map['group_mode'] as String?,
      inheritanceEnabled: (map['inheritance_enabled'] as int? ?? 0) == 1,
      createdAt: DateTime.parse(map['created_at'] as String),
      kind: map['kind'] as String,
      parentBarcode: map['parent_barcode'] as String?,
      numberOfChildren: (map['number_of_children'] as int?) ?? 0,
      linkedChildBarcodes: rawLinked == null || rawLinked.isEmpty
          ? const []
          : List<String>.from(jsonDecode(rawLinked) as List<dynamic>),
      scanCount: (map['scan_count'] as int?) ?? 0,
      linkedGroupId: map['linked_group_id'] as int?,
      linkedItemId: map['linked_item_id'] as int?,
      displayStock: map['display_stock'] as String? ?? '',
      createdBy: map['created_by'] as String? ?? '',
      workflowStatus: map['workflow_status'] as String? ?? 'notStarted',
      updatedAt:
          DateTime.tryParse(map['updated_at'] as String? ?? '') ??
          DateTime.parse(map['created_at'] as String),
      lastScannedAt: DateTime.tryParse(map['last_scanned_at'] as String? ?? ''),
    );
  }

  Map<String, Object?> toMap() {
    return {
      'id': id,
      'barcode': barcode,
      'name': name,
      'type': type,
      'grade': grade,
      'thickness': thickness,
      'supplier': supplier,
      'location': location,
      'unit_id': unitId,
      'unit': unit,
      'notes': notes,
      'group_mode': groupMode,
      'inheritance_enabled': inheritanceEnabled ? 1 : 0,
      'created_at': createdAt.toIso8601String(),
      'kind': kind,
      'parent_barcode': parentBarcode,
      'number_of_children': numberOfChildren,
      'linked_child_barcodes': jsonEncode(linkedChildBarcodes),
      'scan_count': scanCount,
      'linked_group_id': linkedGroupId,
      'linked_item_id': linkedItemId,
      'display_stock': displayStock,
      'created_by': createdBy,
      'workflow_status': workflowStatus,
      'updated_at': updatedAt.toIso8601String(),
      'last_scanned_at': lastScannedAt?.toIso8601String(),
    };
  }

  MaterialRecord toRecord() {
    return MaterialRecord(
      id: id,
      barcode: barcode,
      name: name,
      type: type,
      grade: grade,
      thickness: thickness,
      supplier: supplier,
      location: location,
      unitId: unitId,
      unit: unit,
      notes: notes,
      groupMode: groupMode,
      inheritanceEnabled: inheritanceEnabled,
      createdAt: createdAt,
      kind: kind,
      parentBarcode: parentBarcode,
      numberOfChildren: numberOfChildren,
      linkedChildBarcodes: linkedChildBarcodes,
      scanCount: scanCount,
      linkedGroupId: linkedGroupId,
      linkedItemId: linkedItemId,
      displayStock: displayStock,
      createdBy: createdBy,
      workflowStatus: workflowStatus,
      updatedAt: updatedAt,
      lastScannedAt: lastScannedAt,
    );
  }
}
