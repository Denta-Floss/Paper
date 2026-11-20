import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:core_erp/features/delivery_challans/domain/models/cancel_challan_options.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../../../app/reports/domain/reconciliation_report.dart';
import '../../../core/sync/outbox.dart';
import '../../../core/sync/replica_reader.dart';
import '../domain/challan_template.dart';
import '../domain/delivery_challan.dart';
import 'delivery_challan_repository.dart';

/// Serves the challan list from the local replica.
///
/// The list only, and that limit is the interesting part. Two things make the
/// rest of this interface unservable locally, and both would be silent:
///
/// **The replica holds the SUMMARY shape.** `/api/challans` stops sending the
/// nested `items` array — it sends `lineCount`, `totalQty` and `totalWeight`
/// instead — so a challan read back from the replica has no lines. Answering
/// `getChallan(id)` from it would hand the editor and the printable document an
/// empty challan, which is exactly the regression the detail-hydration work
/// fixed on the client side. Detail always goes to the server.
///
/// **Several filters cannot be answered from a mirror of the list.** `mineOnly`
/// resolves server-side to `dc.created_by = req.user.id`, and filtering by item
/// or variation is a line-level EXISTS over `delivery_challan_items` — rows the
/// replica does not hold. A narrowed request goes to the server rather than
/// being approximated.
class LocalFirstChallanRepository implements ChallanRepository {
  LocalFirstChallanRepository({
    required ChallanRepository remote,
    required Future<Database?> Function() replica,
    required bool Function() isHydrated,
    OutboxSyncEngine? Function()? outbox,
    int? Function()? currentUserId,
  }) : _remote = remote,
       _reader = ReplicaReader(replica: replica, isHydrated: isHydrated),
       _outbox = outbox ?? (() => null),
       _currentUserId = currentUserId ?? (() => null);

  final ChallanRepository _remote;
  final ReplicaReader _reader;

  /// The user's outbox (core/sync/outbox.dart). With one, creating and issuing
  /// a challan never fails for want of a connection: the write is kept and sent
  /// later with its own idempotency key, and the challan shows as pending.
  /// Without one (demo, tests), both go straight to the server as before.
  final OutboxSyncEngine? Function() _outbox;
  String? _outboxWarning;

  /// The signed-in user, so "mine only" can be answered from the replica when
  /// the server cannot be reached (B53). Null: that fallback is not offered.
  final int? Function() _currentUserId;

  @override
  Future<List<DeliveryChallan>> getChallans({
    ChallanType? type,
    DeliveryChallanStatus? status,
    String search = '',
    DateTime? dateFrom,
    DateTime? dateTo,
    int? orderId,
    int? itemId,
    int? variationLeafNodeId,
    bool mineOnly = false,
  }) async {
    final narrowed = type != null ||
        status != null ||
        search.trim().isNotEmpty ||
        dateFrom != null ||
        dateTo != null ||
        orderId != null ||
        itemId != null ||
        variationLeafNodeId != null ||
        mineOnly;
    // Challans the server does not have yet lead the list, so a worker sees
    // what they made offline. Only where nothing but the type narrows it — and
    // "mine only", since a challan waiting on this device is its user's own:
    // the other filters are the server's to answer.
    final onlyType = status == null && search.trim().isEmpty && dateFrom == null && dateTo == null &&
        orderId == null && itemId == null && variationLeafNodeId == null;
    final pending = onlyType ? await _pendingChallans(type) : const <DeliveryChallan>[];
    List<DeliveryChallan> rest;
    try {
      rest = await _listWithoutOutbox(
        type: type, status: status, search: search, dateFrom: dateFrom, dateTo: dateTo,
        orderId: orderId, itemId: itemId, variationLeafNodeId: variationLeafNodeId, mineOnly: mineOnly,
        narrowed: narrowed,
      );
    } catch (error) {
      // Offline. The phone's copy answers what it can — every challan, or this
      // user's (B53) — however far behind it is: the offline banner already
      // says how old it is, and an old list beats an error. What is waiting in
      // the outbox is shown either way; hiding it behind the error would make
      // a challan the worker just saved look lost (B49).
      final copy = onlyType && _isUnreachable(error) ? await _fromCopy(type: type, mineOnly: mineOnly) : null;
      if (copy != null) {
        rest = copy;
      } else if (pending.isNotEmpty) {
        rest = const <DeliveryChallan>[];
      } else {
        rethrow;
      }
    }
    return pending.isEmpty ? rest : <DeliveryChallan>[...pending, ...rest];
  }

