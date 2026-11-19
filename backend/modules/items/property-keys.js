'use strict';

// Property keys and the property schema a group's items carry: pure
// functions, no database. normalizePropertyKey is the one that uses the
// units master's value normaliser; a dead duplicate of it was dropped on
// the way out of server.js.

const { normalizeUnitValue } = require('../units/master');

function normalizePropertyKey(value = '') {
  return normalizeUnitValue(String(value || '').trim());
}

function normalizeGroupPropertyDraft(rawDraft) {
  const name = String(rawDraft?.name || '').trim();
  if (!name) {
    return null;
  }
  const propertyKey =
    String(rawDraft?.propertyKey || '').trim() || normalizePropertyKey(name);
  const inputType = String(rawDraft?.inputType || 'Text').trim() || 'Text';
  const sourceType = ['inherited_item', 'inherited_group', 'manual'].includes(rawDraft?.sourceType)
    ? rawDraft.sourceType
    : 'manual';
  // 'retired' = the group no longer asks for this field, but items already
  // carry values for it, so the definition is kept and hidden instead of
  // deleted. See retireMissingGroupProperties.
  const state = ['active', 'unlinked', 'overridden', 'retired'].includes(rawDraft?.state)
    ? rawDraft.state
    : 'active';
  const overrideLocked = Boolean(rawDraft?.overrideLocked);
  const hasTypeConflict = Boolean(rawDraft?.hasTypeConflict);
  const mandatory = Boolean(rawDraft?.mandatory);
  const unitId = Number(rawDraft?.unitId);
  const unitSymbol = String(rawDraft?.unitSymbol || '').trim() || null;
  const unitLabel = String(rawDraft?.unitLabel || '').trim() || null;
  const sourceGroupId = Number(rawDraft?.sourceGroupId);
  const sourceGroupName = String(rawDraft?.sourceGroupName || '').trim() || null;
  const coverageCount = Number(rawDraft?.coverageCount || 0);
  const selectedItemCountAtResolution = Number(
    rawDraft?.selectedItemCountAtResolution || 0,
  );
  const resolutionSource = String(rawDraft?.resolutionSource || '').trim() || null;
  const sources = Array.isArray(rawDraft?.sources) ? rawDraft.sources : [];
  const sourceItemIds = sources
    .map((source) => Number(source?.itemId))
    .filter((id) => Number.isInteger(id) && id > 0);

  return {
    propertyKey,
    displayName: name,
    inputType,
    sourceType,
    state,
    mandatory,
    unitId: Number.isInteger(unitId) && unitId > 0 ? unitId : null,
    unitSymbol,
    unitLabel,
    sourceGroupId: Number.isInteger(sourceGroupId) && sourceGroupId > 0 ? sourceGroupId : null,
    sourceGroupName,
    overrideLocked,
    hasTypeConflict,
    coverageCount: Number.isFinite(coverageCount) ? Math.max(0, Math.trunc(coverageCount)) : 0,
    selectedItemCountAtResolution: Number.isFinite(selectedItemCountAtResolution)
      ? Math.max(0, Math.trunc(selectedItemCountAtResolution))
      : 0,
    resolutionSource,
    sourceItemIds: [...new Set(sourceItemIds)],
  };
}

function normalizeDiscardedPropertyKeys(rawKeys) {
  if (!Array.isArray(rawKeys)) {
    return [];
  }
  const keys = [];
  const seen = new Set();
  for (const rawKey of rawKeys) {
    const propertyKey = normalizePropertyKey(rawKey);
    if (!propertyKey || seen.has(propertyKey)) {
      continue;
    }
    seen.add(propertyKey);
    keys.push(propertyKey);
  }
  return keys;
}

