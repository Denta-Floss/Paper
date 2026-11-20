import 'dart:async';

import 'package:core_erp/core/services/socket_service.dart';
import 'package:core_erp/core/sync/replica_session.dart';
import 'package:core_erp/core/theme/soft_erp_theme.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

/// Says so when the phone has lost the server.
///
/// The screens keep working from the phone's own copy, which is the point of
/// having one — but what they show then stops moving, and someone counting
/// sheets at a press needs to know that the number in front of them is as of
/// a time, not live. Shown only after the change stream has been down for a
/// few seconds, so starting up or a blip of signal does not flash it.
class OfflineBanner extends StatefulWidget {
  const OfflineBanner({
    super.key,
    required this.child,
    this.live,
    this.lastSyncedAt,
    this.grace = const Duration(seconds: 4),
  });

  final Widget child;

  /// Whether the change stream is open. Defaults to the app's own.
  final ValueListenable<bool>? live;

  /// When the copy last caught up. Defaults to the app's replica.
  final ValueListenable<DateTime?>? lastSyncedAt;

  final Duration grace;

  @override
  State<OfflineBanner> createState() => _OfflineBannerState();
}

class _OfflineBannerState extends State<OfflineBanner> {
  late final ValueListenable<bool> _live = widget.live ?? SocketService.instance.streamLive;
  late final ValueListenable<DateTime?> _synced =
      widget.lastSyncedAt ?? ReplicaSession.instance.lastSyncedAt;
  Timer? _grace;
  bool _showing = false;

  @override
  void initState() {
    super.initState();
    _live.addListener(_onLive);
    _onLive();
  }

  void _onLive() {
    if (_live.value) {
      _grace?.cancel();
      _grace = null;
      if (_showing) setState(() => _showing = false);
      return;
    }
    _grace ??= Timer(widget.grace, () {
      _grace = null;
      if (mounted && !_live.value) setState(() => _showing = true);
    });
  }

  @override
  void dispose() {
    _grace?.cancel();
    _live.removeListener(_onLive);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        if (_showing)
          Material(
            color: SoftErpTheme.warningBg,
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                child: Row(
                  children: <Widget>[
                    const Icon(Icons.cloud_off_outlined, size: 20, color: SoftErpTheme.warningText),
                    const SizedBox(width: 10),
                    Expanded(
                      child: ValueListenableBuilder<DateTime?>(
                        valueListenable: _synced,
                        builder: (context, at, _) => Text(
                          at == null
                              ? 'Offline. Changes made elsewhere will show when the connection is back.'
                              : 'Offline. Showing what this phone last synced at ${_clock(at)}.',
                          key: const ValueKey<String>('offline_banner_text'),
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                            color: SoftErpTheme.warningText,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        Expanded(child: widget.child),
      ],
    );
  }

  static String _clock(DateTime at) {
    String two(int n) => n.toString().padLeft(2, '0');
    final now = DateTime.now();
    final sameDay = at.year == now.year && at.month == now.month && at.day == now.day;
    final time = '${two(at.hour)}:${two(at.minute)}';
    return sameDay ? time : '$time on ${two(at.day)}/${two(at.month)}';
  }
}
