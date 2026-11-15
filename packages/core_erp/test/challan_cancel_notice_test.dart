import 'dart:convert';

import 'package:core_erp/features/delivery_challans/data/api_delivery_challan_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// Cancelling a partly used reception does not cancel it: the server makes a
// draft vendor return for the unused stock and says so in `message`. The
// repository has to carry that sentence to the screen, or the user sees a
// challan that simply did not cancel.

Map<String, dynamic> _challan(String status) => {
  'id': 7,
  'type': 'reception',
  'challanNo': 'RC-00007',
  'date': '2026-11-15',
  'status': status,
  'notes': '',
  'maintainStocks': true,
  'items': const [],
};

ApiChallanRepository _repo(Map<String, dynamic> body) => ApiChallanRepository(
  baseUrl: 'http://paper.test',
  client: MockClient((request) async {
    expect(request.url.path, '/api/challans/7/cancel');
    return http.Response(
      jsonEncode(body),
      200,
      headers: {'content-type': 'application/json'},
    );
  }),
);

void main() {
  test('a partly used reception comes back issued, with the notice', () async {
    final challan = await _repo({
      'success': true,
      'data': _challan('issued'),
      'outcome': 'return_challan_created',
      'message':
          '2 of 5 pc are already used or reserved, so this reception was not '
          'cancelled. A draft return challan IC-00001 was made for the '
          'remaining 3 pc.',
      'returnChallan': _challan('draft'),
      'error': null,
    }).cancelChallan(7);

    expect(challan.isIssued, isTrue);
    expect(challan.actionNotice, contains('IC-00001'));
    expect(challan.actionNotice, contains('remaining 3'));
  });

  test('an ordinary cancel carries no notice', () async {
    final challan = await _repo({
      'success': true,
      'data': _challan('cancelled'),
      'error': null,
    }).cancelChallan(7);

    expect(challan.isCancelled, isTrue);
    expect(challan.actionNotice, isEmpty);
  });
}
