import 'package:flutter/material.dart';

import '../services/offline_unlock.dart';
import 'package:provider/provider.dart';
import 'package:core_erp/features/auth/presentation/providers/auth_provider.dart';

class PasscodeScreen extends StatefulWidget {
  final String expectedPasscode;

  /// Opens the phone without the server for the last person who signed in on
  /// it, when the server cannot be reached (B45). Null: online only.
  final OfflineUnlock? offlineUnlock;

  /// Back to the server setup screen. Null hides the link.
  final VoidCallback? onChangeServer;

  const PasscodeScreen({
    super.key,
    this.expectedPasscode = '0000',
    this.offlineUnlock,
    this.onChangeServer,
  });

  @override
  State<PasscodeScreen> createState() => _PasscodeScreenState();
}

class _PasscodeScreenState extends State<PasscodeScreen> {
  String _enteredDigits = '';

  /// Why the last attempt did not open the phone, shown under the dots with a
  /// way to try again (B44). Owned here rather than by the auth provider: the
  /// app used to swap this screen for a bare error page whenever the provider
  /// held an error, and that page had no way back to the keypad.
  String? _error;

  /// Checking the passcode, so the keypad does not take a fifth digit.
  bool _checking = false;

  int get _passcodeLength => 4;

  void _tryAgain() {
    setState(() {
      _error = null;
      _enteredDigits = '';
    });
  }

  void _onDigitPressed(String digit) {
    if (_checking) return;
    setState(() {
      _error = null;
      if (_enteredDigits.length < _passcodeLength) {
        _enteredDigits += digit;
      }

      if (_enteredDigits.length == _passcodeLength) {
        _performLogin();
      }
    });
  }

  void _onBackspacePressed() {
    setState(() {
      if (_enteredDigits.isNotEmpty) {
        _enteredDigits = _enteredDigits.substring(0, _enteredDigits.length - 1);
      }
    });
  }

  Future<void> _performLogin() async {
    final provider = context.read<AuthProvider>();
    final pin = _enteredDigits;
    final offline = widget.offlineUnlock;
    setState(() => _checking = true);
    final success = await provider.loginWithPin(pin: pin);
    final failure = provider.errorMessage;
    // The reason is shown here; the provider must not hold it, or the app
    // shell would treat it as its own.
    provider.clearError();
    if (mounted) setState(() => _checking = false);
    if (success) {
      final user = provider.user;
      final token = provider.token;
      if (offline != null && user != null && token != null) {
        // Kept for the next time the server cannot be reached.
        await offline.remember(pin: pin, user: user, token: token);
      }
      return;
    }
    // Only when the server was never asked. A PIN it refused stays refused.
    if (offline != null && provider.lastFailureWasUnreachable) {
      final opened = await offline.unlock(pin);
      if (opened != null) {
        provider.signInOffline(user: opened.user, token: opened.token);
        return;
      }
      if (!mounted) return;
      setState(() {
        _enteredDigits = '';
        _error =
            'The server cannot be reached, and this is not the passcode '
            'last used on this phone.';
      });
      return;
    }

    if (!mounted) return;
    setState(() {
      _enteredDigits = '';
      _error = failure ?? 'Invalid passcode.';
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0F172A),
      body: SafeArea(
        // Scrolls on a screen too short for the keypad, the reason and the
        // server link together; on a normal one the spacers lay it out as
        // before.
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: constraints.maxHeight),
              child: IntrinsicHeight(
                child: Column(
                  children: [
                    const Spacer(),
                    const Text(
                      'Enter Passcode',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 24,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 32),
                    _buildPasscodeIndicators(),
                    const SizedBox(height: 20),
                    ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 96),
                      child: _checking
                          ? const Center(
                              child: SizedBox(
                                width: 24,
                                height: 24,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2.5,
                                ),
                              ),
                            )
                          : _error == null
                          ? const SizedBox.shrink()
                          : Column(
                              children: [
                                Padding(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 32,
                                  ),
                                  child: Text(
                                    _error!,
                                    key: const ValueKey<String>(
                                      'passcode_error',
                                    ),
                                    textAlign: TextAlign.center,
                                    style: const TextStyle(
                                      color: Color(0xFFF87171),
                                      fontSize: 15,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ),
                                TextButton(
                                  key: const ValueKey<String>(
                                    'passcode_try_again',
                                  ),
                                  onPressed: _tryAgain,
                                  child: const Text(
                                    'Try again',
                                    style: TextStyle(
                                      fontSize: 15,
                                      color: Colors.white,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                    ),
                    const Spacer(),
                    _buildNumberPad(),
                    const SizedBox(height: 16),
                    if (widget.onChangeServer != null)
                      TextButton(
                        key: const ValueKey<String>('passcode_change_server'),
                        onPressed: widget.onChangeServer,
                        child: const Text(
                          'Change server',
                          style: TextStyle(
                            fontSize: 15,
                            color: Color(0xFF94A3B8),
                          ),
                        ),
                      ),
                    const SizedBox(height: 24),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPasscodeIndicators() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: List.generate(_passcodeLength, (index) {
        final isFilled = index < _enteredDigits.length;

        return Container(
          margin: const EdgeInsets.symmetric(horizontal: 8),
          width: 40,
          height: 48,
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(
                color: isFilled ? const Color(0xFF6366F1) : Colors.white38,
                width: 2,
              ),
            ),
          ),
          alignment: Alignment.center,
          child: Text(
            isFilled ? '*' : '', // Obfuscate digits
            style: const TextStyle(
              color: Colors.white,
              fontSize: 24,
              fontWeight: FontWeight.bold,
            ),
          ),
        );
      }),
    );
  }

  Widget _buildNumberPad() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 48),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _buildKey('1', onTap: () => _onDigitPressed('1')),
              _buildKey('2', onTap: () => _onDigitPressed('2')),
              _buildKey('3', onTap: () => _onDigitPressed('3')),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _buildKey('4', onTap: () => _onDigitPressed('4')),
              _buildKey('5', onTap: () => _onDigitPressed('5')),
              _buildKey('6', onTap: () => _onDigitPressed('6')),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _buildKey('7', onTap: () => _onDigitPressed('7')),
              _buildKey('8', onTap: () => _onDigitPressed('8')),
              _buildKey('9', onTap: () => _onDigitPressed('9')),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              const SizedBox(
                width: 72,
                height: 72,
              ), // Empty space for alignment
              _buildKey('0', onTap: () => _onDigitPressed('0')),
              _buildKey('⌫', onTap: _onBackspacePressed, isAction: true),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildKey(
    String label, {
    required VoidCallback onTap,
    bool isAction = false,
  }) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(36),
        child: Container(
          width: 72,
          height: 72,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: const Color(0xFF1E293B).withValues(alpha: 0.8),
            border: Border.all(
              color: const Color(0xFF334155).withValues(alpha: 0.5),
            ),
          ),
          alignment: Alignment.center,
          child: Text(
            label,
            style: TextStyle(
              color: isAction ? const Color(0xFF94A3B8) : Colors.white,
              fontSize: isAction ? 24 : 28,
              fontWeight: isAction ? FontWeight.normal : FontWeight.w500,
            ),
          ),
        ),
      ),
    );
  }
}
