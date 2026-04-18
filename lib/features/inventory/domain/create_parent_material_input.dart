import 'group_property_draft.dart';

class CreateParentMaterialInput {
  const CreateParentMaterialInput({
    required this.name,
    required this.type,
    required this.grade,
    required this.thickness,
    required this.supplier,
    required this.numberOfChildren,
    this.unitId,
    this.unit = '',
    this.location = '',
    this.groupMode,
    this.inheritanceEnabled = false,
    this.selectedItemIds = const <int>[],
    this.propertyDrafts = const <GroupPropertyDraft>[],
    this.notes = '',
  });

  final String name;
  final String type;
  final String grade;
  final String thickness;
  final String supplier;
  final int numberOfChildren;
  final int? unitId;
  final String unit;
  final String location;
  final String? groupMode;
  final bool inheritanceEnabled;
  final List<int> selectedItemIds;
  final List<GroupPropertyDraft> propertyDrafts;
  final String notes;
}
