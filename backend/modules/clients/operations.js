'use strict';

// ---------------------------------------------------------------------------
// Clients — what the module offers at the kernel desk.
//
//   offered to users
//     clients.list · clients.get · clients.create · clients.update
//     clients.archive · clients.unarchive · clients.delete
//     clients.subContractors.list · .listForClient · .create · .update · .delete
//
//   internal — asked by other modules
//     clients.rows.get        a client's row, for orders and for invoices
//     clients.exists          whether an id is a client, for the die master
//
// A client goes out with its people attached (parties/contacts.js, the same
// family of code). A write's result also carries the raw rows the Track entry
// is written from; the route writes it and broadcasts the change.
//
//     clients.contacts.list · .create · .update
//
//     clients.portal.setCredentials · .catalogItemIds · .replaceCatalog
//     clients.portal.login · .catalog · .addToCart · .placeOrder
//
// The B2B portal (./portal.js). The first three are the shop setting a client
// up and sit under /api/clients, so the gate asks for `clients.read` or, for
// the two POSTs, `clients.create`. The other four sit under /api/portal, which
// maps to no module: reading needs only a signed-in session, and the three
// POSTs need what the old write gate asked (an admin, or `config.write`, or
// `inventory.update`). The operations ask exactly that. The portal has no
// login of its own; "login" only checks a buyer's email and password.
//
// A company's people. The work is in modules/parties/contacts.js. Adding a
// person is a change to the client, so it asks for `clients.update`, as the
// gate in front of the route always has. A person's fields travel under
// `data`: on an update a field left out is kept and one sent empty is cleared.
// ---------------------------------------------------------------------------

const { refusing, fromRefusal } = require('../../kernel/desk-kit');

const id = { type: 'integer', required: true, gt: 0 };
const text = { type: 'string', nullable: true };
const object = { type: 'object' };
const clientFields = {
  alias: text,
  gstNumber: text,
  address: text,
  contactName: text,
  designation: text,
  phone: text,
  email: text,
  logoUrl: text,
  photoUrl: text,
};
const subContractorFields = {
  name: text,
  designation: text,
  phone: text,
  email: text,
  notes: text,
  gstNumber: text,
  address: text,
  photoUrl: text,
};
const clientResult = { fields: { client: { ...object, required: true } } };
const subContractorResult = { fields: { subContractor: { ...object, required: true } } };
const subContractorList = {
  fields: { subContractors: { type: 'array', required: true, items: object } },
};

const contactData = {
  type: 'object',
  required: true,
  fields: {
    name: text,
    designation: text,
    phone: text,
    email: text,
    notes: text,
    isPrimary: { type: 'boolean', nullable: true },
    isArchived: { type: 'boolean', nullable: true },
  },
};
const contactResult = { fields: { contact: { ...object, required: true } } };
const anyId = { type: 'any', required: true };

// What the old write gate asks of a POST to a path no module claims.
const OLD_WRITE_GATE = {
  anyRole: ['super_admin', 'admin'],
  anyPermission: ['config.write', 'inventory.update'],
};

