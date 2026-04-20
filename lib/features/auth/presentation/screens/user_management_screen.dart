import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../domain/auth_user.dart';
import '../providers/auth_provider.dart';

class UserManagementScreen extends StatefulWidget {
  const UserManagementScreen({super.key});

  @override
  State<UserManagementScreen> createState() => _UserManagementScreenState();
}

class _UserManagementScreenState extends State<UserManagementScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<AuthProvider>().loadManagementData();
    });
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    if (!auth.isAdmin) {
      return const Center(child: Text('You do not have access to this area.'));
    }

    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'User Management',
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            OutlinedButton.icon(
              onPressed: auth.isLoading
                  ? null
                  : () => auth.loadManagementData(),
              icon: const Icon(Icons.refresh),
              label: const Text('Refresh'),
            ),
            const SizedBox(width: 12),
            FilledButton.icon(
              onPressed: () => _openCreateUserDialog(context, admin: false),
              icon: const Icon(Icons.person_add_alt_1),
              label: const Text('New User'),
            ),
            if (auth.isSuperAdmin) ...[
              const SizedBox(width: 12),
              FilledButton.tonalIcon(
                onPressed: () => _openCreateUserDialog(context, admin: true),
                icon: const Icon(Icons.admin_panel_settings_outlined),
                label: const Text('New Admin'),
              ),
            ],
          ],
        ),
        if (auth.errorMessage != null) ...[
          const SizedBox(height: 16),
          _InlineError(message: auth.errorMessage!),
        ],
        const SizedBox(height: 20),
        _Section(
          title: 'Accounts',
          child: auth.users.isEmpty
              ? const _EmptyBlock('No users loaded yet.')
              : Column(
                  children: auth.users
                      .map((user) => _UserRow(user: user))
                      .toList(growable: false),
                ),
        ),
        const SizedBox(height: 20),
        _Section(
          title: 'Pending Delete Requests',
          child: auth.deleteRequests.isEmpty
              ? const _EmptyBlock('No pending delete requests.')
              : Column(
                  children: auth.deleteRequests
                      .map((request) => _DeleteRequestRow(request: request))
                      .toList(growable: false),
                ),
        ),
      ],
    );
  }

  Future<void> _openCreateUserDialog(
    BuildContext context, {
    required bool admin,
  }) async {
    final nameController = TextEditingController();
    final emailController = TextEditingController();
    final passwordController = TextEditingController();
    final formKey = GlobalKey<FormState>();
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(admin ? 'Register admin' : 'Register user'),
        content: Form(
          key: formKey,
          child: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextFormField(
                  controller: nameController,
                  decoration: const InputDecoration(labelText: 'Name'),
                  validator: (value) =>
                      value == null || value.trim().isEmpty
                      ? 'Enter a name.'
                      : null,
                ),
                TextFormField(
                  controller: emailController,
                  decoration: const InputDecoration(labelText: 'Email'),
                  validator: (value) =>
                      value == null || value.trim().isEmpty
                      ? 'Enter an email.'
                      : null,
                ),
                TextFormField(
                  controller: passwordController,
                  decoration: const InputDecoration(labelText: 'Password'),
                  obscureText: true,
                  validator: (value) => value == null || value.length < 8
                      ? 'Use at least 8 characters.'
                      : null,
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () async {
              if (!formKey.currentState!.validate()) {
                return;
              }
              final ok = await context.read<AuthProvider>().createUser(
                name: nameController.text,
                email: emailController.text,
                password: passwordController.text,
                admin: admin,
              );
              if (ok && dialogContext.mounted) {
                Navigator.of(dialogContext).pop();
              }
            },
            child: const Text('Create'),
          ),
        ],
      ),
    );
    nameController.dispose();
    emailController.dispose();
    passwordController.dispose();
  }
}

class _UserRow extends StatelessWidget {
  const _UserRow({required this.user});

  final AuthUser user;

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final canManage = user.id != auth.user?.id &&
        (auth.isSuperAdmin || user.role == 'user');
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      leading: CircleAvatar(
        child: Icon(user.role == 'user' ? Icons.person : Icons.shield),
      ),
      title: Text(user.name),
      subtitle: Text('${user.email} • ${user.role}'),
      trailing: Wrap(
        spacing: 8,
        children: [
          Chip(
            label: Text(user.isActive ? 'Active' : 'Inactive'),
            backgroundColor: user.isActive
                ? const Color(0xFFE7F8EF)
                : const Color(0xFFFEECEC),
          ),
          OutlinedButton(
            onPressed: canManage ? () => _resetPassword(context, user) : null,
            child: const Text('Reset password'),
          ),
          OutlinedButton(
            onPressed: canManage
                ? () => auth.setUserActive(
                    userId: user.id,
                    active: !user.isActive,
                  )
                : null,
            child: Text(user.isActive ? 'Deactivate' : 'Activate'),
          ),
        ],
      ),
    );
  }

  Future<void> _resetPassword(BuildContext context, AuthUser user) async {
    final controller = TextEditingController();
    final formKey = GlobalKey<FormState>();
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Reset password for ${user.name}'),
        content: Form(
          key: formKey,
          child: TextFormField(
            controller: controller,
            decoration: const InputDecoration(labelText: 'New password'),
            obscureText: true,
            validator: (value) => value == null || value.length < 8
                ? 'Use at least 8 characters.'
                : null,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () async {
              if (!formKey.currentState!.validate()) {
                return;
              }
              final ok = await context.read<AuthProvider>().resetPassword(
                userId: user.id,
                password: controller.text,
              );
              if (ok && dialogContext.mounted) {
                Navigator.of(dialogContext).pop();
              }
            },
            child: const Text('Reset'),
          ),
        ],
      ),
    );
    controller.dispose();
  }
}

class _DeleteRequestRow extends StatelessWidget {
  const _DeleteRequestRow({required this.request});

  final DeleteRequest request;

  @override
  Widget build(BuildContext context) {
    final auth = context.read<AuthProvider>();
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      leading: const CircleAvatar(child: Icon(Icons.delete_outline)),
      title: Text(request.entityLabel.isEmpty
          ? request.entityId
          : request.entityLabel),
      subtitle: Text(
        'Requested by ${request.requestedByName.ifEmpty('Unknown')} • ${request.reason.ifEmpty('No reason provided')}',
      ),
      trailing: Wrap(
        spacing: 8,
        children: [
          OutlinedButton(
            onPressed: () =>
                auth.reviewDeleteRequest(request.id, approve: false),
            child: const Text('Reject'),
          ),
          FilledButton(
            onPressed: () =>
                auth.reviewDeleteRequest(request.id, approve: true),
            child: const Text('Approve'),
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: const Color(0xFFE1E5ED)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              title,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          const Divider(height: 1),
          child,
        ],
      ),
    );
  }
}

class _EmptyBlock extends StatelessWidget {
  const _EmptyBlock(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Text(message, style: const TextStyle(color: Color(0xFF6B7280))),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFFEECEC),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(message, style: const TextStyle(color: Color(0xFFB42318))),
    );
  }
}

extension _StringFallback on String {
  String ifEmpty(String fallback) => trim().isEmpty ? fallback : this;
}