function collectTopLevelPropertySchemaFromTree(
  variationTree = [],
  {
    existingByKey = new Map(),
    fallbackByKey = new Map(),
  } = {},
) {
  const drafts = [];
  const seen = new Set();
  let sortOrder = 0;
  for (const node of Array.isArray(variationTree) ? variationTree : []) {
    if (!node || String(node.kind) !== 'property') {
      continue;
    }
    const displayName = String(node.name || '').trim();
    if (!displayName) {
      continue;
    }
    const propertyKey = normalizePropertyKey(displayName);
    if (!propertyKey || seen.has(propertyKey)) {
      continue;
    }
    seen.add(propertyKey);
    const existing = existingByKey.get(propertyKey);
    const fallback = fallbackByKey.get(propertyKey);
    drafts.push({
      propertyKey,
      displayName,
      inputType: node.inputType || existing?.inputType || fallback?.inputType || 'Text',
      mandatory: existing?.mandatory ?? fallback?.mandatory ?? false,
      unitId: existing?.unitId ?? fallback?.unitId ?? null,
      unitSymbol: existing?.unitSymbol ?? fallback?.unitSymbol ?? null,
      unitLabel: existing?.unitLabel ?? fallback?.unitLabel ?? null,
      sourceType: existing?.sourceType || fallback?.sourceType || 'manual',
      sourceGroupId: existing?.sourceGroupId ?? fallback?.sourceGroupId ?? null,
      sourceGroupName: existing?.sourceGroupName ?? fallback?.sourceGroupName ?? null,
      sourceItemIds: Array.isArray(existing?.sourceItemIds)
        ? existing.sourceItemIds
        : (Array.isArray(fallback?.sourceItemIds) ? fallback.sourceItemIds : []),
      sortOrder: sortOrder++,
    });
  }
  return drafts;
}

function mergeItemPropertySchema({
  variationTree = [],
  effectiveDrafts = [],
  existingSchema = [],
} = {}) {
  const existingByKey = new Map(
    (Array.isArray(existingSchema) ? existingSchema : [])
      .map((entry) => [normalizePropertyKey(entry.propertyKey || entry.displayName), entry])
      .filter(([key]) => Boolean(key)),
  );
  const effectiveByKey = new Map(
    (Array.isArray(effectiveDrafts) ? effectiveDrafts : [])
      .map((draft) => {
        const propertyKey = normalizePropertyKey(draft.propertyKey || draft.name);
        return [
          propertyKey,
          {
            propertyKey,
            displayName: draft.name,
            inputType: draft.inputType,
            mandatory: draft.mandatory,
            unitId: draft.unitId ?? null,
            unitSymbol: draft.unitSymbol ?? null,
            unitLabel: draft.unitLabel ?? null,
            sourceType: draft.sourceType || 'manual',
            sourceGroupId: draft.sourceGroupId ?? null,
            sourceGroupName: draft.sourceGroupName ?? null,
            sourceItemIds: Array.isArray(draft.sources)
              ? draft.sources
                  .map((source) => Number(source.itemId))
                  .filter((sourceId) => Number.isInteger(sourceId) && sourceId > 0)
              : [],
            sortOrder: 0,
          },
        ];
      })
      .filter(([key]) => Boolean(key)),
  );

  const merged = collectTopLevelPropertySchemaFromTree(variationTree, {
    existingByKey,
    fallbackByKey: effectiveByKey,
  });
  const seen = new Set(merged.map((entry) => entry.propertyKey));
  let sortOrder = merged.length;
  for (const draft of Array.isArray(effectiveDrafts) ? effectiveDrafts : []) {
    const propertyKey = normalizePropertyKey(draft.propertyKey || draft.name);
    if (!propertyKey || seen.has(propertyKey)) {
      continue;
    }
    seen.add(propertyKey);
    merged.push({
      propertyKey,
      displayName: draft.name,
      inputType: draft.inputType,
      mandatory: draft.mandatory,
      unitId: draft.unitId ?? null,
      unitSymbol: draft.unitSymbol ?? null,
      unitLabel: draft.unitLabel ?? null,
      sourceType: draft.sourceType || 'manual',
      sourceGroupId: draft.sourceGroupId ?? null,
      sourceGroupName: draft.sourceGroupName ?? null,
      sourceItemIds: Array.isArray(draft.sources)
        ? draft.sources
            .map((source) => Number(source.itemId))
            .filter((sourceId) => Number.isInteger(sourceId) && sourceId > 0)
        : [],
      sortOrder: sortOrder++,
    });
  }
  return merged;
}

module.exports = { normalizePropertyKey, normalizeGroupPropertyDraft, normalizeDiscardedPropertyKeys, collectTopLevelPropertySchemaFromTree, mergeItemPropertySchema };
