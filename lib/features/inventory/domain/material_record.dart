class MaterialRecord {
  const MaterialRecord({
    required this.id,
    required this.barcode,
    required this.name,
    required this.type,
    required this.grade,
    required this.thickness,
    required this.supplier,
    this.location = '',
    this.unitId,
    this.unit = '',
    this.notes = '',
    this.groupMode,
    this.inheritanceEnabled = false,
    required this.createdAt,
    required this.kind,
    required this.parentBarcode,
    required this.numberOfChildren,
    required this.linkedChildBarcodes,
    required this.scanCount,
    this.linkedGroupId,
    this.linkedItemId,
    this.displayStock = '',
    this.createdBy = '',
    this.workflowStatus = 'notStarted',
    DateTime? updatedAt,
    this.lastScannedAt,
  }) : updatedAt = updatedAt ?? createdAt;

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

  bool get isParent => kind == 'parent';
  bool get isChild => kind == 'child';
  bool get hasInheritanceLink => linkedGroupId != null || linkedItemId != null;
  bool get hasBeenScanned => scanCount > 0 || lastScannedAt != null;
}
