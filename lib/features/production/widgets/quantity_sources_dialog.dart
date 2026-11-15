import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../production_pipelines/domain/material_batch.dart' show fmtQty;
import '../../production_pipelines/domain/stock_source.dart';

/// Issuing a quantity of an item to a run node, when the item's stock sits
/// under more than one barcode.
///
/// A quantity is not a thing you can point at, but the stock it comes from is.
/// This lists every barcode that holds the item, by name, proposes where the
/// quantity comes from (the oldest stock first), lets the user change that
/// split, and returns it only once they approve. The server refuses a quantity
/// that names no barcodes, so this is the one way to issue by quantity.
class QuantitySourcesDialog extends StatefulWidget {
  const QuantitySourcesDialog({
    super.key,
    required this.request,
    required this.nodeName,
    required this.loadSources,
  });

  final StockQuantityRequest request;
  final String nodeName;

  /// Asked once when the dialog opens. A function rather than a repository so
  /// the dialog can be built in a test without a server.
  final Future<List<StockSource>> Function() loadSources;

  static Future<List<StockAllocation>?> show(
    BuildContext context, {
    required StockQuantityRequest request,
    required String nodeName,
    required Future<List<StockSource>> Function() loadSources,
  }) {
    return showDialog<List<StockAllocation>>(
      context: context,
      barrierDismissible: false,
      builder: (_) => QuantitySourcesDialog(
        request: request,
        nodeName: nodeName,
        loadSources: loadSources,
      ),
    );
  }

  @override
  State<QuantitySourcesDialog> createState() => _QuantitySourcesDialogState();
}

class _QuantitySourcesDialogState extends State<QuantitySourcesDialog> {
  static const _epsilon = 1e-6;

  final _quantityController = TextEditingController();
  final Map<String, TextEditingController> _rowControllers = {};

  List<StockSource> _sources = const [];
  bool _loading = true;
  String? _loadError;