module.exports = function clientOperations({
  service,
  contacts,
  portal,
  get,
  all,
  partyContacts,
  partyDeleteBlockers,
  trashAndDelete,
}) {
  const rawClient = (clientId) => get('SELECT * FROM clients WHERE id = ?', [clientId]);
  const withPeople = (rowOrRows) => partyContacts.attachClientContacts({ all }, rowOrRows);

  return {
    'clients.list': {
      permission: 'clients.read',
      summary: 'Every client, archived last, with its people and how many order lines name it.',
      output: { fields: { clients: { type: 'array', required: true, items: object } } },
      run: async () => ({
        ok: true,
        clients: (await withPeople(await service.getClientsWithUsage())).map(service.rowToClientDto),
      }),
    },

    'clients.get': {
      permission: 'clients.read',
      summary: 'One client, with its people.',
      input: { fields: { id } },
      output: clientResult,
      run: async (input) => {
        const row = await service.getClientRowById(input.id);
        if (!row) return { ok: false, status: 404, error: 'Not found' };
        await withPeople(row);
        return { ok: true, client: service.rowToClientDto(row) };
      },
    },

    'clients.create': {
      permission: 'clients.create',
      summary: 'Add a client. One per name or GST number.',
      // That a client needs a name is the service's to say, in its own words.
      input: { fields: { name: text, ...clientFields } },
      output: { fields: { client: { ...object, required: true }, row: { ...object, required: true } } },
      run: (input) =>
        refusing(async () => {
          const row = await service.saveClient({ ...input, id: null });
          await withPeople(row);
          return { ok: true, client: service.rowToClientDto(row), row };
        }),
    },

    'clients.update': {
      permission: 'clients.update',
      summary: 'Change a client. Whatever is left out is kept.',
      input: { fields: { id, name: { type: 'string', nullable: true }, ...clientFields } },
      output: clientResult,
      run: (input) =>
        refusing(async () => {
          const clientId = Number(input.id);
          const before = await rawClient(clientId);
          const row = await service.saveClient({ ...input, id: clientId });
          await withPeople(row);
          return {
            ok: true,
            client: service.rowToClientDto(row),
            before,
            after: await rawClient(clientId),
          };
        }),
    },

    'clients.archive': {
      permission: 'clients.update',
      summary: 'Archive a client no order line or sub-contractor names. Archiving twice is not an error.',
      input: { fields: { id } },
      output: clientResult,
      run: (input) =>
        refusing(async () => {
          const result = await service.archiveClient(Number(input.id));
          if (result.notFound) return { ok: false, status: 404, error: 'Not found', notFound: true };
          const client = service.rowToClientDto(result.row);
          if (result.already) return { ok: true, client, already: true };
          return { ok: true, client, before: result.before, after: result.row };
        }),
    },

    'clients.unarchive': {
      permission: 'clients.update',
      summary: 'Bring an archived client back.',
      input: { fields: { id } },
      output: clientResult,
      run: (input) =>
        refusing(async () => {
          const result = await service.unarchiveClient(Number(input.id));
          if (result.notFound) return { ok: false, status: 404, error: 'Not found', notFound: true };
          return {
            ok: true,
            client: service.rowToClientDto(result.row),
            before: result.before,
            after: result.row,
          };
        }),
    },

    'clients.delete': {
      permission: 'clients.delete',
      summary: 'Move a client nothing names to the trash.',
      input: { fields: { id } },
      run: async (input, ctx) => {
        const clientId = Number(input.id);
        const before = await rawClient(clientId);
        const blockers = await partyDeleteBlockers('clients', clientId);
        if (blockers.length > 0) {
          return {
            ok: false,
            status: 409,
            code: 'client_in_use',
            error: `"${before?.name || 'This client'}" is still named on ${blockers.join(' and ')}. `
              + 'Archive it instead, or move those first.',
          };
        }
        await trashAndDelete('clients', clientId, { user: ctx.actor?.user || null });
        return { ok: true, before };
      },
    },

    // --- sub-contractors ---------------------------------------------------

    'clients.subContractors.list': {
      permission: 'clients.read',
      summary: 'Every sub-contractor, with its client.',
      output: subContractorList,
      run: async () => ({ ok: true, subContractors: await service.listSubContractors() }),
    },

    'clients.subContractors.listForClient': {
      permission: 'clients.read',
      summary: 'One client’s sub-contractors.',
      input: { fields: { clientId: id } },
      output: subContractorList,
      run: async (input) => ({
        ok: true,
        subContractors: await service.listSubContractorsForClient(Number(input.clientId)),
      }),
    },

    'clients.subContractors.create': {
      permission: 'clients.create',
      summary: 'Add a sub-contractor under a client.',
      input: { fields: { clientId: id, ...subContractorFields } },
      output: subContractorResult,
      run: async (input) => {
        const { clientId, ...body } = input;
        const made = await service.createSubContractor(Number(clientId), body);
        if (made.refusal) return fromRefusal(made.refusal);
        return { ok: true, subContractor: made.dto, id: made.id, row: made.row };
      },
    },

    'clients.subContractors.update': {
      permission: 'clients.update',
      summary: 'Change a sub-contractor. Whatever is left out is kept.',
      input: { fields: { id, ...subContractorFields } },
      output: subContractorResult,
      run: async (input) => {
        const { id: subContractorId, ...body } = input;
        const saved = await service.updateSubContractor(Number(subContractorId), body);
        if (saved.refusal) return fromRefusal(saved.refusal);
        return { ok: true, subContractor: saved.dto, before: saved.existing, after: saved.row };
      },
    },

    'clients.subContractors.delete': {
      permission: 'clients.delete',
      summary: 'Remove a sub-contractor.',
      input: { fields: { id } },
      run: async (input) => ({
        ok: true,
        before: await service.deleteSubContractor(Number(input.id)),
      }),
    },

    // --- a company's people --------------------------------------------------

    'clients.contacts.list': {
      permission: 'clients.read',
      summary: 'A client’s people: the first call first, archived last.',
      input: { fields: { clientId: anyId } },
      output: { fields: { contacts: { type: 'array', required: true, items: object } } },
      run: (input) => refusing(() => contacts.list(input.clientId)),
    },

    'clients.contacts.create': {
      permission: 'clients.update',
      summary: 'Add a person at a client. The first one becomes the first call.',
      input: { fields: { clientId: anyId, data: contactData } },
      output: contactResult,
      run: (input) => refusing(() => contacts.create(input.clientId, input.data || {})),
    },

    'clients.contacts.update': {
      permission: 'clients.update',
      summary: 'Change, archive or restore a person, or make them the first call.',
      input: { fields: { clientId: anyId, id: anyId, data: contactData } },
      output: contactResult,
      run: (input) => refusing(() => contacts.update(input.clientId, input.id, input.data || {})),
    },

    // --- the B2B portal ------------------------------------------------------

    'clients.portal.setCredentials': {
      permission: 'clients.create',
      summary: 'Give a client a portal login, or replace the one it has.',
      input: { fields: { clientId: anyId, email: text, password: text } },
      run: (input) => portal.setCredentials(input.clientId, input),
    },

    'clients.portal.catalogItemIds': {
      permission: 'clients.read',
      summary: 'The ids of the items a client may order through the portal.',
      input: { fields: { clientId: anyId } },
      output: { fields: { itemIds: { type: 'array', required: true } } },
      run: (input) => portal.catalogItemIds(input.clientId),
    },

    'clients.portal.replaceCatalog': {
      permission: 'clients.create',
      summary: 'Replace the list of items a client may order.',
      input: { fields: { clientId: anyId, itemIds: { type: 'array', required: true } } },
      run: (input) => portal.replaceCatalog(input.clientId, input.itemIds),
    },

    'clients.portal.login': {
      access: OLD_WRITE_GATE,
      summary: 'Check a buyer’s email and password. It starts no session.',
      input: { fields: { email: text, password: text } },
      output: { fields: { user: { ...object, required: true } } },
      run: (input) => portal.login(input),
    },

    'clients.portal.catalog': {
      access: 'signedIn',
      summary: 'The unarchived items in a client’s catalogue, by display name.',
      input: { fields: { clientId: { type: 'any' } } },
      output: { fields: { items: { type: 'array', required: true, items: object } } },
      run: (input) => portal.catalog(input.clientId),
    },

    'clients.portal.addToCart': {
      access: OLD_WRITE_GATE,
      summary: 'Add an item to a buyer’s cart, or raise its quantity.',
      input: { fields: { portal_user_id: { type: 'any' }, item_id: { type: 'any' }, quantity: { type: 'any' } } },
      run: (input) => portal.addToCart(input),
    },

    'clients.portal.placeOrder': {
      access: OLD_WRITE_GATE,
      summary: 'Turn a cart into a draft order, in one transaction, and empty the cart.',
      input: { fields: { portal_user_id: { type: 'any' }, items: { type: 'any' } } },
      output: { fields: { orderNo: { type: 'string', required: true } } },
      run: (input) => portal.placeOrder(input),
    },

    // --- internal: asked by other modules ----------------------------------

    'clients.rows.get': {
      internal: true,
      summary: 'A client’s row with its usage count, or nothing.',
      input: { fields: { id: { type: 'any', required: true } } },
      output: { fields: { row: { ...object, nullable: true } } },
      run: async (input) => ({ ok: true, row: await service.getClientRowById(input.id) }),
    },

    'clients.subContractors.row': {
      internal: true,
      summary: 'A sub-contractor’s row as stored, or nothing.',
      input: { fields: { id: { type: 'any', required: true } } },
      output: { fields: { row: { ...object, nullable: true } } },
      run: async (input) => ({ ok: true, row: await get('SELECT * FROM sub_contractors WHERE id = ?', [input.id]) }),
    },

    'clients.contacts.byIds': {
      internal: true,
      summary: 'These people, the first call first and then by name.',
      input: { fields: { ids: { type: 'array', required: true } } },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async (input) => {
        const ids = (input.ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
        if (!ids.length) return { ok: true, rows: [] };
        return {
          ok: true,
          rows: await all(
            `SELECT * FROM party_contacts WHERE id IN (${ids.map(() => '?').join(', ')})
              ORDER BY is_primary DESC, name COLLATE NOCASE ASC`,
            ids,
          ),
        };
      },
    },

    'clients.exists': {
      internal: true,
      summary: 'Whether this id is a client.',
      input: { fields: { id: { type: 'any', required: true } } },
      output: { fields: { exists: { type: 'boolean', required: true } } },
      run: async (input) => ({
        ok: true,
        exists: Boolean(await get('SELECT id FROM clients WHERE id = ?', [Number(input.id)])),
      }),
    },
  };
};
