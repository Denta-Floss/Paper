import 'package:flutter/material.dart';

import '../../data/repositories/inventory_repository.dart';
import '../../domain/create_parent_material_input.dart';
import '../../domain/material_inputs.dart';
import '../../domain/material_record.dart';

class InventoryProvider extends ChangeNotifier {
  InventoryProvider({required InventoryRepository repository})
    : _repository = repository;

  final InventoryRepository _repository;

  List<MaterialRecord> _materials = const [];
  MaterialRecord? _selectedMaterial;
  bool _isLoading = false;
  bool _isSaving = false;
  String? _errorMessage;
  String? _lastLookupBarcode;
  String _searchQuery = '';
  bool _initialized = false;

  List<MaterialRecord> get materials => _materials;
  MaterialRecord? get selectedMaterial => _selectedMaterial;
  bool get isLoading => _isLoading;
  bool get isSaving => _isSaving;
  String? get errorMessage => _errorMessage;
  String? get lastLookupBarcode => _lastLookupBarcode;
  String get searchQuery => _searchQuery;

  Future<void> initialize() async {
    if (_initialized) {
      return;
    }

    _initialized = true;
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();

    try {
      await _repository.init();
      await _repository.seedIfEmpty();
      await _reloadMaterials();
      if (_materials.isNotEmpty) {
        _selectedMaterial = _materials.first;
      }
    } catch (error) {
      _errorMessage = _friendlyError(
        fallback: 'Failed to load inventory data.',
        error: error,
      );
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<void> addParentMaterial(CreateParentMaterialInput input) async {
    _isSaving = true;
    _errorMessage = null;
    notifyListeners();

    try {
      final result = await _repository.saveParentWithChildren(input);
      await _reloadMaterials();
      _selectedMaterial = _materials
          .where((item) => item.barcode == result.parentBarcode)
          .firstOrNull;
    } catch (error) {
      _errorMessage = _friendlyError(
        fallback: 'Failed to save material.',
        error: error,
      );
    } finally {
      _isSaving = false;
      notifyListeners();
    }
  }

  Future<void> addChildMaterial(CreateChildMaterialInput input) async {
    _isSaving = true;
    _errorMessage = null;
    notifyListeners();

    try {
      final result = await _repository.createChildMaterial(input);
      await _reloadMaterials();
      _selectedMaterial = _materials
          .where((item) => item.barcode == result.barcode)
          .firstOrNull;
    } catch (error) {
      _errorMessage = _friendlyError(
        fallback: 'Failed to add sub-group.',
        error: error,
      );
    } finally {
      _isSaving = false;
      notifyListeners();
    }
  }

  Future<void> updateMaterial(UpdateMaterialInput input) async {
    _isSaving = true;
    _errorMessage = null;
    notifyListeners();

    try {
      final result = await _repository.updateMaterial(input);
      await _reloadMaterials();
      _selectedMaterial = _materials
          .where((item) => item.barcode == result.barcode)
          .firstOrNull;
    } catch (error) {
      _errorMessage = _friendlyError(
        fallback: 'Failed to update material.',
        error: error,
      );
    } finally {
      _isSaving = false;
      notifyListeners();
    }
  }

  Future<void> deleteMaterial(String barcode) async {
    _isSaving = true;
    _errorMessage = null;
    notifyListeners();

    try {
      await _repository.deleteMaterial(barcode);
      await _reloadMaterials();
      if (_selectedMaterial?.barcode == barcode) {
        _selectedMaterial = _materials.firstOrNull;
      }
    } catch (error) {
      _errorMessage = _friendlyError(
        fallback: 'Failed to delete material.',
        error: error,
      );
    } finally {
      _isSaving = false;
      notifyListeners();
    }
  }

  Future<void> linkMaterialToGroup(String barcode, int groupId) async {
    await _linkMutation(
      action: () => _repository.linkMaterialToGroup(barcode, groupId),
      fallback: 'Failed to link group inheritance.',
    );
  }

  Future<void> linkMaterialToItem(String barcode, int itemId) async {
    await _linkMutation(
      action: () => _repository.linkMaterialToItem(barcode, itemId),
      fallback: 'Failed to link item inheritance.',
    );
  }

  Future<void> unlinkMaterial(String barcode) async {
    await _linkMutation(
      action: () => _repository.unlinkMaterial(barcode),
      fallback: 'Failed to unlink inherited properties.',
    );
  }

  Future<void> selectMaterial(String barcode) async {
    _selectedMaterial = _materials
        .where((item) => item.barcode == barcode)
        .firstOrNull;
    notifyListeners();
  }

  Future<MaterialRecord?> lookupBarcode(String barcode) async {
    _isLoading = true;
    _errorMessage = null;
    _lastLookupBarcode = barcode;
    notifyListeners();

    try {
      final record = await _repository.getMaterialByBarcode(barcode);
      if (record == null) {
        _errorMessage = 'No material found for barcode $barcode.';
        return null;
      }

      await _reloadMaterials();
      _selectedMaterial =
          _materials
              .where((item) => item.barcode == record.barcode)
              .firstOrNull ??
          record;
      return _selectedMaterial;
    } catch (error) {
      _errorMessage = _friendlyError(
        fallback: 'Failed to look up barcode.',
        error: error,
      );
      return null;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<void> resetScanTrace(String barcode) async {
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();

    try {
      final record = await _repository.resetScanTrace(barcode);
      await _reloadMaterials();
      _selectedMaterial =
          _materials.where((item) => item.barcode == barcode).firstOrNull ??
          record;
    } catch (error) {
      _errorMessage = _friendlyError(
        fallback: 'Failed to reset scan trace.',
        error: error,
      );
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  void clearError() {
    if (_errorMessage == null) {
      return;
    }

    _errorMessage = null;
    _lastLookupBarcode = null;
    notifyListeners();
  }

  void setSearchQuery(String value) {
    if (_searchQuery == value) {
      return;
    }

    _searchQuery = value;
    notifyListeners();
  }

  Future<void> _reloadMaterials() async {
    _materials = await _repository.getAllMaterials();
  }

  Future<void> _linkMutation({
    required Future<MaterialRecord> Function() action,
    required String fallback,
  }) async {
    _isSaving = true;
    _errorMessage = null;
    notifyListeners();

    try {
      final result = await action();
      await _reloadMaterials();
      _selectedMaterial = _materials
          .where((item) => item.barcode == result.barcode)
          .firstOrNull;
    } catch (error) {
      _errorMessage = _friendlyError(fallback: fallback, error: error);
    } finally {
      _isSaving = false;
      notifyListeners();
    }
  }

  String _friendlyError({required String fallback, required Object error}) {
    final message = error.toString().trim();
    if (message.isEmpty || message == 'Exception') {
      return fallback;
    }
    return '$fallback $message';
  }
}

extension<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
