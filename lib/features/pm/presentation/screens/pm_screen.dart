import 'package:flutter/material.dart';

import '../../../../core/widgets/app_button.dart';
import '../../../../core/widgets/app_card.dart';
import '../../../../core/widgets/app_section_title.dart';
import '../barcode/material_barcode_toolkit.dart';

class PMScreen extends StatefulWidget {
  const PMScreen({super.key});

  @override
  State<PMScreen> createState() => _PMScreenState();
}

class _PMScreenState extends State<PMScreen> {
  String _selectedSegment = 'group';
  String _selectedSegmentSoft = 'group';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF4F5F9),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const _PMHero(),
            const SizedBox(height: 24),
            _FigmaSegmentSection(
              selectedValue: _selectedSegment,
              onChanged: (value) {
                setState(() {
                  _selectedSegment = value;
                });
              },
            ),
            const SizedBox(height: 24),
            _FigmaSoftSegmentSection(
              selectedValue: _selectedSegmentSoft,
              onChanged: (value) {
                setState(() {
                  _selectedSegmentSoft = value;
                });
              },
            ),
            const SizedBox(height: 24),
            const _ButtonLibrarySection(),
            const SizedBox(height: 24),
            const _BarcodeToolkitSection(),
          ],
        ),
      ),
    );
  }
}

class _PMHero extends StatelessWidget {
  const _PMHero();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(28),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: const LinearGradient(
          colors: [Color(0xFF111827), Color(0xFF3B82F6)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        boxShadow: const [
          BoxShadow(
            color: Color(0x1A1E3A8A),
            blurRadius: 30,
            offset: Offset(0, 18),
          ),
        ],
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final isTight = constraints.maxWidth < 760;

          return Flex(
            direction: isTight ? Axis.vertical : Axis.horizontal,
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                flex: isTight ? 0 : 3,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(
                          color: Colors.white.withValues(alpha: 0.18),
                        ),
                      ),
                      child: const Text(
                        'PM',
                        style: TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.4,
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    Text(
                      'Custom button and shared UI playground',
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(
                            color: Colors.white,
                            fontWeight: FontWeight.w800,
                            height: 1.15,
                          ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'Use this space to collect the custom buttons, actions, and reusable UI patterns we want available across the app.',
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        color: const Color(0xFFE5E7EB),
                        height: 1.5,
                      ),
                    ),
                  ],
                ),
              ),
              SizedBox(width: isTight ? 0 : 24, height: isTight ? 24 : 0),
              const Expanded(flex: 2, child: _HeroPreviewCard()),
            ],
          );
        },
      ),
    );
  }
}

