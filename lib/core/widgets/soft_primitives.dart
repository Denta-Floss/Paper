import 'package:flutter/material.dart';

import '../theme/soft_erp_theme.dart';

class SoftSurface extends StatelessWidget {
  const SoftSurface({
    super.key,
    required this.child,
    this.padding,
    this.margin,
    this.width,
    this.height,
    this.alignment,
    this.color = SoftErpTheme.cardSurface,
    this.radius = SoftErpTheme.radiusMd,
    this.elevated = true,
    this.strongBorder = false,
    this.clipContent = true,
  });

  final Widget child;
  final EdgeInsetsGeometry? padding;
  final EdgeInsetsGeometry? margin;
  final double? width;
  final double? height;
  final AlignmentGeometry? alignment;
  final Color color;
  final double radius;
  final bool elevated;
  final bool strongBorder;
  final bool clipContent;

  @override
  Widget build(BuildContext context) {
    final resolvedChild = clipContent
        ? ClipRRect(borderRadius: BorderRadius.circular(radius), child: child)
        : child;

    return Container(
      margin: margin,
      width: width,
      height: height,
      alignment: alignment,
      padding: padding,
      decoration: SoftErpTheme.surfaceDecoration(
        color: color,
        radius: radius,
        elevated: elevated,
        strongBorder: strongBorder,
      ),
      child: resolvedChild,
    );
  }
}

class SoftSectionCard extends StatelessWidget {
  const SoftSectionCard({
    super.key,
    required this.child,
    this.title,
    this.subtitle,
    this.padding = const EdgeInsets.all(16),
    this.radius = SoftErpTheme.radiusLg,
  });

  final Widget child;
  final String? title;
  final String? subtitle;
  final EdgeInsetsGeometry padding;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return SoftSurface(
      radius: radius,
      color: SoftErpTheme.cardSurface,
      strongBorder: false,
      elevated: true,
      padding: padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null) ...[
            Text(
              title!,
              style: const TextStyle(
                color: SoftErpTheme.textPrimary,
                fontSize: 20,
                fontWeight: FontWeight.w700,
              ),
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 6),
              Text(
                subtitle!,
                style: const TextStyle(
                  color: SoftErpTheme.textSecondary,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
            const SizedBox(height: 14),
          ],
          child,
        ],
      ),
    );
  }
}

class SoftPill extends StatelessWidget {
  const SoftPill({
    super.key,
    required this.label,
    this.leading,
    this.trailing,
    this.padding = const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    this.background = SoftErpTheme.cardSurfaceAlt,
    this.foreground = SoftErpTheme.textSecondary,
    this.borderColor = SoftErpTheme.border,
    this.onTap,
  });

  final String label;
  final Widget? leading;
  final Widget? trailing;
  final EdgeInsetsGeometry padding;
  final Color background;
  final Color foreground;
  final Color borderColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(999),
      child: Container(
        padding: padding,
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: borderColor),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (leading != null) ...[leading!, const SizedBox(width: 8)],
            Text(
              label,
              style: TextStyle(
                color: foreground,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (trailing != null) ...[const SizedBox(width: 8), trailing!],
          ],
        ),
      ),
    );
  }
}

class SoftIconButton extends StatelessWidget {
  const SoftIconButton({
    super.key,
    required this.icon,
    required this.onTap,
    this.tooltip,
    this.size = 36,
    this.iconColor = SoftErpTheme.textSecondary,
    this.background = SoftErpTheme.cardSurfaceAlt,
    this.borderColor = SoftErpTheme.border,
  });

  final IconData icon;
  final VoidCallback? onTap;
  final String? tooltip;
  final double size;
  final Color iconColor;
  final Color background;
  final Color borderColor;

  @override
  Widget build(BuildContext context) {
    final button = Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Ink(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: borderColor),
            boxShadow: SoftErpTheme.insetShadow,
          ),
          child: Icon(icon, size: 18, color: iconColor),
        ),
      ),
    );
    if (tooltip == null || tooltip!.trim().isEmpty) {
      return button;
    }
    return Tooltip(message: tooltip!, child: button);
  }
}

class SoftMetricCard extends StatelessWidget {
  const SoftMetricCard({
    super.key,
    required this.label,
    required this.value,
    required this.isActive,
    required this.onTap,
  });

  final String label;
  final int value;
  final bool isActive;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(SoftErpTheme.radiusMd),
      child: SoftSurface(
        color: isActive ? const Color(0xFFF4F1FF) : SoftErpTheme.cardSurface,
        radius: 22,
        strongBorder: isActive,
        elevated: !isActive,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: const TextStyle(
                  color: SoftErpTheme.textPrimary,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            Container(
              constraints: const BoxConstraints(minWidth: 74),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              decoration: BoxDecoration(
                color: isActive
                    ? const Color(0xFFE8E4FF)
                    : SoftErpTheme.cardSurfaceAlt,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Text(
                '$value',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: SoftErpTheme.textPrimary,
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class SoftRowCard extends StatelessWidget {
  const SoftRowCard({
    super.key,
    required this.child,
    required this.onTap,
    this.isSelected = false,
  });

  final Widget child;
  final VoidCallback onTap;
  final bool isSelected;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Ink(
          decoration: SoftErpTheme.surfaceDecoration(
            color: isSelected
                ? const Color(0xFFF1EEFF)
                : SoftErpTheme.cardSurface,
            radius: 20,
            elevated: true,
            strongBorder: isSelected,
          ),
          child: child,
        ),
      ),
    );
  }
}

class SoftStatusPill extends StatelessWidget {
  const SoftStatusPill({
    super.key,
    required this.label,
    this.background = SoftErpTheme.infoBg,
    this.textColor = SoftErpTheme.infoText,
    this.borderColor = SoftErpTheme.borderStrong,
  });

  final String label;
  final Color background;
  final Color textColor;
  final Color borderColor;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: borderColor),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: textColor,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
