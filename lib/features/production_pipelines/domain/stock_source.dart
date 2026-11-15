/// One barcode that holds free stock of an item and variation: a place a
/// quantity of that item can come from. Stock of the same item usually sits
/// under several of these, one per reception line.
class StockSource {
  const StockSource({
    required this.barcode,
    required this.name,
    required this.supplier,
    required this.receptionChallanNo,
    required this.free,
    required this.uom,
  });

  final String barcode;
  final String name;
  final String supplier;
  final String receptionChallanNo;

  /// On hand and not reserved.
  final double free;
  final String uom;

  factory StockSource.fromJson(Map<String, dynamic> json) {
    return StockSource(
      barcode: json['barcode'] as String? ?? '',
      name: json['name'] as String? ?? '',
      supplier: json['supplier'] as String? ?? '',
      receptionChallanNo: json['receptionChallanNo'] as String? ?? '',
      free: (json['free'] as num?)?.toDouble() ?? 0,
      uom: json['uom'] as String? ?? '',
    );
  }
}

/// How much of a quantity comes from one barcode. The name and unit ride along
/// so the screen can show what was taken without looking the barcode up again.
class StockAllocation {
  const StockAllocation({
    required this.barcode,
    required this.quantity,
    this.name = '',
    this.unit = '',
  });

  final String barcode;
  final double quantity;
  final String name;
  final String unit;

  Map<String, dynamic> toJson() => {'barcode': barcode, 'quantity': quantity};
}

/// "Some of this item, whichever barcode it is under": what is dragged onto a
/// run node to issue by quantity instead of by one barcode.
class StockQuantityRequest {
  const StockQuantityRequest({
    required this.itemId,
    required this.variationLeafNodeId,
    required this.label,
    required this.unit,
    required this.totalOnHand,
    required this.barcodeCount,
  });

  final int itemId;

  /// 0 for an item with no variations.
  final int variationLeafNodeId;
  final String label;
  final String unit;
  final double totalOnHand;
  final int barcodeCount;
}

/// Where a quantity comes from when nobody has chosen: the oldest stock first,
/// each barcode until it is used up. [sources] must already be oldest first,
/// which is how the server sends them. Covers less than [quantity] when there
/// is not enough stock.
Map<String, double> proposeOldestFirst(List<StockSource> sources, double quantity) {
  var left = quantity;
  final split = <String, double>{};
  for (final source in sources) {
    if (left <= 0) break;
    final take = left < source.free ? left : source.free;
    if (take > 0) split[source.barcode] = take;
    left -= take;
  }
  return split;
}
