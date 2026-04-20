class AuthUser {
  const AuthUser({
    required this.id,
    required this.name,
    required this.email,
    required this.role,
    required this.isActive,
  });

  final int id;
  final String name;
  final String email;
  final String role;
  final bool isActive;

  bool get isSuperAdmin => role == 'super_admin';
  bool get isAdmin => role == 'admin' || role == 'super_admin';
  bool get isRegularUser => role == 'user';

  factory AuthUser.fromJson(Map<String, dynamic> json) {
    return AuthUser(
      id: json['id'] as int? ?? 0,
      name: json['name'] as String? ?? '',
      email: json['email'] as String? ?? '',
      role: json['role'] as String? ?? 'user',
      isActive: json['isActive'] as bool? ?? false,
    );
  }
}

class DeleteRequest {
  const DeleteRequest({
    required this.id,
    required this.entityType,
    required this.entityId,
    required this.entityLabel,
    required this.reason,
    required this.status,
    required this.requestedByName,
    required this.createdAt,
  });

  final int id;
  final String entityType;
  final String entityId;
  final String entityLabel;
  final String reason;
  final String status;
  final String requestedByName;
  final DateTime createdAt;

  factory DeleteRequest.fromJson(Map<String, dynamic> json) {
    return DeleteRequest(
      id: json['id'] as int? ?? 0,
      entityType: json['entityType'] as String? ?? '',
      entityId: json['entityId'] as String? ?? '',
      entityLabel: json['entityLabel'] as String? ?? '',
      reason: json['reason'] as String? ?? '',
      status: json['status'] as String? ?? 'pending',
      requestedByName: json['requestedByName'] as String? ?? '',
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.now(),
    );
  }
}
