'use strict';

// Walking an item's variation tree: pure functions of the tree data, no
// database. Shared as code with inventory, which also walks the tree.

function activeChildrenForNode(node) {
  return (node.children || []).filter((child) => !child.isArchived);
}

function activeTopLevelVariationProperties(tree = []) {
  return (tree || []).filter(
    (node) => !node.isArchived && String(node.kind) === 'property',
  );
}

function findVariationNodeById(nodes = [], nodeId) {
  for (const node of nodes || []) {
    if (Number(node.id) === Number(nodeId)) {
      return node;
    }
    const found = findVariationNodeById(node.children || [], nodeId);
    if (found) {
      return found;
    }
  }
  return null;
}

function activeValuePathForLeaf(tree = [], leafNodeId) {
  const selection = activeValueSelectionForLeaf(tree, leafNodeId);
  return selection ? selection.nodeIds : null;
}

function activeValueSelectionForLeaf(tree = [], leafNodeId) {
  const walkProperty = (propertyNode, path) => {
    for (const valueNode of activeChildrenForNode(propertyNode).filter(
      (node) => String(node.kind) === 'value',
    )) {
      const nextPath = {
        nodeIds: [...path.nodeIds, Number(valueNode.id)],
        segments: [...path.segments, String(valueNode.name || '').trim()],
      };
      if (Number(valueNode.id) === Number(leafNodeId)) {
        const activeChildProperty = activeChildrenForNode(valueNode).find(
          (node) => String(node.kind) === 'property',
        );
        return activeChildProperty ? null : nextPath;
      }
      for (const childProperty of activeChildrenForNode(valueNode).filter(
        (node) => String(node.kind) === 'property',
      )) {
        const found = walkProperty(childProperty, nextPath);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };

  for (const propertyNode of activeTopLevelVariationProperties(tree)) {
    const found = walkProperty(propertyNode, {
      nodeIds: [],
      segments: [],
    });
    if (found) {
      return found;
    }
  }
  return null;
}

function variationPathLabelForNodeIds(tree = [], pathNodeIds = []) {
  const segments = [];
  for (const nodeId of pathNodeIds) {
    const node = findVariationNodeById(tree, nodeId);
    if (!node || node.isArchived || String(node.kind) !== 'value') {
      continue;
    }
    const segment = String(node.name || '').trim();
    if (segment) {
      segments.push(segment);
    }
  }
  return buildVariationPathLabel(segments);
}

function buildVariationPathLabel(segments = []) {
  return segments
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .join(' | ');
}

module.exports = { activeChildrenForNode, activeTopLevelVariationProperties, findVariationNodeById, activeValuePathForLeaf, activeValueSelectionForLeaf, variationPathLabelForNodeIds, buildVariationPathLabel };
