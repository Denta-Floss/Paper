import 'package:core_erp/core/sync/replica_reader.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../domain/machine.dart';
import 'machine_repository.dart';

/// Serves the machines list from the local replica, everything else from the
/// network — the pattern of LocalFirstItemRepository.
///
/// The row is the server's own list payload, parsed by the same `fromJson` the
/// network path uses. The replica answers only once hydrated, only when it has
/// rows, and only when it is not known to be behind on this table (a live change
/// it has not applied, or a write this client just made) — see
/// ReplicaFreshness. Otherwise the network answers, as it always did.
class LocalFirstMachineRepository implements MachineRepository {
  LocalFirstMachineRepository({
    required MachineRepository remote,
    required Future<Database?> Function() replica,
    required bool Function() isHydrated,
    required Machine Function(Map<String, dynamic>) fromJson,
  }) : _remote = remote,
       _reader = ReplicaReader(replica: replica, isHydrated: isHydrated),
       _fromJson = fromJson;

  final MachineRepository _remote;
  final ReplicaReader _reader;
  final Machine Function(Map<String, dynamic>) _fromJson;

  @override
  Future<void> init() => _remote.init();

  // The server's order: `created_at DESC`. The provider does not re-sort, and
  // the local table has no created_at column, so it is read from the payload
  // (ISO strings sort as text).
  @override
  Future<List<Machine>> fetchMachines() async {
    final local = await _reader.readAll<Machine>(
      'local_machines',
      orderBy: "json_extract(raw_payload_json, '\$.createdAt') DESC",
      fromJson: _fromJson,
    );
    return local ?? _remote.fetchMachines();
  }

  @override
  Future<Machine> getMachine(String id) async {
    final key = int.tryParse(id);
    final local = key == null
        ? null
        : await _reader.readOne<Machine>('local_machines', keyColumn: 'id', key: key, fromJson: _fromJson);
    return local ?? _remote.getMachine(id);
  }

  // A machine's sheet is shown on every part it runs, so a part's row changes too.
  @override
  Future<Machine> saveMachine(Machine machine) => _wrote(_remote.saveMachine(machine));

  @override
  Future<void> deleteMachine(String id) => _wrote(_remote.deleteMachine(id));

  @override
  Future<MachineAssetUploadIntent?> createAssetUploadIntent(MachineAssetUploadIntentInput input) =>
      _remote.createAssetUploadIntent(input);

  @override
  Future<String?> completeAssetUpload(CompleteMachineAssetUploadInput input) =>
      _wrote(_remote.completeAssetUpload(input));

  @override
  Future<List<MachineQueueItem>> fetchMachineQueue(String machineId) => _remote.fetchMachineQueue(machineId);

  /// A write just went to the server: until the replica has applied it, reads
  /// of what it touched go to the network.
  Future<T> _wrote<T>(Future<T> write) =>
      write.whenComplete(() {
        for (final table in const <String>['local_machines', 'local_items']) {
          _reader.wrote(table);
        }
      });
}
