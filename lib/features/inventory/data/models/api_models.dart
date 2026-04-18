import 'dart:convert';

import '../../domain/create_parent_material_input.dart';
import '../../domain/group_property_draft.dart';
import '../../domain/material_activity_event.dart';
import '../../domain/material_group_configuration.dart';
import '../../domain/material_record.dart';

class MaterialDto {
  const MaterialDto({
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
    required this.isParent,
    required this.parentBarcode,
    required this.numberOfChildren,
    required this.linkedChildBarcodes,
    required this.scanCount,
    required this.createdAt,
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
  final bool isParent;
  final String? parentBarcode;
  final int numberOfChildren;
  final List<String> linkedChildBarcodes;
  final int scanCount;
  final DateTime createdAt;
  final int? linkedGroupId;
  final int? linkedItemId;
  final String displayStock;
  final String createdBy;
  final String workflowStatus;
  final DateTime updatedAt;
  final DateTime? lastScannedAt;

  factory MaterialDto.fromJson(Map<String, dynamic> json) {
    final rawChildren = json['linkedChildBarcodes'];
    final parsedChildren = rawChildren is String
        ? List<String>.from(jsonDecode(rawChildren) as List<dynamic>)
        : List<String>.from((rawChildren as List<dynamic>? ?? const []));

    return MaterialDto(
      id: json['id'] as int?,
      barcode: json['barcode'] as String,
      name: json['name'] as String,
      type: json['type'] as String,
      grade: json['grade'] as String? ?? '',
      thickness: json['thickness'] as String? ?? '',
      supplier: json['supplier'] as String? ?? '',
      location: json['location'] as String? ?? '',
      unitId: json['unitId'] as int?,
      unit: json['unit'] as String? ?? '',
      notes: json['notes'] as String? ?? '',
      groupMode: json['groupMode'] as String?,
      inheritanceEnabled: json['inheritanceEnabled'] as bool? ?? false,
      isParent: json['isParent'] as bool? ?? false,
      parentBarcode: json['parentBarcode'] as String?,
      numberOfChildren: json['numberOfChildren'] as int? ?? 0,
      linkedChildBarcodes: parsedChildren,
      scanCount: json['scanCount'] as int? ?? 0,
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.now(),
      linkedGroupId: json['linkedGroupId'] as int?,
      linkedItemId: json['linkedItemId'] as int?,
      displayStock: json['displayStock'] as String? ?? '',
      createdBy: json['createdBy'] as String? ?? '',
      workflowStatus: json['workflowStatus'] as String? ?? 'notStarted',
      updatedAt:
          DateTime.tryParse(json['updatedAt'] as String? ?? '') ??
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.now(),
      lastScannedAt: DateTime.tryParse(json['lastScannedAt'] as String? ?? ''),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'barcode': barcode,
      'name': name,
      'type': type,
      'grade': grade,
      'thickness': thickness,
      'supplier': supplier,
      'location': location,
      'unitId': unitId,
      'unit': unit,
      'notes': notes,
      'groupMode': groupMode,
      'inheritanceEnabled': inheritanceEnabled,
      'isParent': isParent,
      'parentBarcode': parentBarcode,
      'numberOfChildren': numberOfChildren,
      'linkedChildBarcodes': linkedChildBarcodes,
      'scanCount': scanCount,
      'createdAt': createdAt.toIso8601String(),
      'linkedGroupId': linkedGroupId,
      'linkedItemId': linkedItemId,
      'displayStock': displayStock,
      'createdBy': createdBy,
      'workflowStatus': workflowStatus,
      'updatedAt': updatedAt.toIso8601String(),
      'lastScannedAt': lastScannedAt?.toIso8601String(),
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
      kind: isParent ? 'parent' : 'child',
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

  factory MaterialDto.fromRecord(MaterialRecord record) {
    return MaterialDto(
      id: record.id,
      barcode: record.barcode,
      name: record.name,
      type: record.type,
      grade: record.grade,
      thickness: record.thickness,
      supplier: record.supplier,
      location: record.location,
      unitId: record.unitId,
      unit: record.unit,
      notes: record.notes,
      groupMode: record.groupMode,
      inheritanceEnabled: record.inheritanceEnabled,
      isParent: record.isParent,
      parentBarcode: record.parentBarcode,
      numberOfChildren: record.numberOfChildren,
      linkedChildBarcodes: record.linkedChildBarcodes,
      scanCount: record.scanCount,
      createdAt: record.createdAt,
      linkedGroupId: record.linkedGroupId,
      linkedItemId: record.linkedItemId,
      displayStock: record.displayStock,
      createdBy: record.createdBy,
      workflowStatus: record.workflowStatus,
      updatedAt: record.updatedAt,
      lastScannedAt: record.lastScannedAt,
    );
  }
}

class CreateParentRequest {
  const CreateParentRequest({
    required this.name,
    required this.type,
    required this.grade,
    required this.thickness,
    required this.supplier,
    required this.location,
    required this.unitId,
    required this.unit,
    required this.groupMode,
    required this.inheritanceEnabled,
    required this.selectedItemIds,
    required this.propertyDrafts,
    required this.notes,
    required this.numberOfChildren,
  });

  final String name;
  final String type;
  final String grade;
  final String thickness;
  final String supplier;
  final String location;
  final int? unitId;
  final String unit;
  final String? groupMode;
  final bool inheritanceEnabled;
  final List<int> selectedItemIds;
  final List<GroupPropertyDraftDto> propertyDrafts;
  final String notes;
  final int numberOfChildren;

  factory CreateParentRequest.fromInput(CreateParentMaterialInput input) {
    return CreateParentRequest(
      name: input.name,
      type: input.type,
      grade: input.grade,
      thickness: input.thickness,
      supplier: input.supplier,
      location: input.location,
      unitId: input.unitId,
      unit: input.unit,
      groupMode: input.groupMode,
      inheritanceEnabled: input.inheritanceEnabled,
      selectedItemIds: input.selectedItemIds,
      propertyDrafts: input.propertyDrafts
          .map(GroupPropertyDraftDto.fromDomain)
          .toList(growable: false),
      notes: input.notes,
      numberOfChildren: input.numberOfChildren,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'type': type,
      'grade': grade,
      'thickness': thickness,
      'supplier': supplier,
      'location': location,
      'unitId': unitId,
      'unit': unit,
      'groupMode': groupMode,
      'inheritanceEnabled': inheritanceEnabled,
      'selectedItemIds': selectedItemIds,
      'propertyDrafts': propertyDrafts
          .map((propertyDraft) => propertyDraft.toJson())
          .toList(growable: false),
      'notes': notes,
      'numberOfChildren': numberOfChildren,
    };
  }
}

class GroupPropertySourceDto {
  const GroupPropertySourceDto({required this.itemId, this.itemName});

  final int itemId;
  final String? itemName;

  factory GroupPropertySourceDto.fromJson(Map<String, dynamic> json) {
    return GroupPropertySourceDto(
      itemId: json['itemId'] as int? ?? 0,
      itemName: json['itemName'] as String?,
    );
  }

  factory GroupPropertySourceDto.fromDomain(GroupPropertySource source) {
    return GroupPropertySourceDto(
      itemId: source.itemId,
      itemName: source.itemName,
    );
  }

  GroupPropertySource toDomain() {
    return GroupPropertySource(itemId: itemId, itemName: itemName);
  }

  Map<String, dynamic> toJson() {
    return {'itemId': itemId, 'itemName': itemName};
  }
}

class GroupPropertyDraftDto {
  const GroupPropertyDraftDto({
    required this.name,
    required this.inputType,
    required this.mandatory,
    required this.sourceType,
    required this.state,
    required this.sources,
    required this.overrideLocked,
    required this.hasTypeConflict,
  });

  final String name;
  final String inputType;
  final bool mandatory;
  final String sourceType;
  final String state;
  final List<GroupPropertySourceDto> sources;
  final bool overrideLocked;
  final bool hasTypeConflict;

  factory GroupPropertyDraftDto.fromJson(Map<String, dynamic> json) {
    return GroupPropertyDraftDto(
      name: json['name'] as String? ?? '',
      inputType: json['inputType'] as String? ?? 'Text',
      mandatory: json['mandatory'] as bool? ?? false,
      sourceType: json['sourceType'] as String? ?? 'manual',
      state: json['state'] as String? ?? 'active',
      sources: (json['sources'] as List<dynamic>? ?? const [])
          .map(
            (item) =>
                GroupPropertySourceDto.fromJson(item as Map<String, dynamic>),
          )
          .toList(growable: false),
      overrideLocked: json['overrideLocked'] as bool? ?? false,
      hasTypeConflict: json['hasTypeConflict'] as bool? ?? false,
    );
  }

  factory GroupPropertyDraftDto.fromDomain(GroupPropertyDraft draft) {
    return GroupPropertyDraftDto(
      name: draft.name,
      inputType: draft.inputType,
      mandatory: draft.mandatory,
      sourceType: _sourceTypeToWire(draft.sourceType),
      state: _stateToWire(draft.state),
      sources: draft.sources
          .map(GroupPropertySourceDto.fromDomain)
          .toList(growable: false),
      overrideLocked: draft.overrideLocked,
      hasTypeConflict: draft.hasTypeConflict,
    );
  }

  GroupPropertyDraft toDomain() {
    return GroupPropertyDraft(
      name: name,
      inputType: inputType,
      mandatory: mandatory,
      sourceType: _sourceTypeFromWire(sourceType),
      state: _stateFromWire(state),
      sources: sources
          .map((source) => source.toDomain())
          .toList(growable: false),
      overrideLocked: overrideLocked,
      hasTypeConflict: hasTypeConflict,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'inputType': inputType,
      'mandatory': mandatory,
      'sourceType': sourceType,
      'state': state,
      'sources': sources
          .map((source) => source.toJson())
          .toList(growable: false),
      'overrideLocked': overrideLocked,
      'hasTypeConflict': hasTypeConflict,
    };
  }

  static GroupPropertySourceType _sourceTypeFromWire(String value) {
    switch (value) {
      case 'inherited_item':
        return GroupPropertySourceType.inheritedItem;
      default:
        return GroupPropertySourceType.manual;
    }
  }

  static String _sourceTypeToWire(GroupPropertySourceType value) {
    switch (value) {
      case GroupPropertySourceType.inheritedItem:
        return 'inherited_item';
      case GroupPropertySourceType.manual:
        return 'manual';
    }
  }

  static GroupPropertyState _stateFromWire(String value) {
    switch (value) {
      case 'unlinked':
        return GroupPropertyState.unlinked;
      case 'overridden':
        return GroupPropertyState.overridden;
      default:
        return GroupPropertyState.active;
    }
  }

  static String _stateToWire(GroupPropertyState value) {
    switch (value) {
      case GroupPropertyState.active:
        return 'active';
      case GroupPropertyState.unlinked:
        return 'unlinked';
      case GroupPropertyState.overridden:
        return 'overridden';
    }
  }
}

class MaterialResponse {
  const MaterialResponse({
    required this.success,
    this.material,
    this.groupConfiguration,
    this.error,
  });

  final bool success;
  final MaterialDto? material;
  final MaterialGroupConfigurationDto? groupConfiguration;
  final String? error;

  factory MaterialResponse.fromJson(Map<String, dynamic> json) {
    return MaterialResponse(
      success: json['success'] as bool? ?? false,
      material: json['material'] == null
          ? null
          : MaterialDto.fromJson(json['material'] as Map<String, dynamic>),
      groupConfiguration: json['groupConfiguration'] == null
          ? null
          : MaterialGroupConfigurationDto.fromJson(
              json['groupConfiguration'] as Map<String, dynamic>,
            ),
      error: json['error'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'success': success,
      'material': material?.toJson(),
      'groupConfiguration': groupConfiguration?.toJson(),
      'error': error,
    };
  }
}

class MaterialGroupConfigurationDto {
  const MaterialGroupConfigurationDto({
    required this.selectedItemIds,
    required this.propertyDrafts,
  });

  final List<int> selectedItemIds;
  final List<GroupPropertyDraftDto> propertyDrafts;

  factory MaterialGroupConfigurationDto.fromJson(Map<String, dynamic> json) {
    return MaterialGroupConfigurationDto(
      selectedItemIds: (json['selectedItemIds'] as List<dynamic>? ?? const [])
          .map((id) => (id as num).toInt())
          .toList(growable: false),
      propertyDrafts: (json['propertyDrafts'] as List<dynamic>? ?? const [])
          .map(
            (item) =>
                GroupPropertyDraftDto.fromJson(item as Map<String, dynamic>),
          )
          .toList(growable: false),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'selectedItemIds': selectedItemIds,
      'propertyDrafts': propertyDrafts
          .map((draft) => draft.toJson())
          .toList(growable: false),
    };
  }

  MaterialGroupConfiguration toDomain({required bool inheritanceEnabled}) {
    return MaterialGroupConfiguration(
      inheritanceEnabled: inheritanceEnabled,
      selectedItemIds: selectedItemIds,
      propertyDrafts: propertyDrafts
          .map((draft) => draft.toDomain())
          .toList(growable: false),
    );
  }
}

class MaterialsListResponse {
  const MaterialsListResponse({required this.success, required this.materials});

  final bool success;
  final List<MaterialDto> materials;

  factory MaterialsListResponse.fromJson(Map<String, dynamic> json) {
    return MaterialsListResponse(
      success: json['success'] as bool? ?? false,
      materials: (json['materials'] as List<dynamic>? ?? const [])
          .map((item) => MaterialDto.fromJson(item as Map<String, dynamic>))
          .toList(growable: false),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'success': success,
      'materials': materials.map((material) => material.toJson()).toList(),
    };
  }
}

class MaterialActivityEventDto {
  const MaterialActivityEventDto({
    required this.id,
    required this.barcode,
    required this.type,
    required this.label,
    required this.description,
    required this.actor,
    required this.createdAt,
  });

  final int? id;
  final String barcode;
  final String type;
  final String label;
  final String description;
  final String actor;
  final DateTime createdAt;

  factory MaterialActivityEventDto.fromJson(Map<String, dynamic> json) {
    return MaterialActivityEventDto(
      id: json['id'] as int?,
      barcode: json['barcode'] as String? ?? '',
      type: json['type'] as String? ?? '',
      label: json['label'] as String? ?? '',
      description: json['description'] as String? ?? '',
      actor: json['actor'] as String? ?? '',
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.now(),
    );
  }

  MaterialActivityEvent toEvent() {
    return MaterialActivityEvent(
      id: id,
      barcode: barcode,
      type: type,
      label: label,
      description: description,
      actor: actor,
      createdAt: createdAt,
    );
  }
}

class MaterialActivityListResponse {
  const MaterialActivityListResponse({
    required this.success,
    required this.events,
    this.error,
  });

  final bool success;
  final List<MaterialActivityEventDto> events;
  final String? error;

  factory MaterialActivityListResponse.fromJson(Map<String, dynamic> json) {
    return MaterialActivityListResponse(
      success: json['success'] as bool? ?? false,
      events: (json['events'] as List<dynamic>? ?? const [])
          .map(
            (item) =>
                MaterialActivityEventDto.fromJson(item as Map<String, dynamic>),
          )
          .toList(growable: false),
      error: json['error'] as String?,
    );
  }
}
