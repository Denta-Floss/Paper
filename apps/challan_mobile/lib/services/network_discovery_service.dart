import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:nsd/nsd.dart';
import 'package:shared_preferences/shared_preferences.dart';

class NetworkDiscoveryService extends ChangeNotifier {
  static const String _serviceType = '_papererp._tcp';
  
  Discovery? _discovery;
  String? _discoveredUrl;
  bool _isSearching = false;
  bool _hasTimedOut = false;
  
  String? get discoveredUrl => _discoveredUrl;
  bool get isSearching => _isSearching;
  bool get hasTimedOut => _hasTimedOut;

  /// The server's URL from what was typed: `10.0.2.2`, `10.0.2.2:18080`,
  /// `http://host:8080/` all work. The default port is added only when none
  /// was typed — "10.0.2.2:18080" used to become "http://10.0.2.2:18080:18080",
  /// which was then remembered and failed every launch as "cannot be reached"
  /// (B54).
  static String serverUrlFrom(String typed) {
    var text = typed.trim();
    while (text.endsWith('/')) {
      text = text.substring(0, text.length - 1);
    }
    final withScheme = text.startsWith('http://') || text.startsWith('https://') ? text : 'http://$text';
    final uri = Uri.tryParse(withScheme);
    if (uri == null || uri.host.isEmpty) return withScheme;
    final typedScheme = text.startsWith('http://') || text.startsWith('https://');
    // A typed scheme with no port means that scheme's own port (an AWS URL);
    // a bare address means the factory server's.
    if (uri.hasPort || typedScheme) return withScheme;
    return '$withScheme:18080';
  }

  /// Where the server this phone last connected to is remembered (B45).
  /// Without it every launch started at the setup screen.
  static const String serverKey = 'paper_server_url';

  void manualConnect(String ipAddress) {
    _discoveredUrl = serverUrlFrom(ipAddress);
    _isSearching = false;
    _remember(_discoveredUrl!);
    notifyListeners();
  }

  void _remember(String url) {
    SharedPreferences.getInstance()
        .then((prefs) => prefs.setString(serverKey, url))
        .catchError((_) => false);
  }

  /// Forgets the remembered server and looks again — "Change server".
  Future<void> forget() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(serverKey);
    } catch (_) {
      // Nothing remembered to remove.
    }
    _discoveredUrl = null;
    notifyListeners();
    await discoverServer(useRemembered: false);
  }

  /// Uses the server this phone last connected to, when there is one, and
  /// only looks on the network when there is not. A remembered server is used
  /// even when it cannot be reached right now: that is how the phone starts
  /// offline and opens its own copy.
  Future<void> discoverServer({bool useRemembered = true}) async {
    if (_isSearching) return;
    if (useRemembered) {
      try {
        final prefs = await SharedPreferences.getInstance();
        final remembered = prefs.getString(serverKey);
        if (remembered != null && remembered.isNotEmpty) {
          _discoveredUrl = remembered;
          notifyListeners();
          return;
        }
      } catch (_) {
        // No preferences: look on the network as before.
      }
    }
    
    _isSearching = true;
    _hasTimedOut = false;
    _discoveredUrl = null;
    notifyListeners();

    // 5 second timeout for mDNS
    Future.delayed(const Duration(seconds: 5), () {
      if (_isSearching && _discoveredUrl == null) {
        _hasTimedOut = true;
        _isSearching = false;
        notifyListeners();
        stopServerDiscovery();
      }
    });

    try {
      _discovery = await startDiscovery(_serviceType);
      _discovery!.addListener(() {
        for (final service in _discovery!.services) {
          if (service.host != null && service.port != null) {
            _discoveredUrl = 'http://${service.host}:${service.port}';
            _remember(_discoveredUrl!);
            _isSearching = false;
            notifyListeners();
            stopServerDiscovery();
            break;
          }
        }
      });
    } catch (e) {
      debugPrint('Error starting mDNS discovery: $e');
      _isSearching = false;
      notifyListeners();
    }
  }

  Future<void> stopServerDiscovery() async {
    if (_discovery != null) {
      await stopDiscovery(_discovery!);
      _discovery = null;
    }
    _isSearching = false;
    notifyListeners();
  }
}
