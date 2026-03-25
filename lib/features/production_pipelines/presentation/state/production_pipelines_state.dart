import '../../domain/models/aging_row.dart';

class ProductionPipelinesState {
  static const Object _noChange = Object();

  const ProductionPipelinesState({
    required this.selectedSidebarKey,
    required this.selectedFilters,
    required this.selectedRowIds,
    required this.selectedSummaryCardId,
    required this.sortBy,
    required this.sortAscending,
    required this.summaryCards,
    required this.rows,
  });

  final String selectedSidebarKey;
  final Map<String, String> selectedFilters;
  final Set<String> selectedRowIds;
  final String? selectedSummaryCardId;
  final String sortBy;
  final bool sortAscending;
  final List<SummaryMetric> summaryCards;
  final List<AgingRow> rows;

  ProductionPipelinesState copyWith({
    String? selectedSidebarKey,
    Map<String, String>? selectedFilters,
    Set<String>? selectedRowIds,
    Object? selectedSummaryCardId = _noChange,
    String? sortBy,
    bool? sortAscending,
    List<SummaryMetric>? summaryCards,
    List<AgingRow>? rows,
  }) {
    return ProductionPipelinesState(
      selectedSidebarKey: selectedSidebarKey ?? this.selectedSidebarKey,
      selectedFilters: selectedFilters ?? this.selectedFilters,
      selectedRowIds: selectedRowIds ?? this.selectedRowIds,
      selectedSummaryCardId: identical(selectedSummaryCardId, _noChange)
          ? this.selectedSummaryCardId
          : selectedSummaryCardId as String?,
      sortBy: sortBy ?? this.sortBy,
      sortAscending: sortAscending ?? this.sortAscending,
      summaryCards: summaryCards ?? this.summaryCards,
      rows: rows ?? this.rows,
    );
  }
}
