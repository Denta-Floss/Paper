import 'dart:convert';
import 'dart:io';

import 'package:challan_mobile/screens/passcode_screen.dart';
import 'package:challan_mobile/services/offline_unlock.dart';
import 'package:core_erp/features/auth/domain/auth_user.dart';
import 'package:core_erp/features/auth/presentation/providers/auth_provider.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'offline_unlock_test.dart' show MapStore;

// B44: a refused passcode used to strand the phone on a bare error page.
// B45: with the server out of reach, the last person to sign in opens the
// phone's own copy with the same passcode — and only when the server was
// never asked: a passcode the server refuses stays refused.

const _ravi = AuthUser(
  id: 7, name: 'Ravi', email: 'ravi@paper.test', role: 'user',
  permissions: <String>[], isActive: true,
);

/// The server: answers PIN 4321, refuses anything else — or cannot be reached.
MockClient _server({required bool reachable}) => MockClient((request) async {
      if (!reachable) throw const SocketException('Network is unreachable');
      final pin = (jsonDecode(request.body) as Map)['pin'];
      if (pin == '4321') {
        return http.Response(jsonEncode(<String, dynamic>{
          'success': true,
          'token': 'tok-online',
          'user': <String, dynamic>{'id': 7, 'name': 'Ravi', 'email': 'ravi@paper.test', 'role': 'user', 'permissions': <String>[], 'isActive': true},
        }), 200, headers: {'content-type': 'application/json'});
      }
      return http.Response('{"success":false,"error":"Invalid PIN."}', 401,
          headers: {'content-type': 'application/json'});
    });

void _phoneSize(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 1920);
  tester.view.devicePixelRatio = 2.625;
  addTearDown(tester.view.reset);
}

Future<(AuthProvider, OfflineUnlock)> _open(WidgetTester tester, {required bool reachable, bool remembered = false}) async {
  _phoneSize(tester);
  final unlock = OfflineUnlock(serverUrl: 'http://srv', store: MapStore());
  if (remembered) await unlock.remember(pin: '4321', user: _ravi, token: 'tok-kept');
  final auth = http.runWithClient(() => AuthProvider(baseUrl: 'http://srv'), () => _server(reachable: reachable));
  await tester.pumpWidget(ChangeNotifierProvider<AuthProvider>.value(
    value: auth,
    child: MaterialApp(home: PasscodeScreen(offlineUnlock: unlock, onChangeServer: () {})),
  ));
  return (auth, unlock);
}

Future<void> _type(WidgetTester tester, String pin) async {
  for (final digit in pin.split('')) {
    await tester.tap(find.text(digit));
    await tester.pump();
  }
  // Let the request (or its failure) and the offline check finish.
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 400)));
  await tester.pump();
}

void main() {
  testWidgets('a refused passcode is shown beside the keypad, with Try again (B44)', (tester) async {
    final (auth, _) = await _open(tester, reachable: true);
    await _type(tester, '1111');

    expect(find.byKey(const ValueKey<String>('passcode_error')), findsOneWidget);
    expect(find.text('Invalid PIN.'), findsOneWidget);
    expect(auth.errorMessage, isNull, reason: 'the shell never sees it, so it cannot swap the screen out');
    expect(find.text('1'), findsOneWidget, reason: 'the keypad is still there');

    await tester.tap(find.byKey(const ValueKey<String>('passcode_try_again')));
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('passcode_error')), findsNothing);
  });

  testWidgets('online, a sign-in is remembered for the next time the server is away', (tester) async {
    final (auth, unlock) = await _open(tester, reachable: true);
    await _type(tester, '4321');
    expect(auth.isAuthenticated, isTrue);
    expect(auth.isOffline, isFalse);
    expect((await tester.runAsync(() => unlock.unlock('4321')))?.token, 'tok-online');
  });

  testWidgets('offline, the last passcode used opens the phone (B45)', (tester) async {
    final (auth, _) = await _open(tester, reachable: false, remembered: true);
    await _type(tester, '4321');
    expect(auth.isAuthenticated, isTrue);
    expect(auth.isOffline, isTrue);
    expect(auth.user?.id, 7);
    expect(auth.token, 'tok-kept');
  });

  testWidgets('offline, any other passcode does not', (tester) async {
    final (auth, _) = await _open(tester, reachable: false, remembered: true);
    await _type(tester, '9999');
    expect(auth.isAuthenticated, isFalse);
    expect(find.textContaining('not the passcode last used on this phone'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('passcode_try_again')), findsOneWidget);
  });

  testWidgets('a passcode the server refuses stays refused, whatever the phone remembers', (tester) async {
    // The phone remembers 4321 for Ravi, but the server now refuses 4321 (his
    // PIN was changed, or he was deactivated). Online, the server decides.
    _phoneSize(tester);
    final unlock = OfflineUnlock(serverUrl: 'http://srv', store: MapStore());
    await unlock.remember(pin: '4321', user: _ravi, token: 'tok-kept');
    final refusing = MockClient((_) async => http.Response('{"success":false,"error":"Invalid PIN."}', 401,
        headers: {'content-type': 'application/json'}));
    final auth = http.runWithClient(() => AuthProvider(baseUrl: 'http://srv'), () => refusing);
    await tester.pumpWidget(ChangeNotifierProvider<AuthProvider>.value(
      value: auth,
      child: MaterialApp(home: PasscodeScreen(offlineUnlock: unlock)),
    ));
    await _type(tester, '4321');
    expect(auth.isAuthenticated, isFalse);
    expect(find.text('Invalid PIN.'), findsOneWidget);
  });

  testWidgets('Change server is offered on the passcode screen', (tester) async {
    _phoneSize(tester);
    var asked = false;
    final auth = http.runWithClient(() => AuthProvider(baseUrl: 'http://srv'), () => _server(reachable: true));
    await tester.pumpWidget(ChangeNotifierProvider<AuthProvider>.value(
      value: auth,
      child: MaterialApp(home: PasscodeScreen(onChangeServer: () => asked = true)),
    ));
    await tester.tap(find.byKey(const ValueKey<String>('passcode_change_server')));
    expect(asked, isTrue);
  });
}
