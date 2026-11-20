import 'package:challan_mobile/services/offline_unlock.dart';
import 'package:core_erp/features/auth/domain/auth_user.dart';
import 'package:flutter_test/flutter_test.dart';

class MapStore implements SecretStore {
  final Map<String, String> values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

const _ravi = AuthUser(
  id: 7,
  name: 'Ravi',
  email: 'ravi@paper.test',
  role: 'user',
  permissions: <String>['challans.create'],
  isActive: true,
  mobilePin: '4321',
);

void main() {
  test('the last person to sign in opens the phone offline with their passcode', () async {
    final store = MapStore();
    final unlock = OfflineUnlock(serverUrl: 'http://10.0.2.2:18080', store: store);
    await unlock.remember(pin: '4321', user: _ravi, token: 'tok-1');

    final opened = await unlock.unlock('4321');
    expect(opened?.user.id, 7);
    expect(opened?.user.permissions, <String>['challans.create']);
    expect(opened?.token, 'tok-1');
  });

  test('any other passcode does not', () async {
    final unlock = OfflineUnlock(serverUrl: 'http://s', store: MapStore());
    await unlock.remember(pin: '4321', user: _ravi, token: 't');
    expect(await unlock.unlock('1234'), isNull);
    expect(await unlock.unlock(''), isNull);
  });

  test('the passcode itself is never kept, not even inside the user', () async {
    final store = MapStore();
    await OfflineUnlock(serverUrl: 'http://s', store: store)
        .remember(pin: '4321', user: _ravi, token: 't');
    final kept = store.values.values.single;
    expect(kept.contains('4321'), isFalse, reason: 'a hash, and the user without mobilePin');
  });

  test('a sign-in remembered for one server does not open another', () async {
    final store = MapStore();
    await OfflineUnlock(serverUrl: 'http://factory-a', store: store)
        .remember(pin: '4321', user: _ravi, token: 't');
    expect(await OfflineUnlock(serverUrl: 'http://factory-b', store: store).unlock('4321'), isNull);
  });

  test('forgotten, nothing opens', () async {
    final store = MapStore();
    final unlock = OfflineUnlock(serverUrl: 'http://s', store: store);
    await unlock.remember(pin: '4321', user: _ravi, token: 't');
    await unlock.forget();
    expect(await unlock.unlock('4321'), isNull);
  });
}