  static bool _isUnreachable(Object error) =>
      error is SocketException ||
      error is http.ClientException ||
      error is TimeoutException ||
      error is HandshakeException;

  /// The replica's challans, filtered here by type and creator as the server
  /// would (`dc.created_by = req.user.id`), in the server's order. Null when
  /// there is no copy to read, or "mine" was asked with no user to match.
  Future<List<DeliveryChallan>?> _fromCopy({ChallanType? type, required bool mineOnly}) async {
    final me = _currentUserId();
    if (mineOnly && me == null) return null;
    final db = await _reader.available();
    if (db == null) return null;
    final rows = await db.query(
      'local_delivery_challans',
      columns: const <String>['raw_payload_json'],
      orderBy: 'date(challan_date) DESC, id DESC',
    );
    final out = <DeliveryChallan>[];
    for (final row in rows) {
      try {
        final raw = jsonDecode('${row['raw_payload_json']}');
        if (raw is! Map<String, dynamic>) continue;
        if (mineOnly) {
          final by = raw['created_by'] ?? raw['createdBy'];
          if ((by is num ? by.toInt() : int.tryParse('$by')) != me) continue;
        }
        final challan = DeliveryChallan.fromJson(raw);
        if (type != null && challan.type != type) continue;
        out.add(challan);
      } catch (_) {
        continue; // One unreadable row does not hide the rest.
      }
    }
    return out;
  }

  Future<List<DeliveryChallan>> _listWithoutOutbox({
    ChallanType? type,
    DeliveryChallanStatus? status,
    String search = '',
    DateTime? dateFrom,
    DateTime? dateTo,
    int? orderId,
    int? itemId,
    int? variationLeafNodeId,
    bool mineOnly = false,
    required bool narrowed,
  }) async {
    if (narrowed) {
      return _remote.getChallans(
        type: type,
        status: status,
        search: search,
        dateFrom: dateFrom,
        dateTo: dateTo,
        orderId: orderId,
        itemId: itemId,
        variationLeafNodeId: variationLeafNodeId,
        mineOnly: mineOnly,
      );
    }

    // `ORDER BY date(dc.date) DESC, dc.id DESC` — the id is the tiebreaker, and
    // challans routinely share a date.
    final local = await _reader.readAll<DeliveryChallan>(
      'local_delivery_challans',
      orderBy: 'date(challan_date) DESC, id DESC',
      fromJson: DeliveryChallan.fromJson,
    );
    return local ?? _remote.getChallans();
  }

  @override
  String? get lastWarningMessage => _outboxWarning ?? _remote.lastWarningMessage;

  @override
  Future<void> init() => _remote.init();

  @override
  Future<CompanyProfile> getCompanyProfile() => _remote.getCompanyProfile();

  @override
  Future<CompanyProfile> updateCompanyProfile(CompanyProfile profile) => _remote.updateCompanyProfile(profile);

  @override
  Future<List<DeliveryChallan>> getOrderChallans(int orderId) => _remote.getOrderChallans(orderId);

  @override
  Future<DeliveryChallan> getChallan(int id) => _remote.getChallan(id);

  @override
  Future<DeliveryChallan> createChallan(DeliveryChallanDraftInput input) async {
    final outbox = _outbox();
    if (outbox == null) return _wrote(_remote.createChallan(input));
    final entry = await outbox.submit(
      operationType: 'create_challan',
      method: 'POST',
      endpoint: '/api/challans',
      body: input.toJson(),
      preview: _previewOf(input),
    );
    return _settled(outbox, entry, issued: false);
  }

  @override
  Future<DeliveryChallan> updateChallan(
    int id,
    DeliveryChallanDraftInput input,
  ) => _wrote(_remote.updateChallan(id, input));

