import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../../../core/theme/soft_erp_theme.dart';
import '../../../../core/widgets/app_button.dart';
import '../../../../core/widgets/app_empty_state.dart';
import '../../../../core/widgets/searchable_select.dart';
import '../../../../core/widgets/soft_primitives.dart';
import '../../../clients/domain/client_definition.dart';
import '../../../clients/presentation/providers/clients_provider.dart';
import '../../../items/domain/item_definition.dart';
import '../../../items/presentation/providers/items_provider.dart';
import '../../domain/order_entry.dart';
import '../../domain/order_inputs.dart';
import '../providers/orders_provider.dart';

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});

  static Future<void> openEditor(BuildContext context) {
    final isNarrow = MediaQuery.of(context).size.width < 900;
    final body = const _OrderEditorSheet();
    if (isNarrow) {
      return showModalBottomSheet<void>(
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

    return showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 847, maxHeight: 680),
          child: body,
        ),
      ),
    );
  }

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  static const double _contentHorizontalPadding = 22;
  final Set<int> _selectedOrderIds = <int>{};
  int? _partyFilterClientId;
  int? _itemFilterId;
  OrderStatus? _statusFilter;

  @override
  Widget build(BuildContext context) {
    final ordersProvider = context.watch<OrdersProvider>();
    final clients = context
        .watch<ClientsProvider>()
        .clients
        .where((client) => !client.isArchived)
        .toList(growable: false);
    final items = context
        .watch<ItemsProvider>()
        .items
        .where((item) => !item.isArchived)
        .toList(growable: false);
    final orders = ordersProvider.orders;
    final visibleOrders = _applyFilters(ordersProvider.filteredOrders);
    final summary = _OrderSummary.fromOrders(orders);

    _selectedOrderIds.removeWhere(
      (id) => !orders.any((order) => order.id == id),
    );

    return Container(
      color: SoftErpTheme.canvas,
      padding: const EdgeInsets.fromLTRB(22, 14, 22, 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: SoftSurface(
              color: SoftErpTheme.shellSurface,
              radius: 44,
              padding: const EdgeInsets.fromLTRB(0, 14, 0, 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      _contentHorizontalPadding,
                      0,
                      _contentHorizontalPadding,
                      18,
                    ),
                    child: _OrdersHeader(
                      onNewOrder: () => OrdersScreen.openEditor(context),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: _contentHorizontalPadding,
                    ),
                    child: _OrdersControlRow(
                      partyFilterClientId: _partyFilterClientId,
                      itemFilterId: _itemFilterId,
                      statusFilter: _statusFilter,
                      clients: clients,
                      items: items,
                      selectedCount: _selectedOrderIds.length,
                      onPartySelected: (value) {
                        setState(() {
                          _partyFilterClientId = value;
                        });
                      },
                      onItemSelected: (value) {
                        setState(() {
                          _itemFilterId = value;
                        });
                      },
                      onStatusSelected: (value) {
                        setState(() {
                          _statusFilter = value;
                        });
                      },
                      onClearSelection: () {
                        setState(_selectedOrderIds.clear);
                      },
                    ),
                  ),
                  const SizedBox(height: 14),
                  const Divider(height: 1, color: SoftErpTheme.border),
                  const SizedBox(height: 18),
                  if (ordersProvider.errorMessage != null) ...[
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: _contentHorizontalPadding,
                      ),
                      child: _OrdersMessageBanner(
                        message: ordersProvider.errorMessage!,
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: _contentHorizontalPadding,
                    ),
                    child: _OrdersSummaryRow(
                      summary: summary,
                      activeStatus: _statusFilter,
                      onStatusSelected: (value) {
                        setState(() {
                          _statusFilter = value;
                        });
                      },
                    ),
                  ),
                  const SizedBox(height: 16),
                  Expanded(
                    child: _OrdersTableCard(
                      orders: visibleOrders,
                      selectedOrderIds: _selectedOrderIds,
                      onToggleSelection: (orderId, selected) {
                        setState(() {
                          if (selected) {
                            _selectedOrderIds.add(orderId);
                          } else {
                            _selectedOrderIds.remove(orderId);
                          }
                        });
                      },
                      onRowTap: (order) => _openLifecycleEditor(context, order),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<OrderEntry> _applyFilters(List<OrderEntry> orders) {
    return orders
        .where((order) {
          if (_partyFilterClientId != null &&
              order.clientId != _partyFilterClientId) {
            return false;
          }
          if (_itemFilterId != null && order.itemId != _itemFilterId) {
            return false;
          }
          if (_statusFilter != null && order.status != _statusFilter) {
            return false;
          }
          return true;
        })
        .toList(growable: false);
  }

  Future<void> _openLifecycleEditor(BuildContext context, OrderEntry order) {
    return showGeneralDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'Order details',
      barrierColor: const Color(0x7D100D1F),
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
                    maxWidth: 757,
                    minWidth: 520,
                  ),
                  child: _OrderDetailsSheet(
                    order: order,
                    onEdit: () {
                      Navigator.of(context).pop();
                      Future<void>.microtask(() {
                        if (!mounted) {
                          return;
                        }
                        showDialog<void>(
                          context: this.context,
                          builder: (context) => Dialog(
                            insetPadding: const EdgeInsets.all(32),
                            child: ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 520),
                              child: _OrderLifecycleEditorSheet(order: order),
                            ),
                          ),
                        );
                      });
                    },
                  ),
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
}

class _OrdersHeader extends StatelessWidget {
  const _OrdersHeader({required this.onNewOrder});

  final VoidCallback onNewOrder;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final title = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Order Book',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                fontSize: 28,
                fontWeight: FontWeight.w700,
                color: SoftErpTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Soft operational dashboard for orders, progress, and fulfillment.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: SoftErpTheme.textSecondary,
              ),
            ),
          ],
        );
        final button = _OrdersPrimaryButton(
          key: const Key('orders-new-order-button'),
          label: 'New Order',
          onPressed: onNewOrder,
        );

        final content = constraints.maxWidth < 900
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  title,
                  const SizedBox(height: 12),
                  Align(alignment: Alignment.centerRight, child: button),
                ],
              )
            : Row(
                children: [
                  Expanded(child: title),
                  const SizedBox(width: 16),
                  button,
                ],
              );

        return SoftSurface(
          radius: 30,
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
          color: SoftErpTheme.cardSurface,
          child: content,
        );
      },
    );
  }
}