class _HeroPreviewCard extends StatelessWidget {
  const _HeroPreviewCard();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: Colors.white.withValues(alpha: 0.14)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: const [
          Text(
            'Pinned actions',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
          ),
          SizedBox(height: 16),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              AppButton(label: 'Primary CTA', onPressed: null),
              AppButton(
                label: 'Secondary',
                onPressed: null,
                variant: AppButtonVariant.secondary,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ButtonLibrarySection extends StatelessWidget {
  const _ButtonLibrarySection();

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const AppSectionTitle(
            title: 'Button library',
            subtitle:
                'A starter home for shared custom buttons and reusable UI states across Paper ERP.',
          ),
          const SizedBox(height: 20),
          LayoutBuilder(
            builder: (context, constraints) {
              final isNarrow = constraints.maxWidth < 780;

              return Flex(
                direction: isNarrow ? Axis.vertical : Axis.horizontal,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: const [
                  Expanded(
                    child: _ButtonGroupCard(
                      title: 'Primary actions',
                      description:
                          'High-emphasis actions for save, create, and proceed flows.',
                      children: [
                        AppButton(
                          label: 'Create Item',
                          icon: Icons.add_rounded,
                          onPressed: null,
                        ),
                        AppButton(
                          label: 'Sync Pipeline',
                          icon: Icons.sync_rounded,
                          onPressed: null,
                        ),
                        AppButton(
                          label: 'Saving',
                          onPressed: null,
                          isLoading: true,
                        ),
                      ],
                    ),
                  ),
                  SizedBox(width: 16, height: 16),
                  Expanded(
                    child: _ButtonGroupCard(
                      title: 'Secondary actions',
                      description:
                          'Lower-emphasis actions for support flows, filters, and previews.',
                      children: [
                        AppButton(
                          label: 'Preview',
                          icon: Icons.visibility_outlined,
                          onPressed: null,
                          variant: AppButtonVariant.secondary,
                        ),
                        AppButton(
                          label: 'Export',
                          icon: Icons.file_download_outlined,
                          onPressed: null,
                          variant: AppButtonVariant.secondary,
                        ),
                        AppButton(
                          label: 'Open Config',
                          icon: Icons.tune_outlined,
                          onPressed: null,
                          variant: AppButtonVariant.secondary,
                        ),
                      ],
                    ),
                  ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _BarcodeToolkitSection extends StatelessWidget {
  const _BarcodeToolkitSection();

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const AppSectionTitle(
            title: 'Barcode toolkit',
            subtitle:
                'Reusable barcode UI lives in PM so Inventory can keep its own UX while future modules reuse the same building blocks.',
          ),
          const SizedBox(height: 20),
          LayoutBuilder(
            builder: (context, constraints) {
              final isNarrow = constraints.maxWidth < 860;

              return Flex(
                direction: isNarrow ? Axis.vertical : Axis.horizontal,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Expanded(
                    child: _BarcodeToolkitDocCard(
                      title: 'What is reusable',
                      bullets: [
                        'Scan trace badge',
                        'Inline barcode preview',
                        'Desktop barcode sheet dialog',
                        'Shared material barcode detail rows',
                      ],
                    ),
                  ),
                  const SizedBox(width: 16, height: 16),
                  Expanded(
                    child: AppCard(
                      padding: const EdgeInsets.all(18),
                      backgroundColor: const Color(0xFFF8F7FF),
                      borderColor: const Color(0xFFE0DEFF),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: const [
                          Text(
                            'Reference components',
                            style: TextStyle(
                              fontWeight: FontWeight.w700,
                              color: Color(0xFF111827),
                            ),
                          ),
                          SizedBox(height: 14),
                          BarcodeTraceBadge(scanCount: 4),
                          SizedBox(height: 14),
                          InlineBarcodePreview(value: 'CHD-8266-01'),
                          SizedBox(height: 14),
                          Text(
                            'Docs path: lib/features/pm/BARCODE_TOOLKIT.md',
                            style: TextStyle(
                              color: Color(0xFF6B7280),
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _BarcodeToolkitDocCard extends StatelessWidget {
  const _BarcodeToolkitDocCard({required this.title, required this.bullets});

  final String title;
  final List<String> bullets;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 14),
          ...bullets.map(
            (item) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Padding(
                    padding: EdgeInsets.only(top: 5),
                    child: Icon(
                      Icons.circle,
                      size: 8,
                      color: Color(0xFF6C63FF),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      item,
                      style: const TextStyle(
                        color: Color(0xFF374151),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FigmaSegmentSection extends StatelessWidget {
  const _FigmaSegmentSection({
    required this.selectedValue,
    required this.onChanged,
  });

  final String selectedValue;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const AppSectionTitle(
            title: 'Figma custom button',
            subtitle:
                'Translated from node 15289:6503 in Funnel Reborn and added to PM as a reusable segmented control.',
          ),
          const SizedBox(height: 20),
          LayoutBuilder(
            builder: (context, constraints) {
              final isNarrow = constraints.maxWidth < 720;

              return Flex(
                direction: isNarrow ? Axis.vertical : Axis.horizontal,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: _FigmaPreviewPanel(
                      selectedValue: selectedValue,
                      onChanged: onChanged,
                    ),
                  ),
                  SizedBox(width: isNarrow ? 0 : 20, height: isNarrow ? 20 : 0),
                  const Expanded(child: _FigmaSpecPanel()),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _FigmaPreviewPanel extends StatelessWidget {
  const _FigmaPreviewPanel({
    required this.selectedValue,
    required this.onChanged,
  });

  final String selectedValue;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFFE5E7EB)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Live preview',
            style: Theme.of(
              context,
            ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Text(
            'This keeps the compact pill shape, active gradient fill, and tight label tracking from the design.',
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: const Color(0xFF6B7280)),
          ),
          const SizedBox(height: 24),
          Align(
            alignment: Alignment.centerLeft,
            child: PMFigmaSegmentedControl(
              value: selectedValue,
              onChanged: onChanged,
              variant: PMFigmaSegmentedControlVariant.gradient,
            ),
          ),
        ],
      ),
    );
  }
}

class _FigmaSoftSegmentSection extends StatelessWidget {
  const _FigmaSoftSegmentSection({
    required this.selectedValue,
    required this.onChanged,
  });

  final String selectedValue;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const AppSectionTitle(
            title: 'Figma custom button alt',
            subtitle:
                'Translated from node 15289:6480 in Funnel Reborn as the softer selected state with a white chip and blue active text.',
          ),
          const SizedBox(height: 20),
          LayoutBuilder(
            builder: (context, constraints) {
              final isNarrow = constraints.maxWidth < 720;

              return Flex(
                direction: isNarrow ? Axis.vertical : Axis.horizontal,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(24),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF8FAFC),
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(color: const Color(0xFFE5E7EB)),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Alternate state preview',
                            style: Theme.of(context).textTheme.titleSmall
                                ?.copyWith(fontWeight: FontWeight.w700),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'This version keeps the same shell but swaps the selected chip to a white surface with a shadow and bright blue label.',
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(color: const Color(0xFF6B7280)),
                          ),
                          const SizedBox(height: 24),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: PMFigmaSegmentedControl(
                              value: selectedValue,
                              onChanged: onChanged,
                              variant: PMFigmaSegmentedControlVariant.soft,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  SizedBox(width: isNarrow ? 0 : 20, height: isNarrow ? 20 : 0),
                  const Expanded(child: _FigmaSoftSpecPanel()),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _FigmaSpecPanel extends StatelessWidget {
  const _FigmaSpecPanel();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: const Color(0xFF111827),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Mapped details',
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
              color: Colors.white,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 16),
          const _SpecRow(
            label: 'Container',
            value: '20px radius, 2px outer padding',
          ),
          const _SpecRow(
            label: 'Active state',
            value: 'Vertical violet gradient + subtle drop shadow',
          ),
          const _SpecRow(
            label: 'Typography',
            value: '12px label size with compact line-height and tracking',
          ),
          const _SpecRow(
            label: 'Options',
            value: 'Group and Item, with reusable toggle behavior',
          ),
        ],
      ),
    );
  }
}

class _FigmaSoftSpecPanel extends StatelessWidget {
  const _FigmaSoftSpecPanel();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: const Color(0xFF0F172A),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Mapped details',
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
              color: Colors.white,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 16),
          const _SpecRow(
            label: 'Container',
            value: 'Same light shell, same 2px padding, same chip spacing',
          ),
          const _SpecRow(
            label: 'Active state',
            value: 'White selected chip, subtle shadow, blue active label',
          ),
          const _SpecRow(
            label: 'Typography',
            value: '12px text, semibold when active and medium when idle',
          ),
          const _SpecRow(
            label: 'Reuse',
            value:
                'Implemented as a second visual variant of the same reusable segmented control',
          ),
        ],
      ),
    );
  }
}

class _SpecRow extends StatelessWidget {
  const _SpecRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: Theme.of(context).textTheme.labelLarge?.copyWith(
              color: const Color(0xFF93C5FD),
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            value,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: const Color(0xFFE5E7EB),
              height: 1.45,
            ),
          ),
        ],
      ),
    );
  }
}

class _ButtonGroupCard extends StatelessWidget {
  const _ButtonGroupCard({
    required this.title,
    required this.description,
    required this.children,
  });

  final String title;
  final String description;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE5E7EB)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Text(
            description,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: const Color(0xFF6B7280)),
          ),
          const SizedBox(height: 18),
          Wrap(spacing: 12, runSpacing: 12, children: children),
        ],
      ),
    );
  }
}

class PMFigmaSegmentedControl extends StatelessWidget {
  const PMFigmaSegmentedControl({
    super.key,
    required this.value,
    required this.onChanged,
    this.variant = PMFigmaSegmentedControlVariant.gradient,
  });

  final String value;
  final ValueChanged<String> onChanged;
  final PMFigmaSegmentedControlVariant variant;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: 'PM group and item segmented control',
      child: Container(
        padding: const EdgeInsets.all(2),
        decoration: BoxDecoration(
          color: const Color(0xFFF5F7F9),
          borderRadius: BorderRadius.circular(20),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _PMFigmaSegmentChip(
              label: 'Group',
              isSelected: value == 'group',
              onTap: () => onChanged('group'),
              variant: variant,
            ),
            _PMFigmaSegmentChip(
              label: 'Item',
              isSelected: value == 'item',
              onTap: () => onChanged('item'),
              variant: variant,
            ),
          ],
        ),
      ),
    );
  }
}

