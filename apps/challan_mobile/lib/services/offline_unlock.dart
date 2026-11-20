import 'dart:convert';
import 'dart:math';

import 'package:core_erp/features/auth/domain/auth_user.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where the offline unlock keeps what it needs. The app's is the platform's
/// secure storage (the Android keystore); a test hands in a map.
abstract class SecretStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SecureSecretStore implements SecretStore {
  const SecureSecretStore([this._storage = const FlutterSecureStorage()]);

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// Lets the last person who signed in on this phone open it again when the
/// server cannot be reached (B45).
///
/// What it keeps, after each online PIN sign-in: who that person is, the
/// token that sign-in issued, the server it was issued by, and a salted,
/// stretched hash of their PIN — never the PIN. What it unlocks: only the copy
/// already on this phone; every write still needs the server, and the stored
/// token is what the app presents when the server is back (if it has expired,
/// the server refuses it and the person signs in again).
///
/// It is used only when the server could not be asked at all. A PIN the server
/// refused is refused; an offline unlock never overrides an answer.
class OfflineUnlock {
  OfflineUnlock({required this.serverUrl, SecretStore? store, Random? random})
      : _store = store ?? const SecureSecretStore(),
        _random = random ?? Random.secure();

  /// The server this phone talks to. A sign-in remembered for another server
  /// does not unlock this one.
  final String serverUrl;
  final SecretStore _store;
  final Random _random;

  static const String _key = 'paper_offline_unlock_v1';

  /// Rounds of SHA-256 over the salted PIN. A four-digit PIN is a small
  /// space, so this only slows a guesser who has the phone's keystore; the
  /// keystore is the real protection.
  static const int _rounds = 20000;

  /// Records an online sign-in so the same person can open the phone offline.
  Future<void> remember({
    required String pin,
    required AuthUser user,
    required String token,
  }) async {
    final salt = base64Encode(List<int>.generate(16, (_) => _random.nextInt(256)));
    await _store.write(
      _key,
      jsonEncode(<String, dynamic>{
        'server': serverUrl,
        'salt': salt,
        'hash': _hash(salt, pin),
        'user': user.toJson(),
        'token': token,
      }),
    );
  }

  /// Who [pin] opens the phone as, offline; null when it does not match what
  /// was remembered, nothing was, or it was for another server.
  Future<({AuthUser user, String token})?> unlock(String pin) async {
    final raw = await _store.read(_key);
    if (raw == null) return null;
    try {
      final kept = jsonDecode(raw) as Map<String, dynamic>;
      if (kept['server'] != serverUrl) return null;
      final hash = _hash(kept['salt'] as String, pin);
      if (!_sameText(hash, kept['hash'] as String)) return null;
      return (
        user: AuthUser.fromJson(kept['user'] as Map<String, dynamic>),
        token: kept['token'] as String,
      );
    } catch (_) {
      return null;
    }
  }

  /// Forgets the remembered sign-in — on signing out, or a change of server.
  Future<void> forget() => _store.delete(_key);

  static String _hash(String salt, String pin) {
    var digest = sha256.convert(utf8.encode('$salt:$pin')).bytes;
    for (var i = 1; i < _rounds; i += 1) {
      digest = sha256.convert(digest).bytes;
    }
    return base64Encode(digest);
  }

  /// Compares without stopping at the first difference.
  static bool _sameText(String a, String b) {
    if (a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i += 1) {
      diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
    }
    return diff == 0;
  }
}
