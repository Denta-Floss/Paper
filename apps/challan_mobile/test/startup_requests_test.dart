import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:challan_mobile/main.dart';
import 'package:core_erp/features/units/presentation/providers/units_provider.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

// What the phone asks the server for when it starts, counted.
//
// Every list provider used to be refreshed twice: once by its
// ChangeNotifierProxyProvider's `update` (which runs when the auth provider
// notifies) and once by _AuthGate's one-per-sign-in Future.wait. On a shop
// floor link that doubled the start-up cost for nothing. This pins it at
// once per path.
void main() {
  cacheTests();

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
      cacheDirectory: _freshCacheDirectory(),
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

// A cache directory that does not exist yet: loading it is then no file I/O,
// which a widget test's fake clock would never let finish.
Directory _freshCacheDirectory() => Directory(
    '${Directory.systemTemp.path}/paper-mobile-cache-${DateTime.now().microsecondsSinceEpoch}');

void cacheTests() {
  testWidgets('a list fetched again is revalidated, and a 304 still yields the list', (tester) async {
    final conditional = <String>[];
    final client = MockClient((request) async {
      if (request.method != 'GET' || request.url.path != '/api/units') {
        return http.Response('{"success":true}', 200, headers: {'content-type': 'application/json'});
      }
      if (request.headers['If-None-Match'] == 'W/"units-1"') {
        conditional.add(request.url.path);
        return http.Response('', 304, headers: {'etag': 'W/"units-1"'});
      }
      return http.Response(
        '{"success":true,"units":[{"id":1,"name":"Kilogram","symbol":"kg"}]}',
        200,
        headers: {
          'content-type': 'application/json',
          'etag': 'W/"units-1"',
          'cache-control': 'private, no-cache, must-revalidate',
        },
      );
    });

    await tester.pumpWidget(MyApp(
      apiUrl: 'http://localhost:18080',
      demoMode: true,
      httpClient: client,
      cacheDirectory: _freshCacheDirectory(),
    ));
    for (var i = 0; i < 10; i += 1) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    final units = Provider.of<UnitsProvider>(tester.element(find.byType(MaterialApp)), listen: false);
    expect(units.units.map((u) => u.symbol), contains('kg'));

    await tester.runAsync(() => units.refresh());
    expect(conditional, <String>['/api/units'], reason: 'the second fetch asked whether it changed');
    expect(units.units.map((u) => u.symbol), contains('kg'), reason: 'and the 304 replayed the stored list');
  });
}
