import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:paper/main.dart';

void main() {
  testWidgets('renders production pipelines desktop structure', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const MyApp());
    await tester.pumpAndSettle();

    expect(find.text('Heading'), findsOneWidget);
    expect(find.text('Production Pipelines'), findsOneWidget);
    expect(find.text('Party Name'), findsOneWidget);
    expect(find.text('Acme Corporation Ltd.'), findsOneWidget);
  });

  testWidgets('row selection count updates and can be cleared', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const MyApp());
    await tester.pumpAndSettle();

    expect(find.text('0 Selected'), findsOneWidget);

    await tester.tap(find.text('Acme Corporation Ltd.').first);
    await tester.pumpAndSettle();

    expect(find.text('1 Selected'), findsOneWidget);

    await tester.tap(find.byTooltip('Clear selection'));
    await tester.pumpAndSettle();

    expect(find.text('0 Selected'), findsOneWidget);
  });

  testWidgets('sort toggle control is rendered', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const MyApp());
    await tester.pumpAndSettle();

    expect(find.text('Newest'), findsOneWidget);
    expect(find.byIcon(Icons.arrow_downward), findsWidgets);
  });
}
