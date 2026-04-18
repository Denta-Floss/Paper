import 'group_property_draft.dart';

class MaterialGroupConfiguration {
  const MaterialGroupConfiguration({
    this.inheritanceEnabled = false,
    this.selectedItemIds = const <int>[],
    this.propertyDrafts = const <GroupPropertyDraft>[],
  });

  final bool inheritanceEnabled;
  final List<int> selectedItemIds;
  final List<GroupPropertyDraft> propertyDrafts;
}
