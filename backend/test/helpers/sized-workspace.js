'use strict';

// A workspace big enough that bytes on the wire mean something.
//
// The demo seed is eleven kilobytes over twenty calls; a budget asserted
// against it would never trip. The real workspace that showed the problem
// held a few hundred parts, a few hundred order lines and challans, and a
// couple of hundred materials. This fills a seeded server to that order of
// magnitude through the API, so every row has the shape a user would have
// produced — the DTOs, the links, the variation leaves, the activity rows.
//
// Sizes are fixed so a budget measured today is the same budget tomorrow.

const SIZES = Object.freeze({
  clients: 40,
  vendors: 15,
  dies: 60,
  machines: 25,
  items: 300,
  orders: 250,
  challans: 150,
  materials: 120,
});

async function must(promise, label) {
  const response = await promise;
  if (response.status >= 300) {
    throw new Error(`${label}: ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`);
  }
  return response.body;
}

// `api(method, path, body)` resolves to `{ status, body }`, the shape every
// test helper in this folder already uses.
async function fillWorkspace(api, sizes = SIZES) {
  const groups = (await must(api('GET', '/api/groups'), 'groups')).groups || [];
  const group = groups.find((g) => !g.isArchived && (!g.groupType || g.groupType === 'item')) || groups[0];
  const units = (await must(api('GET', '/api/units'), 'units')).units || [];
  const unit = units.find((u) => !u.isArchived) || units[0];
  if (!group || !unit) throw new Error('the seed has no item group or unit to file parts under');

  const clients = [];
  for (let i = 0; i < sizes.clients; i += 1) {
    const made = await must(api('POST', '/api/clients', {
      name: `Sized Client ${i + 1}`,
      address: `${i + 1} Industrial Estate, Phase ${(i % 4) + 1}`,
      phone: `98200${String(10000 + i).slice(-5)}`,
      email: `client${i + 1}@sized.test`,
    }), `client ${i}`);
    clients.push(made.client);
  }

  const vendors = [];
  for (let i = 0; i < sizes.vendors; i += 1) {
    const made = await must(api('POST', '/api/vendors', { name: `Sized Vendor ${i + 1}` }), `vendor ${i}`);
    vendors.push(made.vendor);
  }

  const dies = [];
  for (let i = 0; i < sizes.dies; i += 1) {
    const made = await must(api('POST', '/api/dies', {
      toolCode: `SZ-D${String(i + 1).padStart(3, '0')}`,
      status: 'active',
      ownership: 'owned',
      dieType: i % 2 === 0 ? 'cutting' : 'bending',
      madeBy: `Toolroom ${(i % 5) + 1}`,
      noOfSet: (i % 3) + 1,
      storeArea: `Die Store ${String.fromCharCode(65 + (i % 4))}`,
      rackNo: `R-${(i % 20) + 1}`,
      linerSizeNm: 600000 + i * 1000,
      linerSizeUnit: 'mm',
    }), `die ${i}`);
    dies.push(made.die || made);
  }

  const machines = [];
  for (let i = 0; i < sizes.machines; i += 1) {
    const made = await must(api('POST', '/api/machines', {
      name: `Press ${i + 1}`,
      assetId: `SZ-M${String(i + 1).padStart(3, '0')}`,
      status: 'operational',
      machineMake: i % 2 ? 'Bhurji' : 'Amada',
      feederMake: 'Servo',
      runningHours: 1000 + i * 37,
    }), `machine ${i}`);
    machines.push(made.machine || made);
  }

  // Parts: two thirds with a small variation tree (a colour and a numeric
  // range, the way real parts are), one third plain. Every third part is
  // developed for a client, so the joined columns are populated.
  const items = [];
  for (let i = 0; i < sizes.items; i += 1) {
    const withTree = i % 3 !== 2;
    const client = clients[i % clients.length];
    const made = await must(api('POST', '/api/items', {
      name: `Sized Part ${i + 1}`,
      alias: `SP${i + 1}`,
      groupId: group.id,
      unitId: unit.id,
      variationTree: withTree
        ? [
          {
            kind: 'property',
            name: 'Finish',
            children: [
              { kind: 'value', name: 'Plain', children: [] },
              { kind: 'value', name: 'Zinc', children: [] },
              { kind: 'value', name: 'Powder', children: [] },
            ],
          },
          { kind: 'property', name: 'Sheets', inputType: 'Numeric', numericMin: 1, numericMax: 20, children: [] },
        ]
        : [],
      developedFor: i % 3 === 0
        ? { kind: 'client', clientId: client.id, at: '2026-03-01T00:00:00.000Z', quotationAmount: 1000 + i }
        : undefined,
    }), `item ${i}`);
    items.push(made.item || made);
  }

  const leaves = new Map();
  async function leafFor(item) {
    if (leaves.has(item.id)) return leaves.get(item.id);
    const tree = (await must(api('GET', `/api/items/${item.id}/variations/tree`), `tree ${item.id}`));
    const rows = tree.rows || tree.nodes || tree.tree || [];
    const leaf = Array.isArray(rows) ? rows.find((row) => row.isLeaf || row.is_leaf || row.leaf) || null : null;
    leaves.set(item.id, leaf);
    return leaf;
  }

  const orders = [];
  for (let i = 0; i < sizes.orders; i += 1) {
    // Plain parts only: a line on a part with variations must name a leaf, and
    // which leaf is the item module's business, not this helper's.
    const item = items[2 + (i * 3) % items.length];
    const client = clients[i % clients.length];
    const made = await must(api('POST', '/api/orders', {
      orderNo: `SZ-ORD-${String(i + 1).padStart(4, '0')}`,
      clientId: client.id,
      clientName: client.name,
      poNumber: `PO-${1000 + i}`,
      itemId: item.id,
      itemName: item.displayName || item.name,
      variationLeafNodeId: 0,
      variationPathNodeIds: [],
      quantity: 10 + (i % 90),
      status: i % 4 === 0 ? 'completed' : i % 4 === 1 ? 'inProgress' : 'notStarted',
      startDate: '2026-04-01T00:00:00.000Z',
      endDate: '2026-04-30T00:00:00.000Z',
    }), `order ${i}`);
    orders.push(made.order);
  }

  const challans = [];
  for (let i = 0; i < sizes.challans; i += 1) {
    const lines = [];
    for (let line = 0; line < 1 + (i % 4); line += 1) {
      const item = items[2 + ((i + line) * 3) % items.length];
      lines.push({
        itemId: item.id,
        variationLeafNodeId: 0,
        particulars: item.displayName || item.name,
        quantityPcs: String(5 + line),
        weight: String(12.5 + line),
        lineNo: line + 1,
      });
    }
    const made = await must(api('POST', '/api/challans', {
      type: 'delivery',
      challanNo: `SZ-CH-${String(i + 1).padStart(4, '0')}`,
      date: '2026-05-10',
      status: i % 2 ? 'draft' : 'issued',
      customerName: clients[i % clients.length].name,
      maintainStocks: false,
      items: lines,
    }), `challan ${i}`);
    challans.push(made.data || made);
  }

  const materials = [];
  for (let i = 0; i < sizes.materials; i += 1) {
    const made = await must(api('POST', '/api/materials/parent', {
      name: `Sized Material ${i + 1}`,
      type: 'Raw Material',
      unit: 'kg',
      location: `RACK-${(i % 12) + 1}`,
      numberOfChildren: i % 3,
    }), `material ${i}`);
    materials.push(made.material || made.parent || made);
  }

  void leafFor;
  return { group, unit, clients, vendors, dies, machines, items, orders, challans, materials };
}

module.exports = { SIZES, fillWorkspace };
