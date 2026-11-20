import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../../../../core/sync/replica_reader.dart';
import '../../domain/unit_definition.dart';
import '../../domain/unit_inputs.dart';
import '../models/unit_api_models.dart';
import 'unit_repository.dart';

/// Serves the units list from the local replica, everything else from the
/// network — the pattern of LocalFirstItemRepository.
///
/// The row is the server's own list payload, parsed by the same `fromJson` the
/// network path uses. The replica answers only once hydrated, only when it has
/// rows, and only when it is not known to be behind on this table (a live change
/// it has not applied, or a write this client just made) — see
/// ReplicaFreshness. Otherwise the network answers, as it always did.
class LocalFirstUnitRepository implements UnitRepository {
  LocalFirstUnitRepository({
    required UnitRepository remote,
    required Future<Database?> Function() replica,
    required bool Function() isHydrated,
  }) : _remote = remote,
       _reader = ReplicaReader(replica: replica, isHydrated: isHydrated);

  final UnitRepository _remote;
  final ReplicaReader _reader;

  @override
  Future<void> init() => _remote.init();

  // The server's order: archived last, then unit group, name and symbol.
  @override
  Future<List<UnitDefinition>> getUnits() async {
    final local = await _reader.readAll<UnitDefinition>(
      'local_units',
      orderBy: "json_extract(raw_payload_json, '\$.isArchived') ASC, "
          "LOWER(COALESCE(json_extract(raw_payload_json, '\$.unitGroupName'), '')) ASC, "
          'LOWER(name) ASC, LOWER(symbol) ASC',
      fromJson: (json) => UnitDto.fromJson(json).toDomain(),
    );
    return local ?? _remote.getUnits();
  }

  // Not replicated: the gauge table has no local copy.
  @override
  Future<List<ConversionPoint>> getGaugePoints() => _remote.getGaugePoints();

  @override
  Future<UnitDefinition> createUnit(CreateUnitInput input) => _wrote(_remote.createUnit(input));

  @override
  Future<UnitDefinition> updateUnit(UpdateUnitInput input) => _wrote(_remote.updateUnit(input));

  @override
  Future<void> deleteUnit(int id) => _wrote(_remote.deleteUnit(id));

  /// A write just went to the server: until the replica has applied it, reads
  /// of what it touched go to the network.
  Future<T> _wrote<T>(Future<T> write) =>
      write.whenComplete(() {
        for (final table in const <String>['local_units']) {
          _reader.wrote(table);
        }
      });
}
