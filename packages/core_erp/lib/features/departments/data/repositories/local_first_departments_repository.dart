import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../../../../core/sync/replica_reader.dart';
import '../../domain/department_definition.dart';
import 'departments_repository.dart';

/// Serves the departments list from the local replica, everything else from
/// the network — the pattern of LocalFirstItemRepository.
///
/// A subclass rather than a decorator: [DepartmentsRepository] is a concrete
/// class with no interface. Only the departments list is replicated; employees
/// are not, and keep going to the network through the inherited methods.
///
/// The server lists live departments only (`WHERE is_archived = 0 ORDER BY
/// name ASC`), so the replica holds exactly those, in the same order.
class LocalFirstDepartmentsRepository extends DepartmentsRepository {
  LocalFirstDepartmentsRepository({
    super.client,
    super.baseUrl,
    super.useMockResponses,
    required Future<Database?> Function() replica,
    required bool Function() isHydrated,
  }) : _reader = ReplicaReader(replica: replica, isHydrated: isHydrated);

  final ReplicaReader _reader;

  @override
  Future<List<DepartmentDefinition>> getDepartments() async {
    final local = await _reader.readAll<DepartmentDefinition>(
      'local_departments',
      orderBy: 'name ASC',
      fromJson: DepartmentDefinition.fromJson,
    );
    return local ?? super.getDepartments();
  }

  @override
  Future<DepartmentDefinition> createDepartment(String name, String description, String photoUrl) =>
      _wrote(super.createDepartment(name, description, photoUrl));

  @override
  Future<DepartmentDefinition> updateDepartment(int id, String name, String description, String photoUrl) =>
      _wrote(super.updateDepartment(id, name, description, photoUrl));

  @override
  Future<void> deleteDepartment(int id) => _wrote(super.deleteDepartment(id));

  Future<T> _wrote<T>(Future<T> write) =>
      write.whenComplete(() => _reader.wrote('local_departments'));
}
