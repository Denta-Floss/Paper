import 'package:challan_mobile/services/network_discovery_service.dart';
import 'package:flutter_test/flutter_test.dart';

// B54: the address typed on the setup screen becomes the server URL the phone
// remembers. A port typed with it was doubled, and the phone could never connect.
void main() {
  test('a bare address gets the factory server\'s port', () {
    expect(NetworkDiscoveryService.serverUrlFrom('10.0.2.2'), 'http://10.0.2.2:18080');
  });

  test('a typed port is kept, not doubled', () {
    expect(NetworkDiscoveryService.serverUrlFrom('10.0.2.2:18080'), 'http://10.0.2.2:18080');
    expect(NetworkDiscoveryService.serverUrlFrom(' 192.168.1.20:9000/ '), 'http://192.168.1.20:9000');
  });

  test('a URL with its scheme is used as typed, less a trailing slash', () {
    expect(NetworkDiscoveryService.serverUrlFrom('https://paper.example.com/'), 'https://paper.example.com');
    expect(NetworkDiscoveryService.serverUrlFrom('http://16.170.236.173:18080'), 'http://16.170.236.173:18080');
  });
}
