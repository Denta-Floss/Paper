import 'package:core_erp/core/sync/replica_reader.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../domain/die.dart';
import 'die_repository.dart';

/// Serves the dies list from the local replica, everything else from the
/// network — the pattern of LocalFirstItemRepository.
///
/// The row is the server's own list payload, parsed by the same `fromJson` the
/// network path uses. The replica answers only once hydrated, only when it has
/// rows, and only when it is not known to be behind on this table (a live change
/// it has not applied, or a write this client just made) — see
/// ReplicaFreshness. Otherwise the network answers, as it always did.
class LocalFirstDieRepository implements DieRepository {
  LocalFirstDieRepository({
    required DieRepository remote,
    required Future<Database?> Function() replica,
    required bool Function() isHydrated,
    required Die Function(Map<String, dynamic>) fromJson,
  }) : _remote = remote,
       _reader = ReplicaReader(replica: replica, isHydrated: isHydrated),
       _fromJson = fromJson;

  final DieRepository _remote;
  final ReplicaReader _reader;
  final Die Function(Map<String, dynamic>) _fromJson;

  @override
  Future<void> init() => _remote.init();

  // The server's order: `created_at DESC`, read from the payload as for machines.
  @override
  Future<List<Die>> fetchDies() async {
    final local = await _reader.readAll<Die>(
      'local_dies',
      orderBy: "json_extract(raw_payload_json, '\$.createdAt') DESC",
      fromJson: _fromJson,
    );
    return local ?? _remote.fetchDies();
  }

  @override
  Future<Die> getDie(String id) async {
    final key = int.tryParse(id);
    final local = key == null
        ? null
        : await _reader.readOne<Die>('local_dies', keyColumn: 'id', key: key, fromJson: _fromJson);
    return local ?? _remote.getDie(id);
  }

  // A die's sheet is shown on every part it makes, so a part's row changes too.
  @override
  Future<Die> saveDie(Die die) => _wrote(_remote.saveDie(die));

  @override
  Future<void> deleteDie(String id) => _wrote(_remote.deleteDie(id));

  @override
  Future<DieAssetUploadIntent?> createAssetUploadIntent(DieAssetUploadIntentInput input) =>
      _remote.createAssetUploadIntent(input);

  @override
  Future<String?> completeAssetUpload(CompleteDieAssetUploadInput input) =>
      _wrote(_remote.completeAssetUpload(input));

  /// A write just went to the server: until the replica has applied it, reads
  /// of what it touched go to the network.
  Future<T> _wrote<T>(Future<T> write) =>
      write.whenComplete(() {
        for (final table in const <String>['local_dies', 'local_items']) {
          _reader.wrote(table);
        }
      });
}
