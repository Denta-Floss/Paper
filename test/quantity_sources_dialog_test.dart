import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:paper/features/production/widgets/quantity_sources_dialog.dart';
import 'package:paper/features/production_pipelines/domain/stock_source.dart';

// Issuing a quantity of an item whose stock sits under several barcodes. The
// dialog has to name every barcode, propose the oldest first, and hand back a
// split only when it adds up and the user approves it.

const _sources = [
  StockSource(
    barcode: 'RC-00012-L1',
    name: 'CR Sheet 2 mm',
    supplier: 'Acme Steel',
    receptionChallanNo: 'RC-00012',
    free: 5,
    uom: 'kg',
  ),
  StockSource(
    barcode: 'RC-00015-L1',
    name: 'CR Sheet 2 mm (second lot)',
    supplier: 'Bharat Metals',
    receptionChallanNo: 'RC-00015',
    free: 4,
    uom: 'kg',
  ),
];

const _request = StockQuantityRequest(
  itemId: 1,
  variationLeafNodeId: 2,
  label: 'CR Sheet 2 mm',
  unit: 'kg',
  totalOnHand: 9,
  barcodeCount: 2,
);

Future<List<StockAllocation>? Function()> _open(WidgetTester tester) async {
  List<StockAllocation>? result;
  var closed = false;
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () async {
                result = await QuantitySourcesDialog.show(
                  context,
                  request: _request,
                  nodeName: 'Cutting',
                  loadSources: () async => _sources,
                );
                closed = true;
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pump();
  await tester.pump();
  return () => closed ? result : throw StateError('dialog still open');
}

bool _approveEnabled(WidgetTester tester) => tester
    .widget<FilledButton>(find.byKey(const ValueKey('quantity_sources_approve')))
    .enabled;

String _rowText(WidgetTester tester, String barcode) => tester
    .widget<TextField>(find.byKey(ValueKey('quantity_sources_row_$barcode')))
    .controller!
    .text;

void main() {
  test('the proposal takes the oldest stock first', () {
    expect(proposeOldestFirst(_sources, 7), {'RC-00012-L1': 5, 'RC-00015-L1': 2});
    expect(proposeOldestFirst(_sources, 3), {'RC-00012-L1': 3});
    expect(proposeOldestFirst(_sources, 20), {'RC-00012-L1': 5, 'RC-00015-L1': 4});
  });

  testWidgets('every barcode is shown by name, with who it came from', (tester) async {
    await _open(tester);
    expect(find.text('CR Sheet 2 mm'), findsOneWidget);
    expect(find.text('CR Sheet 2 mm (second lot)'), findsOneWidget);
    expect(find.textContaining('RC-00012-L1'), findsOneWidget);
    expect(find.textContaining('Acme Steel'), findsOneWidget);
    expect(find.textContaining('Challan RC-00015'), findsOneWidget);
    expect(find.text('5 kg free'), findsOneWidget);
    expect(_approveEnabled(tester), isFalse, reason: 'nothing to approve yet');
  });

  testWidgets('typing a quantity proposes the oldest first, and approving returns that split', (tester) async {
    final result = await _open(tester);
    await tester.enterText(find.byKey(const ValueKey('quantity_sources_quantity')), '7');
    await tester.pump();
    expect(_rowText(tester, 'RC-00012-L1'), '5');
    expect(_rowText(tester, 'RC-00015-L1'), '2');
    expect(_approveEnabled(tester), isTrue);

    await tester.tap(find.byKey(const ValueKey('quantity_sources_approve')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    final allocations = result()!;
    expect(allocations.map((a) => '${a.barcode}=${a.quantity}').toList(), [
      'RC-00012-L1=5.0',
      'RC-00015-L1=2.0',
    ]);
    expect(allocations.first.name, 'CR Sheet 2 mm');
  });

  testWidgets('a split that does not add up cannot be approved', (tester) async {
    await _open(tester);
    await tester.enterText(find.byKey(const ValueKey('quantity_sources_quantity')), '7');
    await tester.pump();

    // The user moves one over to the newer lot but forgets the other side.
    await tester.enterText(find.byKey(const ValueKey('quantity_sources_row_RC-00015-L1')), '3');
    await tester.pump();
    expect(_approveEnabled(tester), isFalse);
    expect(find.textContaining('too much'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('quantity_sources_row_RC-00012-L1')), '4');
    await tester.pump();
    expect(_approveEnabled(tester), isTrue);

    // Their split is kept when the quantity changes; it no longer follows.
    await tester.enterText(find.byKey(const ValueKey('quantity_sources_quantity')), '8');
    await tester.pump();
    expect(_rowText(tester, 'RC-00012-L1'), '4');
    expect(_approveEnabled(tester), isFalse);
    expect(find.textContaining('more'), findsOneWidget);

    // More than a barcode holds, or more than there is at all, is refused.
    await tester.enterText(find.byKey(const ValueKey('quantity_sources_row_RC-00012-L1')), '6');
    await tester.pump();
    expect(_approveEnabled(tester), isFalse);
    await tester.enterText(find.byKey(const ValueKey('quantity_sources_quantity')), '10');
    await tester.pump();
    expect(find.textContaining('Only 9'), findsOneWidget);
  });
}
