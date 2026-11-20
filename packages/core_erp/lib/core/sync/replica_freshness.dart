/// Which replica tables are known to be behind the server.
///
/// The replica answers for a table only when it is not. A table falls behind
/// the moment the replica hears of a change it has not applied yet — a live
/// event, or a write this client just made through a local-first repository —
/// and catches up when a drain that STARTED after that moment has applied it.
///
/// Why it matters: a provider refreshes on the same live event the replica is
/// told about (SocketService emits `table-change` to the replica and the named
/// event to the provider back to back), and refreshes again after its own
/// writes. Either way it reads before the replica has applied the change, and
/// shows the old row. While a table is behind, reads go to the network, which
/// has the answer.
///
/// Each mark is numbered. A drain clears a table only if the mark it saw when
/// it started is still the latest one, so a change heard during a drain is not
/// cleared by it. A table whose change never arrives (SSE down) stays behind,
/// and the network keeps answering — the correct outcome.
class ReplicaFreshness {
  ReplicaFreshness();

  /// The one the app uses. Tests make their own.
  static final ReplicaFreshness instance = ReplicaFreshness();

  int _sequence = 0;
  final Map<String, int> _behind = <String, int>{};

  /// [localTable] has a change the replica has not applied.
  void markBehind(String localTable) {
    _sequence += 1;
    _behind[localTable] = _sequence;
  }

  bool isBehind(String localTable) => _behind.containsKey(localTable);

  /// The current marks for [localTables], taken before applying them.
  Map<String, int> snapshot(Iterable<String> localTables) => <String, int>{
        for (final table in localTables)
          if (_behind.containsKey(table)) table: _behind[table]!,
      };

  /// After applying: clears each table whose mark has not moved since
  /// [before] was taken.
  void caughtUp(Map<String, int> before) {
    for (final entry in before.entries) {
      if (_behind[entry.key] == entry.value) _behind.remove(entry.key);
    }
  }

  /// Forgets every mark — a new replica (another user, a resync) owes nothing.
  void reset() => _behind.clear();
}
