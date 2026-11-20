import 'dart:io';

import 'package:challan_mobile/main.dart';
import 'package:challan_mobile/services/offline_unlock.dart';
import 'package:challan_mobile/widgets/phone_settings_sheet.dart';
import 'package:core_erp/features/auth/domain/auth_user.dart';
import 'package:core_erp/features/auth/presentation/providers/auth_provider.dart';
import 'package:provider/provider.dart';
import 'package:core_erp/features/sync_health/sync_health_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'offline_unlock_test.dart' show MapStore;

// B55: the gear opened the desktop's settings dialog, which needs a
// PreferencesProvider the phone never had — a red error box. The phone has its
// own sheet now: Sync Health, the server, sign out, the version.
void main() {
  Future<void> pumpApp(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
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
      apiUrl: 'http://10.0.2.2:18080',
      demoMode: true,
      httpClient: client,
      cacheDirectory: Directory('${Directory.systemTemp.path}/paper-settings-${DateTime.now().microsecondsSinceEpoch}'),
    ));
    for (var i = 0; i < 5; i += 1) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 10; i += 1) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  testWidgets('the gear opens the phone\'s settings, with no error box', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.byKey(const Key('open_settings')));
    await settle(tester);
    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('settings_sync_health')), findsOneWidget);
    expect(find.text('http://10.0.2.2:18080'), findsOneWidget);
    expect(find.byKey(const Key('settings_sign_out')), findsOneWidget);
    expect(find.text('Version 1.0.0+1 · API 1'), findsOneWidget);
    expect(find.text('Load demo scenario?'), findsNothing);

    await tester.tap(find.byKey(const Key('settings_sync_health')));
    await settle(tester);
    expect(find.byType(SyncHealthScreen), findsOneWidget);
  });

  testWidgets('Sign out asks first, then signs out through the session', (tester) async {
    var signedOut = 0;
    // As in the app: the providers sit above MaterialApp, so a sheet's route sees them.
    await tester.pumpWidget(ChangeNotifierProvider<AuthProvider>(
      create: (_) => AuthProvider(baseUrl: 'http://srv'),
      child: MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => showPhoneSettingsSheet(
                  context,
                  PhoneSession(serverUrl: 'http://srv', signOut: () async => signedOut += 1),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await settle(tester);
    await tester.tap(find.byKey(const Key('settings_sign_out')));
    await settle(tester);
    await tester.tap(find.text('Cancel'));
    await settle(tester);
    expect(signedOut, 0, reason: 'Cancel signs nobody out');
    await tester.tap(find.byKey(const Key('settings_sign_out')));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Sign out'));
    await settle(tester);
    expect(signedOut, 1);
  });

  test('signing out forgets the offline unlock, so the PIN no longer opens the phone without the server', () async {
    final unlock = OfflineUnlock(serverUrl: 'http://srv', store: MapStore());
    const ravi = AuthUser(id: 7, name: 'Ravi', email: 'r@p.test', role: 'user', permissions: <String>[], isActive: true);
    await unlock.remember(pin: '4321', user: ravi, token: 'tok');
    expect(await unlock.unlock('4321'), isNotNull, reason: 'remembered before');
    final auth = AuthProvider(baseUrl: 'http://127.0.0.1:9');
    await signOutPhone(auth, unlock);
    expect(await unlock.unlock('4321'), isNull);
    expect(auth.isAuthenticated, isFalse);
  });
}