  @override
  Future<DeliveryChallan> issueChallan(int id) async {
    final outbox = _outbox();
    if (outbox == null) return _wrote(_remote.issueChallan(id));
    // A challan still in the outbox has a negative id: its issue waits behind
    // it and goes to whatever id the server gives it.
    final queued = id < 0 ? await _entryForPendingId(outbox, id) : null;
    if (id < 0 && queued == null) {
      throw const ChallanApiException('That challan is no longer waiting to be sent.');
    }
    final entry = await outbox.submit(
      operationType: 'issue_challan',
      method: 'POST',
      endpoint: queued == null ? '/api/challans/$id/issue' : '/api/challans/{ref:${queued.id}}/issue',
      body: const <String, dynamic>{},
      preview: queued?.preview ?? await _previewOfExisting(id),
    );
    return _settled(outbox, entry, issued: true);
  }

  @override
  Future<DeliveryChallan> reconcileChallan(int id, ChallanReconcileInput input) => _wrote(_remote.reconcileChallan(id, input));

  @override
  Future<DeliveryChallan> cancelChallan(int id, {String? actionType}) => _wrote(_remote.cancelChallan(id, actionType: actionType));

  @override
  Future<CancelChallanOptions> getCancelOptions(int id) => _remote.getCancelOptions(id);

  @override
  Future<void> deleteChallan(int id) => _wrote(_remote.deleteChallan(id));

  @override
  Future<void> recordPrint(int id) => _remote.recordPrint(id);

  @override
  Future<DeliveryChallan> savePieceBarcodes(
    int challanId,
    List<Map<String, dynamic>> barcodes,
  ) => _wrote(_remote.savePieceBarcodes(challanId, barcodes));

  @override
  Future<Map<String, dynamic>?> lookupSheetBarcode(String code) => _remote.lookupSheetBarcode(code);

  @override
  Future<DeliveryChallan> updateChallanReportGroups(
    int id,
    List<String> reportGroupCodes,
  ) => _wrote(_remote.updateChallanReportGroups(id, reportGroupCodes));

  @override
  Future<ReconciliationReportSnapshot> getReconciliationReport() => _remote.getReconciliationReport();

  @override
  Future<List<InvoiceHeader>> getInvoices() => _remote.getInvoices();

  @override
  Future<InvoiceHeader> getInvoice(int id) => _remote.getInvoice(id);

  @override
  Future<InvoiceHeader> updateInvoiceStatus(int id, String status) => _remote.updateInvoiceStatus(id, status);

  @override
  Future<InvoiceHeader> createInvoice(InvoiceDraftInput input) => _remote.createInvoice(input);

  @override
  Future<InvoiceHeader> updateInvoice(int id, InvoiceDraftInput input) => _remote.updateInvoice(id, input);

  @override
  Future<void> deleteInvoice(int id) => _remote.deleteInvoice(id);

  @override
  Future<Uint8List> fetchInvoicePdf(int invoiceId) => _remote.fetchInvoicePdf(invoiceId);

  @override
  Future<List<ConversionOverride>> getConversionOverrides() => _remote.getConversionOverrides();

  @override
  Future<ConversionOverride> saveConversionOverride(
    ConversionOverrideInput input,
  ) => _remote.saveConversionOverride(input);

  @override
  Future<List<WasteAuditRow>> getWasteAuditRows() => _remote.getWasteAuditRows();

  @override
  Future<ClientStatementReport> generateClientStatementReport({
    required String reportGroupCode,
    required List<String> challanNos,
    required List<String> receptionChallanNos,
  }) => _remote.generateClientStatementReport(reportGroupCode: reportGroupCode, challanNos: challanNos, receptionChallanNos: receptionChallanNos);

  @override
  Future<List<CompletedProductionRun>> getCompletedProductionRuns({
    String search = '',
    int limit = 25,
  }) => _remote.getCompletedProductionRuns(search: search, limit: limit);

  @override
  Future<List<ChallanTemplate>> getTemplates({
    ChallanTemplatePartyType? partyType,
    int? partyId,
    ChallanType? challanType,
    bool activeOnly = false,
  }) => _remote.getTemplates(partyType: partyType, partyId: partyId, challanType: challanType, activeOnly: activeOnly);

  @override
  Future<List<ChallanTemplateScan>> getTemplateScans({int limit = 24}) => _remote.getTemplateScans(limit: limit);

