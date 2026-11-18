import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

class AuthProvider extends ChangeNotifier {
  bool _isLoading = true;
  bool _isAuthenticated = false;
  int? _portalUserId;
  int? _clientId;
  String? _userName;

  bool get isLoading => _isLoading;
  bool get isAuthenticated => _isAuthenticated;
  int? get portalUserId => _portalUserId;
  int? get clientId => _clientId;
  String? get userName => _userName;

  AuthProvider() {
    _init();
  }

  Future<void> _init() async {
    final prefs = await SharedPreferences.getInstance();
    _portalUserId = prefs.getInt('portalUserId');
    _clientId = prefs.getInt('clientId');
    _userName = prefs.getString('userName');
    _isAuthenticated = _portalUserId != null && _clientId != null;
    _isLoading = false;
    notifyListeners();
  }

  Future<bool> login(String email, String password) async {
    try {
      final url = Uri.parse('http://localhost:3000/api/portal/login');
      final res = await http.post(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': email, 'password': password}),
      );
      
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final prefs = await SharedPreferences.getInstance();
        _portalUserId = data['user']['id'];
        _clientId = data['user']['client_id'];
        _userName = data['user']['name'] ?? data['user']['email'];
        await prefs.setInt('portalUserId', _portalUserId!);
        await prefs.setInt('clientId', _clientId!);
        await prefs.setString('userName', _userName!);
        _isAuthenticated = true;
        notifyListeners();
        return true;
      }
      
      return false;
    } catch (e) {
      return false;
    }
  }

  Future<void> logout() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    _isAuthenticated = false;
    _portalUserId = null;
    _clientId = null;
    _userName = null;
    notifyListeners();
  }
}
