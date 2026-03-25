import 'package:flutter/material.dart';

import 'features/production_pipelines/presentation/screens/production_pipelines_screen.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6049E3)),
      scaffoldBackgroundColor: const Color(0xFFF1F1F1),
      fontFamily: 'Segoe UI',
      textTheme: const TextTheme(
        titleLarge: TextStyle(fontSize: 22, fontWeight: FontWeight.w500),
        bodyLarge: TextStyle(fontSize: 16),
        bodyMedium: TextStyle(fontSize: 14),
        bodySmall: TextStyle(fontSize: 12),
      ),
    );

    return MaterialApp(
      title: 'Paper',
      debugShowCheckedModeBanner: false,
      theme: base.copyWith(
        textTheme: base.textTheme.apply(
          bodyColor: const Color(0xFF3C3C3C),
          displayColor: const Color(0xFF3C3C3C),
        ),
      ),
      home: const ProductionPipelinesScreen(),
    );
  }
}
