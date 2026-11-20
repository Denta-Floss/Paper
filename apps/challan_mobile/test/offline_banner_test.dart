import 'package:challan_mobile/widgets/offline_banner.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// The phone keeps working off its own copy when the server is gone, and says
// so — after a grace period, so starting up or a blip does not flash it.
void main() {
  Future<(ValueNotifier<bool>, ValueNotifier<DateTime?>)> pump(WidgetTester tester) async {
    final live = ValueNotifier<bool>(true);
    final synced = ValueNotifier<DateTime?>(DateTime.now().copyWith(hour: 14, minute: 5));
    await tester.pumpWidget(MaterialApp(
      home: OfflineBanner(live: live, lastSyncedAt: synced, child: const Text('screen')),
    ));
    return (live, synced);
  }

  testWidgets('a connection lost for a moment shows nothing', (tester) async {
    final (live, _) = await pump(tester);
    live.value = false;
    await tester.pump(const Duration(seconds: 2));
    live.value = true;
    await tester.pump(const Duration(seconds: 5));
    expect(find.byKey(const ValueKey<String>('offline_banner_text')), findsNothing);
    expect(find.text('screen'), findsOneWidget);
  });

  testWidgets('a connection lost for longer says how old the screen is, and goes when it is back', (tester) async {
    final (live, _) = await pump(tester);
    live.value = false;
    await tester.pump(const Duration(seconds: 5));
    expect(find.text('Offline. Showing what this phone last synced at 14:05.'), findsOneWidget);
    expect(find.text('screen'), findsOneWidget, reason: 'the screen keeps working');

    live.value = true;
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('offline_banner_text')), findsNothing);
  });

  testWidgets('with no sync yet it says what will happen instead', (tester) async {
    final (live, synced) = await pump(tester);
    synced.value = null;
    live.value = false;
    await tester.pump(const Duration(seconds: 5));
    expect(find.textContaining('will show when the connection is back'), findsOneWidget);
  });
}
