import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/sync/sync_health.dart';
import '../../core/theme/soft_erp_theme.dart';

/// Sync Health: is this device talking to the server, how far behind is its
/// copy, what is it still holding to send, and do the two sides' versions
/// work together. For the person at the terminal and whoever they call.
///
/// Reads itself again every [interval] while it is open, which is the live
/// ping. Used as a page on the phone and as a pane inside desktop settings
/// ([embedded]).
class SyncHealthScreen extends StatefulWidget {
  const SyncHealthScreen({
    super.key,
    required this.probe,
    this.interval = const Duration(seconds: 5),
    this.embedded = false,
  });

  final SyncHealthProbe probe;
  final Duration interval;

  /// Without its own app bar, for a settings pane that already has a title.
  final bool embedded;

  @override
  State<SyncHealthScreen> createState() => _SyncHealthScreenState();
}

class _SyncHealthScreenState extends State<SyncHealthScreen> {
  SyncHealthReading? _reading;
  Timer? _timer;
  bool _busy = false;
  bool _flushing = false;

  @override
  void initState() {
    super.initState();
    _read();
    _timer = Timer.periodic(widget.interval, (_) => _read());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _read() async {
    if (_busy) return;
    _busy = true;
    try {
      final reading = await widget.probe.read();
      if (mounted) setState(() => _reading = reading);
    } finally {
      _busy = false;
    }
  }

  Future<void> _flush() async {
    setState(() => _flushing = true);
    try {
      await widget.probe.flushNow();
    } finally {
      if (mounted) setState(() => _flushing = false);
      await _read();
    }
  }

  @override
  Widget build(BuildContext context) {
    final reading = _reading;
    final body = reading == null
        ? const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))
        : ListView(
            key: const Key('sync_health_list'),
            // Embedded, it sits in a pane that already scrolls.
            shrinkWrap: widget.embedded,
            physics: widget.embedded ? const NeverScrollableScrollPhysics() : null,
            padding: widget.embedded ? EdgeInsets.zero : const EdgeInsets.all(16),
            children: [
              _ConnectionCard(reading: reading),
              const SizedBox(height: 12),
              _ReplicaCard(reading: reading),
              const SizedBox(height: 12),
              _OutboxCard(reading: reading, flushing: _flushing, onFlush: _flush),
              const SizedBox(height: 12),
              _VersionCard(reading: reading),
            ],
          );
    if (widget.embedded) return body;
    return Scaffold(
      backgroundColor: SoftErpTheme.shellSurface,
      appBar: AppBar(
        title: const Text('Sync Health'),
        actions: [
          IconButton(
            key: const Key('sync_health_refresh'),
            tooltip: 'Check again',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: _read,
          ),
        ],
      ),
      body: body,
    );
  }
}

String _ago(DateTime? at, DateTime now) {
  if (at == null) return 'never';
  final d = now.difference(at);
  if (d.inSeconds < 60) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} h ago';
  return '${d.inDays} d ago';
}

String _clock(DateTime at) {
  final local = at.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(local.hour)}:${two(local.minute)}:${two(local.second)}';
}

enum _Tone { good, warn, bad, neutral }

class _Card extends StatelessWidget {
  const _Card({required this.title, required this.icon, required this.status, required this.tone, required this.children});

  final String title;
  final IconData icon;
  final String status;
  final _Tone tone;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (tone) {
      _Tone.good => (SoftErpTheme.successBg, SoftErpTheme.successText),
      _Tone.warn => (SoftErpTheme.warningBg, SoftErpTheme.warningText),
      _Tone.bad => (SoftErpTheme.dangerBg, SoftErpTheme.dangerText),
      _Tone.neutral => (SoftErpTheme.sectionSurface, SoftErpTheme.textSecondary),
    };
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: SoftErpTheme.cardSurface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: SoftErpTheme.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: SoftErpTheme.accent),
              const SizedBox(width: 10),
              Expanded(
                child: Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: SoftErpTheme.textPrimary)),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(20)),
                child: Text(status, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: fg)),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ...children,
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value, {this.valueKey});

  final String label;
  final String value;
  final Key? valueKey;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 150,
            child: Text(label, style: const TextStyle(fontSize: 14, color: SoftErpTheme.textSecondary)),
          ),
          Expanded(
            child: Text(value, key: valueKey, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: SoftErpTheme.textPrimary)),
          ),
        ],
      ),
    );
  }
}

class _ConnectionCard extends StatelessWidget {
  const _ConnectionCard({required this.reading});

  final SyncHealthReading reading;

  @override
  Widget build(BuildContext context) {
    final ms = reading.pingMs;
    final (status, tone) = !reading.reachable
        ? ('Offline', _Tone.bad)
        : reading.error != null
            ? ('Problem', _Tone.warn)
            : ms != null && ms > 1500
                ? ('Slow', _Tone.warn)
                : ('Connected', _Tone.good);
    return _Card(
      title: 'Connection',
      icon: Icons.wifi_tethering_rounded,
      status: status,
      tone: tone,
      children: [
        _Row('Round trip', ms == null ? '—' : '$ms ms', valueKey: const Key('sync_health_ping')),
        _Row('Checked', _clock(reading.at)),
        if (reading.error != null) _Row('Detail', reading.error!, valueKey: const Key('sync_health_error')),
      ],
    );
  }
}

