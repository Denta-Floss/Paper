import 'dart:io' show Platform;
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../../../core/widgets/app_button.dart';
import '../../../../core/widgets/app_empty_state.dart';
import '../../../../core/widgets/app_info_panel.dart';
import '../../../../core/widgets/app_section_title.dart';
import '../../../../core/widgets/searchable_select.dart';
import '../../../groups/presentation/providers/groups_provider.dart';
import '../../../items/presentation/providers/items_provider.dart';
import '../../../pm/presentation/barcode/material_barcode_toolkit.dart';
import '../../../pm/presentation/screens/pm_screen.dart';
import '../../../units/domain/unit_definition.dart';
import '../../../units/domain/unit_inputs.dart';
import '../../../units/presentation/providers/units_provider.dart';
import '../../domain/create_parent_material_input.dart';
import '../../domain/material_inputs.dart';
import '../../domain/material_record.dart';
import '../providers/inventory_provider.dart';

enum _InventoryViewMode { groups, items }

enum _InventorySummaryFilter { all, lowStock, criticalStock }

const _inventoryHoverColor = Color(0xFFF5F2FF);

class InventoryScreen extends StatefulWidget {
  const InventoryScreen({super.key});

  static bool get _isDesktopPlatform =>
      kIsWeb || Platform.isWindows || Platform.isMacOS || Platform.isLinux;

  static Future<T?> _showInventoryModal<T>(
    BuildContext context,
    Widget body,
  ) async {
    final isNarrow =
        MediaQuery.of(context).size.width < 800 || !_isDesktopPlatform;
    if (isNarrow) {
      return showModalBottomSheet<T>(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (context) => Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(context).viewInsets.bottom,
          ),
          child: body,
        ),
      );
    }

    return showDialog<T>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.symmetric(horizontal: 72, vertical: 48),
        backgroundColor: Colors.transparent,
        elevation: 0,
        child: body,
      ),
    );
  }

  static Future<void> openCreateGroupForm(BuildContext context) async {
    await _showInventoryModal<void>(context, const _AddMaterialForm());
  }

  static Future<void> openAddStockForm(BuildContext context) async {
    await _showInventoryModal<void>(context, const _AddStockForm());
  }

  @override
  State<InventoryScreen> createState() => _InventoryScreenState();
}

class _InventoryScreenState extends State<InventoryScreen> {
  final Set<String> _selectedBarcodes = <String>{};
  final Set<String> _expandedParents = <String>{};
  _InventoryViewMode _viewMode = _InventoryViewMode.groups;
  _InventorySummaryFilter _summaryFilter = _InventorySummaryFilter.all;
  String? _supplierFilter;
  String? _typeFilter;
  String? _kindFilter;
  bool _sortNewestFirst = true;

  @override
  Widget build(BuildContext context) {
    return Consumer3<InventoryProvider, GroupsProvider, ItemsProvider>(
      builder: (context, inventory, groups, items, _) {
        if (inventory.isLoading && inventory.materials.isEmpty) {
          return const Center(child: CircularProgressIndicator());
        }

        final records = inventory.materials;
        final suppliers = _distinctValues(
          records.map((record) => record.supplier),
        );
        final types = _distinctValues(records.map((record) => record.type));
        final filteredRecords = _applyFilters(records, inventory.searchQuery);
        final summary = _InventorySummary.fromRecords(filteredRecords);
        final rows = _buildRows(filteredRecords);

        _selectedBarcodes.removeWhere(
          (barcode) => !records.any((record) => record.barcode == barcode),
        );
        _expandedParents.removeWhere(
          (barcode) => !records.any((record) => record.barcode == barcode),
        );

        return Container(
          color: const Color(0xFFF5F6FA),
          padding: const EdgeInsets.fromLTRB(22, 14, 22, 22),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (inventory.errorMessage != null) ...[
                _ErrorBanner(message: inventory.errorMessage!),
                const SizedBox(height: 14),
              ],
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(0, 6, 0, 18),
                        child: Text(
                          'Inventory',
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(
                                fontSize: 18,
                                fontWeight: FontWeight.w500,
                                color: const Color(0xFF3F3F3F),
                              ),
                        ),
                      ),
                      _InventoryWorkspaceHeader(
                        viewMode: _viewMode,
                        onViewModeChanged: (value) {
                          setState(() {
                            _viewMode = value;
                          });
                        },
                        onNewGroup: () =>
                            InventoryScreen.openCreateGroupForm(context),
                        onAddStock: () =>
                            InventoryScreen.openAddStockForm(context),
                      ),
                      const SizedBox(height: 14),
                      _InventoryControlsRow(
                        supplierFilter: _supplierFilter,
                        typeFilter: _typeFilter,
                        kindFilter: _kindFilter,
                        suppliers: suppliers,
                        types: types,
                        selectedCount: _selectedBarcodes.length,
                        sortNewestFirst: _sortNewestFirst,
                        onSupplierSelected: (value) {
                          setState(() {
                            _supplierFilter = value;
                          });
                        },
                        onTypeSelected: (value) {
                          setState(() {
                            _typeFilter = value;
                          });
                        },
                        onKindSelected: (value) {
                          setState(() {
                            _kindFilter = value;
                          });
                        },
                        onClearSelection: () {
                          setState(_selectedBarcodes.clear);
                        },
                        onClearFilters: () {
                          setState(() {
                            _supplierFilter = null;
                            _typeFilter = null;
                            _kindFilter = null;
                          });
                        },
                        onToggleSort: () {
                          setState(() {
                            _sortNewestFirst = !_sortNewestFirst;
                          });
                        },
                      ),
                      const SizedBox(height: 14),
                      const Divider(height: 1, color: Color(0xFFE9E9EE)),
                      const SizedBox(height: 18),
                      _InventorySummaryRow(
                        summary: summary,
                        activeFilter: _summaryFilter,
                        onSelectFilter: (value) {
                          setState(() {
                            _summaryFilter = value;
                          });
                        },
                      ),
                      const SizedBox(height: 16),
                      Expanded(
                        child: _InventoryTable(
                          rows: rows,
                          viewMode: _viewMode,
                          groupsProvider: groups,
                          itemsProvider: items,
                          selectedBarcodes: _selectedBarcodes,
                          expandedParents: _expandedParents,
                          onToggleSelection: (barcode) {
                            setState(() {
                              if (_selectedBarcodes.contains(barcode)) {
                                _selectedBarcodes.remove(barcode);
                              } else {
                                _selectedBarcodes.add(barcode);
                              }
                            });
                          },
                          onToggleExpanded: (barcode) {
                            setState(() {
                              if (_expandedParents.contains(barcode)) {
                                _expandedParents.remove(barcode);
                              } else {
                                _expandedParents.add(barcode);
                              }
                            });
                          },
                          onOpenDetails: (record) => _openDetails(record),
                          onAddSubGroup: (record) => _openAddSubGroup(record),
                          onEdit: (record) => _openEditMaterial(record),
                          onDelete: (record) => _confirmDelete(record),
                          onLinkGroup: (record) => _openGroupLinker(record),
                          onLinkItem: (record) => _openItemLinker(record),
                          onUnlink: (record) => _unlinkInheritance(record),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  List<String> _distinctValues(Iterable<String> values) {
    final distinct =
        values
            .map((value) => value.trim())
            .where((value) => value.isNotEmpty)
            .toSet()
            .toList()
          ..sort();
    return distinct;
  }

  List<MaterialRecord> _applyFilters(
    List<MaterialRecord> records,
    String query,
  ) {
    final normalizedQuery = _normalize(query);
    final scoped = records
        .where((record) {
          if (_supplierFilter != null && record.supplier != _supplierFilter) {
            return false;
          }
          if (_typeFilter != null && record.type != _typeFilter) {
            return false;
          }
          if (_kindFilter != null && record.kind != _kindFilter) {
            return false;
          }
          if (normalizedQuery.isEmpty) {
            return true;
          }

          final haystack = <String>[
            record.name,
            record.barcode,
            record.type,
            record.grade,
            record.thickness,
            record.supplier,
            record.unit,
            record.notes,
            record.parentBarcode ?? '',
            record.displayStock,
            record.createdBy,
            record.workflowStatus,
          ].map(_normalize).join(' ');
          return haystack.contains(normalizedQuery);
        })
        .toList(growable: false);

    scoped.sort((a, b) {
      final timeCompare = a.createdAt.compareTo(b.createdAt);
      if (timeCompare != 0) {
        return _sortNewestFirst ? -timeCompare : timeCompare;
      }
      return a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });
    return scoped;
  }

  List<_InventoryRowEntry> _buildRows(List<MaterialRecord> scopedRecords) {
    if (_viewMode == _InventoryViewMode.items) {
      return scopedRecords
          .where(
            (record) =>
                (record.parentBarcode ?? '').isNotEmpty &&
                record.numberOfChildren == 0,
          )
          .map((record) => _InventoryRowEntry(record: record))
          .toList(growable: false);
    }

    final rows = <_InventoryRowEntry>[];
    final childrenByParent = <String, List<MaterialRecord>>{};
    for (final record in scopedRecords) {
      final parentBarcode = record.parentBarcode;
      if (parentBarcode == null || parentBarcode.isEmpty) {
        continue;
      }
      childrenByParent
          .putIfAbsent(parentBarcode, () => <MaterialRecord>[])
          .add(record);
    }

    final rootRecords = scopedRecords
        .where((record) => (record.parentBarcode ?? '').isEmpty)
        .toList(growable: false);
    for (final root in rootRecords) {
      rows.addAll(
        _buildTreeRows(root, depth: 0, childrenByParent: childrenByParent),
      );
    }

    return rows;
  }

  List<_InventoryRowEntry> _buildTreeRows(
    MaterialRecord record, {
    required int depth,
    required Map<String, List<MaterialRecord>> childrenByParent,
  }) {
    final children =
        childrenByParent[record.barcode]?.toList(growable: false) ?? const [];
    final isExpanded = _expandedParents.contains(record.barcode);
    final rows = <_InventoryRowEntry>[
      _InventoryRowEntry(
        record: record,
        depth: depth,
        canExpand: children.isNotEmpty,
        isExpanded: isExpanded,
      ),
    ];

    if (isExpanded) {
      for (final child in children) {
        rows.addAll(
          _buildTreeRows(
            child,
            depth: depth + 1,
            childrenByParent: childrenByParent,
          ),
        );
      }
    }

    return rows;
  }

  Future<void> _openDetails(MaterialRecord record) async {
    final provider = context.read<InventoryProvider>();
    await provider.selectMaterial(record.barcode);
    if (!mounted) {
      return;
    }

    await showGeneralDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'Inventory details',
      barrierColor: const Color(0x66100D1F),
      pageBuilder: (context, animation, secondaryAnimation) {
        return SafeArea(
          child: Align(
            alignment: Alignment.centerRight,
            child: Padding(
              padding: const EdgeInsets.only(top: 12, right: 12, bottom: 12),
              child: SizedBox(
                height: double.infinity,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxWidth: 520,
                    minWidth: 420,
                  ),
                  child: _InventoryDetailSheet(record: record),
                ),
              ),
            ),
          ),
        );
      },
      transitionDuration: const Duration(milliseconds: 220),
      transitionBuilder: (context, animation, secondaryAnimation, child) {
        final curved = CurvedAnimation(
          parent: animation,
          curve: Curves.easeOutCubic,
        );
        return SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0.08, 0),
            end: Offset.zero,
          ).animate(curved),
          child: FadeTransition(opacity: curved, child: child),
        );
      },
    );
  }

  Future<void> _openAddSubGroup(MaterialRecord record) async {
    if (!record.isParent) {
      return;
    }
    await showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: _AddChildMaterialSheet(parent: record),
        ),
      ),
    );
  }

  Future<void> _openEditMaterial(MaterialRecord record) async {
    await showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: _EditMaterialSheet(record: record),
        ),
      ),
    );
  }

  Future<void> _confirmDelete(MaterialRecord record) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(record.isParent ? 'Delete group?' : 'Delete item?'),
        content: Text(
          record.isParent
              ? 'This will remove ${record.name} and all of its linked child items.'
              : 'This will remove ${record.name} from inventory.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    await context.read<InventoryProvider>().deleteMaterial(record.barcode);
  }

  Future<void> _openGroupLinker(MaterialRecord record) async {
    await showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: _LinkGroupSheet(record: record),
        ),
      ),
    );
  }

  Future<void> _openItemLinker(MaterialRecord record) async {
    await showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: _LinkItemSheet(record: record),
        ),
      ),
    );
  }

  Future<void> _unlinkInheritance(MaterialRecord record) async {
    await context.read<InventoryProvider>().unlinkMaterial(record.barcode);
  }

  String _normalize(String value) {
    return value.trim().toLowerCase();
  }
}

