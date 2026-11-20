import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:challan_mobile/main.dart';

// What the phone asks the server for when it starts, counted.
//
// Every list provider used to be refreshed twice: once by its
// ChangeNotifierProxyProvider's `update` (which runs when the auth provider
// notifies) and once by _AuthGate's one-per-sign-in Future.wait. On a shop
// floor link that doubled the start-up cost for nothing. This pins it at
// once per path.
void main() {
  testWidgets('each list is fetched once at start-up, not twice', (tester) async {
    final hits = <String, int>{};
    final client = MockClient((request) async {
      if (request.method == 'GET') {
        hits.update(request.url.path, (n) => n + 1, ifAbsent: () => 1);
      }
      return http.Response('{"success":true}', 200,
          headers: {'content-type': 'application/json'});
    });

    await tester.pumpWidget(MyApp(
      apiUrl: 'http://localhost:18080',
      demoMode: true,
      httpClient: client,
    ));
    // Let the post-frame refresh start and the fake answers land.
    for (var i = 0; i < 10; i += 1) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    final twice = hits.entries.where((e) => e.value > 1).map((e) => '${e.key} ×${e.value}').toList();
    expect(twice, isEmpty, reason: 'a list fetched more than once at start-up: $twice');
    expect(hits.keys, containsAll(<String>['/api/orders', '/api/items', '/api/units', '/api/clients']),
        reason: 'the start-up refresh still runs: ${hits.keys.toList()}');
  });
}