  @override
  Future<ChallanTemplate> createTemplate(ChallanTemplateInput input) => _remote.createTemplate(input);

  @override
  Future<ChallanTemplate> updateTemplate(int id, ChallanTemplateInput input) => _remote.updateTemplate(id, input);

  @override
  Future<void> deleteTemplate(int id) => _remote.deleteTemplate(id);

  @override
  Future<ChallanTemplateUploadTarget> createTemplateUploadIntent(
    ChallanTemplateUploadIntentInput input,
  ) => _remote.createTemplateUploadIntent(input);

  @override
  Future<ChallanTemplateBackground> completeTemplateUpload({
    required String uploadSessionId,
    required String objectKey,
  }) => _remote.completeTemplateUpload(uploadSessionId: uploadSessionId, objectKey: objectKey);

  @override
  Future<ChallanTemplateUploadTarget> createTemplateStampUploadIntent(
    ChallanTemplateUploadIntentInput input,
  ) => _remote.createTemplateStampUploadIntent(input);

  @override
  Future<ChallanTemplateBackground> completeTemplateStampUpload({
    required String uploadSessionId,
    required String objectKey,
  }) => _remote.completeTemplateStampUpload(uploadSessionId: uploadSessionId, objectKey: objectKey);

  @override
  Uri templatePreviewUri({
    required int challanId,
    int? templateId,
    required String mode,
  }) => _remote.templatePreviewUri(challanId: challanId, templateId: templateId, mode: mode);

  @override
  Future<Uint8List> fetchTemplatePreviewPdf({
    required int challanId,
    int? templateId,
    required String mode,
  }) => _remote.fetchTemplatePreviewPdf(challanId: challanId, templateId: templateId, mode: mode);

  @override
  Uri templateTestPrintUri({
    required int templateId,
    required String mode,
    int? itemCount,
  }) => _remote.templateTestPrintUri(templateId: templateId, mode: mode, itemCount: itemCount);

  @override
  Future<Uint8List> fetchTemplateTestPrintPdf({
    required int templateId,
    required String mode,
    int? itemCount,
    List<ChallanTemplateMapping>? mappings,
  }) => _remote.fetchTemplateTestPrintPdf(templateId: templateId, mode: mode, itemCount: itemCount, mappings: mappings);

  /// A write just went to the server: until the replica has applied it, reads
  /// of what it touched go to the network, or the refresh that follows a save
  /// shows the row as it was before.
  Future<T> _wrote<T>(Future<T> write) =>
      write.whenComplete(() {
        for (final table in const <String>['local_delivery_challans', 'local_order_items', 'local_materials']) {
          _reader.wrote(table);
        }
      });

  // --- the outbox --------------------------------------------------------------

  /// The write as the server took it, or the challan as it stands until then.
  ///
  /// A refusal while the worker is still on the form is thrown, as it always
  /// was, and the entry dropped: they are there to correct it. Refusals of
  /// writes sent later stay in the outbox as conflicts for a person to settle.
  Future<DeliveryChallan> _settled(OutboxSyncEngine outbox, OutboxEntry entry, {required bool issued}) async {
    _reader.wrote('local_delivery_challans');
    _reader.wrote('local_order_items');
    _reader.wrote('local_materials');
    _outboxWarning = null;
    if (entry.status == OutboxStatus.synced) {
      final answer = entry.serverResponseJson == null ? null : jsonDecode(entry.serverResponseJson!);
      if (answer is Map) {
        final payload = answer.cast<String, dynamic>();
        final warnings = payload['warnings'];
        if (warnings is List && warnings.isNotEmpty && warnings.first is String) {
          _outboxWarning = (warnings.first as String).trim();
        }
        final data = payload['data'] ?? payload['challan'];
        if (data is Map) return DeliveryChallan.fromJson(data.cast<String, dynamic>());
      }
      throw const ChallanApiException('The server applied this, but its answer was lost. Reload to see it.');
    }
    if (entry.status == OutboxStatus.conflict) {
      await outbox.discard(entry.id);
      throw ChallanApiException(entry.lastError ?? 'The server refused this.');
    }
    return _pendingChallan(entry, issued: issued);
  }