class _ReplicaCard extends StatelessWidget {
  const _ReplicaCard({required this.reading});

  final SyncHealthReading reading;

  @override
  Widget build(BuildContext context) {
    final behind = reading.changesBehind;
    final (status, tone) = reading.localCursor == null
        ? ('No copy', _Tone.neutral)
        : behind == null
            ? ('Unknown', _Tone.neutral)
            : behind == 0
                ? ('Up to date', _Tone.good)
                : ('$behind behind', _Tone.warn);
    return _Card(
      title: 'This device\'s copy',
      icon: Icons.storage_rounded,
      status: status,
      tone: tone,
      children: [
        _Row('Copy is at change', reading.localCursor?.toString() ?? '—', valueKey: const Key('sync_health_cursor')),
        _Row('Server is at change', reading.serverHead?.toString() ?? (reading.reachable ? '—' : 'unknown while offline'),
            valueKey: const Key('sync_health_head')),
        _Row('Last synced', reading.lastSyncedAt == null
            ? 'never'
            : '${_clock(reading.lastSyncedAt!)} (${_ago(reading.lastSyncedAt, reading.at)})'),
      ],
    );
  }
}

class _OutboxCard extends StatelessWidget {
  const _OutboxCard({required this.reading, required this.flushing, required this.onFlush});

  final SyncHealthReading reading;
  final bool flushing;
  final VoidCallback onFlush;

  @override
  Widget build(BuildContext context) {
    final queued = reading.outboxWaiting + reading.outboxSending;
    final (status, tone) = !reading.hasOutbox
        ? ('Not in use', _Tone.neutral)
        : reading.outboxConflicts > 0
            ? ('${reading.outboxConflicts} need review', _Tone.bad)
            : queued > 0
                ? ('$queued waiting', _Tone.warn)
                : ('Empty', _Tone.good);
    // Drawn disabled with the reason, never hidden: a button that appears only
    // sometimes reads as missing the rest of the time.
    final String? cannotFlush = !reading.hasOutbox
        ? 'There is no outbox on this device.'
        : queued == 0
            ? 'Nothing is waiting to be sent.'
            : !reading.reachable
                ? 'The server cannot be reached; it will be sent when it can.'
                : null;
    return _Card(
      title: 'Waiting to send',
      icon: Icons.outbox_rounded,
      status: status,
      tone: tone,
      children: [
        _Row('Waiting', '${reading.outboxWaiting}', valueKey: const Key('sync_health_waiting')),
        _Row('Sending now', '${reading.outboxSending}'),
        _Row('Need review', '${reading.outboxConflicts}', valueKey: const Key('sync_health_conflicts')),
        if (reading.outboxNextAttempt != null && queued > 0)
          _Row('Next try', _clock(reading.outboxNextAttempt!)),
        if (reading.outboxLastError != null && queued > 0) _Row('Last attempt', reading.outboxLastError!),
        const SizedBox(height: 8),
        Tooltip(
          message: cannotFlush ?? 'Send everything waiting now, without waiting for the next retry.',
          child: FilledButton.icon(
            key: const Key('sync_health_flush'),
            onPressed: cannotFlush != null || flushing ? null : onFlush,
            icon: flushing
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.send_rounded),
            label: const Text('Flush now', style: TextStyle(fontSize: 15)),
          ),
        ),
      ],
    );
  }
}

class _VersionCard extends StatelessWidget {
  const _VersionCard({required this.reading});

  final SyncHealthReading reading;

  @override
  Widget build(BuildContext context) {
    final compatibility = reading.compatibility;
    final (status, tone, meaning) = switch (compatibility) {
      ApiCompatibility.same => ('Compatible', _Tone.good, 'Same version (N).'),
      ApiCompatibility.appOneBehind => ('Compatible', _Tone.good, 'This app is one version behind the server (N-1); update when convenient.'),
      ApiCompatibility.serverOneBehind => ('Compatible', _Tone.good, 'The server is one version behind this app (N-1), as after a server rollback.'),
      ApiCompatibility.incompatible => ('Incompatible', _Tone.bad, 'More than one version apart: update the app or the server.'),
      ApiCompatibility.unknown => ('Unknown', _Tone.neutral, 'The server could not be asked.'),
    };
    return _Card(
      title: 'Versions',
      icon: Icons.verified_outlined,
      status: status,
      tone: tone,
      children: [
        _Row('This app', '${reading.appVersion} · API ${reading.appApiVersion}', valueKey: const Key('sync_health_app_version')),
        _Row('Server', reading.serverVersion == null
            ? '—'
            : '${reading.serverVersion}${reading.serverRelease == null ? '' : ' (${reading.serverRelease})'} · API ${reading.serverApiVersion ?? '?'}'),
        _Row('Check', meaning, valueKey: const Key('sync_health_compat')),
      ],
    );
  }
}