class _InventoryWorkspaceHeader extends StatelessWidget {
  const _InventoryWorkspaceHeader({
    required this.viewMode,
    required this.onViewModeChanged,
    required this.onNewGroup,
    required this.onAddStock,
  });

  final _InventoryViewMode viewMode;
  final ValueChanged<_InventoryViewMode> onViewModeChanged;
  final VoidCallback onNewGroup;
  final VoidCallback onAddStock;

  @override
  Widget build(BuildContext context) {
    final segmented = PMFigmaSegmentedControl(
      value: viewMode == _InventoryViewMode.groups ? 'group' : 'item',
      onChanged: (value) {
        onViewModeChanged(
          value == 'group'
              ? _InventoryViewMode.groups
              : _InventoryViewMode.items,
        );
      },
    );

    final actions = Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        _InventoryToolbarButton(
          label: '+ New Group',
          onTap: onNewGroup,
          isPrimary: false,
        ),
        _InventoryToolbarButton(
          label: '+ Add Stock',
          onTap: onAddStock,
          isPrimary: true,
        ),
      ],
    );

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 860) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [segmented, const SizedBox(height: 12), actions],
          );
        }

        return Row(
          children: [
            Expanded(
              child: Align(alignment: Alignment.centerLeft, child: segmented),
            ),
            const SizedBox(width: 16),
            actions,
          ],
        );
      },
    );
  }
}

class _InventoryToolbarButton extends StatelessWidget {
  const _InventoryToolbarButton({
    required this.label,
    required this.onTap,
    required this.isPrimary,
  });

  final String label;
  final VoidCallback onTap;
  final bool isPrimary;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        hoverColor: _inventoryHoverColor,
        borderRadius: BorderRadius.circular(4),
        child: Ink(
          height: 38,
          padding: const EdgeInsets.symmetric(horizontal: 18),
          decoration: BoxDecoration(
            color: isPrimary ? const Color(0xFF6049E3) : Colors.white,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(
              color: isPrimary
                  ? const Color(0xFF6049E3)
                  : const Color(0xFF6049E3),
            ),
          ),
          child: Center(
            child: Text(
              label,
              style: TextStyle(
                color: isPrimary ? Colors.white : const Color(0xFF4F3CBC),
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _InventoryControlsRow extends StatelessWidget {
  const _InventoryControlsRow({
    required this.supplierFilter,
    required this.typeFilter,
    required this.kindFilter,
    required this.suppliers,
    required this.types,
    required this.selectedCount,
    required this.sortNewestFirst,
    required this.onSupplierSelected,
    required this.onTypeSelected,
    required this.onKindSelected,
    required this.onClearSelection,
    required this.onClearFilters,
    required this.onToggleSort,
  });

  final String? supplierFilter;
  final String? typeFilter;
  final String? kindFilter;
  final List<String> suppliers;
  final List<String> types;
  final int selectedCount;
  final bool sortNewestFirst;
  final ValueChanged<String?> onSupplierSelected;
  final ValueChanged<String?> onTypeSelected;
  final ValueChanged<String?> onKindSelected;
  final VoidCallback onClearSelection;
  final VoidCallback onClearFilters;
  final VoidCallback onToggleSort;

  @override
  Widget build(BuildContext context) {
    final filters = Wrap(
      spacing: 0,
      runSpacing: 8,
      children: [
        _InventoryFilterChipButton<String?>(
          label: 'Supplier',
          valueLabel: supplierFilter ?? 'All',
          isFirst: true,
          values: [
            const _MenuValue<String?>(value: null, label: 'All'),
            ...suppliers.map(
              (value) => _MenuValue<String?>(value: value, label: value),
            ),
          ],
          onSelected: onSupplierSelected,
        ),
        _InventoryFilterChipButton<String?>(
          label: 'Type',
          valueLabel: typeFilter ?? 'Any',
          values: [
            const _MenuValue<String?>(value: null, label: 'Any'),
            ...types.map(
              (value) => _MenuValue<String?>(value: value, label: value),
            ),
          ],
          onSelected: onTypeSelected,
        ),
        _InventoryFilterChipButton<String?>(
          label: 'Kind',
          valueLabel: switch (kindFilter) {
            'parent' => 'Groups',
            'child' => 'Items',
            _ => 'All',
          },
          isLast: true,
          values: const [
            _MenuValue<String?>(value: null, label: 'All'),
            _MenuValue<String?>(value: 'parent', label: 'Groups'),
            _MenuValue<String?>(value: 'child', label: 'Items'),
          ],
          onSelected: onKindSelected,
        ),
      ],
    );

    final trailing = Wrap(
      spacing: 10,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        if (selectedCount > 0) ...[
          Text(
            '$selectedCount Selected',
            style: const TextStyle(
              color: Color(0xFF5E6572),
              fontSize: 12,
              fontWeight: FontWeight.w500,
            ),
          ),
          InkWell(
            onTap: onClearSelection,
            hoverColor: _inventoryHoverColor,
            borderRadius: BorderRadius.circular(15),
            child: Container(
              width: 26,
              height: 26,
              decoration: BoxDecoration(
                color: const Color(0xFFF4F4F7),
                borderRadius: BorderRadius.circular(13),
              ),
              child: const Icon(
                Icons.close_rounded,
                size: 16,
                color: Color(0xFF6A6A6A),
              ),
            ),
          ),
        ],
        _ActionChip(
          label: sortNewestFirst ? 'Newest' : 'Oldest',
          icon: Icons.south_rounded,
          onTap: onToggleSort,
        ),
        _ActionChip(
          label: 'Clear Filters',
          icon: Icons.filter_alt_off_outlined,
          onTap: onClearFilters,
        ),
      ],
    );

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 980) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [filters, const SizedBox(height: 12), trailing],
          );
        }

        return Row(
          children: [
            Expanded(child: filters),
            const SizedBox(width: 12),
            trailing,
          ],
        );
      },
    );
  }
}

class _InventoryFilterChipButton<T> extends StatelessWidget {
  const _InventoryFilterChipButton({
    required this.label,
    required this.valueLabel,
    required this.values,
    required this.onSelected,
    this.isFirst = false,
    this.isLast = false,
  });

  final String label;
  final String valueLabel;
  final List<_MenuValue<T>> values;
  final ValueChanged<T> onSelected;
  final bool isFirst;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.horizontal(
        left: Radius.circular(isFirst ? 8 : 0),
        right: Radius.circular(isLast ? 8 : 0),
      ),
      onTap: () async {
        final selected = await showSearchableSelectDialog<T>(
          context: context,
          title: label,
          searchHintText: 'Search $label',
          options: values
              .map(
                (entry) => SearchableSelectOption<T>(
                  value: entry.value,
                  label: entry.label,
                ),
              )
              .toList(growable: false),
        );
        if (selected != null) {
          onSelected(selected.value);
        }
      },
      child: Container(
        height: 34,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border.all(color: const Color(0xFFD8DDE7)),
          borderRadius: BorderRadius.horizontal(
            left: Radius.circular(isFirst ? 8 : 0),
            right: Radius.circular(isLast ? 8 : 0),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (isFirst) ...[
              const Icon(
                Icons.filter_alt_outlined,
                size: 15,
                color: Color(0xFF6A7280),
              ),
              const SizedBox(width: 7),
            ],
            Text(
              '$label: ',
              style: const TextStyle(
                color: Color(0xFF5F6775),
                fontFamily: 'Segoe UI',
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
            Flexible(
              child: Text(
                valueLabel,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: Color(0xFF1C2632),
                  fontFamily: 'Segoe UI',
                  fontSize: 12,
                  fontWeight: FontWeight.w400,
                ),
              ),
            ),
            const SizedBox(width: 2),
            const Icon(
              Icons.keyboard_arrow_down_rounded,
              size: 16,
              color: Color(0xFF6A7280),
            ),
          ],
        ),
      ),
    );
  }
}