class _OrdersPrimaryButton extends StatelessWidget {
  const _OrdersPrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
  });

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        gradient: const LinearGradient(
          colors: [Color(0xFF6A66F2), Color(0xFF5C6BF2)],
        ),
        boxShadow: const [
          BoxShadow(
            color: Color(0x386366F1),
            blurRadius: 14,
            offset: Offset(0, 8),
          ),
        ],
      ),
      child: SizedBox(
        height: 52,
        child: FilledButton(
          onPressed: onPressed,
          style: FilledButton.styleFrom(
            elevation: 0,
            backgroundColor: Colors.transparent,
            foregroundColor: Colors.white,
            shadowColor: Colors.transparent,
            padding: const EdgeInsets.symmetric(horizontal: 24),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(22),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.add_rounded, size: 18),
              const SizedBox(width: 10),
              Text(
                label,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _OrdersControlRow extends StatelessWidget {
  const _OrdersControlRow({
    required this.partyFilterClientId,
    required this.itemFilterId,
    required this.statusFilter,
    required this.clients,
    required this.items,
    required this.selectedCount,
    required this.onPartySelected,
    required this.onItemSelected,
    required this.onStatusSelected,
    required this.onClearSelection,
  });

  final int? partyFilterClientId;
  final int? itemFilterId;
  final OrderStatus? statusFilter;
  final List<ClientDefinition> clients;
  final List<ItemDefinition> items;
  final int selectedCount;
  final ValueChanged<int?> onPartySelected;
  final ValueChanged<int?> onItemSelected;
  final ValueChanged<OrderStatus?> onStatusSelected;
  final VoidCallback onClearSelection;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final filters = [
          _FilterChipButton<int?>(
            label: 'Party',
            valueLabel:
                clients
                        .where((client) => client.id == partyFilterClientId)
                        .firstOrNull
                        ?.alias
                        .trim()
                        .isNotEmpty ==
                    true
                ? clients
                      .where((client) => client.id == partyFilterClientId)
                      .first
                      .alias
                : 'All',
            isFirst: true,
            values: [
              const _MenuValue<int?>(value: null, label: 'All'),
              ...clients.map(
                (client) => _MenuValue<int?>(
                  value: client.id,
                  label: client.alias.isEmpty ? client.name : client.alias,
                ),
              ),
            ],
            onSelected: onPartySelected,
          ),
          _FilterChipButton<int?>(
            label: 'Item',
            valueLabel:
                items
                    .where((item) => item.id == itemFilterId)
                    .firstOrNull
                    ?.name ??
                'Anytime',
            values: [
              const _MenuValue<int?>(value: null, label: 'Anytime'),
              ...items.map(
                (item) => _MenuValue<int?>(value: item.id, label: item.name),
              ),
            ],
            onSelected: onItemSelected,
          ),
          _FilterChipButton<OrderStatus?>(
            label: 'Status',
            valueLabel: statusFilter?.label ?? 'All',
            isLast: true,
            values: [
              const _MenuValue<OrderStatus?>(value: null, label: 'All'),
              ...OrderStatus.values.map(
                (status) => _MenuValue<OrderStatus?>(
                  value: status,
                  label: status.label,
                ),
              ),
            ],
            onSelected: onStatusSelected,
          ),
        ];

        final trailing = Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 10,
          runSpacing: 8,
          children: [
            if (selectedCount > 0) ...[
              Padding(
                padding: const EdgeInsets.only(right: 4),
                child: Text(
                  '$selectedCount Selected',
                  style: const TextStyle(
                    color: SoftErpTheme.textSecondary,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              InkWell(
                onTap: onClearSelection,
                borderRadius: BorderRadius.circular(15),
                child: Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    color: SoftErpTheme.cardSurfaceAlt,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: SoftErpTheme.border),
                  ),
                  child: const Icon(
                    Icons.close_rounded,
                    size: 16,
                    color: SoftErpTheme.textSecondary,
                  ),
                ),
              ),
            ],
            const _ActionChip(
              label: 'Newest',
              icon: Icons.keyboard_arrow_down_rounded,
            ),
            const _ActionChip(
              label: 'Filters',
              icon: Icons.filter_list_rounded,
            ),
          ],
        );

        if (constraints.maxWidth < 1140) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(spacing: 0, runSpacing: 8, children: filters),
              const SizedBox(height: 12),
              trailing,
            ],
          );
        }

        return Row(
          children: [
            Expanded(child: Wrap(spacing: 0, runSpacing: 8, children: filters)),
            const SizedBox(width: 12),
            trailing,
          ],
        );
      },
    );
  }
}

class _FilterChipButton<T> extends StatelessWidget {
  const _FilterChipButton({
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
    final radius = BorderRadius.horizontal(
      left: Radius.circular(isFirst ? 22 : 14),
      right: Radius.circular(isLast ? 22 : 14),
    );
    return InkWell(
      borderRadius: radius,
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
        height: 38,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          color: SoftErpTheme.cardSurfaceAlt,
          border: Border.all(color: SoftErpTheme.border),
          borderRadius: radius,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (isFirst) ...[
              const Icon(
                Icons.filter_alt_outlined,
                size: 15,
                color: SoftErpTheme.textSecondary,
              ),
              const SizedBox(width: 7),
            ],
            Text(
              '$label: ',
              style: const TextStyle(
                color: SoftErpTheme.textSecondary,
                fontFamily: 'Segoe UI',
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
            Text(
              valueLabel,
              style: const TextStyle(
                color: SoftErpTheme.textPrimary,
                fontFamily: 'Segoe UI',
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(width: 4),
            const Icon(
              Icons.keyboard_arrow_down_rounded,
              size: 16,
              color: SoftErpTheme.textSecondary,
            ),
          ],
        ),
      ),
    );
  }
}

class _ActionChip extends StatelessWidget {
  const _ActionChip({required this.label, required this.icon});

  final String label;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return SoftPill(
      label: label,
      leading: Icon(icon, size: 16, color: SoftErpTheme.textSecondary),
      background: SoftErpTheme.cardSurfaceAlt,
      borderColor: SoftErpTheme.border,
      foreground: SoftErpTheme.textPrimary,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
    );
  }
}

class _OrdersSummaryRow extends StatelessWidget {
  const _OrdersSummaryRow({
    required this.summary,
    required this.activeStatus,
    required this.onStatusSelected,
  });

  final _OrderSummary summary;
  final OrderStatus? activeStatus;
  final ValueChanged<OrderStatus?> onStatusSelected;

