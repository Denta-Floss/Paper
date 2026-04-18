const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('group governance persists and can be updated without recreating material', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-governance-'));
  const dbPath = path.join(tempDir, 'paper.db');
  process.env.DB_PATH = dbPath;

  const backend = require('../server.js');

  try {
    await backend.resetAndSeedDemoData();
    const items = await backend.getItemsWithUsage();
    assert.ok(items.length >= 3, 'expected seeded items for governance test');
    const selectedItemIds = items.slice(0, 3).map((item) => item.id);

    const created = await backend.createParentWithChildren({
      name: 'Governance Demo Group',
      type: 'Item Group',
      numberOfChildren: 0,
      unit: 'Pieces',
      groupMode: 'item_group_authoring',
      inheritanceEnabled: true,
      selectedItemIds,
      propertyDrafts: [
        {
          name: 'Material',
          inputType: 'Text',
          mandatory: false,
          sourceType: 'inherited_item',
          state: 'active',
          overrideLocked: false,
          hasTypeConflict: false,
          sources: selectedItemIds.map((itemId) => ({ itemId })),
        },
        {
          name: 'material',
          inputType: 'Text',
          mandatory: false,
          sourceType: 'inherited_item',
          state: 'active',
          overrideLocked: false,
          hasTypeConflict: false,
          sources: [{ itemId: selectedItemIds[0] }],
        },
        {
          name: 'Density',
          inputType: 'Number',
          mandatory: true,
          sourceType: 'manual',
          state: 'active',
          overrideLocked: false,
          hasTypeConflict: false,
          sources: [],
        },
      ],
    });

    const materialRow = await backend.getMaterialRowByBarcode(created.barcode);
    assert.ok(materialRow, 'expected created parent material row');
    assert.equal(materialRow.group_mode, 'item_group_authoring');
    assert.equal(materialRow.inheritance_enabled, 1);

    const initialConfig = await backend.getMaterialGroupGovernance(materialRow.id);
    assert.deepEqual(initialConfig.selectedItemIds, selectedItemIds);
    assert.equal(initialConfig.propertyDrafts.length, 2, 'expected deduped property rows');
    assert.ok(
      initialConfig.propertyDrafts.some((draft) => draft.propertyKey === 'material'),
      'expected normalized material property key',
    );

    await backend.updateMaterialGroupConfiguration(created.barcode, {
      groupMode: 'item_group_authoring',
      inheritanceEnabled: true,
      selectedItemIds,
      propertyDrafts: [
        {
          name: 'Material',
          inputType: 'Text',
          mandatory: false,
          sourceType: 'inherited_item',
          state: 'unlinked',
          overrideLocked: false,
          hasTypeConflict: false,
          sources: selectedItemIds.map((itemId) => ({ itemId })),
        },
        {
          name: 'Density',
          inputType: 'Number',
          mandatory: true,
          sourceType: 'manual',
          state: 'overridden',
          overrideLocked: true,
          hasTypeConflict: false,
          sources: [{ itemId: selectedItemIds[0] }],
        },
      ],
    });

    const updatedConfig = await backend.getMaterialGroupGovernance(materialRow.id);
    const materialDraft = updatedConfig.propertyDrafts.find(
      (draft) => draft.propertyKey === 'material',
    );
    const densityDraft = updatedConfig.propertyDrafts.find(
      (draft) => draft.propertyKey === 'density',
    );
    assert.ok(materialDraft, 'expected material draft to exist');
    assert.ok(densityDraft, 'expected density draft to exist');
    assert.equal(materialDraft.state, 'unlinked');
    assert.equal(densityDraft.state, 'overridden');
    assert.equal(densityDraft.overrideLocked, true);
    assert.deepEqual(updatedConfig.selectedItemIds, selectedItemIds);
  } finally {
    await backend.closeDb();
  }
});