class _ActionChip extends StatelessWidget {
  const _ActionChip({
    required this.label,
    required this.icon,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        hoverColor: _inventoryHoverColor,
        borderRadius: BorderRadius.circular(8),
        child: Ink(
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: const Color(0xFFF5F6F8),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 16, color: const Color(0xFF6A7280)),
              const SizedBox(width: 7),
              Text(
                label,
                style: const TextStyle(
                  color: Color(0xFF4F5561),
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _InventorySummaryRow extends StatelessWidget {
  const _InventorySummaryRow({
    required this.summary,
    required this.activeFilter,
    required this.onSelectFilter,
  });

  final _InventorySummary summary;
  final _InventorySummaryFilter activeFilter;
  final ValueChanged<_InventorySummaryFilter> onSelectFilter;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final cardWidth = constraints.maxWidth >= 1160
            ? 308.0
            : constraints.maxWidth >= 980
            ? 280.0
            : constraints.maxWidth >= 760
            ? 240.0
            : constraints.maxWidth;
        return Align(
          alignment: Alignment.centerLeft,
          child: Wrap(
            spacing: 22,
            runSpacing: 12,
            children: [
              SizedBox(
                width: cardWidth,
                child: _SummaryCard(
                  label: 'All',
                  value: summary.total,
                  isActive: activeFilter == _InventorySummaryFilter.all,
                  onTap: () => onSelectFilter(_InventorySummaryFilter.all),
                ),
              ),
              SizedBox(
                width: cardWidth,
                child: _SummaryCard(
                  label: 'Low Stock',
                  value: summary.parents,
                  isActive: activeFilter == _InventorySummaryFilter.lowStock,
                  onTap: () => onSelectFilter(_InventorySummaryFilter.lowStock),
                ),
              ),
              SizedBox(
                width: cardWidth,
                child: _SummaryCard(
                  label: 'Critical Stock',
                  value: summary.children,
                  isActive:
                      activeFilter == _InventorySummaryFilter.criticalStock,
                  onTap: () =>
                      onSelectFilter(_InventorySummaryFilter.criticalStock),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _SummaryCard extends StatelessWidget {
  const _SummaryCard({
    required this.label,
    required this.value,
    required this.isActive,
    required this.onTap,
  });

  final String label;
  final int value;
  final bool isActive;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      hoverColor: _inventoryHoverColor,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        height: 66,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: BoxDecoration(
          color: isActive ? _inventoryHoverColor : Colors.white,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: isActive ? const Color(0xFF7B61FF) : const Color(0xFFE4E7EE),
            width: isActive ? 1.4 : 1,
          ),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: const TextStyle(
                  color: Color(0xFF474747),
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            Container(
              constraints: const BoxConstraints(minWidth: 72),
              height: 42,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: isActive
                    ? const Color(0xFFF5F2FF)
                    : const Color(0xFFFCFCFE),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                '$value',
                style: const TextStyle(
                  color: Color(0xFF303030),
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _InventoryTable extends StatefulWidget {
  const _InventoryTable({
    required this.rows,
    required this.viewMode,
    required this.groupsProvider,
    required this.itemsProvider,
    required this.selectedBarcodes,
    required this.expandedParents,
    required this.onToggleSelection,
    required this.onToggleExpanded,
    required this.onOpenDetails,
    required this.onAddSubGroup,
    required this.onEdit,
    required this.onDelete,
    required this.onLinkGroup,
    required this.onLinkItem,
    required this.onUnlink,
  });

  final List<_InventoryRowEntry> rows;
  final _InventoryViewMode viewMode;
  final GroupsProvider groupsProvider;
  final ItemsProvider itemsProvider;
  final Set<String> selectedBarcodes;
  final Set<String> expandedParents;
  final ValueChanged<String> onToggleSelection;
  final ValueChanged<String> onToggleExpanded;
  final ValueChanged<MaterialRecord> onOpenDetails;
  final ValueChanged<MaterialRecord> onAddSubGroup;
  final ValueChanged<MaterialRecord> onEdit;
  final ValueChanged<MaterialRecord> onDelete;
  final ValueChanged<MaterialRecord> onLinkGroup;
  final ValueChanged<MaterialRecord> onLinkItem;
  final ValueChanged<MaterialRecord> onUnlink;

  @override
  State<_InventoryTable> createState() => _InventoryTableState();
}

class _InventoryTableState extends State<_InventoryTable> {
  final ScrollController _horizontalController = ScrollController();
  final ScrollController _leftVerticalController = ScrollController();
  final ScrollController _rightVerticalController = ScrollController();
  bool _syncingLeft = false;
  bool _syncingRight = false;

  @override
  void initState() {
    super.initState();
    _leftVerticalController.addListener(_syncFromLeft);
    _rightVerticalController.addListener(_syncFromRight);
  }

  @override
  void dispose() {
    _leftVerticalController.removeListener(_syncFromLeft);
    _rightVerticalController.removeListener(_syncFromRight);
    _horizontalController.dispose();
    _leftVerticalController.dispose();
    _rightVerticalController.dispose();
    super.dispose();
  }

  void _syncFromLeft() {
    if (_syncingRight || !_rightVerticalController.hasClients) {
      return;
    }
    _syncingLeft = true;
    final offset = _leftVerticalController.offset.clamp(
      0.0,
      _rightVerticalController.position.maxScrollExtent,
    );
    if ((_rightVerticalController.offset - offset).abs() > 0.5) {
      _rightVerticalController.jumpTo(offset);
    }
    _syncingLeft = false;
  }

  void _syncFromRight() {
    if (_syncingLeft || !_leftVerticalController.hasClients) {
      return;
    }
    _syncingRight = true;
    final offset = _rightVerticalController.offset.clamp(
      0.0,
      _leftVerticalController.position.maxScrollExtent,
    );
    if ((_leftVerticalController.offset - offset).abs() > 0.5) {
      _leftVerticalController.jumpTo(offset);
    }
    _syncingRight = false;
  }

  @override
  Widget build(BuildContext context) {
    if (widget.rows.isEmpty) {
      return const AppEmptyState(
        title: 'No materials found',
        message:
            'Try a different search or filter, or create a new inventory group to populate this workspace.',
        icon: Icons.inventory_2_outlined,
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final metrics = _InventoryTableMetrics.fromViewportWidth(
          constraints.maxWidth,
        );
        final leftPaneWidth = math.max(
          0.0,
          constraints.maxWidth - metrics.actionsWidth - 6,
        );
        final dataTableWidth = math.max(metrics.dataWidth, leftPaneWidth);
        return Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SingleChildScrollView(
                    controller: _horizontalController,
                    scrollDirection: Axis.horizontal,
                    child: ConstrainedBox(
                      constraints: BoxConstraints(minWidth: leftPaneWidth),
                      child: SizedBox(
                        width: dataTableWidth,
                        child: _InventoryTableHeader(
                          viewMode: widget.viewMode,
                          metrics: metrics,
                          includeActions: false,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Expanded(
                    child: SingleChildScrollView(
                      controller: _horizontalController,
                      scrollDirection: Axis.horizontal,
                      child: ConstrainedBox(
                        constraints: BoxConstraints(minWidth: leftPaneWidth),
                        child: SizedBox(
                          width: dataTableWidth,
                          child: ListView.separated(
                            controller: _leftVerticalController,
                            itemCount: widget.rows.length,
                            separatorBuilder: (_, _) =>
                                const SizedBox(height: 0),
                            itemBuilder: (context, index) {
                              final entry = widget.rows[index];
                              final record = entry.record;
                              return _InventoryMainDataRow(
                                record: record,
                                entry: entry,
                                metrics: metrics,
                                isSelected: widget.selectedBarcodes.contains(
                                  record.barcode,
                                ),
                                isStriped: index.isOdd,
                                onTap: () => widget.onOpenDetails(record),
                                onLongPress: () =>
                                    widget.onToggleSelection(record.barcode),
                                onExpandToggle: entry.canExpand
                                    ? () => widget.onToggleExpanded(
                                        record.barcode,
                                      )
                                    : null,
                              );
                            },
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Container(
              width: metrics.actionsWidth,
              margin: const EdgeInsets.only(left: 6),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(10),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x14000000),
                    blurRadius: 10,
                    offset: Offset(-4, 0),
                  ),
                ],
              ),
              child: Column(
                children: [
                  _InventoryActionsHeader(metrics: metrics),
                  const SizedBox(height: 10),
                  Expanded(
                    child: ListView.separated(
                      controller: _rightVerticalController,
                      itemCount: widget.rows.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 0),
                      itemBuilder: (context, index) {
                        final entry = widget.rows[index];
                        final record = entry.record;
                        return _InventoryActionsCell(
                          record: record,
                          metrics: metrics,
                          isSelected: widget.selectedBarcodes.contains(
                            record.barcode,
                          ),
                          isStriped: index.isOdd,
                          onTap: () => widget.onOpenDetails(record),
                          onAddSubGroup: () => widget.onAddSubGroup(record),
                          onEdit: () => widget.onEdit(record),
                          onDelete: () => widget.onDelete(record),
                          onLinkGroup: () => widget.onLinkGroup(record),
                          onLinkItem: () => widget.onLinkItem(record),
                          onUnlink: () => widget.onUnlink(record),
                        );
                      },
                    ),
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

class _InventoryTableHeader extends StatelessWidget {
  const _InventoryTableHeader({
    required this.viewMode,
    required this.metrics,
    this.includeActions = true,
  });

  final _InventoryViewMode viewMode;
  final _InventoryTableMetrics metrics;
  final bool includeActions;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: metrics.headerHeight,
      padding: EdgeInsets.symmetric(horizontal: metrics.horizontalPadding),
      decoration: BoxDecoration(
        color: const Color(0xFFF5F2FF),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          _HeaderCell(
            viewMode == _InventoryViewMode.groups ? 'Group Name' : 'Item Name',
            width: metrics.nameWidth,
            metrics: metrics,
          ),
          _HeaderCell(
            'Group ID',
            width: metrics.barcodeWidth,
            metrics: metrics,
          ),
          _HeaderCell('Stock', width: metrics.stockWidth, metrics: metrics),
          _HeaderCell(
            'Created Date',
            width: metrics.dateWidth,
            metrics: metrics,
          ),
          _HeaderCell(
            'Created By',
            width: metrics.createdByWidth,
            metrics: metrics,
          ),
          _HeaderCell('Status', width: metrics.statusWidth, metrics: metrics),
          if (includeActions)
            _HeaderCell(
              'Actions',
              width: metrics.actionsWidth,
              metrics: metrics,
            ),
        ],
      ),
    );
  }
}

class _InventoryActionsHeader extends StatelessWidget {
  const _InventoryActionsHeader({required this.metrics});

  final _InventoryTableMetrics metrics;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: metrics.headerHeight,
      decoration: const BoxDecoration(
        color: Color(0xFFF6F4FF),
        borderRadius: BorderRadius.only(
          topLeft: Radius.circular(10),
          topRight: Radius.circular(10),
        ),
      ),
      alignment: Alignment.center,
      child: Text(
        'Actions',
        style: TextStyle(
          color: Color(0xFF3C3C3C),
          fontSize: metrics.headerFontSize,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _HeaderCell extends StatelessWidget {
  const _HeaderCell(this.label, {required this.width, required this.metrics});

  final String label;
  final double width;
  final _InventoryTableMetrics metrics;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      child: Text(
        label,
        style: _inventoryManropeStyle(
          color: const Color(0xFF454545),
          size: metrics.headerFontSize,
          weight: FontWeight.w500,
        ),
      ),
    );
  }
}

class _InventoryMainDataRow extends StatelessWidget {
  const _InventoryMainDataRow({
    required this.record,
    required this.entry,
    required this.metrics,
    required this.isSelected,
    required this.isStriped,
    required this.onTap,
    required this.onLongPress,
    this.onExpandToggle,
  });

  final MaterialRecord record;
  final _InventoryRowEntry entry;
  final _InventoryTableMetrics metrics;
  final bool isSelected;
  final bool isStriped;
  final VoidCallback onTap;
  final VoidCallback onLongPress;
  final VoidCallback? onExpandToggle;

  @override
  Widget build(BuildContext context) {
    final backgroundColor = isSelected
        ? _inventoryHoverColor
        : entry.depth == 0 && entry.isExpanded
        ? _inventoryHoverColor
        : isStriped
        ? const Color(0xFFF9F9F9)
        : Colors.white;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        hoverColor: _inventoryHoverColor,
        borderRadius: BorderRadius.circular(12),
        child: Ink(
          decoration: BoxDecoration(
            color: backgroundColor,
            border: entry.depth == 0 && entry.isExpanded
                ? Border.all(color: const Color(0xFFB9A9FF))
                : null,
            borderRadius: BorderRadius.circular(metrics.rowRadius),
          ),
          child: SizedBox(
            height: metrics.rowHeight,
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: metrics.horizontalPadding,
              ),
              child: Row(
                children: [
                  SizedBox(
                    width: metrics.nameWidth,
                    child: _InventoryNameCell(
                      record: record,
                      entry: entry,
                      metrics: metrics,
                      onExpandToggle: onExpandToggle,
                    ),
                  ),
                  _DataCell(
                    _displayGroupId(record),
                    width: metrics.barcodeWidth,
                    metrics: metrics,
                  ),
                  _DataCell(
                    _displayStock(record),
                    width: metrics.stockWidth,
                    metrics: metrics,
                  ),
                  _DataCell(
                    _formatDate(record.createdAt),
                    width: metrics.dateWidth,
                    metrics: metrics,
                  ),
                  _DataCell(
                    record.createdBy.ifEmpty('15-05-2026'),
                    width: metrics.createdByWidth,
                    metrics: metrics,
                  ),
                  SizedBox(
                    width: metrics.statusWidth,
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: _InventoryStatusBadge(
                        record: record,
                        metrics: metrics,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  String _formatDate(DateTime value) {
    final day = value.day.toString().padLeft(2, '0');
    final month = value.month.toString().padLeft(2, '0');
    return '$day-$month-${value.year}';
  }

  String _displayGroupId(MaterialRecord value) {
    if (value.barcode.startsWith('GRP-')) {
      return '123456';
    }
    return value.barcode;
  }

  String _displayStock(MaterialRecord value) {
    if (value.displayStock.trim().isNotEmpty) {
      return value.displayStock;
    }
    return '1000 Pieces';
  }
}

class _InventoryActionsCell extends StatelessWidget {
  const _InventoryActionsCell({
    required this.record,
    required this.metrics,
    required this.isSelected,
    required this.isStriped,
    required this.onTap,
    required this.onAddSubGroup,
    required this.onEdit,
    required this.onDelete,
    required this.onLinkGroup,
    required this.onLinkItem,
    required this.onUnlink,
  });

  final MaterialRecord record;
  final _InventoryTableMetrics metrics;
  final bool isSelected;
  final bool isStriped;
  final VoidCallback onTap;
  final VoidCallback onAddSubGroup;
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  final VoidCallback onLinkGroup;
  final VoidCallback onLinkItem;
  final VoidCallback onUnlink;

  @override
  Widget build(BuildContext context) {
    final backgroundColor = isSelected
        ? _inventoryHoverColor
        : isStriped
        ? const Color(0xFFF9F9F9)
        : Colors.white;

    return Container(
      height: metrics.rowHeight,
      color: backgroundColor,
      alignment: Alignment.center,
      child: _InventoryActionsOverlayAnchor(
        triggerSize: metrics.actionButtonSize,
        canAddSubGroup:
            record.numberOfChildren > 0 || (record.parentBarcode ?? '').isEmpty,
        onAddSubGroup: onAddSubGroup,
        onEdit: onEdit,
        onDelete: onDelete,
      ),
    );
  }
}

class _InventoryNameCell extends StatelessWidget {
  const _InventoryNameCell({
    required this.record,
    required this.entry,
    required this.metrics,
    this.onExpandToggle,
  });

  final MaterialRecord record;
  final _InventoryRowEntry entry;
  final _InventoryTableMetrics metrics;
  final VoidCallback? onExpandToggle;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        SizedBox(width: entry.depth * metrics.treeIndent),
        if (entry.canExpand)
          InkWell(
            onTap: onExpandToggle,
            hoverColor: _inventoryHoverColor,
            borderRadius: BorderRadius.circular(12),
            child: Icon(
              entry.isExpanded
                  ? Icons.keyboard_arrow_down_rounded
                  : Icons.keyboard_arrow_right_rounded,
              size: metrics.chevronSize,
              color: const Color(0xFF5A6271),
            ),
          )
        else
          SizedBox(width: metrics.chevronSize),
        SizedBox(width: metrics.nameGap),
        Expanded(
          child: Text(
            record.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: _inventoryManropeStyle(
              color: const Color(0xFF2F2F2F),
              size: metrics.bodyFontSize,
              weight: entry.depth == 0 ? FontWeight.w500 : FontWeight.w400,
            ),
          ),
        ),
      ],
    );
  }
}

class _DataCell extends StatelessWidget {
  const _DataCell(this.text, {required this.width, required this.metrics});

  final String text;
  final double width;
  final _InventoryTableMetrics metrics;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      child: Text(
        text,
        softWrap: false,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: _inventoryManropeStyle(
          color: const Color(0xFF3C3C3C),
          size: metrics.bodyFontSize,
          weight: FontWeight.w400,
        ),
      ),
    );
  }
}

class _InventoryStatusBadge extends StatelessWidget {
  const _InventoryStatusBadge({required this.record, required this.metrics});

  final MaterialRecord record;
  final _InventoryTableMetrics metrics;

  @override
  Widget build(BuildContext context) {
    final scheme = switch (_resolveState()) {
      _InventoryRecordState.notStarted => (
        bg: const Color(0xFFFDF5F0),
        border: const Color(0xFFF8DBB9),
        text: const Color(0xFF824C00),
        label: 'Not Started',
      ),
      _InventoryRecordState.inProgress => (
        bg: const Color(0xFFF0F6FD),
        border: const Color(0xFFB9CFF8),
        text: const Color(0xFF003BFB),
        label: 'In Progress',
      ),
      _InventoryRecordState.completed => (
        bg: const Color(0xFFF0FDF8),
        border: const Color(0xFFB9F8DF),
        text: const Color(0xFF007D30),
        label: 'Completed',
      ),
    };

    return FittedBox(
      fit: BoxFit.scaleDown,
      alignment: Alignment.centerLeft,
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: metrics.statusHorizontalPadding,
          vertical: metrics.statusVerticalPadding,
        ),
        decoration: BoxDecoration(
          color: scheme.bg,
          borderRadius: BorderRadius.circular(metrics.statusRadius),
          border: Border.all(color: scheme.border),
        ),
        child: Text(
          scheme.label,
          style: _inventoryInterStyle(
            color: scheme.text,
            size: metrics.statusFontSize,
            weight: FontWeight.w500,
          ),
        ),
      ),
    );
  }

  _InventoryRecordState _resolveState() {
    switch (record.workflowStatus) {
      case 'completed':
        return _InventoryRecordState.completed;
      case 'inProgress':
        return _InventoryRecordState.inProgress;
      default:
        return _InventoryRecordState.notStarted;
    }
  }
}

class _InventoryDetailSheet extends StatelessWidget {
  const _InventoryDetailSheet({required this.record});

  final MaterialRecord record;

  @override
  Widget build(BuildContext context) {
    final groups = context.watch<GroupsProvider>();
    final items = context.watch<ItemsProvider>();
    final linkedGroup = groups.findById(record.linkedGroupId);
    final linkedItem = items.items
        .where((item) => item.id == record.linkedItemId)
        .firstOrNull;

    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(16),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 18),
            decoration: const BoxDecoration(color: Color(0xFFFBFBFB)),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    record.name,
                    style: const TextStyle(
                      color: Color(0xFF3F3F3F),
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: AppInfoPanel(
                title: record.barcode,
                subtitle: record.isParent
                    ? 'Parent inventory group'
                    : 'Child inventory item',
                headerTrailing: BarcodeTraceBadge(scanCount: record.scanCount),
                rows: [
                  if (linkedGroup != null)
                    AppInfoRow(
                      label: 'Inherited group',
                      value: linkedGroup.name,
                    ),
                  if (linkedItem != null)
                    AppInfoRow(
                      label: 'Inherited item',
                      value: linkedItem.displayName,
                    ),
                  ...buildMaterialBarcodeInfoRows(
                    record,
                    includeBarcodeImage: InventoryScreen._isDesktopPlatform,
                  ),
                  if (record.isParent)
                    AppInfoRow(
                      label: 'Child barcodes',
                      child: Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: record.linkedChildBarcodes
                            .map((barcode) => _Badge(label: barcode))
                            .toList(growable: false),
                      ),
                    ),
                ],
                footer: Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    if (InventoryScreen._isDesktopPlatform)
                      ShowBarcodeButton(material: record),
                    if (kDebugMode)
                      AppButton(
                        label: 'Reset Trace',
                        icon: Icons.restore,
                        variant: AppButtonVariant.secondary,
                        onPressed: () {
                          context.read<InventoryProvider>().resetScanTrace(
                            record.barcode,
                          );
                          Navigator.of(context).pop();
                        },
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _InventorySummary {
  const _InventorySummary({
    required this.total,
    required this.parents,
    required this.children,
  });

  final int total;
  final int parents;
  final int children;

  factory _InventorySummary.fromRecords(List<MaterialRecord> records) {
    return _InventorySummary(
      total: records.length,
      parents: records
          .where((record) => record.workflowStatus == 'inProgress')
          .length,
      children: records
          .where((record) => record.workflowStatus == 'completed')
          .length,
    );
  }
}

class _InventoryRowEntry {
  const _InventoryRowEntry({
    required this.record,
    this.depth = 0,
    this.canExpand = false,
    this.isExpanded = false,
  });

  final MaterialRecord record;
  final int depth;
  final bool canExpand;
  final bool isExpanded;
}

class _InventoryTableMetrics {
  const _InventoryTableMetrics({
    required this.horizontalPadding,
    required this.nameWidth,
    required this.barcodeWidth,
    required this.stockWidth,
    required this.dateWidth,
    required this.createdByWidth,
    required this.statusWidth,
    required this.actionsWidth,
    required this.headerHeight,
    required this.rowHeight,
    required this.headerFontSize,
    required this.bodyFontSize,
    required this.statusFontSize,
    required this.treeIndent,
    required this.chevronSize,
    required this.nameGap,
    required this.rowRadius,
    required this.statusRadius,
    required this.statusHorizontalPadding,
    required this.statusVerticalPadding,
    required this.actionButtonSize,
  });

  factory _InventoryTableMetrics.fromViewportWidth(double width) {
    if (width < 1100) {
      return const _InventoryTableMetrics(
        horizontalPadding: 16,
        nameWidth: 220,
        barcodeWidth: 110,
        stockWidth: 128,
        dateWidth: 132,
        createdByWidth: 126,
        statusWidth: 120,
        actionsWidth: 64,
        headerHeight: 42,
        rowHeight: 50,
        headerFontSize: 12,
        bodyFontSize: 13,
        statusFontSize: 11,
        treeIndent: 18,
        chevronSize: 20,
        nameGap: 8,
        rowRadius: 10,
        statusRadius: 6,
        statusHorizontalPadding: 8,
        statusVerticalPadding: 4,
        actionButtonSize: 26,
      );
    }
    if (width < 1440) {
      return const _InventoryTableMetrics(
        horizontalPadding: 20,
        nameWidth: 270,
        barcodeWidth: 126,
        stockWidth: 150,
        dateWidth: 146,
        createdByWidth: 142,
        statusWidth: 138,
        actionsWidth: 72,
        headerHeight: 44,
        rowHeight: 53,
        headerFontSize: 13,
        bodyFontSize: 15,
        statusFontSize: 12,
        treeIndent: 22,
        chevronSize: 21,
        nameGap: 9,
        rowRadius: 11,
        statusRadius: 6,
        statusHorizontalPadding: 9,
        statusVerticalPadding: 5,
        actionButtonSize: 27,
      );
    }
    const base = _InventoryTableMetrics(
      horizontalPadding: 24,
      nameWidth: 320,
      barcodeWidth: 140,
      stockWidth: 170,
      dateWidth: 160,
      createdByWidth: 160,
      statusWidth: 156,
      actionsWidth: 78,
      headerHeight: 46,
      rowHeight: 55,
      headerFontSize: 14,
      bodyFontSize: 16,
      statusFontSize: 12,
      treeIndent: 24,
      chevronSize: 22,
      nameGap: 10,
      rowRadius: 12,
      statusRadius: 6,
      statusHorizontalPadding: 10,
      statusVerticalPadding: 5,
      actionButtonSize: 28,
    );

    final availableDataWidth = width - base.actionsWidth - 12;
    final extraWidth = availableDataWidth - base.dataWidth;
    if (extraWidth <= 24) {
      return base;
    }

    final distributedExtra = extraWidth.toDouble();
    return _InventoryTableMetrics(
      horizontalPadding: base.horizontalPadding + (distributedExtra * 0.01),
      nameWidth: base.nameWidth + (distributedExtra * 0.32),
      barcodeWidth: base.barcodeWidth + (distributedExtra * 0.10),
      stockWidth: base.stockWidth + (distributedExtra * 0.14),
      dateWidth: base.dateWidth + (distributedExtra * 0.16),
      createdByWidth: base.createdByWidth + (distributedExtra * 0.13),
      statusWidth: base.statusWidth + (distributedExtra * 0.13),
      actionsWidth: base.actionsWidth,
      headerHeight: base.headerHeight,
      rowHeight: base.rowHeight,
      headerFontSize: base.headerFontSize,
      bodyFontSize: base.bodyFontSize,
      statusFontSize: base.statusFontSize,
      treeIndent: base.treeIndent,
      chevronSize: base.chevronSize,
      nameGap: base.nameGap,
      rowRadius: base.rowRadius,
      statusRadius: base.statusRadius,
      statusHorizontalPadding: base.statusHorizontalPadding,
      statusVerticalPadding: base.statusVerticalPadding,
      actionButtonSize: base.actionButtonSize,
    );
  }

  final double horizontalPadding;
  final double nameWidth;
  final double barcodeWidth;
  final double stockWidth;
  final double dateWidth;
  final double createdByWidth;
  final double statusWidth;
  final double actionsWidth;
  final double headerHeight;
  final double rowHeight;
  final double headerFontSize;
  final double bodyFontSize;
  final double statusFontSize;
  final double treeIndent;
  final double chevronSize;
  final double nameGap;
  final double rowRadius;
  final double statusRadius;
  final double statusHorizontalPadding;
  final double statusVerticalPadding;
  final double actionButtonSize;

  double get dataWidth =>
      nameWidth +
      barcodeWidth +
      stockWidth +
      dateWidth +
      createdByWidth +
      statusWidth +
      4 +
      (horizontalPadding * 2);
}

enum _InventoryRecordState { notStarted, inProgress, completed }

class _ActionMenuLabel extends StatelessWidget {
  const _ActionMenuLabel({
    required this.icon,
    required this.label,
    this.isHighlighted = false,
    this.isDestructive = false,
  });

  final IconData icon;
  final String label;
  final bool isHighlighted;
  final bool isDestructive;

  @override
  Widget build(BuildContext context) {
    final iconColor = isDestructive
        ? const Color(0xFFFF5C5C)
        : isHighlighted
        ? const Color(0xFF7357FF)
        : const Color(0xFF6D7483);
    final textColor = isDestructive
        ? const Color(0xFF2F2F2F)
        : const Color(0xFF3C3C3C);

    return Row(
      children: [
        Icon(icon, size: 20, color: iconColor),
        const SizedBox(width: 10),
        Text(
          label,
          style:
              _inventoryInterStyle(
                color: textColor,
                size: 14,
                weight: FontWeight.w400,
              ).copyWith(
                decoration: TextDecoration.none,
                decorationColor: Colors.transparent,
                decorationThickness: 0,
              ),
        ),
      ],
    );
  }
}

class _InventoryActionMenuButton extends StatelessWidget {
  const _InventoryActionMenuButton({
    required this.icon,
    required this.label,
    required this.onPressed,
    this.isHighlighted = false,
    this.isDestructive = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  final bool isHighlighted;
  final bool isDestructive;

  @override
  Widget build(BuildContext context) {
    return _InventoryActionMenuHoverTile(
      icon: icon,
      label: label,
      onPressed: onPressed,
      isHighlighted: isHighlighted,
      isDestructive: isDestructive,
    );
  }
}

class _InventoryActionMenuHoverTile extends StatefulWidget {
  const _InventoryActionMenuHoverTile({
    required this.icon,
    required this.label,
    required this.onPressed,
    this.isHighlighted = false,
    this.isDestructive = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  final bool isHighlighted;
  final bool isDestructive;

  @override
  State<_InventoryActionMenuHoverTile> createState() =>
      _InventoryActionMenuHoverTileState();
}

class _InventoryActionMenuHoverTileState
    extends State<_InventoryActionMenuHoverTile> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      opaque: true,
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: Focus(
        canRequestFocus: false,
        skipTraversal: true,
        descendantsAreFocusable: false,
        child: Listener(
          behavior: HitTestBehavior.opaque,
          onPointerUp: (_) => widget.onPressed(),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Container(
              width: 234,
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
              decoration: BoxDecoration(
                color: _isHovered ? _inventoryHoverColor : Colors.transparent,
                borderRadius: BorderRadius.circular(12),
              ),
              child: _ActionMenuLabel(
                icon: widget.icon,
                label: widget.label,
                isHighlighted: widget.isHighlighted || _isHovered,
                isDestructive: widget.isDestructive,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _InventoryActionsOverlayAnchor extends StatefulWidget {
  const _InventoryActionsOverlayAnchor({
    required this.triggerSize,
    required this.canAddSubGroup,
    required this.onAddSubGroup,
    required this.onEdit,
    required this.onDelete,
  });

  final double triggerSize;
  final bool canAddSubGroup;
  final VoidCallback onAddSubGroup;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  @override
  State<_InventoryActionsOverlayAnchor> createState() =>
      _InventoryActionsOverlayAnchorState();
}

class _InventoryActionsOverlayAnchorState
    extends State<_InventoryActionsOverlayAnchor> {
  final LayerLink _layerLink = LayerLink();
  OverlayEntry? _overlayEntry;
  bool _isOpen = false;

  @override
  void dispose() {
    _removeOverlay();
    super.dispose();
  }

  void _toggleMenu() {
    if (_isOpen) {
      _removeOverlay();
    } else {
      _showOverlay();
    }
  }

  void _showOverlay() {
    final overlay = Overlay.of(context);
    _overlayEntry = OverlayEntry(
      builder: (context) => Stack(
        children: [
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.translucent,
              onTap: _removeOverlay,
              child: const SizedBox.expand(),
            ),
          ),
          CompositedTransformFollower(
            link: _layerLink,
            showWhenUnlinked: false,
            targetAnchor: Alignment.topLeft,
            followerAnchor: Alignment.topRight,
            offset: const Offset(-12, -8),
            child: Theme(
              data: Theme.of(context).copyWith(
                highlightColor: Colors.transparent,
                splashColor: Colors.transparent,
                hoverColor: Colors.transparent,
                focusColor: Colors.transparent,
                splashFactory: NoSplash.splashFactory,
              ),
              child: ExcludeFocus(
                child: ExcludeSemantics(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(18),
                      boxShadow: const [
                        BoxShadow(
                          color: Color(0x22000000),
                          blurRadius: 18,
                          offset: Offset(0, 10),
                        ),
                      ],
                    ),
                    child: SizedBox(
                      width: 250,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 10,
                        ),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (widget.canAddSubGroup)
                              _InventoryActionMenuButton(
                                icon: Icons.add_rounded,
                                label: 'Add Sub-Group',
                                isHighlighted: true,
                                onPressed: () {
                                  _removeOverlay();
                                  widget.onAddSubGroup();
                                },
                              ),
                            _InventoryActionMenuButton(
                              icon: Icons.edit_outlined,
                              label: 'Edit',
                              onPressed: () {
                                _removeOverlay();
                                widget.onEdit();
                              },
                            ),
                            _InventoryActionMenuButton(
                              icon: Icons.delete_outline_rounded,
                              label: 'Delete',
                              isDestructive: true,
                              onPressed: () {
                                _removeOverlay();
                                widget.onDelete();
                              },
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );

    overlay.insert(_overlayEntry!);
    setState(() => _isOpen = true);
  }

  void _removeOverlay() {
    _overlayEntry?.remove();
    _overlayEntry = null;
    if (mounted && _isOpen) {
      setState(() => _isOpen = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return CompositedTransformTarget(
      link: _layerLink,
      child: _InventoryActionTriggerButton(
        size: widget.triggerSize,
        isOpen: _isOpen,
        onTap: _toggleMenu,
      ),
    );
  }
}

class _InventoryActionTriggerButton extends StatefulWidget {
  const _InventoryActionTriggerButton({
    required this.size,
    required this.isOpen,
    required this.onTap,
  });

  final double size;
  final bool isOpen;
  final VoidCallback onTap;

  @override
  State<_InventoryActionTriggerButton> createState() =>
      _InventoryActionTriggerButtonState();
}

class _InventoryActionTriggerButtonState
    extends State<_InventoryActionTriggerButton> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final isActive = widget.isOpen || _isHovered;
    return MouseRegion(
      opaque: true,
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: Focus(
        canRequestFocus: false,
        skipTraversal: true,
        descendantsAreFocusable: false,
        child: Listener(
          behavior: HitTestBehavior.opaque,
          onPointerUp: (_) => widget.onTap(),
          child: Container(
            width: widget.size,
            height: widget.size,
            decoration: BoxDecoration(
              color: isActive ? _inventoryHoverColor : Colors.transparent,
              borderRadius: BorderRadius.circular(6),
            ),
            child: const Icon(
              Icons.more_vert,
              size: 18,
              color: Color(0xFF58458F),
            ),
          ),
        ),
      ),
    );
  }
}

TextStyle _inventoryManropeStyle({
  required Color color,
  required double size,
  required FontWeight weight,
}) {
  return TextStyle(
    fontFamily: 'Manrope',
    fontFamilyFallback: const ['Segoe UI', 'Arial'],
    color: color,
    fontSize: size,
    fontWeight: weight,
  );
}

TextStyle _inventoryInterStyle({
  required Color color,
  required double size,
  required FontWeight weight,
}) {
  return TextStyle(
    fontFamily: 'Inter',
    fontFamilyFallback: const ['Segoe UI', 'Arial'],
    color: color,
    fontSize: size,
    fontWeight: weight,
  );
}

TextStyle _inventorySegoeStyle({
  required Color color,
  required double size,
  required FontWeight weight,
}) {
  return TextStyle(
    fontFamily: 'Segoe UI',
    fontFamilyFallback: const ['Arial'],
    color: color,
    fontSize: size,
    fontWeight: weight,
  );
}

class _MenuValue<T> {
  const _MenuValue({required this.value, required this.label});

  final T value;
  final String label;
}

class _AddChildMaterialSheet extends StatefulWidget {
  const _AddChildMaterialSheet({required this.parent});

  final MaterialRecord parent;

  @override
  State<_AddChildMaterialSheet> createState() => _AddChildMaterialSheetState();
}

class _AddChildMaterialSheetState extends State<_AddChildMaterialSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _nameController;
  final TextEditingController _notesController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController(
      text: '${widget.parent.name} - Sub Group',
    );
  }

  @override
  void dispose() {
    _nameController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<InventoryProvider>();
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const AppSectionTitle(
              title: 'Add Sub-Group',
              subtitle:
                  'Create a child inventory node under this group using the parent properties as a base.',
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: 'Sub-group name'),
              validator: (value) =>
                  (value?.trim().isEmpty ?? true) ? 'Required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _notesController,
              decoration: const InputDecoration(labelText: 'Notes'),
              maxLines: 3,
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                AppButton(
                  label: 'Cancel',
                  variant: AppButtonVariant.secondary,
                  onPressed: () => Navigator.of(context).pop(),
                ),
                const SizedBox(width: 10),
                AppButton(
                  label: 'Create',
                  isLoading: provider.isSaving,
                  onPressed: () async {
                    if (!_formKey.currentState!.validate()) {
                      return;
                    }
                    await context.read<InventoryProvider>().addChildMaterial(
                      CreateChildMaterialInput(
                        parentBarcode: widget.parent.barcode,
                        name: _nameController.text.trim(),
                        notes: _notesController.text.trim(),
                      ),
                    );
                    if (!context.mounted ||
                        context.read<InventoryProvider>().errorMessage !=
                            null) {
                      return;
                    }
                    Navigator.of(context).pop();
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _EditMaterialSheet extends StatefulWidget {
  const _EditMaterialSheet({required this.record});

  final MaterialRecord record;

  @override
  State<_EditMaterialSheet> createState() => _EditMaterialSheetState();
}

class _EditMaterialSheetState extends State<_EditMaterialSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _nameController;
  late final TextEditingController _typeController;
  late final TextEditingController _gradeController;
  late final TextEditingController _thicknessController;
  late final TextEditingController _supplierController;
  late final TextEditingController _notesController;

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController(text: widget.record.name);
    _typeController = TextEditingController(text: widget.record.type);
    _gradeController = TextEditingController(text: widget.record.grade);
    _thicknessController = TextEditingController(text: widget.record.thickness);
    _supplierController = TextEditingController(text: widget.record.supplier);
    _notesController = TextEditingController(text: widget.record.notes);
  }

  @override
  void dispose() {
    _nameController.dispose();
    _typeController.dispose();
    _gradeController.dispose();
    _thicknessController.dispose();
    _supplierController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<InventoryProvider>();
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const AppSectionTitle(
              title: 'Edit Inventory Record',
              subtitle:
                  'Update the label and inventory metadata without breaking barcode traceability.',
            ),
            const SizedBox(height: 16),
            _SimpleField(controller: _nameController, label: 'Name'),
            const SizedBox(height: 12),
            _SimpleField(controller: _typeController, label: 'Type'),
            const SizedBox(height: 12),
            _SimpleField(controller: _gradeController, label: 'Grade'),
            const SizedBox(height: 12),
            _SimpleField(controller: _thicknessController, label: 'Thickness'),
            const SizedBox(height: 12),
            _SimpleField(controller: _supplierController, label: 'Supplier'),
            const SizedBox(height: 12),
            TextFormField(
              controller: _notesController,
              decoration: const InputDecoration(labelText: 'Notes'),
              maxLines: 3,
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                AppButton(
                  label: 'Cancel',
                  variant: AppButtonVariant.secondary,
                  onPressed: () => Navigator.of(context).pop(),
                ),
                const SizedBox(width: 10),
                AppButton(
                  label: 'Save',
                  isLoading: provider.isSaving,
                  onPressed: () async {
                    if (!_formKey.currentState!.validate()) {
                      return;
                    }
                    await context.read<InventoryProvider>().updateMaterial(
                      UpdateMaterialInput(
                        barcode: widget.record.barcode,
                        name: _nameController.text.trim(),
                        type: _typeController.text.trim(),
                        grade: _gradeController.text.trim(),
                        thickness: _thicknessController.text.trim(),
                        supplier: _supplierController.text.trim(),
                        unitId: widget.record.unitId,
                        unit: widget.record.unit,
                        notes: _notesController.text.trim(),
                      ),
                    );
                    if (!context.mounted ||
                        context.read<InventoryProvider>().errorMessage !=
                            null) {
                      return;
                    }
                    Navigator.of(context).pop();
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SimpleField extends StatelessWidget {
  const _SimpleField({required this.controller, required this.label});

  final TextEditingController controller;
  final String label;

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: controller,
      decoration: InputDecoration(labelText: label),
      validator: (value) => (value?.trim().isEmpty ?? true) ? 'Required' : null,
    );
  }
}

class _CreateGroupToggleSection extends StatelessWidget {
  const _CreateGroupToggleSection({
    required this.title,
    required this.value,
    required this.onChanged,
    required this.child,
  });

  final String title;
  final bool value;
  final ValueChanged<bool> onChanged;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () => onChanged(!value),
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              children: [
                Checkbox(
                  value: value,
                  onChanged: (checked) => onChanged(checked ?? false),
                  activeColor: const Color(0xFF6049E3),
                  visualDensity: VisualDensity.compact,
                  side: const BorderSide(color: Color(0xFFB8B8B8)),
                ),
                const SizedBox(width: 4),
                Text(
                  title,
                  style: _inventoryManropeStyle(
                    color: const Color(0xFF3F3F3F),
                    size: 14,
                    weight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
        ),
        AnimatedCrossFade(
          firstChild: const SizedBox.shrink(),
          secondChild: Padding(
            padding: const EdgeInsets.only(top: 12),
            child: child,
          ),
          crossFadeState: value
              ? CrossFadeState.showSecond
              : CrossFadeState.showFirst,
          duration: const Duration(milliseconds: 180),
        ),
      ],
    );
  }
}

class _CreateGroupField extends StatelessWidget {
  const _CreateGroupField({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: _inventorySegoeStyle(
            color: const Color(0xFF717171),
            size: 14,
            weight: FontWeight.w400,
          ),
        ),
        const SizedBox(height: 4),
        Container(
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: Colors.white,
            border: Border.all(color: const Color(0xFFE5E5E5)),
            borderRadius: BorderRadius.circular(8),
          ),
          child: child,
        ),
      ],
    );
  }
}

class _CreateGroupDropdown extends StatelessWidget {
  const _CreateGroupDropdown({
    required this.value,
    required this.placeholder,
    required this.options,
    required this.onSelected,
  });

  final String? value;
  final String placeholder;
  final List<String> options;
  final ValueChanged<String?> onSelected;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () async {
        final selected = await showSearchableSelectDialog<String>(
          context: context,
          title: placeholder,
          searchHintText: 'Search option',
          selectedValue: value,
          options: options
              .map(
                (option) => SearchableSelectOption<String>(
                  value: option,
                  label: option,
                ),
              )
              .toList(growable: false),
        );
        onSelected(selected?.value);
      },
      child: Row(
        children: [
          Expanded(
            child: Text(
              value ?? placeholder,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: _inventorySegoeStyle(
                color: value == null
                    ? const Color(0xFF9D9D9D)
                    : const Color(0xFF3F3F3F),
                size: 14,
                weight: FontWeight.w400,
              ),
            ),
          ),
          const Icon(
            Icons.keyboard_arrow_down_rounded,
            color: Color(0xFF727272),
            size: 20,
          ),
        ],
      ),
    );
  }
}

class _PropertyChip extends StatelessWidget {
  const _PropertyChip({required this.label, required this.onRemove});

  final String label;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: const Color(0xFFF6F4FF),
        border: Border.all(color: const Color(0xFFCFC7FF)),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: _inventoryInterStyle(
              color: const Color(0xFF2A00E4),
              size: 12,
              weight: FontWeight.w500,
            ),
          ),
          const SizedBox(width: 4),
          InkWell(
            onTap: onRemove,
            borderRadius: BorderRadius.circular(999),
            child: const Icon(
              Icons.close_rounded,
              size: 12,
              color: Color(0xFF5A4BBA),
            ),
          ),
        ],
      ),
    );
  }
}

class _LinkGroupSheet extends StatelessWidget {
  const _LinkGroupSheet({required this.record});

  final MaterialRecord record;

  @override
  Widget build(BuildContext context) {
    final groups = context.watch<GroupsProvider>().activeGroups;
    final provider = context.watch<InventoryProvider>();
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const AppSectionTitle(
            title: 'Link Group Inheritance',
            subtitle:
                'Attach this inventory group to a configurator group so inherited properties can be referenced and later unlinked.',
          ),
          const SizedBox(height: 16),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 360),
            child: ListView.separated(
              shrinkWrap: true,
              itemCount: groups.length,
              separatorBuilder: (_, _) =>
                  const Divider(height: 1, color: Color(0xFFE8E8F0)),
              itemBuilder: (context, index) {
                final group = groups[index];
                final isSelected = group.id == record.linkedGroupId;
                return ListTile(
                  title: Text(group.name),
                  subtitle: Text(
                    group.parentGroupId == null
                        ? 'Top level group'
                        : 'Nested group',
                  ),
                  trailing: isSelected
                      ? const Icon(Icons.check_circle, color: Color(0xFF6049E3))
                      : null,
                  onTap: () async {
                    await context.read<InventoryProvider>().linkMaterialToGroup(
                      record.barcode,
                      group.id,
                    );
                    if (!context.mounted || provider.errorMessage != null) {
                      return;
                    }
                    Navigator.of(context).pop();
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _LinkItemSheet extends StatelessWidget {
  const _LinkItemSheet({required this.record});

  final MaterialRecord record;

  @override
  Widget build(BuildContext context) {
    final items = context
        .watch<ItemsProvider>()
        .items
        .where((item) => !item.isArchived)
        .toList(growable: false);
    final provider = context.watch<InventoryProvider>();
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const AppSectionTitle(
            title: 'Link Item Inheritance',
            subtitle:
                'Attach this inventory item to a configurator item so inherited item properties and variation structure stay visible.',
          ),
          const SizedBox(height: 16),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 420),
            child: ListView.separated(
              shrinkWrap: true,
              itemCount: items.length,
              separatorBuilder: (_, _) =>
                  const Divider(height: 1, color: Color(0xFFE8E8F0)),
              itemBuilder: (context, index) {
                final item = items[index];
                final isSelected = item.id == record.linkedItemId;
                return ListTile(
                  title: Text(item.displayName),
                  subtitle: Text(
                    item.topLevelProperties.isEmpty
                        ? 'No inherited properties'
                        : item.topLevelProperties
                              .map((node) => node.name)
                              .join(', '),
                  ),
                  trailing: isSelected
                      ? const Icon(Icons.check_circle, color: Color(0xFF6049E3))
                      : null,
                  onTap: () async {
                    await context.read<InventoryProvider>().linkMaterialToItem(
                      record.barcode,
                      item.id,
                    );
                    if (!context.mounted || provider.errorMessage != null) {
                      return;
                    }
                    Navigator.of(context).pop();
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _AddMaterialForm extends StatefulWidget {
  const _AddMaterialForm();

  @override
  State<_AddMaterialForm> createState() => _AddMaterialFormState();
}

class _AddMaterialFormState extends State<_AddMaterialForm> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _propertyController = TextEditingController();
  final FocusNode _nameFocus = FocusNode();
  String _groupType = 'Primary';
  bool _addSubGroups = false;
  bool _addItems = false;
  bool _addProperties = false;
  String? _selectedSubGroup;
  String? _selectedItem;
  final List<String> _addedProperties = <String>[];

  @override
  void dispose() {
    _nameController.dispose();
    _propertyController.dispose();
    _nameFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<InventoryProvider>();
    final groups = context.watch<GroupsProvider>().activeGroups;
    final items = context
        .watch<ItemsProvider>()
        .items
        .where((item) => !item.isArchived)
        .toList(growable: false);
    final availableSubGroups =
        groups
            .map((group) => group.name.trim())
            .where((name) => name.isNotEmpty)
            .toSet()
            .toList(growable: false)
          ..sort();
    final availableItems =
        items
            .map((item) => item.displayName.trim())
            .where((name) => name.isNotEmpty)
            .toSet()
            .toList(growable: false)
          ..sort();

    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(16),
      child: SizedBox(
        width: 1023,
        height: 620,
        child: Form(
          key: _formKey,
          child: Column(
            children: [
              Container(
                height: 60,
                width: double.infinity,
                alignment: Alignment.center,
                decoration: const BoxDecoration(
                  color: Color(0xFFFBFBFB),
                  borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
                ),
                child: Text(
                  'Create New Group',
                  style: _inventoryInterStyle(
                    color: const Color(0xFF3F3F3F),
                    size: 16,
                    weight: FontWeight.w500,
                  ),
                ),
              ),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(24, 24, 24, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: _CreateGroupField(
                              label: 'Group Name',
                              child: TextFormField(
                                controller: _nameController,
                                focusNode: _nameFocus,
                                decoration: const InputDecoration(
                                  hintText: 'Enter',
                                  border: InputBorder.none,
                                  isCollapsed: true,
                                ),
                                style: _inventorySegoeStyle(
                                  color: const Color(0xFF3F3F3F),
                                  size: 14,
                                  weight: FontWeight.w400,
                                ),
                                validator: (value) =>
                                    (value == null || value.trim().isEmpty)
                                    ? 'Required'
                                    : null,
                              ),
                            ),
                          ),
                          const SizedBox(width: 24),
                          Expanded(
                            child: _CreateGroupField(
                              label: 'Group Type',
                              child: _CreateGroupDropdown(
                                value: _groupType,
                                placeholder: 'Select',
                                options: const [
                                  'Primary',
                                  'Secondary',
                                  'Material',
                                  'Assembly',
                                ],
                                onSelected: (value) {
                                  if (value == null) {
                                    return;
                                  }
                                  setState(() {
                                    _groupType = value;
                                  });
                                },
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 20),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.only(bottom: 20),
                        decoration: const BoxDecoration(
                          border: Border(
                            bottom: BorderSide(color: Color(0xFFEFEFEF)),
                          ),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: _CreateGroupToggleSection(
                                title: 'Add Sub-Groups',
                                value: _addSubGroups,
                                onChanged: (value) {
                                  setState(() {
                                    _addSubGroups = value;
                                    if (!value) {
                                      _selectedSubGroup = null;
                                    }
                                  });
                                },
                                child: _CreateGroupField(
                                  label: 'Add Sub-Groups',
                                  child: _CreateGroupDropdown(
                                    value: _selectedSubGroup,
                                    placeholder: 'Select',
                                    options: availableSubGroups,
                                    onSelected: (value) {
                                      setState(() {
                                        _selectedSubGroup = value;
                                      });
                                    },
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 24),
                            Expanded(
                              child: _CreateGroupToggleSection(
                                title: 'Add Items',
                                value: _addItems,
                                onChanged: (value) {
                                  setState(() {
                                    _addItems = value;
                                    if (!value) {
                                      _selectedItem = null;
                                    }
                                  });
                                },
                                child: _CreateGroupField(
                                  label: 'Items',
                                  child: _CreateGroupDropdown(
                                    value: _selectedItem,
                                    placeholder: 'Select',
                                    options: availableItems,
                                    onSelected: (value) {
                                      setState(() {
                                        _selectedItem = value;
                                      });
                                    },
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 20),
                      _CreateGroupToggleSection(
                        title: 'Add Group Properties',
                        value: _addProperties,
                        onChanged: (value) {
                          setState(() {
                            _addProperties = value;
                            if (!value) {
                              _propertyController.clear();
                              _addedProperties.clear();
                            }
                          });
                        },
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SizedBox(
                              width: 300,
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Expanded(
                                    child: _CreateGroupField(
                                      label: 'Group Properties',
                                      child: TextFormField(
                                        controller: _propertyController,
                                        decoration: const InputDecoration(
                                          hintText: 'Enter',
                                          border: InputBorder.none,
                                          isCollapsed: true,
                                        ),
                                        style: _inventorySegoeStyle(
                                          color: const Color(0xFF3F3F3F),
                                          size: 14,
                                          weight: FontWeight.w400,
                                        ),
                                        onFieldSubmitted: (_) =>
                                            _addPropertyChip(),
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  SizedBox(
                                    height: 40,
                                    child: OutlinedButton(
                                      onPressed: _addPropertyChip,
                                      style: OutlinedButton.styleFrom(
                                        side: const BorderSide(
                                          color: Color(0xFFDDDDDD),
                                        ),
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 14,
                                        ),
                                        shape: RoundedRectangleBorder(
                                          borderRadius: BorderRadius.circular(
                                            48,
                                          ),
                                        ),
                                      ),
                                      child: Text(
                                        '+ Add',
                                        style: _inventoryInterStyle(
                                          color: const Color(0xFF484848),
                                          size: 14,
                                          weight: FontWeight.w500,
                                        ),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            Container(
                              width: 1,
                              height: 72,
                              margin: const EdgeInsets.symmetric(
                                horizontal: 20,
                              ),
                              color: const Color(0xFFE3E3E3),
                            ),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'Added Properties',
                                    style: _inventoryManropeStyle(
                                      color: const Color(0xFF717171),
                                      size: 14,
                                      weight: FontWeight.w400,
                                    ),
                                  ),
                                  const SizedBox(height: 8),
                                  Wrap(
                                    spacing: 8,
                                    runSpacing: 8,
                                    children: _addedProperties
                                        .map(
                                          (property) => _PropertyChip(
                                            label: property,
                                            onRemove: () {
                                              setState(() {
                                                _addedProperties.remove(
                                                  property,
                                                );
                                              });
                                            },
                                          ),
                                        )
                                        .toList(growable: false),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              Container(
                height: 61,
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 24),
                decoration: const BoxDecoration(
                  color: Colors.white,
                  border: Border(top: BorderSide(color: Color(0xFFE2E2E2))),
                  borderRadius: BorderRadius.vertical(
                    bottom: Radius.circular(16),
                  ),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    OutlinedButton(
                      onPressed: () => Navigator.of(context).pop(),
                      style: OutlinedButton.styleFrom(
                        side: const BorderSide(color: Color(0xFFDDDDDD)),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(4),
                        ),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 20,
                          vertical: 10,
                        ),
                      ),
                      child: Text(
                        'Cancel',
                        style: _inventoryInterStyle(
                          color: const Color(0xFF484848),
                          size: 14,
                          weight: FontWeight.w500,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    FilledButton(
                      onPressed: provider.isSaving
                          ? null
                          : () => _submit(context),
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF6049E3),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(4),
                        ),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 20,
                          vertical: 10,
                        ),
                      ),
                      child: provider.isSaving
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Text(
                              'Save',
                              style: _inventoryInterStyle(
                                color: Colors.white,
                                size: 14,
                                weight: FontWeight.w500,
                              ),
                            ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _submit(BuildContext context) async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    final notes = <String>[
      'Group Type: $_groupType',
      if (_addSubGroups && _selectedSubGroup != null)
        'Sub-Group: $_selectedSubGroup',
      if (_addItems && _selectedItem != null) 'Item: $_selectedItem',
      if (_addProperties && _addedProperties.isNotEmpty)
        'Properties: ${_addedProperties.join(', ')}',
    ].join('\n');
    final childrenCount = [
      if (_addSubGroups && _selectedSubGroup != null) _selectedSubGroup,
      if (_addItems && _selectedItem != null) _selectedItem,
    ].length;
    final provider = context.read<InventoryProvider>();
    await provider.addParentMaterial(
      CreateParentMaterialInput(
        name: _nameController.text.trim(),
        type: _groupType,
        grade: '',
        thickness: '',
        supplier: '',
        unitId: null,
        unit: 'Pieces',
        notes: notes,
        numberOfChildren: childrenCount,
      ),
    );

    if (!context.mounted || provider.errorMessage != null) {
      return;
    }

    Navigator.of(context).maybePop();
  }

  void _addPropertyChip() {
    final value = _propertyController.text.trim();
    if (value.isEmpty) {
      return;
    }
    setState(() {
      _addedProperties.add(value);
      _propertyController.clear();
    });
  }
}

class _AddStockForm extends StatefulWidget {
  const _AddStockForm();

  @override
  State<_AddStockForm> createState() => _AddStockFormState();
}

class _AddStockFormState extends State<_AddStockForm> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _typeController = TextEditingController();
  final _gradeController = TextEditingController();
  final _thicknessController = TextEditingController();
  final _supplierController = TextEditingController();
  final _childrenController = TextEditingController(text: '0');

  UnitDefinition? _selectedUnit;

  @override
  void dispose() {
    _nameController.dispose();
    _typeController.dispose();
    _gradeController.dispose();
    _thicknessController.dispose();
    _supplierController.dispose();
    _childrenController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<InventoryProvider>();

    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(16),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Form(
            key: _formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const AppSectionTitle(
                  title: 'Add Inventory Stock',
                  subtitle:
                      'Create a parent stock record and optionally pre-split it into child barcodes for tracking.',
                ),
                const SizedBox(height: 16),
                _SimpleField(controller: _nameController, label: 'Name'),
                const SizedBox(height: 12),
                _SimpleField(controller: _typeController, label: 'Type'),
                const SizedBox(height: 12),
                _SimpleField(controller: _gradeController, label: 'Grade'),
                const SizedBox(height: 12),
                _SimpleField(
                  controller: _thicknessController,
                  label: 'Thickness',
                ),
                const SizedBox(height: 12),
                _SimpleField(
                  controller: _supplierController,
                  label: 'Supplier',
                ),
                const SizedBox(height: 12),
                _StockUnitField(
                  selectedUnit: _selectedUnit,
                  onPressed: _selectUnit,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _childrenController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: 'Cut into X children',
                  ),
                  validator: (value) {
                    final parsed = int.tryParse(value?.trim() ?? '');
                    if (parsed == null || parsed < 0) {
                      return 'Enter 0 or more';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    AppButton(
                      label: 'Cancel',
                      variant: AppButtonVariant.secondary,
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                    const SizedBox(width: 10),
                    AppButton(
                      label: 'Save Parent + Children',
                      isLoading: provider.isSaving,
                      onPressed: () => _submit(context),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _selectUnit() async {
    final selected = await showDialog<UnitDefinition>(
      context: context,
      builder: (context) => Dialog(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: _UnitPickerSheet(),
        ),
      ),
    );
    if (!mounted || selected == null) {
      return;
    }
    setState(() {
      _selectedUnit = selected;
    });
  }

  Future<void> _submit(BuildContext context) async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    await context.read<InventoryProvider>().addParentMaterial(
      CreateParentMaterialInput(
        name: _nameController.text.trim(),
        type: _typeController.text.trim(),
        grade: _gradeController.text.trim(),
        thickness: _thicknessController.text.trim(),
        supplier: _supplierController.text.trim(),
        unitId: _selectedUnit?.id,
        unit: _selectedUnit?.symbol ?? 'Pieces',
        notes: '',
        numberOfChildren: int.tryParse(_childrenController.text.trim()) ?? 0,
      ),
    );

    if (!context.mounted ||
        context.read<InventoryProvider>().errorMessage != null) {
      return;
    }

    Navigator.of(context).pop();
  }
}

class _StockUnitField extends StatelessWidget {
  const _StockUnitField({required this.selectedUnit, required this.onPressed});

  final UnitDefinition? selectedUnit;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final label = selectedUnit == null
        ? 'Select a unit'
        : '${selectedUnit!.name} (${selectedUnit!.symbol})';
    return InputDecorator(
      decoration: const InputDecoration(labelText: 'Unit'),
      child: Align(
        alignment: Alignment.centerLeft,
        child: TextButton(onPressed: onPressed, child: Text(label)),
      ),
    );
  }
}

class _UnitPickerSheet extends StatefulWidget {
  const _UnitPickerSheet();

  @override
  State<_UnitPickerSheet> createState() => _UnitPickerSheetState();
}

class _UnitPickerSheetState extends State<_UnitPickerSheet> {
  final TextEditingController _searchController = TextEditingController();

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<UnitsProvider>();
    final query = _normalizeUnitQuery(_searchController.text);
    final units = provider.activeUnits
        .where((unit) {
          if (query.isEmpty) {
            return true;
          }
          return _normalizeUnitQuery(unit.name).contains(query) ||
              _normalizeUnitQuery(unit.symbol).contains(query);
        })
        .toList(growable: false);
    final canCreate =
        query.isNotEmpty &&
        !provider.activeUnits.any(
          (unit) =>
              _normalizeUnitQuery(unit.name) == query ||
              _normalizeUnitQuery(unit.symbol) == query,
        );

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const AppSectionTitle(
            title: 'Select a unit',
            subtitle:
                'Pick an existing unit or create one inline for this stock entry.',
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _searchController,
            decoration: const InputDecoration(
              hintText: 'Search unit name or symbol',
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 16),
          SizedBox(
            height: 280,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final unit in units)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text('${unit.name} (${unit.symbol})'),
                      onTap: () => Navigator.of(context).pop(unit),
                    ),
                  if (canCreate)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text('Create "${_searchController.text.trim()}"'),
                      onTap: () => _openCreateUnit(context),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _openCreateUnit(BuildContext context) async {
    final created = await showDialog<UnitDefinition>(
      context: context,
      builder: (context) => Dialog(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: _QuickCreateUnitSheet(initialName: _searchController.text),
        ),
      ),
    );
    if (!context.mounted || created == null) {
      return;
    }
    Navigator.of(context).pop(created);
  }

  static String _normalizeUnitQuery(String value) {
    return value.trim().replaceAll(RegExp(r'\s+'), ' ').toLowerCase();
  }
}

class _QuickCreateUnitSheet extends StatefulWidget {
  const _QuickCreateUnitSheet({required this.initialName});

  final String initialName;

  @override
  State<_QuickCreateUnitSheet> createState() => _QuickCreateUnitSheetState();
}

class _QuickCreateUnitSheetState extends State<_QuickCreateUnitSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _nameController;
  final TextEditingController _symbolController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController(text: widget.initialName.trim());
  }

  @override
  void dispose() {
    _nameController.dispose();
    _symbolController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const AppSectionTitle(
              title: 'Create Unit',
              subtitle: 'Add the missing unit without leaving the stock flow.',
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: 'Name'),
              validator: (value) =>
                  (value?.trim().isEmpty ?? true) ? 'Required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _symbolController,
              decoration: const InputDecoration(labelText: 'Symbol'),
              validator: (value) =>
                  (value?.trim().isEmpty ?? true) ? 'Required' : null,
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                ElevatedButton(
                  onPressed: () => _submit(context),
                  child: const Text('Create Unit'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _submit(BuildContext context) async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    final provider = context.read<UnitsProvider>();
    final created = await provider.createUnit(
      CreateUnitInput(
        name: _nameController.text.trim(),
        symbol: _symbolController.text.trim(),
      ),
    );
    if (!context.mounted || created == null) {
      return;
    }
    Navigator.of(context).pop(created);
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0xFFEEEAFE),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 12,
          color: Color(0xFF5B4FE6),
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF1F2),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFFFECACA)),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: Color(0xFFB91C1C)),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(
                color: Color(0xFF991B1B),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

extension _NullableStringX on String? {
  String ifEmpty(String fallback) {
    final value = this;
    if (value == null || value.trim().isEmpty) {
      return fallback;
    }
    return value;
  }
}

extension _FirstOrNullX<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