  @override
  Widget build(BuildContext context) {
    const cardWidth = 338.0;
    return SizedBox(
      height: 84,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            SizedBox(
              width: cardWidth,
              child: _SummaryCard(
                label: 'All',
                value: summary.total,
                isActive: activeStatus == null,
                onTap: () => onStatusSelected(null),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: cardWidth,
              child: _SummaryCard(
                label: 'Not Started',
                value: summary.notStarted,
                isActive: activeStatus == OrderStatus.notStarted,
                onTap: () => onStatusSelected(OrderStatus.notStarted),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: cardWidth,
              child: _SummaryCard(
                label: 'In Progress',
                value: summary.inProgress,
                isActive: activeStatus == OrderStatus.inProgress,
                onTap: () => onStatusSelected(OrderStatus.inProgress),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: cardWidth,
              child: _SummaryCard(
                label: 'Completed',
                value: summary.completed,
                isActive: activeStatus == OrderStatus.completed,
                onTap: () => onStatusSelected(OrderStatus.completed),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: cardWidth,
              child: _SummaryCard(
                label: 'Delayed',
                value: summary.delayed,
                isActive: activeStatus == OrderStatus.delayed,
                onTap: () => onStatusSelected(OrderStatus.delayed),
              ),
            ),
          ],
        ),
      ),
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
    return SoftMetricCard(
      label: label,
      value: value,
      isActive: isActive,
      onTap: onTap,
    );
  }
}

class _OrdersTableCard extends StatelessWidget {
  const _OrdersTableCard({
    required this.orders,
    required this.selectedOrderIds,
    required this.onToggleSelection,
    required this.onRowTap,
  });

  final List<OrderEntry> orders;
  final Set<int> selectedOrderIds;
  final void Function(int orderId, bool selected) onToggleSelection;
  final ValueChanged<OrderEntry> onRowTap;

  @override
  Widget build(BuildContext context) {
    if (orders.isEmpty) {
      return const AppEmptyState(
        title: 'No orders found',
        message:
            'Try a different filter or create a new order to populate the order book.',
        icon: Icons.receipt_long_outlined,
      );
    }

    return SoftSurface(
      radius: 30,
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 10),
      color: SoftErpTheme.cardSurface,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final layout = _OrdersTableLayout.fromContainerWidth(
            constraints.maxWidth,
          );

          return Column(
            children: [
              _TableHeaderRow(layout: layout),
              const SizedBox(height: 10),
              Expanded(
                child: ListView.separated(
                  itemCount: orders.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 10),
                  itemBuilder: (context, index) {
                    final order = orders[index];
                    return _OrderDataRow(
                      order: order,
                      layout: layout,
                      isSelected: selectedOrderIds.contains(order.id),
                      isStriped: index.isOdd,
                      onSelectionChanged: (selected) =>
                          onToggleSelection(order.id, selected),
                      onTap: () => onRowTap(order),
                    );
                  },
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _TableHeaderRow extends StatelessWidget {
  const _TableHeaderRow({required this.layout});

  final _OrdersTableLayout layout;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 46,
      padding: const EdgeInsets.symmetric(
        horizontal: _OrdersTableMetrics.horizontalPadding,
      ),
      decoration: BoxDecoration(
        color: SoftErpTheme.cardSurfaceAlt,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: SoftErpTheme.border),
      ),
      child: Row(
        children: [
          _HeaderCell('Order ID', width: layout.orderIdWidth),
          _HeaderCell('Date', width: layout.dateWidth),
          _HeaderCell('Party', width: layout.partyWidth),
          _HeaderCell('Item', width: layout.itemWidth),
          _HeaderCell('Purchase Order Number', width: layout.poWidth),
          _HeaderCell('Order Quantity', width: layout.quantityWidth),
          _HeaderCell('Start Date', width: layout.startDateWidth),
          _HeaderCell('End Date', width: layout.endDateWidth),
          _HeaderCell('Status', width: layout.statusWidth),
        ],
      ),
    );
  }
}

class _HeaderCell extends StatelessWidget {
  const _HeaderCell(this.label, {required this.width});

  final String label;
  final double width;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      child: Text(
        label,
        style: const TextStyle(
          color: SoftErpTheme.textSecondary,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _OrderDataRow extends StatelessWidget {
  const _OrderDataRow({
    required this.order,
    required this.layout,
    required this.isSelected,
    required this.isStriped,
    required this.onSelectionChanged,
    required this.onTap,
  });

  final OrderEntry order;
  final _OrdersTableLayout layout;
  final bool isSelected;
  final bool isStriped;
  final ValueChanged<bool> onSelectionChanged;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return SoftRowCard(
      isSelected: isSelected,
      onTap: onTap,
      child: SizedBox(
        height: 56,
        child: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onLongPress: () => onSelectionChanged(!isSelected),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: _OrdersTableMetrics.horizontalPadding,
            ),
            child: Row(
              children: [
                _DataCell(
                  order.orderNo,
                  width: layout.orderIdWidth,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                  overflow: TextOverflow.ellipsis,
                ),
                _DataCell(
                  _formatDate(order.createdAt),
                  width: layout.dateWidth,
                ),
                _DataCell(
                  order.clientName,
                  width: layout.partyWidth,
                  overflow: TextOverflow.ellipsis,
                ),
                _DataCell(
                  order.variationPathLabel.isEmpty ||
                          order.variationPathLabel == order.itemName
                      ? order.itemName
                      : '${order.itemName} · ${order.variationPathLabel}',
                  width: layout.itemWidth,
                  overflow: TextOverflow.ellipsis,
                ),
                _DataCell(
                  order.poNumber.isEmpty ? '—' : order.poNumber,
                  width: layout.poWidth,
                  overflow: TextOverflow.ellipsis,
                ),
                _DataCell(
                  '${order.quantity} Pieces',
                  width: layout.quantityWidth,
                  overflow: TextOverflow.ellipsis,
                ),
                _DataCell(
                  _formatDate(order.startDate),
                  width: layout.startDateWidth,
                ),
                _DataCell(
                  _formatDate(order.endDate),
                  width: layout.endDateWidth,
                ),
                SizedBox(
                  width: layout.statusWidth,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: _StatusPill(status: order.status),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _formatDate(DateTime? value) {
    if (value == null) {
      return '—';
    }
    final day = value.day.toString().padLeft(2, '0');
    final month = value.month.toString().padLeft(2, '0');
    return '$day-$month-${value.year}';
  }
}

class _DataCell extends StatelessWidget {
  const _DataCell(
    this.text, {
    required this.width,
    this.style,
    this.overflow = TextOverflow.clip,
  });

  final String text;
  final double width;
  final TextStyle? style;
  final TextOverflow overflow;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      child: Padding(
        padding: const EdgeInsets.only(right: 12),
        child: Text(
          text,
          softWrap: false,
          maxLines: 1,
          overflow: overflow,
          style: const TextStyle(
            color: SoftErpTheme.textPrimary,
            fontSize: 13,
          ).merge(style),
        ),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.status});

  final OrderStatus status;

  @override
  Widget build(BuildContext context) {
    final scheme = switch (status) {
      OrderStatus.notStarted => (
        bg: SoftErpTheme.warningBg,
        border: const Color(0xFFE8D0A6),
        text: SoftErpTheme.warningText,
      ),
      OrderStatus.inProgress => (
        bg: SoftErpTheme.infoBg,
        border: const Color(0xFFBDD0F8),
        text: SoftErpTheme.infoText,
      ),
      OrderStatus.completed => (
        bg: SoftErpTheme.successBg,
        border: const Color(0xFFB7DEBF),
        text: SoftErpTheme.successText,
      ),
      OrderStatus.delayed => (
        bg: SoftErpTheme.dangerBg,
        border: const Color(0xFFF0B4B4),
        text: SoftErpTheme.dangerText,
      ),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: scheme.bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: scheme.border),
      ),
      child: Text(
        status.label,
        style: TextStyle(
          color: scheme.text,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _OrdersTableMetrics {
  static const double horizontalPadding = 18;
  static const double orderIdWidth = 120;
  static const double dateWidth = 122;
  static const double partyWidth = 212;
  static const double itemWidth = 236;
  static const double poWidth = 214;
  static const double quantityWidth = 150;
  static const double startDateWidth = 136;
  static const double endDateWidth = 136;
  static const double statusWidth = 128;

  static const double totalWidth =
      horizontalPadding * 2 +
      orderIdWidth +
      dateWidth +
      partyWidth +
      itemWidth +
      poWidth +
      quantityWidth +
      startDateWidth +
      endDateWidth +
      statusWidth;
}

class _OrdersTableLayout {
  const _OrdersTableLayout({
    required this.orderIdWidth,
    required this.dateWidth,
    required this.partyWidth,
    required this.itemWidth,
    required this.poWidth,
    required this.quantityWidth,
    required this.startDateWidth,
    required this.endDateWidth,
    required this.statusWidth,
  });

  final double orderIdWidth;
  final double dateWidth;
  final double partyWidth;
  final double itemWidth;
  final double poWidth;
  final double quantityWidth;
  final double startDateWidth;
  final double endDateWidth;
  final double statusWidth;

  static _OrdersTableLayout fromContainerWidth(double containerWidth) {
    final contentWidth =
        (containerWidth - (_OrdersTableMetrics.horizontalPadding * 2) - 8)
            .clamp(0.0, double.infinity);
    final baseContentWidth =
        _OrdersTableMetrics.totalWidth -
        (_OrdersTableMetrics.horizontalPadding * 2);
    final scale = baseContentWidth == 0 ? 1.0 : contentWidth / baseContentWidth;

    return _OrdersTableLayout(
      orderIdWidth: _OrdersTableMetrics.orderIdWidth * scale,
      dateWidth: _OrdersTableMetrics.dateWidth * scale,
      partyWidth: _OrdersTableMetrics.partyWidth * scale,
      itemWidth: _OrdersTableMetrics.itemWidth * scale,
      poWidth: _OrdersTableMetrics.poWidth * scale,
      quantityWidth: _OrdersTableMetrics.quantityWidth * scale,
      startDateWidth: _OrdersTableMetrics.startDateWidth * scale,
      endDateWidth: _OrdersTableMetrics.endDateWidth * scale,
      statusWidth: _OrdersTableMetrics.statusWidth * scale,
    );
  }
}

class _OrderEditorSheet extends StatefulWidget {
  const _OrderEditorSheet();

  @override
  State<_OrderEditorSheet> createState() => _OrderEditorSheetState();
}

class _OrderEditorSheetState extends State<_OrderEditorSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _orderNoController;
  late final TextEditingController _poNumberController;
  late final TextEditingController _clientCodeController;
  late final TextEditingController _quantityController;
  late final TextEditingController _startDateController;
  late final TextEditingController _endDateController;

  int? _selectedClientId;
  int? _selectedItemId;
  final Map<String, int> _selectionState = <String, int>{};
  OrderStatus _selectedStatus = OrderStatus.notStarted;
  DateTime? _startDate;
  DateTime? _endDate;
  late List<_CompletionShortcutPreset> _completionShortcuts;

  String? get _clientCodeError {
    final text = _clientCodeController.text.trim();
    if (_selectedClientId == null) {
      return null;
    }
    if (text.isEmpty) {
      return 'Selected client has no client code in master.';
    }
    return null;
  }

  @override
  void initState() {
    super.initState();
    _orderNoController = TextEditingController();
    _poNumberController = TextEditingController();
    _clientCodeController = TextEditingController();
    _quantityController = TextEditingController(text: '1');
    _startDateController = TextEditingController();
    _endDateController = TextEditingController();
    _completionShortcuts = const <_CompletionShortcutPreset>[
      _CompletionShortcutPreset(amount: 3, unit: _CompletionShortcutUnit.days),
      _CompletionShortcutPreset(amount: 3, unit: _CompletionShortcutUnit.weeks),
    ];
  }

  @override
  void dispose() {
    _orderNoController.dispose();
    _poNumberController.dispose();
    _clientCodeController.dispose();
    _quantityController.dispose();
    _startDateController.dispose();
    _endDateController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final clients = context
        .watch<ClientsProvider>()
        .clients
        .where((client) => !client.isArchived)
        .toList(growable: false);
    final items = context
        .watch<ItemsProvider>()
        .items
        .where((item) => !item.isArchived)
        .toList(growable: false);

    return Container(
      decoration: BoxDecoration(
        color: SoftErpTheme.cardSurface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: SoftErpTheme.border),
        boxShadow: SoftErpTheme.raisedShadow,
      ),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(28, 20, 28, 20),
              decoration: const BoxDecoration(
                border: Border(bottom: BorderSide(color: SoftErpTheme.border)),
              ),
              child: Text(
                'Create New Order',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                  color: SoftErpTheme.textPrimary,
                ),
              ),
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(56, 18, 56, 18),
                child: clients.isEmpty || items.isEmpty
                    ? _DependencyMessage(
                        hasClients: clients.isNotEmpty,
                        hasItems: items.isNotEmpty,
                      )
                    : LayoutBuilder(
                        builder: (context, constraints) {
                          final fieldWidth = ((constraints.maxWidth - 24) / 2)
                              .clamp(260.0, 300.0);
                          final children = <Widget>[
                            SizedBox(
                              width: fieldWidth,
                              child: _OrderEditorField(
                                label: 'Order No',
                                child: TextFormField(
                                  key: const ValueKey<String>(
                                    'orders-editor-order-no-field',
                                  ),
                                  controller: _orderNoController,
                                  decoration: _inputDecoration(
                                    hintText: 'Enter',
                                  ),
                                  textInputAction: TextInputAction.next,
                                  validator: (value) {
                                    if ((value ?? '').trim().isEmpty) {
                                      return 'Enter an order number.';
                                    }
                                    return null;
                                  },
                                ),
                              ),
                            ),
                            SizedBox(
                              width: fieldWidth,
                              child: _OrderEditorField(
                                label: 'Purchase Order No.',
                                child: TextFormField(
                                  key: const ValueKey<String>(
                                    'orders-editor-po-number-field',
                                  ),
                                  controller: _poNumberController,
                                  decoration: _inputDecoration(
                                    hintText: 'Enter',
                                  ),
                                  textInputAction: TextInputAction.next,
                                ),
                              ),
                            ),
                            SizedBox(
                              width: fieldWidth,
                              child: _OrderEditorField(
                                label: 'Client',
                                child: SearchableSelectField<int>(
                                  key: const ValueKey<String>(
                                    'orders-editor-client-field',
                                  ),
                                  tapTargetKey: const ValueKey<String>(
                                    'orders-editor-client-field',
                                  ),
                                  value: _selectedClientId,
                                  decoration: _inputDecoration(
                                    hintText: 'Select',
                                  ),
                                  dialogTitle: 'Client',
                                  searchHintText: 'Search client',
                                  options: clients
                                      .map(
                                        (client) => SearchableSelectOption<int>(
                                          value: client.id,
                                          label: client.displayLabel,
                                        ),
                                      )
                                      .toList(growable: false),
                                  onChanged: (value) {
                                    setState(() {
                                      _selectedClientId = value;
                                      final selected = _selectedClient(clients);
                                      _clientCodeController.text =
                                          _resolveClientCode(selected);
                                    });
                                  },
                                  validator: (value) {
                                    if (value == null) {
                                      return 'Select a client.';
                                    }
                                    return null;
                                  },
                                ),
                              ),
                            ),
                            SizedBox(
                              width: fieldWidth,
                              child: _OrderEditorField(
                                label: 'Client Code',
                                child: TextFormField(
                                  key: const ValueKey<String>(
                                    'orders-editor-client-code-field',
                                  ),
                                  controller: _clientCodeController,
                                  readOnly: true,
                                  decoration: _inputDecoration(
                                    hintText: 'Enter',
                                    errorText: _clientCodeError,
                                  ),
                                ),
                              ),
                            ),
                            SizedBox(
                              width: fieldWidth,
                              child: _OrderEditorField(
                                label: 'Item',
                                child: SearchableSelectField<int>(
                                  key: const ValueKey<String>(
                                    'orders-editor-item-field',
                                  ),
                                  tapTargetKey: const ValueKey<String>(
                                    'orders-editor-item-field',
                                  ),
                                  value: _selectedItemId,
                                  decoration: _inputDecoration(
                                    hintText: 'Select',
                                  ),
                                  dialogTitle: 'Item',
                                  searchHintText: 'Search item',
                                  options: items
                                      .map(
                                        (item) => SearchableSelectOption<int>(
                                          value: item.id,
                                          label: item.displayName,
                                        ),
                                      )
                                      .toList(growable: false),
                                  onChanged: (value) {
                                    setState(() {
                                      _selectedItemId = value;
                                      _selectionState.clear();
                                    });
                                  },
                                  validator: (value) {
                                    if (value == null) {
                                      return 'Select an item.';
                                    }
                                    return null;
                                  },
                                ),
                              ),
                            ),
                            ..._buildVariationSelectors(items, fieldWidth),
                            SizedBox(
                              width: fieldWidth,
                              child: _OrderEditorField(
                                label: 'Quantity / Unit',
                                child: TextFormField(
                                  key: const ValueKey<String>(
                                    'orders-editor-quantity-field',
                                  ),
                                  controller: _quantityController,
                                  decoration: _inputDecoration(
                                    hintText: 'Enter',
                                  ),
                                  keyboardType: TextInputType.number,
                                  validator: (value) {
                                    final quantity = int.tryParse(
                                      (value ?? '').trim(),
                                    );
                                    if (quantity == null || quantity <= 0) {
                                      return 'Enter a valid quantity.';
                                    }
                                    return null;
                                  },
                                ),
                              ),
                            ),
                            SizedBox(
                              width: fieldWidth,
                              child: _OrderEditorField(
                                label: 'Status',
                                child: SearchableSelectField<OrderStatus>(
                                  key: const ValueKey<String>(
                                    'orders-editor-status-field',
                                  ),
                                  tapTargetKey: const ValueKey<String>(
                                    'orders-editor-status-field',
                                  ),
                                  value: _selectedStatus,
                                  decoration: _inputDecoration(
                                    hintText: 'Select',
                                  ),
                                  dialogTitle: 'Status',
                                  searchHintText: 'Search status',
                                  options: OrderStatus.values
                                      .map(
                                        (status) =>
                                            SearchableSelectOption<OrderStatus>(
                                              value: status,
                                              label: status.label,
                                            ),
                                      )
                                      .toList(growable: false),
                                  onChanged: (value) {
                                    if (value == null) {
                                      return;
                                    }
                                    setState(() {
                                      _selectedStatus = value;
                                    });
                                  },
                                ),
                              ),
                            ),
                            SizedBox(
                              width: fieldWidth,
                              child: _DateField(
                                key: const ValueKey<String>(
                                  'orders-editor-start-date-field',
                                ),
                                label: 'Start Date',
                                controller: _startDateController,
                                onTap: () => _pickDate(
                                  context,
                                  initial: _startDate ?? DateTime.now(),
                                  onSelected: (value) {
                                    setState(() {
                                      _startDate = value;
                                      _startDateController.text = _formatDate(
                                        value,
                                      );
                                    });
                                  },
                                ),
                              ),
                            ),
                            SizedBox(
                              width: fieldWidth,
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  _DateField(
                                    key: const ValueKey<String>(
                                      'orders-editor-end-date-field',
                                    ),
                                    label: 'Estimated Completion Date',
                                    controller: _endDateController,
                                    onTap: () => _pickDate(
                                      context,
                                      initial:
                                          _endDate ??
                                          _startDate ??
                                          DateTime.now(),
                                      onSelected: (value) {
                                        setState(() {
                                          _endDate = value;
                                          _endDateController.text = _formatDate(
                                            value,
                                          );
                                        });
                                      },
                                    ),
                                  ),
                                  const SizedBox(height: 10),
                                  Wrap(
                                    spacing: 8,
                                    runSpacing: 8,
                                    children: [
                                      for (
                                        var index = 0;
                                        index < _completionShortcuts.length;
                                        index++
                                      )
                                        _CompletionShortcutButton(
                                          key: ValueKey<String>(
                                            'orders-editor-shortcut-$index',
                                          ),
                                          label:
                                              _completionShortcuts[index].label,
                                          onTap: () => _applyCompletionShortcut(
                                            _completionShortcuts[index],
                                          ),
                                        ),
                                      _CompletionShortcutButton(
                                        key: const ValueKey<String>(
                                          'orders-editor-shortcut-add',
                                        ),
                                        label: 'Add',
                                        isGhost: true,
                                        onTap: _openCompletionShortcutEditor,
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          ];
                          return Wrap(
                            spacing: 24,
                            runSpacing: 18,
                            children: children,
                          );
                        },
                      ),
              ),
            ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(24, 14, 24, 14),
              decoration: const BoxDecoration(
                border: Border(top: BorderSide(color: SoftErpTheme.border)),
              ),
              child: Wrap(
                alignment: WrapAlignment.end,
                spacing: 10,
                runSpacing: 10,
                children: [
                  AppButton(
                    label: 'Cancel',
                    variant: AppButtonVariant.secondary,
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                  AppButton(
                    label: 'Create Order',
                    onPressed: clients.isEmpty || items.isEmpty
                        ? null
                        : () => _submit(context, clients, items),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _submit(
    BuildContext context,
    List<ClientDefinition> clients,
    List<ItemDefinition> items,
  ) async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    final selectedClient = _selectedClient(clients);
    final selectedItem = _selectedItem(items);
    final selectedLeaf = _selectedLeafValue(selectedItem);
    if (selectedClient == null ||
        selectedItem == null ||
        selectedLeaf == null) {
      return;
    }
    final clientCode = _resolveClientCode(selectedClient);
    if (clientCode.isEmpty) {
      setState(() {});
      return;
    }

    final result = await context.read<OrdersProvider>().createOrder(
      CreateOrderInput(
        orderNo: _orderNoController.text,
        clientId: selectedClient.id,
        clientName: selectedClient.name,
        poNumber: _poNumberController.text,
        clientCode: clientCode,
        itemId: selectedItem.id,
        itemName: selectedItem.displayName,
        variationLeafNodeId: selectedLeaf.id,
        variationPathLabel: selectedLeaf.displayName,
        variationPathNodeIds: _selectedPathNodeIds(selectedLeaf),
        quantity: int.parse(_quantityController.text.trim()),
        status: _selectedStatus,
        startDate: _startDate,
        endDate: _endDate,
      ),
    );

    if (!context.mounted) {
      return;
    }

    if (result != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Order created successfully.')),
      );
      Navigator.of(context).pop();
      return;
    }

    final message =
        context.read<OrdersProvider>().errorMessage ??
        'Unable to create order. Please try again.';
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  ClientDefinition? _selectedClient(List<ClientDefinition> clients) {
    for (final client in clients) {
      if (client.id == _selectedClientId) {
        return client;
      }
    }
    return null;
  }

  ItemDefinition? _selectedItem(List<ItemDefinition> items) {
    for (final item in items) {
      if (item.id == _selectedItemId) {
        return item;
      }
    }
    return null;
  }

  List<Widget> _buildVariationSelectors(
    List<ItemDefinition> items,
    double fieldWidth,
  ) {
    final selectedItem = _selectedItem(items);
    if (selectedItem == null) {
      return [
        SizedBox(
          width: fieldWidth,
          child: _OrderEditorField(
            label: 'Variation Path',
            child: SearchableSelectField<int>(
              key: const ValueKey<String>('orders-editor-variation-path-field'),
              tapTargetKey: const ValueKey<String>(
                'orders-editor-variation-path-field',
              ),
              value: null,
              decoration: _inputDecoration(hintText: 'Select'),
              options: const <SearchableSelectOption<int>>[],
              fieldEnabled: false,
              onChanged: (_) {},
              validator: (value) {
                if (value == null) {
                  return 'Select an item first.';
                }
                return null;
              },
            ),
          ),
        ),
      ];
    }

    final steps = _buildSelectionSteps(selectedItem);
    if (steps.isEmpty) {
      return [
        SizedBox(
          width: fieldWidth,
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFFFF7ED),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFF4C98B)),
            ),
            child: const Text(
              'This item does not have any active orderable leaf paths yet.',
            ),
          ),
        ),
      ];
    }

    final widgets = <Widget>[];
    for (var index = 0; index < steps.length; index++) {
      final step = steps[index];
      widgets.add(
        SizedBox(
          width: fieldWidth,
          child: _OrderEditorField(
            label: step.label,
            child: SearchableSelectField<int>(
              key: ValueKey<String>(
                'orders-editor-${step.label.toLowerCase().replaceAll(' ', '-')}-field',
              ),
              tapTargetKey: ValueKey<String>(
                'orders-editor-${step.label.toLowerCase().replaceAll(' ', '-')}-field',
              ),
              value: step.selectedId,
              decoration: _inputDecoration(hintText: 'Select'),
              dialogTitle: step.label,
              searchHintText: 'Search ${step.label.toLowerCase()}',
              options: step.options
                  .map(
                    (node) => SearchableSelectOption<int>(
                      value: node.id,
                      label: node.name,
                    ),
                  )
                  .toList(growable: false),
              onChanged: (value) {
                setState(() {
                  if (value == null) {
                    _selectionState.remove(step.stateKey);
                  } else {
                    _selectionState[step.stateKey] = value;
                  }
                  _clearSelectionAfter(steps, index);
                });
              },
              validator: (value) {
                if (step.required && value == null) {
                  return 'Select ${step.label.toLowerCase()}.';
                }
                return null;
              },
            ),
          ),
        ),
      );
    }
    final selectedLeaf = _selectedLeafValue(selectedItem);
    if (selectedLeaf != null) {
      widgets.add(
        SizedBox(
          width: fieldWidth,
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFF8FAFC),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFE2E8F0)),
            ),
            child: Text('Selected Path: ${selectedLeaf.displayName}'),
          ),
        ),
      );
    }
    return widgets;
  }

  List<_OrderSelectionStep> _buildSelectionSteps(ItemDefinition item) {
    final steps = <_OrderSelectionStep>[];
    List<ItemVariationNodeDefinition> propertyOptions = item.topLevelProperties;
    String branchKey = 'root';
    while (propertyOptions.isNotEmpty) {
      ItemVariationNodeDefinition propertyNode;
      if (propertyOptions.length > 1) {
        final propertySelectionKey = 'property:$branchKey';
        final selectedPropertyId = _selectionState[propertySelectionKey];
        steps.add(
          _OrderSelectionStep(
            label: 'Property Group',
            stateKey: propertySelectionKey,
            selectedId:
                propertyOptions.any((node) => node.id == selectedPropertyId)
                ? selectedPropertyId
                : null,
            options: propertyOptions,
            required: true,
          ),
        );
        propertyNode =
            propertyOptions
                .where((node) => node.id == selectedPropertyId)
                .firstOrNull ??
            propertyOptions.first;
        if (selectedPropertyId == null) {
          break;
        }
      } else {
        propertyNode = propertyOptions.first;
      }

      final valueSelectionKey = 'value:${propertyNode.id}';
      final valueOptions = propertyNode.activeChildren
          .where((node) => node.kind == ItemVariationNodeKind.value)
          .toList(growable: false);
      final selectedValueId = _selectionState[valueSelectionKey];
      steps.add(
        _OrderSelectionStep(
          label: propertyNode.name,
          stateKey: valueSelectionKey,
          selectedId: valueOptions.any((node) => node.id == selectedValueId)
              ? selectedValueId
              : null,
          options: valueOptions,
          required: true,
        ),
      );
      final selectedValue = valueOptions
          .where((node) => node.id == selectedValueId)
          .firstOrNull;
      if (selectedValue == null) {
        break;
      }
      propertyOptions = selectedValue.activeChildren
          .where((node) => node.kind == ItemVariationNodeKind.property)
          .toList(growable: false);
      branchKey = selectedValue.id.toString();
    }
    return steps;
  }

  void _clearSelectionAfter(List<_OrderSelectionStep> steps, int index) {
    for (var cursor = index + 1; cursor < steps.length; cursor++) {
      _selectionState.remove(steps[cursor].stateKey);
    }
  }

  ItemVariationNodeDefinition? _selectedLeafValue(ItemDefinition? item) {
    if (item == null) {
      return null;
    }
    List<ItemVariationNodeDefinition> propertyOptions = item.topLevelProperties;
    var branchKey = 'root';
    while (propertyOptions.isNotEmpty) {
      ItemVariationNodeDefinition propertyNode;
      if (propertyOptions.length > 1) {
        final propertySelection = _selectionState['property:$branchKey'];
        propertyNode =
            propertyOptions
                .where((node) => node.id == propertySelection)
                .firstOrNull ??
            propertyOptions.first;
        if (propertySelection == null) {
          return null;
        }
      } else {
        propertyNode = propertyOptions.first;
      }
      final selectedValueId = _selectionState['value:${propertyNode.id}'];
      final selectedValue = propertyNode.activeChildren
          .where((node) => node.kind == ItemVariationNodeKind.value)
          .where((node) => node.id == selectedValueId)
          .firstOrNull;
      if (selectedValue == null) {
        return null;
      }
      final nextProperties = selectedValue.activeChildren
          .where((node) => node.kind == ItemVariationNodeKind.property)
          .toList(growable: false);
      if (nextProperties.isEmpty) {
        return selectedValue;
      }
      propertyOptions = nextProperties;
      branchKey = selectedValue.id.toString();
    }
    return null;
  }

  List<int> _selectedPathNodeIds(ItemVariationNodeDefinition leaf) {
    final path = <int>[];

    void visit(ItemVariationNodeDefinition node, List<int> current) {
      final next = [...current, node.id];
      if (node.id == leaf.id) {
        path
          ..clear()
          ..addAll(next);
        return;
      }
      for (final child in node.children) {
        visit(child, next);
      }
    }

    final item = _selectedItem(
      context
          .read<ItemsProvider>()
          .items
          .where((entry) => !entry.isArchived)
          .toList(growable: false),
    );
    if (item != null) {
      for (final root in item.variationTree) {
        visit(root, const []);
      }
    }
    return path;
  }

  String _resolveClientCode(ClientDefinition? client) {
    return client?.alias.trim() ?? '';
  }

  InputDecoration _inputDecoration({String? hintText, String? errorText}) {
    return InputDecoration(
      hintText: hintText,
      hintStyle: const TextStyle(
        color: SoftErpTheme.textSecondary,
        fontSize: 14,
      ),
      errorText: errorText,
      filled: true,
      fillColor: SoftErpTheme.cardSurfaceAlt,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: SoftErpTheme.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: SoftErpTheme.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: SoftErpTheme.accent),
      ),
    );
  }

  Future<void> _pickDate(
    BuildContext context, {
    required DateTime initial,
    required ValueChanged<DateTime> onSelected,
  }) async {
    final picked = await showDatePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
      initialDate: initial,
    );
    if (picked != null) {
      onSelected(picked);
    }
  }

  String _formatDate(DateTime value) {
    final day = value.day.toString().padLeft(2, '0');
    final month = value.month.toString().padLeft(2, '0');
    return '$day-$month-${value.year}';
  }

  void _applyCompletionShortcut(_CompletionShortcutPreset preset) {
    final anchorDate = _startDate ?? DateTime.now();
    final dayOffset = switch (preset.unit) {
      _CompletionShortcutUnit.days => preset.amount,
      _CompletionShortcutUnit.weeks => preset.amount * 7,
    };
    final estimatedDate = anchorDate.add(Duration(days: dayOffset));
    setState(() {
      _endDate = estimatedDate;
      _endDateController.text = _formatDate(estimatedDate);
    });
  }

  Future<void> _openCompletionShortcutEditor() async {
    final updatedShortcuts = await showDialog<List<_CompletionShortcutPreset>>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: _CompletionShortcutEditorDialog(
            initialShortcuts: _completionShortcuts,
          ),
        ),
      ),
    );
    if (updatedShortcuts == null || updatedShortcuts.isEmpty) {
      return;
    }
    setState(() {
      _completionShortcuts = updatedShortcuts.take(3).toList(growable: false);
    });
  }
}

class _OrderLifecycleEditorSheet extends StatefulWidget {
  const _OrderLifecycleEditorSheet({required this.order});

  final OrderEntry order;

  @override
  State<_OrderLifecycleEditorSheet> createState() =>
      _OrderLifecycleEditorSheetState();
}

class _OrderLifecycleEditorSheetState
    extends State<_OrderLifecycleEditorSheet> {
  late OrderStatus _status;
  late final TextEditingController _startDateController;
  late final TextEditingController _endDateController;
  DateTime? _startDate;
  DateTime? _endDate;

  @override
  void initState() {
    super.initState();
    _status = widget.order.status;
    _startDate = widget.order.startDate;
    _endDate = widget.order.endDate;
    _startDateController = TextEditingController(
      text: _startDate == null ? '' : _formatDate(_startDate!),
    );
    _endDateController = TextEditingController(
      text: _endDate == null ? '' : _formatDate(_endDate!),
    );
  }

  @override
  void dispose() {
    _startDateController.dispose();
    _endDateController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: SoftErpTheme.cardSurface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: SoftErpTheme.border),
        boxShadow: SoftErpTheme.raisedShadow,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Update Order',
            style: Theme.of(
              context,
            ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Text(
            '${widget.order.orderNo} • ${widget.order.clientName}',
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: SoftErpTheme.textSecondary),
          ),
          const SizedBox(height: 20),
          SearchableSelectField<OrderStatus>(
            key: const ValueKey<String>('orders-lifecycle-status-field'),
            tapTargetKey: const ValueKey<String>(
              'orders-lifecycle-status-field',
            ),
            value: _status,
            decoration: const InputDecoration(
              labelText: 'Status',
              filled: true,
              fillColor: SoftErpTheme.cardSurfaceAlt,
            ),
            dialogTitle: 'Status',
            searchHintText: 'Search status',
            options: OrderStatus.values
                .map(
                  (status) => SearchableSelectOption<OrderStatus>(
                    value: status,
                    label: status.label,
                  ),
                )
                .toList(growable: false),
            onChanged: (value) {
              if (value != null) {
                setState(() {
                  _status = value;
                });
              }
            },
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: _DateField(
                  label: 'Start Date',
                  controller: _startDateController,
                  onTap: () => _pickDate(
                    context,
                    initial: _startDate ?? widget.order.createdAt,
                    onSelected: (value) {
                      setState(() {
                        _startDate = value;
                        _startDateController.text = _formatDate(value);
                      });
                    },
                  ),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: _DateField(
                  label: 'End Date',
                  controller: _endDateController,
                  onTap: () => _pickDate(
                    context,
                    initial: _endDate ?? _startDate ?? widget.order.createdAt,
                    onSelected: (value) {
                      setState(() {
                        _endDate = value;
                        _endDateController.text = _formatDate(value);
                      });
                    },
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 12,
            runSpacing: 10,
            children: [
              AppButton(
                label: 'Close',
                variant: AppButtonVariant.secondary,
                onPressed: () => Navigator.of(context).pop(),
              ),
              AppButton(
                label: 'Save',
                onPressed: () async {
                  final result = await context
                      .read<OrdersProvider>()
                      .updateOrderLifecycle(
                        UpdateOrderLifecycleInput(
                          id: widget.order.id,
                          status: _status,
                          startDate: _startDate,
                          endDate: _endDate,
                        ),
                      );
                  if (!context.mounted) {
                    return;
                  }

                  if (result != null) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Order updated successfully.'),
                      ),
                    );
                    Navigator.of(context).pop();
                    return;
                  }

                  final message =
                      context.read<OrdersProvider>().errorMessage ??
                      'Unable to update order. Please try again.';
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(SnackBar(content: Text(message)));
                },
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _pickDate(
    BuildContext context, {
    required DateTime initial,
    required ValueChanged<DateTime> onSelected,
  }) async {
    final picked = await showDatePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
      initialDate: initial,
    );
    if (picked != null) {
      onSelected(picked);
    }
  }

  String _formatDate(DateTime value) {
    final day = value.day.toString().padLeft(2, '0');
    final month = value.month.toString().padLeft(2, '0');
    return '$day-$month-${value.year}';
  }
}

class _OrderDetailsSheet extends StatelessWidget {
  const _OrderDetailsSheet({required this.order, required this.onEdit});

  final OrderEntry order;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final detailRows = <({String label, String value})>[
      (label: 'Order Code', value: order.orderNo),
      (label: 'Purchase order no.', value: _emptyFallback(order.poNumber)),
      (label: 'Item', value: order.itemName),
      (label: 'Purchase order item Code', value: '—'),
      (label: 'Quantity / Unit', value: '${order.quantity} Pieces'),
      (label: 'Start Date', value: _formatDate(order.startDate)),
      (label: 'Estimated completion date', value: _formatDate(order.endDate)),
    ];

    return Material(
      color: Colors.transparent,
      child: Container(
        decoration: BoxDecoration(
          color: SoftErpTheme.cardSurface,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(24),
            bottomLeft: Radius.circular(24),
          ),
          border: Border.all(color: SoftErpTheme.border),
          boxShadow: SoftErpTheme.raisedShadow,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.max,
          children: [
            Container(
              height: 60,
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 24),
              decoration: const BoxDecoration(
                color: SoftErpTheme.shellSurface,
                borderRadius: BorderRadius.only(topLeft: Radius.circular(24)),
              ),
              alignment: Alignment.centerLeft,
              child: const Text(
                'Order Details',
                style: TextStyle(
                  color: SoftErpTheme.textPrimary,
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            Expanded(
              child: Align(
                alignment: Alignment.topLeft,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.only(bottom: 24),
                        decoration: const BoxDecoration(
                          border: Border(
                            bottom: BorderSide(color: SoftErpTheme.border),
                          ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: detailRows
                              .map(
                                (entry) => Padding(
                                  padding: const EdgeInsets.only(bottom: 18),
                                  child: SizedBox(
                                    width: 360,
                                    child: Row(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        SizedBox(
                                          width: 220,
                                          child: Text(
                                            entry.label,
                                            style: const TextStyle(
                                              color: SoftErpTheme.textSecondary,
                                              fontSize: 14,
                                            ),
                                          ),
                                        ),
                                        Expanded(
                                          child: Text(
                                            entry.value,
                                            style: const TextStyle(
                                              color: SoftErpTheme.textPrimary,
                                              fontSize: 16,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              )
                              .toList(growable: false),
                        ),
                      ),
                      const SizedBox(height: 16),
                      SizedBox(
                        width: 360,
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            const SizedBox(
                              width: 220,
                              child: Text(
                                'Status',
                                style: TextStyle(
                                  color: SoftErpTheme.textSecondary,
                                  fontSize: 14,
                                ),
                              ),
                            ),
                            Flexible(
                              child: Align(
                                alignment: Alignment.centerLeft,
                                child: _StatusPill(status: order.status),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(24),
              decoration: const BoxDecoration(
                border: Border(top: BorderSide(color: SoftErpTheme.border)),
              ),
              child: Wrap(
                alignment: WrapAlignment.end,
                spacing: 10,
                runSpacing: 10,
                children: [
                  AppButton(
                    label: 'Cancel',
                    variant: AppButtonVariant.secondary,
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                  _OrderDetailActionButton(label: 'Edit', onPressed: onEdit),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  static String _emptyFallback(String value) {
    return value.trim().isEmpty ? '—' : value;
  }

  static String _formatDate(DateTime? value) {
    if (value == null) {
      return '—';
    }
    final day = value.day.toString().padLeft(2, '0');
    final month = value.month.toString().padLeft(2, '0');
    return '$day-$month-${value.year}';
  }
}

class _OrderDetailActionButton extends StatelessWidget {
  const _OrderDetailActionButton({
    required this.label,
    required this.onPressed,
  });

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 44,
      child: FilledButton(
        onPressed: onPressed,
        style: FilledButton.styleFrom(
          elevation: 3,
          backgroundColor: SoftErpTheme.accent,
          foregroundColor: Colors.white,
          shadowColor: const Color(0x2A6366F1),
          padding: const EdgeInsets.symmetric(horizontal: 24),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
        child: Text(
          label,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}

class _OrdersMessageBanner extends StatelessWidget {
  const _OrdersMessageBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF2EF),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFF1B8AE)),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.error_outline_rounded,
            color: Color(0xFFC2410C),
            size: 18,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: const Color(0xFF9A3412),
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _OrderEditorField extends StatelessWidget {
  const _OrderEditorField({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            fontSize: 14,
            color: SoftErpTheme.textSecondary,
          ),
        ),
        const SizedBox(height: 4),
        child,
      ],
    );
  }
}

class _DateField extends StatelessWidget {
  const _DateField({
    super.key,
    required this.label,
    required this.controller,
    required this.onTap,
  });

  final String label;
  final TextEditingController controller;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return _OrderEditorField(
      label: label,
      child: TextFormField(
        key: key,
        controller: controller,
        readOnly: true,
        onTap: onTap,
        decoration: InputDecoration(
          hintText: 'Enter',
          hintStyle: const TextStyle(
            color: SoftErpTheme.textSecondary,
            fontSize: 14,
          ),
          filled: true,
          fillColor: SoftErpTheme.cardSurfaceAlt,
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 14,
            vertical: 13,
          ),
          suffixIcon: const Icon(
            Icons.calendar_today_outlined,
            size: 18,
            color: SoftErpTheme.textSecondary,
          ),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: const BorderSide(color: SoftErpTheme.border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: const BorderSide(color: SoftErpTheme.border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: const BorderSide(color: SoftErpTheme.accent),
          ),
        ),
      ),
    );
  }
}

class _CompletionShortcutButton extends StatelessWidget {
  const _CompletionShortcutButton({
    super.key,
    required this.label,
    required this.onTap,
    this.isGhost = false,
  });

  final String label;
  final VoidCallback onTap;
  final bool isGhost;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(
          color: isGhost ? SoftErpTheme.cardSurface : const Color(0xFFF1EEFF),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: isGhost ? SoftErpTheme.border : const Color(0xFFD9D2FF),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: isGhost ? SoftErpTheme.textSecondary : SoftErpTheme.accent,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _CompletionShortcutEditorDialog extends StatefulWidget {
  const _CompletionShortcutEditorDialog({required this.initialShortcuts});

  final List<_CompletionShortcutPreset> initialShortcuts;

  @override
  State<_CompletionShortcutEditorDialog> createState() =>
      _CompletionShortcutEditorDialogState();
}

class _CompletionShortcutEditorDialogState
    extends State<_CompletionShortcutEditorDialog> {
  late final List<TextEditingController> _amountControllers;
  late final List<_CompletionShortcutUnit> _units;
  late bool _showThirdShortcut;

  @override
  void initState() {
    super.initState();
    final drafts = List<_CompletionShortcutDraft>.generate(3, (index) {
      if (index < widget.initialShortcuts.length) {
        final shortcut = widget.initialShortcuts[index];
        return _CompletionShortcutDraft(
          amountText: shortcut.amount.toString(),
          unit: shortcut.unit,
        );
      }
      return const _CompletionShortcutDraft(
        amountText: '',
        unit: _CompletionShortcutUnit.days,
      );
    });
    _amountControllers = drafts
        .map((draft) => TextEditingController(text: draft.amountText))
        .toList(growable: false);
    _units = drafts.map((draft) => draft.unit).toList(growable: false);
    _showThirdShortcut = widget.initialShortcuts.length > 2;
  }

  @override
  void dispose() {
    for (final controller in _amountControllers) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final visibleCount = _showThirdShortcut ? 3 : 2;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: SoftErpTheme.cardSurface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: SoftErpTheme.border),
        boxShadow: SoftErpTheme.raisedShadow,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Edit Completion Buttons',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w700,
              color: const Color(0xFF2F3441),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Set quick completion presets for common lead times. People can still enter a date manually when the job runs longer.',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: SoftErpTheme.textSecondary,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 10),
          for (var index = 0; index < visibleCount; index++) ...[
            _buildShortcutCard(index),
            if (index != visibleCount - 1) const SizedBox(height: 8),
          ],
          if (!_showThirdShortcut) ...[
            const SizedBox(height: 8),
            InkWell(
              key: const ValueKey<String>('orders-editor-add-third-shortcut'),
              onTap: () {
                setState(() {
                  _showThirdShortcut = true;
                });
              },
              borderRadius: BorderRadius.circular(12),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: SoftErpTheme.cardSurfaceAlt,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: SoftErpTheme.border),
                ),
                child: const Row(
                  children: [
                    Icon(
                      Icons.add_circle_outline_rounded,
                      size: 18,
                      color: Color(0xFF6049E3),
                    ),
                    SizedBox(width: 10),
                    Text(
                      'Add third shortcut',
                      style: TextStyle(
                        color: Color(0xFF374151),
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 10,
            runSpacing: 10,
            children: [
              AppButton(
                label: 'Cancel',
                variant: AppButtonVariant.secondary,
                onPressed: () => Navigator.of(context).pop(),
              ),
              AppButton(
                label: 'Save',
                onPressed: () {
                  final shortcuts = <_CompletionShortcutPreset>[];
                  for (var index = 0; index < visibleCount; index++) {
                    final amount = int.tryParse(
                      _amountControllers[index].text.trim(),
                    );
                    if (amount == null || amount <= 0) {
                      continue;
                    }
                    shortcuts.add(
                      _CompletionShortcutPreset(
                        amount: amount,
                        unit: _units[index],
                      ),
                    );
                  }
                  Navigator.of(context).pop(shortcuts);
                },
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildShortcutCard(int index) {
    final amountController = _amountControllers[index];
    final previewAmount = int.tryParse(amountController.text.trim());
    final previewLabel = previewAmount == null || previewAmount <= 0
        ? 'Not set'
        : '$previewAmount ${_units[index].label}';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: SoftErpTheme.cardSurfaceAlt,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: SoftErpTheme.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                index == 0
                    ? 'Primary Button'
                    : index == 1
                    ? 'Secondary Button'
                    : 'Extra Button',
                style: const TextStyle(
                  color: Color(0xFF2F3441),
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: const Color(0xFFF2EEFF),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  previewLabel,
                  style: const TextStyle(
                    color: Color(0xFF6049E3),
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const Spacer(),
              if (index == 2) ...[
                InkWell(
                  onTap: () {
                    setState(() {
                      _showThirdShortcut = false;
                      _amountControllers[index].clear();
                      _units[index] = _CompletionShortcutUnit.days;
                    });
                  },
                  borderRadius: BorderRadius.circular(999),
                  child: const Padding(
                    padding: EdgeInsets.all(4),
                    child: Icon(
                      Icons.close_rounded,
                      size: 18,
                      color: Color(0xFF6B7280),
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              SizedBox(
                width: 84,
                child: TextFormField(
                  key: ValueKey<String>('orders-editor-shortcut-amount-$index'),
                  controller: amountController,
                  keyboardType: TextInputType.number,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    labelText: 'Days',
                    hintText: index == 0
                        ? '3'
                        : index == 1
                        ? '3'
                        : '7',
                    isDense: true,
                    filled: true,
                    fillColor: SoftErpTheme.cardSurface,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 10,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                      borderSide: const BorderSide(color: SoftErpTheme.border),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                      borderSide: const BorderSide(color: SoftErpTheme.border),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: _CompletionShortcutUnit.values
                      .map((unit) {
                        final isSelected = _units[index] == unit;
                        return InkWell(
                          key: unit == _CompletionShortcutUnit.days
                              ? ValueKey<String>(
                                  'orders-editor-shortcut-unit-$index',
                                )
                              : null,
                          onTap: () {
                            setState(() {
                              _units[index] = unit;
                            });
                          },
                          borderRadius: BorderRadius.circular(999),
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 150),
                            padding: const EdgeInsets.symmetric(
                              horizontal: 11,
                              vertical: 7,
                            ),
                            decoration: BoxDecoration(
                              color: isSelected
                                  ? SoftErpTheme.accent
                                  : SoftErpTheme.cardSurface,
                              borderRadius: BorderRadius.circular(999),
                              border: Border.all(
                                color: isSelected
                                    ? SoftErpTheme.accent
                                    : SoftErpTheme.border,
                              ),
                            ),
                            child: Text(
                              unit.label,
                              style: TextStyle(
                                color: isSelected
                                    ? Colors.white
                                    : SoftErpTheme.textSecondary,
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        );
                      })
                      .toList(growable: false),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _CompletionShortcutPreset {
  const _CompletionShortcutPreset({required this.amount, required this.unit});

  final int amount;
  final _CompletionShortcutUnit unit;

  String get label => '$amount ${unit.label}';
}

class _CompletionShortcutDraft {
  const _CompletionShortcutDraft({
    required this.amountText,
    required this.unit,
  });

  final String amountText;
  final _CompletionShortcutUnit unit;
}

enum _CompletionShortcutUnit {
  days('days'),
  weeks('weeks');

  const _CompletionShortcutUnit(this.label);

  final String label;
}

class _DependencyMessage extends StatelessWidget {
  const _DependencyMessage({required this.hasClients, required this.hasItems});

  final bool hasClients;
  final bool hasItems;

  @override
  Widget build(BuildContext context) {
    final missing = <String>[
      if (!hasClients) 'at least one active client',
      if (!hasItems) 'at least one active item',
    ].join(' and ');

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: SoftErpTheme.warningBg,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE6CC9D)),
      ),
      child: Text(
        'Orders need $missing before a record can be created.',
        style: Theme.of(
          context,
        ).textTheme.bodyMedium?.copyWith(color: SoftErpTheme.warningText),
      ),
    );
  }
}

class _OrderSelectionStep {
  const _OrderSelectionStep({
    required this.label,
    required this.stateKey,
    required this.selectedId,
    required this.options,
    required this.required,
  });

  final String label;
  final String stateKey;
  final int? selectedId;
  final List<ItemVariationNodeDefinition> options;
  final bool required;
}

class _OrderSummary {
  const _OrderSummary({
    required this.total,
    required this.notStarted,
    required this.inProgress,
    required this.completed,
    required this.delayed,
  });

  final int total;
  final int notStarted;
  final int inProgress;
  final int completed;
  final int delayed;

  factory _OrderSummary.fromOrders(List<OrderEntry> orders) {
    var notStarted = 0;
    var inProgress = 0;
    var completed = 0;
    var delayed = 0;

    for (final order in orders) {
      switch (order.status) {
        case OrderStatus.notStarted:
          notStarted += 1;
        case OrderStatus.inProgress:
          inProgress += 1;
        case OrderStatus.completed:
          completed += 1;
        case OrderStatus.delayed:
          delayed += 1;
      }
    }

    return _OrderSummary(
      total: orders.length,
      notStarted: notStarted,
      inProgress: inProgress,
      completed: completed,
      delayed: delayed,
    );
  }
}

class _MenuValue<T> {
  const _MenuValue({required this.value, required this.label});

  final T value;
  final String label;
}

extension on OrderStatus {
  String get label {
    return switch (this) {
      OrderStatus.notStarted => 'Not Started',
      OrderStatus.inProgress => 'In Progress',
      OrderStatus.completed => 'Completed',
      OrderStatus.delayed => 'Delayed',
    };
  }
}

extension<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
