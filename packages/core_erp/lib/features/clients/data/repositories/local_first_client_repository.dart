import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../../../../core/sync/replica_reader.dart';
import '../../domain/party_contact.dart';
import '../../domain/client_definition.dart';
import '../../domain/client_inputs.dart';
import '../models/client_api_models.dart';
import 'client_repository.dart';

/// Serves the clients list from the local replica, everything else from the
/// network — the pattern of LocalFirstItemRepository.
///
/// The row is the server's own list payload, parsed by the same `fromJson` the
/// network path uses. The replica answers only once hydrated, only when it has
/// rows, and only when it is not known to be behind on this table (a live change
/// it has not applied, or a write this client just made) — see
/// ReplicaFreshness. Otherwise the network answers, as it always did.
class LocalFirstClientRepository implements ClientRepository {
  LocalFirstClientRepository({
    required ClientRepository remote,
    required Future<Database?> Function() replica,
    required bool Function() isHydrated,
  }) : _remote = remote,
       _reader = ReplicaReader(replica: replica, isHydrated: isHydrated);

  final ClientRepository _remote;
  final ReplicaReader _reader;

  @override
  Future<void> init() => _remote.init();

  // The server's order: `is_archived ASC, LOWER(name) ASC`. Archived clients
  // are listed, not filtered; the flag lives in the payload only.
  @override
  Future<List<ClientDefinition>> getClients() async {
    final local = await _reader.readAll<ClientDefinition>(
      'local_clients',
      orderBy: "json_extract(raw_payload_json, '\$.isArchived') ASC, LOWER(name) ASC",
      fromJson: (json) => ClientDto.fromJson(json).toDomain(),
    );
    return local ?? _remote.getClients();
  }

  @override
  Future<ClientDefinition?> getClient(int id) async {
    final local = await _reader.readOne<ClientDefinition>(
      'local_clients',
      keyColumn: 'id',
      key: id,
      fromJson: (json) => ClientDto.fromJson(json).toDomain(),
    );
    return local ?? _remote.getClient(id);
  }

  @override
  Future<ClientDefinition> createClient(CreateClientInput input) => _wrote(_remote.createClient(input));

  @override
  Future<ClientDefinition> updateClient(UpdateClientInput input) => _wrote(_remote.updateClient(input));

  @override
  Future<ClientDefinition> archiveClient(int id) => _wrote(_remote.archiveClient(id));

  @override
  Future<ClientDefinition> restoreClient(int id) => _wrote(_remote.restoreClient(id));

  @override
  Future<void> deleteClient(int id) => _wrote(_remote.deleteClient(id));

  // A client's people ride inside its payload, so changing one changes the row.
  @override
  Future<PartyContact> addContact(int clientId, PartyContact contact) =>
      _wrote(_remote.addContact(clientId, contact));

  @override
  Future<PartyContact> updateContact(int clientId, PartyContact contact) =>
      _wrote(_remote.updateContact(clientId, contact));

  @override
  Future<PartyContact> archiveContact(int clientId, int contactId, {bool archived = true}) =>
      _wrote(_remote.archiveContact(clientId, contactId, archived: archived));

  /// A write just went to the server: until the replica has applied it, reads
  /// of what it touched go to the network.
  Future<T> _wrote<T>(Future<T> write) =>
      write.whenComplete(() {
        for (final table in const <String>['local_clients']) {
          _reader.wrote(table);
        }
      });
}
