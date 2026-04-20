enum GroupPropertySourceType { manual, inheritedItem }

enum GroupPropertyState { active, unlinked, overridden }

class GroupPropertySource {
  const GroupPropertySource({required this.itemId, this.itemName});

  final int itemId;
  final String? itemName;
}

class GroupPropertyDraft {
  const GroupPropertyDraft({
    required this.name,
    required this.inputType,
    required this.mandatory,
    this.sourceType = GroupPropertySourceType.manual,
    this.state = GroupPropertyState.active,
    this.sources = const <GroupPropertySource>[],
    this.overrideLocked = false,
    this.hasTypeConflict = false,
    this.coverageCount = 0,
    this.selectedItemCountAtResolution = 0,
    this.resolutionSource,
  });

  final String name;
  final String inputType;
  final bool mandatory;
  final GroupPropertySourceType sourceType;
  final GroupPropertyState state;
  final List<GroupPropertySource> sources;
  final bool overrideLocked;
  final bool hasTypeConflict;
  final int coverageCount;
  final int selectedItemCountAtResolution;
  final String? resolutionSource;

  GroupPropertyDraft copyWith({
    String? name,
    String? inputType,
    bool? mandatory,
    GroupPropertySourceType? sourceType,
    GroupPropertyState? state,
    List<GroupPropertySource>? sources,
    bool? overrideLocked,
    bool? hasTypeConflict,
    int? coverageCount,
    int? selectedItemCountAtResolution,
    String? resolutionSource,
  }) {
    return GroupPropertyDraft(
      name: name ?? this.name,
      inputType: inputType ?? this.inputType,
      mandatory: mandatory ?? this.mandatory,
      sourceType: sourceType ?? this.sourceType,
      state: state ?? this.state,
      sources: sources ?? this.sources,
      overrideLocked: overrideLocked ?? this.overrideLocked,
      hasTypeConflict: hasTypeConflict ?? this.hasTypeConflict,
      coverageCount: coverageCount ?? this.coverageCount,
      selectedItemCountAtResolution:
          selectedItemCountAtResolution ?? this.selectedItemCountAtResolution,
      resolutionSource: resolutionSource ?? this.resolutionSource,
    );
  }
}
