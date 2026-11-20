import 'package:challan_mobile/services/network_discovery_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

// B45: the phone forgot its server on every launch.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a remembered server is used at launch, without looking on the network', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      NetworkDiscoveryService.serverKey: 'http://10.0.2.2:18080',
    });
    final discovery = NetworkDiscoveryService();
    await discovery.discoverServer();
    expect(discovery.discoveredUrl, 'http://10.0.2.2:18080');
    expect(discovery.isSearching, isFalse);
  });

  test('a server typed in is remembered', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    NetworkDiscoveryService().manualConnect('http://10.0.2.2:18080');
    await Future<void>.delayed(Duration.zero);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(NetworkDiscoveryService.serverKey), 'http://10.0.2.2:18080');
  });

  test('a bare address is remembered as the URL it becomes', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    NetworkDiscoveryService().manualConnect('192.168.1.20');
    await Future<void>.delayed(Duration.zero);
    expect((await SharedPreferences.getInstance()).getString(NetworkDiscoveryService.serverKey),
        'http://192.168.1.20:18080');
  });

  test('Change server forgets it', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      NetworkDiscoveryService.serverKey: 'http://10.0.2.2:18080',
    });
    final discovery = NetworkDiscoveryService();
    await discovery.discoverServer();
    await discovery.forget();
    expect((await SharedPreferences.getInstance()).getString(NetworkDiscoveryService.serverKey), isNull);
    expect(discovery.discoveredUrl, isNull);
  });
}
