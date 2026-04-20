import 'package:flutter/material.dart';

import '../../data/auth_api.dart';
import '../../domain/auth_user.dart';

class AuthProvider extends ChangeNotifier {
  AuthProvider({
    required String baseUrl,
    bool demoMode = false,
  }) : _demoMode = demoMode,
       _api = AuthApi(baseUrl: baseUrl);

  final AuthApi _api;
  final bool _demoMode;

  AuthUser? _user;
  String? _token;
  bool _isLoading = false;
  String? _errorMessage;
  List<AuthUser> _users = const [];
  List<DeleteRequest> _deleteRequests = const [];

  AuthUser? get user => _user;
  String? get token => _token;
  bool get isLoading => _isLoading;
  String? get errorMessage => _errorMessage;
  List<AuthUser> get users => _users;
  List<DeleteRequest> get deleteRequests => _deleteRequests;
  bool get isAuthenticated => _user != null || _demoMode;
  bool get isAdmin => _demoMode || (_user?.isAdmin ?? false);
  bool get isSuperAdmin => _user?.isSuperAdmin ?? _demoMode;
  bool get isRegularUser => !_demoMode && (_user?.isRegularUser ?? false);

  Future<void> initialize() async {
    if (_demoMode) {
      _user = const AuthUser(
        id: 0,
        name: 'Demo Admin',
        email: 'demo@paper.local',
        role: 'super_admin',
        isActive: true,
      );
      notifyListeners();
    }
  }

  Future<bool> login({required String email, required String password}) async {
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();
    try {
      final result = await _api.login(email: email, password: password);
      _user = result.user;
      _token = result.token;
      _api.token = _token;
      return true;
    } catch (error) {
      _errorMessage = _friendly(error, fallback: 'Login failed.');
      return false;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  void logout() {
    _user = null;
    _token = null;
    _api.token = null;
    _users = const [];
    _deleteRequests = const [];
    notifyListeners();
  }

  Future<void> loadManagementData() async {
    if (!isAdmin || _demoMode) {
      return;
    }
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();
    try {
      _users = await _api.getUsers();
      _deleteRequests = await _api.getDeleteRequests();
    } catch (error) {
      _errorMessage = _friendly(
        error,
        fallback: 'Failed to load user management data.',
      );
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<bool> createUser({
    required String name,
    required String email,
    required String password,
    required bool admin,
  }) async {
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();
    try {
      await _api.createUser(
        name: name,
        email: email,
        password: password,
        admin: admin,
      );
      await loadManagementData();
      return true;
    } catch (error) {
      _errorMessage = _friendly(error, fallback: 'Failed to create user.');
      return false;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<bool> resetPassword({
    required int userId,
    required String password,
  }) async {
    _errorMessage = null;
    notifyListeners();
    try {
      await _api.resetPassword(userId: userId, password: password);
      return true;
    } catch (error) {
      _errorMessage = _friendly(error, fallback: 'Failed to reset password.');
      notifyListeners();
      return false;
    }
  }

  Future<bool> setUserActive({
    required int userId,
    required bool active,
  }) async {
    _errorMessage = null;
    notifyListeners();
    try {
      await _api.setUserActive(userId: userId, active: active);
      await loadManagementData();
      return true;
    } catch (error) {
      _errorMessage = _friendly(
        error,
        fallback: 'Failed to update user status.',
      );
      notifyListeners();
      return false;
    }
  }

  Future<bool> changeOwnPassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    _errorMessage = null;
    notifyListeners();
    try {
      await _api.changeOwnPassword(
        currentPassword: currentPassword,
        newPassword: newPassword,
      );
      return true;
    } catch (error) {
      _errorMessage = _friendly(error, fallback: 'Failed to change password.');
      notifyListeners();
      return false;
    }
  }

  Future<bool> requestDelete({
    required String entityType,
    required String entityId,
    required String entityLabel,
    required String reason,
  }) async {
    _errorMessage = null;
    notifyListeners();
    try {
      await _api.requestDelete(
        entityType: entityType,
        entityId: entityId,
        entityLabel: entityLabel,
        reason: reason,
      );
      return true;
    } catch (error) {
      _errorMessage = _friendly(error, fallback: 'Failed to request deletion.');
      notifyListeners();
      return false;
    }
  }

  Future<bool> reviewDeleteRequest(int id, {required bool approve}) async {
    _errorMessage = null;
    notifyListeners();
    try {
      await _api.reviewDeleteRequest(id, approve: approve);
      await loadManagementData();
      return true;
    } catch (error) {
      _errorMessage = _friendly(
        error,
        fallback: 'Failed to review delete request.',
      );
      notifyListeners();
      return false;
    }
  }

  String _friendly(Object error, {required String fallback}) {
    if (error is AuthApiException && error.message.trim().isNotEmpty) {
      return error.message;
    }
    final text = error.toString();
    return text.trim().isEmpty ? fallback : text;
  }
}
