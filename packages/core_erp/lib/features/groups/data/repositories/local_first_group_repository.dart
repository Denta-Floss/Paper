import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../../../../core/sync/replica_reader.dart';
import '../../domain/group_definition.dart';
import '../../domain/group_inputs.dart';
import '../../domain/group_overview.dart';
import '../models/group_api_models.dart';
import 'group_repository.dart';

/// Serves the groups list from the local replica, everything else from the
/// network — the pattern of LocalFirstItemRepository.
///
/// The row is the server's own list payload, parsed by the same `fromJson` the
/// network path uses. The replica answers only once hydrated, only when it has
/// rows, and only when it is not known to be behind on this table (a live change
/// it has not applied, or a write this client just made) — see
/// ReplicaFreshness. Otherwise the network answers, as it always did.
class LocalFirstGroupRepository implements GroupRepository {
  LocalFirstGroupRepository({
    required GroupRepository remote,
    required Future<Database?> Function() replica,
    required bool Function() isHydrated,
  }) : _remote = remote,
       _reader = ReplicaReader(replica: replica, isHydrated: isHydrated);

  final GroupRepository _remote;
  final ReplicaReader _reader;

  @override
  Future<void> init() => _remote.init();

  // The replica holds the list without covers, so only that variant is local.
  // The server's order: `is_archived ASC, LOWER(name) ASC`.
  @override
  Future<List<GroupDefinition>> getGroups({bool withCovers = false}) async {
    if (withCovers) return _remote.getGroups(withCovers: true);
    final local = await _reader.readAll<GroupDefinition>(
      'local_groups',
      orderBy: 'is_archived ASC, LOWER(name) ASC',
      fromJson: (json) => GroupDto.fromJson(json).toDomain(),
    );
    return local ?? _remote.getGroups();
  }

  @override
  Future<GroupOverview> getGroupOverview(int groupId) => _remote.getGroupOverview(groupId);

  @override
  Future<GroupDefinition> createGroup(CreateGroupInput input) => _wrote(_remote.createGroup(input));

  @override
  Future<GroupDefinition> updateGroup(UpdateGroupInput input) => _wrote(_remote.updateGroup(input));

  @override
  Future<void> deleteGroup(int id) => _wrote(_remote.deleteGroup(id));

  @override
  Future<GroupDefinition> archiveGroup(int id) => _wrote(_remote.archiveGroup(id));

  @override
  Future<GroupDefinition> restoreGroup(int id) => _wrote(_remote.restoreGroup(id));

  // Moves items between groups: the items' rows change as well as the counts.
  @override
  Future<int> assignItemsToGroup(int groupId, List<int> itemIds) =>
      _wrote(_remote.assignItemsToGroup(groupId, itemIds));

  /// A write just went to the server: until the replica has applied it, reads
  /// of what it touched go to the network.
  Future<T> _wrote<T>(Future<T> write) =>
      write.whenComplete(() {
        for (final table in const <String>['local_groups', 'local_items']) {
          _reader.wrote(table);
        }
      });
}
