import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:core_erp/features/auth/presentation/providers/auth_provider.dart';

class SocketService extends ChangeNotifier {
  bool _isConnected = false;
  String? _baseUrl;
  AuthProvider? _authProvider;

  bool get isConnected => _isConnected;
  String? get baseUrl => _baseUrl;

  void initAuth(AuthProvider authProvider) {
    _authProvider = authProvider;
  }

  void connect(String url) {
    _baseUrl = url;
    _isConnected = true;
    notifyListeners();
  }

  void disconnect() {
    _isConnected = false;
    notifyListeners();
  }

  Future<Map<String, dynamic>?> fetchMaterialDetail(String barcode) async {
    if (_isConnected && _baseUrl != null) {
      try {
        final token = _authProvider?.token ?? '';
        final response = await http.get(
          Uri.parse('$_baseUrl/api/materials/$barcode/detail'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
          },
        );
        if (response.statusCode == 200) {
          return jsonDecode(response.body);
        }
      } catch (e) {
        debugPrint('Failed to fetch material detail: $e');
      }
    }
    return null;
  }

}
