import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../../../../core/sync/replica_reader.dart';
import '../../domain/vendor_definition.dart';
import '../../domain/vendor_inputs.dart';
import 'vendor_repository.dart';

/// Serves the vendors list from the local replica, everything else from the
/// network — the pattern of LocalFirstItemRepository.
///
/// The row is the server's own list payload, parsed by the same `fromJson` the
/// network path uses. The replica answers only once hydrated, only when it has
/// rows, and only when it is not known to be behind on this table (a live change
/// it has not applied, or a write this client just made) — see
/// ReplicaFreshness. Otherwise the network answers, as it always did.
class LocalFirstVendorRepository implements VendorRepository {
  LocalFirstVendorRepository({
    required VendorRepository remote,
    required Future<Database?> Function() replica,
    required bool Function() isHydrated,
    required VendorDefinition Function(Map<String, dynamic>) fromJson,
  }) : _remote = remote,
       _reader = ReplicaReader(replica: replica, isHydrated: isHydrated),
       _fromJson = fromJson;

  final VendorRepository _remote;
  final ReplicaReader _reader;
  final VendorDefinition Function(Map<String, dynamic>) _fromJson;

  @override
  Future<void> init() => _remote.init();

  // The server's order: `is_archived ASC, LOWER(name) ASC, id ASC`.
  @override
  Future<List<VendorDefinition>> getVendors() async {
    final local = await _reader.readAll<VendorDefinition>(
      'local_vendors',
      orderBy: "json_extract(raw_payload_json, '\$.isArchived') ASC, LOWER(name) ASC, id ASC",
      fromJson: _fromJson,
    );
    return local ?? _remote.getVendors();
  }

  @override
  Future<VendorDefinition?> getVendor(int id) async {
    final local = await _reader.readOne<VendorDefinition>(
      'local_vendors',
      keyColumn: 'id',
      key: id,
      fromJson: _fromJson,
    );
    return local ?? _remote.getVendor(id);
  }

  @override
  Future<VendorDefinition> createVendor(CreateVendorInput input) => _wrote(_remote.createVendor(input));

  @override
  Future<VendorDefinition> updateVendor(UpdateVendorInput input) => _wrote(_remote.updateVendor(input));

  @override
  Future<void> deleteVendor(int id) => _wrote(_remote.deleteVendor(id));

  /// A write just went to the server: until the replica has applied it, reads
  /// of what it touched go to the network.
  Future<T> _wrote<T>(Future<T> write) =>
      write.whenComplete(() {
        for (final table in const <String>['local_vendors']) {
          _reader.wrote(table);
        }
      });
}
