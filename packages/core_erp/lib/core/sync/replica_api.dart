import 'dart:convert';

import 'package:http/http.dart' as http;

import 'delta_sync_engine.dart';
import 'replica_catch_up.dart';

/// The network side of the replica: where each table lives, and how to get one
/// record, a whole list, or the changes since a position.
///
/// Kept apart from the engine so the engine can be tested without HTTP, and
/// apart from `main.dart` so the endpoint map is somewhere it can be checked.
class ReplicaApi {
  ReplicaApi({required http.Client client, required String baseUrl})
    : _client = client,
      _baseUrl = baseUrl.replaceFirst(RegExp(r'/$'), '');

  final http.Client _client;
  final String _baseUrl;

  /// Where each replicated table's list lives.
  ///
  /// Not derivable from the table name — `order_items` is served by
  /// `/api/orders`, `delivery_challans` by `/api/challans`, and pipeline routes
  /// have no `/api` prefix at all. Writing it out is the only honest option.
  static const Map<String, String> listPaths = <String, String>{
    'items': '/api/items',
    'delivery_challans': '/api/challans',
    'order_items': '/api/orders',
    'materials': '/api/materials',
    'clients': '/api/clients',
    'vendors': '/api/vendors',
    'machines': '/api/machines',
    'dies': '/api/dies',
    'units': '/api/units',
    'groups': '/api/groups',
    'departments': '/api/departments',
    'pipeline_templates': '/api/production/pipeline-templates',
    'pipeline_runs': '/runs',
  };

  /// Where one record lives. A table absent here has no by-id endpoint, which
  /// is why its binding uses a list refetch or is ignored.
  static const Map<String, String> recordPaths = <String, String>{
    'items': '/api/items',
    'delivery_challans': '/api/challans',
    'order_items': '/api/orders',
    'materials': '/api/materials',
    'clients': '/api/clients',
    'vendors': '/api/vendors',
    'machines': '/api/machines',
    'dies': '/api/dies',
    'pipeline_templates': '/templates',
    'pipeline_runs': '/runs',
  };

  Future<Map<String, dynamic>?> fetchRecord(String table, Object key) async {
    final path = recordPaths[table];
    if (path == null) return null;
    final uri = Uri.parse('$_baseUrl$path/${Uri.encodeComponent('$key')}');
    final response = await _client.get(uri);
    // A 404 is an answer, not a failure: the record is gone, and the engine
    // removes it locally. Anything else is a failure and must throw, so the
    // cursor stays behind it rather than skipping the change.
    if (response.statusCode == 404) return null;
    if (response.statusCode != 200) {
      throw http.ClientException('${response.statusCode} for $uri', uri);
    }
    return unwrapRecord(response.body);
  }

  Future<List<Map<String, dynamic>>> fetchList(String table) async {
    final path = listPaths[table];
    if (path == null) return const <Map<String, dynamic>>[];
    final uri = Uri.parse('$_baseUrl$path');
    final response = await _client.get(uri);
    if (response.statusCode != 200) {
      throw http.ClientException('${response.statusCode} for $uri', uri);
    }
    return unwrapList(response.body);
  }

  /// One page of the changelog after [since], with what the server says about
  /// it: whether more follows, the oldest change it still holds, and its head.
  Future<ChangesPage> fetchChangesPage(int since) async {
    final uri = Uri.parse('$_baseUrl/api/changes?since=$since');
    final response = await _client.get(uri);
    if (response.statusCode != 200) {
      throw http.ClientException('${response.statusCode} for $uri', uri);
    }
    final decoded = jsonDecode(response.body);
    final map = decoded is Map ? decoded.cast<String, dynamic>() : const <String, dynamic>{};
    int number(Object? value) => value is num ? value.toInt() : int.tryParse('${value ?? ''}') ?? 0;
    return ChangesPage(
      changes: parseChanges(decoded),
      hasMore: map['hasMore'] == true,
      oldestAvailable: number(map['oldestAvailable']),
      head: number(map['head']),
    );
  }