  /// False once the user has typed in a row: from then on the split is theirs
  /// and typing a new quantity must not overwrite it.
  bool _following = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _quantityController.dispose();
    for (final controller in _rowControllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final sources = await widget.loadSources();
      if (!mounted) return;
      setState(() {
        _sources = sources;
        for (final source in sources) {
          _rowControllers[source.barcode] = TextEditingController();
        }
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loadError = error.toString();
        _loading = false;
      });
    }
  }

  double get _quantity => double.tryParse(_quantityController.text.trim()) ?? 0;

  double _rowValue(String barcode) =>
      double.tryParse(_rowControllers[barcode]?.text.trim() ?? '') ?? 0;

  double get _chosen =>
      _sources.fold(0, (sum, source) => sum + _rowValue(source.barcode));

  double get _totalFree => _sources.fold(0, (sum, source) => sum + source.free);

  String get _unit => _sources.isNotEmpty && _sources.first.uom.isNotEmpty
      ? _sources.first.uom
      : widget.request.unit;

  void _fillOldestFirst() {
    final split = proposeOldestFirst(_sources, _quantity);
    for (final source in _sources) {
      final take = split[source.barcode] ?? 0;
      _rowControllers[source.barcode]!.text = take > 0 ? fmtQty(take) : '';
    }
  }

  /// Why the split cannot be approved yet, or null when it can.
  String? get _problem {
    if (_quantity <= 0) return 'Type the quantity to issue.';
    if (_quantity > _totalFree + _epsilon) {
      return 'Only ${fmtQty(_totalFree)} $_unit is free across these barcodes.';
    }
    for (final source in _sources) {
      if (_rowValue(source.barcode) > source.free + _epsilon) {
        return '${source.barcode} has only ${fmtQty(source.free)} $_unit free.';
      }
    }
    final difference = _quantity - _chosen;
    if (difference > _epsilon) {
      return 'Choose ${fmtQty(difference)} $_unit more.';
    }
    if (difference < -_epsilon) {
      return 'The barcodes add up to ${fmtQty(-difference)} $_unit too much.';
    }
    return null;
  }

  void _approve() {
    final allocations = [
      for (final source in _sources)
        if (_rowValue(source.barcode) > 0)
          StockAllocation(
            barcode: source.barcode,
            quantity: _rowValue(source.barcode),
            name: source.name,
            unit: source.uom,
          ),
    ];
    Navigator.of(context).pop(allocations);
  }

  @override
  Widget build(BuildContext context) {
    final problem = _loading || _loadError != null || _sources.isEmpty
        ? ''
        : _problem;
    return AlertDialog(
      title: Text('Issue ${widget.request.label} to ${widget.nodeName}'),
      content: SizedBox(
        width: 620,
        child: _loading
            ? const SizedBox(
                height: 120,
                child: Center(child: CircularProgressIndicator()),
              )
            : _loadError != null
            ? Text(
                'Could not load the barcodes for this item.\n$_loadError',
                style: const TextStyle(fontSize: 15, color: Color(0xFFB91C1C)),
              )
            : _sources.isEmpty
            ? const Text(
                'No barcode holds free stock of this item.',
                style: TextStyle(fontSize: 15),
              )
            : _buildBody(problem),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const ValueKey('quantity_sources_approve'),
          onPressed: problem == null ? _approve : null,
          child: const Text('Approve'),
        ),
      ],
    );
  }

  Widget _buildBody(String? problem) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'This item is held under ${_sources.length} '
          '${_sources.length == 1 ? 'barcode' : 'barcodes'}, '
          '${fmtQty(_totalFree)} $_unit free in all. Say how much to issue, '
          'then check which barcodes it comes from.',
          style: const TextStyle(fontSize: 15, height: 1.4),
        ),
        const SizedBox(height: 16),
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            SizedBox(
              width: 200,
              child: TextField(
                key: const ValueKey('quantity_sources_quantity'),
                controller: _quantityController,
                autofocus: true,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
                ],
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
                decoration: InputDecoration(
                  labelText: 'Quantity to issue',
                  suffixText: _unit,
                  border: const OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {
                  if (_following) _fillOldestFirst();
                }),
              ),
            ),
            const SizedBox(width: 12),
            TextButton.icon(
              onPressed: () => setState(() {
                _following = true;
                _fillOldestFirst();
              }),
              icon: const Icon(Icons.restart_alt_rounded, size: 18),
              label: const Text('Oldest first'),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Flexible(
          child: SingleChildScrollView(
            child: Column(
              children: [
                for (final source in _sources) _buildRow(source),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          problem ??
              'Issuing ${fmtQty(_chosen)} $_unit from '
                  '${_sources.where((s) => _rowValue(s.barcode) > 0).length} '
                  'barcode(s).',
          key: const ValueKey('quantity_sources_status'),
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w600,
            color: problem == null
                ? const Color(0xFF15803D)
                : const Color(0xFFB45309),
          ),
        ),
      ],
    );
  }

  Widget _buildRow(StockSource source) {
    final details = [
      source.barcode,
      if (source.supplier.isNotEmpty) source.supplier,
      if (source.receptionChallanNo.isNotEmpty)
        'Challan ${source.receptionChallanNo}',
    ].join('  ·  ');
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Color(0xFFE2E8F0))),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  source.name.isEmpty ? source.barcode : source.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF0F172A),
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  details,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14, color: Color(0xFF475569)),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: 110,
            child: Text(
              '${fmtQty(source.free)} ${source.uom} free',
              textAlign: TextAlign.right,
              style: const TextStyle(fontSize: 14, color: Color(0xFF334155)),
            ),
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: 120,
            child: TextField(
              key: ValueKey('quantity_sources_row_${source.barcode}'),
              controller: _rowControllers[source.barcode],
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [
                FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
              ],
              textAlign: TextAlign.right,
              style: const TextStyle(fontSize: 16),
              decoration: const InputDecoration(
                isDense: true,
                hintText: '0',
                border: OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() => _following = false),
            ),
          ),
        ],
      ),
    );
  }
}
