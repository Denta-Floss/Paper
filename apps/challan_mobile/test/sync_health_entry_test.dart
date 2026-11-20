import 'dart:io';

import 'package:challan_mobile/main.dart';
import 'package:core_erp/features/sync_health/sync_health_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:package_info_plus/package_info_plus.dart';

// Sync Health opens from the phone's app bar — through the real MyApp, so the
// probe is built from the providers it actually has. It once read the auth
// provider from a provider listed above it, threw on the tap, and the button
// did nothing at all.
void main() {
  testWidgets('the app bar button opens Sync Health', (tester) async {
    tester.view.physicalSize = const Size(1080, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    PackageInfo.setMockInitialValues(
      appName: 'Challan', packageName: 'com.example.challan_mobile', version: '1.0.0', buildNumber: '1',
      buildSignature: '', installerStore: null,
    );
    final client = MockClient((request) async => http.Response(
          request.url.path == '/api/system/status'
              ? '{"success":true,"serverVersion":"1.0.0","apiVersion":1,"minClientApiVersion":0,"changelogHead":3}'
              : '{"success":true}',
          200,
          headers: {'content-type': 'application/json'},
        ));
    await tester.pumpWidget(MyApp(
      apiUrl: 'http://localhost:18080',
      demoMode: true,
      httpClient: client,
      cacheDirectory: Directory('${Directory.systemTemp.path}/paper-sync-health-${DateTime.now().microsecondsSinceEpoch}'),
    ));
    for (var i = 0; i < 5; i += 1) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    await tester.tap(find.byKey(const Key('open_sync_health')));
    for (var i = 0; i < 10; i += 1) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(tester.takeException(), isNull);
    expect(find.byType(SyncHealthScreen), findsOneWidget);
    expect(find.text('Connection'), findsOneWidget);
    expect(find.text('1.0.0+1 · API 1'), findsOneWidget, reason: 'the version the app reports for itself');
  });
}