  /// A cold replica's lists in one answer, or null from a server that has no
  /// bootstrap (it predates it), in which case the lists are fetched one by one.
  Future<ReplicaBootstrap?> fetchBootstrap() async {
    final uri = Uri.parse('$_baseUrl/api/replica/bootstrap');
    final response = await _client.get(uri);
    if (response.statusCode == 404) return null;
    if (response.statusCode != 200) {
      throw http.ClientException('${response.statusCode} for $uri', uri);
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map || decoded['success'] != true) {
      throw http.ClientException('bootstrap refused for $uri', uri);
    }
    final rawLists = decoded['lists'];
    final lists = <String, List<Map<String, dynamic>>>{};
    if (rawLists is Map) {
      for (final entry in rawLists.entries) {
        final rows = entry.value;
        if (rows is! List) continue;
        lists['${entry.key}'] = rows.whereType<Map>().map(_cast).toList(growable: false);
      }
    }
    final head = decoded['head'];
    Set<String> names(Object? raw) =>
        raw is List ? raw.map((value) => '$value').toSet() : const <String>{};
    return ReplicaBootstrap(
      head: head is num ? head.toInt() : 0,
      lists: lists,
      missing: names(decoded['missing']),
    );
  }

  /// Everything the changelog recorded after [since].
  Future<List<TableChange>> fetchChangesSince(int since) async {
    final uri = Uri.parse('$_baseUrl/api/changes?since=$since');
    final response = await _client.get(uri);
    if (response.statusCode != 200) {
      throw http.ClientException('${response.statusCode} for $uri', uri);
    }
    return parseChanges(jsonDecode(response.body));
  }

  static List<TableChange> parseChanges(Object? decoded) {
    final rows = decoded is Map ? decoded['changes'] : decoded;
    if (rows is! List) return const <TableChange>[];
    return rows.whereType<Map>().map((row) {
      final map = row.cast<String, dynamic>();
      return TableChange(
        table: '${map['table_name'] ?? map['table'] ?? ''}',
        recordId: map['record_id'] ?? map['id'] ?? 0,
        action: '${map['event_type'] ?? map['action'] ?? 'UPDATE'}',
        changelogId: (map['id'] is num) ? (map['id'] as num).toInt() : 0,
      );
    }).where((change) => change.table.isNotEmpty).toList(growable: false);
  }

  /// Pulls the list out of whatever envelope the endpoint used.
  ///
  /// They are not consistent — `{items: []}`, `{data: []}`, `{orders: []}`,
  /// `{challans: []}`, and a couple return a bare array. Rather than encode
  /// thirteen envelope names, take the first list of objects in the body: an
  /// endpoint only ever has one.
  static List<Map<String, dynamic>> unwrapList(String body) {
    final decoded = jsonDecode(body);
    if (decoded is List) return decoded.whereType<Map>().map(_cast).toList(growable: false);
    if (decoded is! Map) return const <Map<String, dynamic>>[];
    for (final value in decoded.values) {
      if (value is List) {
        return value.whereType<Map>().map(_cast).toList(growable: false);
      }
    }
    return const <Map<String, dynamic>>[];
  }

  /// The same, for a single record: `{item: {...}}`, `{order: {...}}`,
  /// `{data: {...}}`. `success` and `error` are envelope, never the record.
  static Map<String, dynamic>? unwrapRecord(String body) {
    final decoded = jsonDecode(body);
    if (decoded is! Map) return null;
    const envelope = <String>{'success', 'error', 'message'};
    for (final entry in decoded.entries) {
      if (envelope.contains(entry.key)) continue;
      if (entry.value is Map) return _cast(entry.value as Map);
    }
    // Some endpoints return the record itself with no wrapper at all.
    return decoded.keys.any((k) => !envelope.contains(k)) ? _cast(decoded) : null;
  }

  static Map<String, dynamic> _cast(Map value) => value.cast<String, dynamic>();
}
