import 'dart:convert';

import 'package:core_erp/core/sync/sync_health.dart';
import 'package:core_erp/features/auth/presentation/providers/auth_provider.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:paper/app/shell/app_sidebar.dart';
import 'package:paper/app/shell/navigation_provider.dart';
import 'package:provider/provider.dart';

/// Sync Health is for whoever is at the terminal. Settings & Preferences holds
/// the destructive data controls and stays with admins, so a staff member gets
/// Sync Health on its own in the sidebar footer; an admin finds it as a pane
/// inside Settings instead.

class _FakeAuth extends AuthProvider {
  _FakeAuth({required this.allowed}) : super(baseUrl: 'http://localhost:0');

  final bool allowed;

  @override
  bool can(String permission) => allowed;
}

SyncHealthProbe _probe() => SyncHealthProbe(
      client: MockClient((_) async => http.Response(
            jsonEncode(<String, dynamic>{
              'serverVersion': '1.0.0', 'apiVersion': kPaperApiVersion,
              'minClientApiVersion': kPaperApiVersion - 1, 'changelogHead': 7,
            }),
            200,
          )),
      baseUrl: 'http://srv',
      appVersion: () async => '1.0.0+1',
      localCursor: () async => 7,
    );

Future<void> _pump(WidgetTester tester, {required bool admin}) async {
  tester.view.physicalSize = const Size(1600, 1400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<NavigationProvider>(create: (_) => NavigationProvider(initialKey: 'inventory')),
        ChangeNotifierProvider<AuthProvider>(create: (_) => _FakeAuth(allowed: admin)),
        Provider<SyncHealthProbe>(create: (_) => _probe()),
      ],
      child: const MaterialApp(
        home: Scaffold(body: SizedBox(width: 300, height: 1400, child: AppSidebar(compact: false))),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('a staff member opens Sync Health from the sidebar footer', (tester) async {
    await _pump(tester, admin: false);
    expect(find.text('Settings &\nPreferences'), findsNothing);
    await tester.tap(find.byKey(const Key('sidebar_sync_health')));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(find.text('Connection'), findsOneWidget);
    expect(find.text('Connected'), findsOneWidget);
    expect(find.text('Up to date'), findsOneWidget);
  });

  testWidgets('an admin has Settings, where Sync Health is a pane, and no second button', (tester) async {
    await _pump(tester, admin: true);
    expect(find.byKey(const Key('sidebar_sync_health')), findsNothing);
    expect(find.text('Settings &\nPreferences'), findsOneWidget);
  });
}