  Future<OutboxEntry?> _entryForPendingId(OutboxSyncEngine outbox, int id) async {
    for (final entry in await outbox.store.unsettled(operationType: 'create_challan')) {
      if (entry.seq == -id) return entry;
    }
    return null;
  }

  /// The challans the outbox holds, as list rows.
  Future<List<DeliveryChallan>> _pendingChallans(ChallanType? type) async {
    final outbox = _outbox();
    if (outbox == null) return const <DeliveryChallan>[];
    final entries = await outbox.store.unsettled();
    final issuedFor = <String>{};
    for (final entry in entries) {
      final ref = RegExp(r'\{ref:([^}]+)\}').firstMatch(entry.endpoint);
      if (entry.operationType == 'issue_challan' && ref != null) issuedFor.add(ref.group(1)!);
    }
    return entries
        .where((entry) => entry.operationType == 'create_challan')
        .map((entry) => _pendingChallan(entry, issued: issuedFor.contains(entry.id)))
        .where((challan) => type == null || challan.type == type)
        .toList(growable: false)
        .reversed
        .toList(growable: false);
  }

  static Map<String, dynamic> _previewOf(DeliveryChallanDraftInput input) => <String, dynamic>{
        'type': input.type.name,
        'purpose': input.purpose.name,
        'challanNo': input.challanNo.trim(),
        'date': input.date.toIso8601String(),
        'location': input.location,
        'customerName': input.customerName,
        'vendorName': input.vendorName,
        'notes': input.notes,
        'orderIds': input.orderIds,
        'orderId': input.orderId,
        'itemsCount': input.items.length,
        'maintainStocks': input.maintainStocks,
      };

  Future<Map<String, dynamic>?> _previewOfExisting(int id) async {
    final local = await _reader.readOne<DeliveryChallan>(
      'local_delivery_challans', keyColumn: 'id', key: id, fromJson: DeliveryChallan.fromJson,
    );
    if (local == null) return null;
    return <String, dynamic>{
      'type': local.type.name, 'purpose': local.purpose.name, 'challanNo': local.challanNo,
      'date': local.date.toIso8601String(), 'location': local.location,
      'customerName': local.customerName, 'vendorName': local.vendorName, 'notes': local.notes,
      'orderIds': local.orderIds, 'orderId': local.orderId ?? 0, 'itemsCount': local.itemsCount,
      'maintainStocks': local.maintainStocks, 'serverId': local.id,
    };
  }

  /// A challan the server does not have yet: a negative id (the outbox entry's
  /// place in the queue), no number until the server issues one.
  static DeliveryChallan _pendingChallan(OutboxEntry entry, {required bool issued}) {
    final p = entry.preview ?? const <String, dynamic>{};
    final serverId = p['serverId'];
    final orderIds = (p['orderIds'] as List? ?? const <dynamic>[]).whereType<num>().map((n) => n.toInt()).toList();
    final typed = '${p['challanNo'] ?? ''}'.trim();
    return DeliveryChallan(
      id: serverId is num ? serverId.toInt() : -entry.seq,
      type: challanTypeFromName('${p['type'] ?? 'delivery'}'),
      orderId: (p['orderId'] as num?)?.toInt(),
      orderIds: orderIds,
      clientId: null,
      orderNo: '',
      orderNos: const <String>[],
      challanNo: typed.isEmpty ? 'Pending upload' : typed,
      date: DateTime.tryParse('${p['date'] ?? ''}') ?? entry.createdAt,
      location: '${p['location'] ?? ''}',
      customerName: '${p['customerName'] ?? ''}',
      customerGstin: '',
      vendorId: null,
      vendorName: '${p['vendorName'] ?? ''}',
      vendorGstin: '',
      sourceReference: '',
      companyProfileSnapshot: null,
      notes: '${p['notes'] ?? ''}',
      maintainStocks: p['maintainStocks'] == true,
      status: issued ? DeliveryChallanStatus.issued : DeliveryChallanStatus.draft,
      items: const [],
      itemsCount: (p['itemsCount'] as num?)?.toInt() ?? 0,
      assets: const [],
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      outboxId: entry.id,
      outboxState: entry.status == OutboxStatus.conflict ? 'conflict' : 'pending',
      outboxError: entry.status == OutboxStatus.conflict ? entry.lastError : null,
    );
  }
}