class _PMFigmaSegmentChip extends StatelessWidget {
  const _PMFigmaSegmentChip({
    required this.label,
    required this.isSelected,
    required this.onTap,
    required this.variant,
  });

  final String label;
  final bool isSelected;
  final VoidCallback onTap;
  final PMFigmaSegmentedControlVariant variant;

  @override
  Widget build(BuildContext context) {
    final gradient = const LinearGradient(
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
      colors: [Color(0xFF5E5BF9), Color(0xFF413F9C)],
      stops: [0, 1],
    );
    final usesGradient = variant == PMFigmaSegmentedControlVariant.gradient;
    final activeTextColor = usesGradient
        ? Colors.white
        : const Color(0xFF1100FF);

    return Padding(
      padding: EdgeInsets.only(right: label == 'Item' ? 0 : 4),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(isSelected ? 20 : 22),
          onTap: onTap,
          child: Ink(
            height: 30,
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
            decoration: BoxDecoration(
              color: isSelected
                  ? (usesGradient ? null : Colors.white)
                  : const Color(0xFFF5F7F9),
              gradient: isSelected && usesGradient ? gradient : null,
              borderRadius: BorderRadius.circular(isSelected ? 20 : 22),
              boxShadow: isSelected
                  ? const [
                      BoxShadow(
                        color: Color(0x33000000),
                        blurRadius: 2,
                        offset: Offset(0, 1),
                      ),
                    ]
                  : null,
            ),
            child: Center(
              child: Text(
                label,
                style: TextStyle(
                  color: isSelected ? activeTextColor : const Color(0xFF1C2632),
                  fontSize: 12,
                  height: 1,
                  letterSpacing: 0.24,
                  fontWeight: isSelected ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

enum PMFigmaSegmentedControlVariant { gradient, soft }
