import 'package:core_erp/core/sync/sync_health.dart';
import 'package:core_erp/core/theme/soft_erp_theme.dart';
import 'package:core_erp/features/auth/presentation/providers/auth_provider.dart';
import 'package:core_erp/features/sync_health/sync_health_screen.dart';
import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import '../services/offline_unlock.dart';

/// An explicit sign-out on the phone. Forgets the offline unlock first:
/// otherwise the PIN would still open this phone onto its copy without the
/// server (OfflineUnlock, B45). Then the server session, then this one.
Future<void> signOutPhone(AuthProvider auth, OfflineUnlock? unlock) async {
  await unlock?.forget();
  await auth.logoutRemote();
}

/// What the phone's settings sheet can do for the signed-in session; given by
/// _AuthGate, which owns the session.
class PhoneSession {
  const PhoneSession({required this.serverUrl, required this.signOut, this.changeServer});

  final String serverUrl;

  /// Signs out here and forgets the offline unlock, so the PIN no longer opens
  /// this phone without the server.
  final Future<void> Function() signOut;

  /// Signs out, forgets this server and looks for one again.
  final Future<void> Function()? changeServer;
}

/// The phone's own settings (B55). The gear used to open the desktop's
/// AppSettingsDialog, which reads a PreferencesProvider the phone never had —
/// a red error box — and which holds desktop item-form switches and the demo
/// reseed / clear-data controls, none of which belong on a shop-floor phone.
Future<void> showPhoneSettingsSheet(BuildContext context, PhoneSession session) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheetContext) => _PhoneSettingsSheet(session: session, hostContext: context),
  );
}

class _PhoneSettingsSheet extends StatelessWidget {
  const _PhoneSettingsSheet({required this.session, required this.hostContext});

  final PhoneSession session;

  /// The screen the sheet was opened from: pages are pushed from there, after
  /// the sheet has closed.
  final BuildContext hostContext;

  @override
  Widget build(BuildContext context) {
    final user = context.watch<AuthProvider>().user;
    const label = TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: SoftErpTheme.textPrimary);
    const detail = TextStyle(fontSize: 14, color: SoftErpTheme.textSecondary);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 0, 8, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text('Settings', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
            ),
            if (user != null)
              ListTile(
                leading: const Icon(Icons.person_outline, color: SoftErpTheme.accent),
                title: Text(user.name.isEmpty ? user.email : user.name, style: label),
                subtitle: Text(user.email, style: detail),
              ),
            ListTile(
              key: const Key('settings_sync_health'),
              leading: const Icon(Icons.monitor_heart_outlined, color: SoftErpTheme.accent),
              title: const Text('Sync health', style: label),
              subtitle: const Text('Connection, this phone\'s copy, what is waiting to send', style: detail),
              trailing: const Icon(Icons.chevron_right),
              onTap: () {
                final probe = context.read<SyncHealthProbe>();
                Navigator.of(context).pop();
                Navigator.of(hostContext).push(MaterialPageRoute<void>(builder: (_) => SyncHealthScreen(probe: probe)));
              },
            ),
            ListTile(
              key: const Key('settings_server'),
              leading: const Icon(Icons.dns_outlined, color: SoftErpTheme.accent),
              title: const Text('Server', style: label),
              subtitle: Text(session.serverUrl, style: detail),
              trailing: session.changeServer == null
                  ? null
                  : TextButton(
                      key: const Key('settings_change_server'),
                      onPressed: () => _confirm(
                        context,
                        title: 'Change server?',
                        message: 'You will be signed out and the phone will look for a server again.',
                        action: 'Change server',
                        run: session.changeServer!,
                      ),
                      child: const Text('Change', style: TextStyle(fontSize: 15)),
                    ),
            ),
            ListTile(
              key: const Key('settings_sign_out'),
              leading: const Icon(Icons.logout, color: SoftErpTheme.dangerText),
              title: const Text('Sign out', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: SoftErpTheme.dangerText)),
              subtitle: const Text('Your PIN will need the server to sign in again', style: detail),
              onTap: () => _confirm(
                context,
                title: 'Sign out?',
                message: 'Your PIN will not open this phone again until the server can be reached.',
                action: 'Sign out',
                run: session.signOut,
              ),
            ),
            const Divider(height: 24),
            FutureBuilder<PackageInfo>(
              future: PackageInfo.fromPlatform(),
              builder: (context, snapshot) {
                final info = snapshot.data;
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(
                    info == null
                        ? 'API $kPaperApiVersion'
                        : 'Version ${info.version}+${info.buildNumber} · API $kPaperApiVersion',
                    key: const Key('settings_version'),
                    style: detail,
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirm(
    BuildContext context, {
    required String title,
    required String message,
    required String action,
    required Future<void> Function() run,
  }) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(message, style: const TextStyle(fontSize: 15)),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: Text(action)),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    Navigator.of(context).pop();
    await run();
  }
}
