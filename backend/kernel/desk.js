'use strict';

// ---------------------------------------------------------------------------
// Kernel desk — the one place a module's work is asked for.
//
// A module publishes OPERATIONS: named functions with a declared input shape
// and a required permission. Callers come here and nowhere else:
//
//   HTTP       a route handler calls desk.call   on behalf of a signed-in user
//   module     desk.as('clients').ask(...)       one neighbourhood asking another
//   system     boot code, seeds and tests        trusted, inside the process
//
// Every call gets the same treatment whoever makes it: the name is resolved,
// the actor is checked, the input is checked against the operation's contract,
// the function runs, its result is checked against the output contract, and a
// plain result comes back —
//
//   { ok: true, ...data }                         or
//   { ok: false, status, code, error, ...detail }
//
// — the shape modules/process_routes/service.js already returned before the
// desk existed. A refusal is a RESULT. A throw is a bug, and is not caught
// here: the caller reports it in its own way (a route answers 500).
//
// CONTRACTS have two strictness modes, per operation:
//
//   report    a violation is recorded (onViolation) and the call carries on.
//             The kernel's default, because tightening a contract can change
//             an answer the app already depends on; this is how one finds out
//             first. The server runs in enforce (see server.js) and names the
//             few operations it keeps in report.
//   enforce   an input violation is refused with 400 input_invalid; an output
//             violation is the module's own bug and throws.
//
// An operation moves from report to enforce once the suite and a journey run
// record no violations for it. catalogue() says which mode each is in.
//
// WHO MAY ASK, for an operation offered to users, is one of:
//
//   permission: 'orders.read'      the usual case: the user holds this key
//   access: 'signedIn'             any signed-in user
//   access: { anyRole, anyPermission }
//                                  a role in the list OR any one of the keys
//
// `permission` and `access` may both be set, and then both must hold; and
// optionally `roles: [...]` on top, which the user's role must be in whatever
// else is asked. The last three exist because some routes were never
// behind a module permission (the B2B portal, the older /templates set, an
// employee's login): an operation has to ask exactly what the route in front
// of it always asked, or some user gets a different answer than before.
//
// Everything stays in one process on one database connection, so a call
// through the desk joins whatever transaction the caller has open. That is
// deliberate: issuing a challan moves stock in the same transaction, and a
// network hop between the two would let it half-happen.
//
// The desk is created, not required as a singleton: the tests re-require
// server.js many times in one process, and a shared table would fill up with
// the previous boot's closures.
// ---------------------------------------------------------------------------

const { checkPayload } = require('./contracts');

const ACTOR_KINDS = new Set(['user', 'module', 'system']);
const MODES = new Set(['report', 'enforce']);

function refusal(status, code, error, detail = {}) {
  return { ok: false, status, code, error, ...detail };
}

/// The rule used when nobody supplies one: a super admin may ask anything,
/// anyone else needs the key set true. server.js replaces it with its own
/// hasPermission so fine-grained keys fall back to their coarse key exactly as
/// they do at the HTTP border — one rule, not two that drift.
function defaultUserMay(actor, permissionKey) {
  if (actor.user?.role === 'super_admin') return true;
  return actor.permissions?.[permissionKey] === true;
}

function createDesk({
  userMay = defaultUserMay,
  onViolation = () => {},
  // The mode of an operation that does not name one. The kernel's own default
  // is the cautious one; the server asks for 'enforce' once the evidence is in.
  defaultMode = 'report',
  // Overrides every operation's mode, its own included. For an operator who
  // needs enforcement off without a code change: PAPER_CONTRACTS_MODE=report.
  forceMode = null,
} = {}) {
  for (const mode of [defaultMode, forceMode]) {
    if (mode !== null && !MODES.has(mode)) throw new Error(`unknown contract mode '${mode}'`);
  }
  const operations = new Map(); // name -> the registered operation, see register()
  // For tests only: operations whose next call fails before it runs, so a test
  // can see what a failure in the middle of a flow leaves behind.
  const tripped = new Map();
  const uses = new Map(); // module -> Set of operation names it may ask for
  const calls = new Map(); // name -> count
  const violations = new Map(); // name -> { input, output } counts
  let userCheck = userMay;

  /// Publishes a module's operations and records what it may ask of others.
  ///
  /// `uses` is the written record of which neighbourhood talks to which: a
  /// module that has not declared a name is refused it, so a new dependency
  /// between two modules cannot appear without a line saying so.
  function register(moduleName, { operations: published = {}, uses: asks = [] } = {}) {
    const module = String(moduleName || '').trim();
    if (!module) throw new Error('desk.register needs a module name');

    for (const [name, spec] of Object.entries(published)) {
      if (!name.startsWith(`${module}.`)) {
        throw new Error(`operation '${name}' must be named '${module}.…'`);
      }
      if (operations.has(name)) {
        throw new Error(`operation '${name}' is already registered`);
      }
      if (typeof spec?.run !== 'function') {
        throw new Error(`operation '${name}' has no run function`);
      }
      if (!spec.internal && !spec.permission && !spec.access) {
        throw new Error(`operation '${name}' needs a permission, an access rule, or internal: true`);
      }
      const access = spec.access || null;
      if (access && access !== 'signedIn') {
        const named = [...(access.anyRole || []), ...(access.anyPermission || [])];
        if (typeof access !== 'object' || named.length === 0) {
          throw new Error(`operation '${name}' has an access rule that lets nobody in`);
        }
      }
      const mode = forceMode || spec.mode || defaultMode;
      if (!MODES.has(mode)) {
        throw new Error(`operation '${name}' has unknown mode '${mode}'`);
      }
      operations.set(name, {
        module,
        permission: spec.permission || null,
        access,
        roles: Array.isArray(spec.roles) && spec.roles.length ? [...spec.roles] : null,
        input: spec.input || { fields: {} },
        // What an ok result carries. Absent means "not declared yet".
        output: spec.output || null,
        mode,
        internal: Boolean(spec.internal),
        // Must run inside the caller's open transaction. Two modules joined by
        // such an operation cannot be put in separate processes.
        joinsCallerTransaction: Boolean(spec.joinsCallerTransaction),
        summary: spec.summary || '',
        run: spec.run,
      });
      calls.set(name, 0);
      violations.set(name, { input: 0, output: 0 });
    }

    const allowed = uses.get(module) || new Set();
    for (const name of asks) allowed.add(String(name));
    uses.set(module, allowed);
  }

  function mayAsk(actor, name, operation) {
    if (!actor || !ACTOR_KINDS.has(actor.kind)) {
      return refusal(403, 'actor_unknown', 'A call needs to say who is asking.');
    }
    // Code inside the process acting for nobody in particular: boot, seeds,
    // tests. There is no way to claim this from outside; a request can only
    // ever become a 'user' actor (actorFromRequest).
    if (actor.kind === 'system') return null;

    if (actor.kind === 'module') {
      const caller = String(actor.name || '');
      // A module asking itself is not a border crossing.
      if (caller === operation.module) return null;
      if (uses.get(caller)?.has(name)) return null;
      return refusal(
        403,
        'not_declared',
        `Module '${caller}' has not declared that it uses '${name}'.`,
      );
    }

    if (operation.internal) {
      return refusal(403, 'operation_internal', `'${name}' is not offered to users.`);
    }
    const role = actor.user?.role || null;
    if (operation.roles && !operation.roles.includes(role)) {
      return refusal(403, 'forbidden', 'You do not have permission for this action.', {
        roles: operation.roles,
      });
    }
    // An access rule and a permission may both be set (approving a delete
    // request sat behind the old write gate AND its own key); then both hold.
    if (operation.access === 'signedIn' && !actor.user) {
      return refusal(401, 'not_signed_in', 'Authentication required.');
    }
    if (operation.access && operation.access !== 'signedIn') {
      const { anyRole = [], anyPermission = [] } = operation.access;
      if (!anyRole.includes(role) && !anyPermission.some((key) => userCheck(actor, key))) {
        return refusal(403, 'forbidden', 'You do not have permission for this action.', {
          access: operation.access,
        });
      }
    }
    if (operation.permission && !userCheck(actor, operation.permission)) {
      return refusal(403, 'forbidden', `This needs the '${operation.permission}' permission.`, {
        permission: operation.permission,
      });
    }
    return null;
  }

  function noteViolation(name, operation, side, problems) {
    violations.get(name)[side] += 1;
    onViolation({ operation: name, module: operation.module, side, mode: operation.mode, problems });
  }

  /// Runs one operation. Never throws for a refusal; lets a bug throw.
  async function call(name, input = {}, { actor } = {}) {
    const operation = operations.get(name);
    if (!operation) {
      return refusal(404, 'operation_unknown', `There is no operation called '${name}'.`);
    }

    const denied = mayAsk(actor, name, operation);
    if (denied) return denied;

    if (tripped.has(name)) {
      const error = tripped.get(name);
      tripped.delete(name);
      throw error;
    }

    const payload = input == null ? {} : input;
    const problems = checkPayload({ entity: name, ...operation.input }, payload);
    if (problems.length) {
      noteViolation(name, operation, 'input', problems);
      if (operation.mode === 'enforce') {
        // Said about the field, not about the operation: "name is required"
        // is for a person, "units.create.name is required" is for us. The
        // full paths stay in `problems`.
        const message = problems[0].message.split(`${name}.`).join('');
        return refusal(400, 'input_invalid', message, { problems });
      }
    }

    calls.set(name, calls.get(name) + 1);
    const result = await operation.run(payload, { actor, name });
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      throw new Error(`operation '${name}' did not return a result with ok`);
    }

    // A refusal has the one shape every refusal has; only an ok result is the
    // operation's own to describe.
    if (result.ok && operation.output) {
      const wrong = checkPayload({ entity: `${name} result`, ...operation.output }, result);
      if (wrong.length) {
        noteViolation(name, operation, 'output', wrong);
        if (operation.mode === 'enforce') {
          throw new Error(`operation '${name}' broke its output contract: ${wrong[0].message}`);
        }
      }
    }
    return result;
  }

  /// A module's own handle on the desk. `ask` is for the caller that cannot
  /// carry on without an answer: a refusal becomes a thrown error rather than
  /// a value somebody forgets to look at.
  function as(moduleName) {
    const actor = { kind: 'module', name: String(moduleName) };
    return {
      call: (name, input) => call(name, input, { actor }),
      async ask(name, input) {
        const result = await call(name, input, { actor });
        if (!result.ok) {
          const error = new Error(`${moduleName} → ${name}: ${result.error}`);
          error.code = result.code;
          error.statusCode = result.status;
          error.result = result;
          throw error;
        }
        return result;
      },
    };
  }

  function actorFromRequest(req) {
    return {
      kind: 'user',
      user: req.user || null,
      permissions: req.userPermissions || {},
      // The permission key the HTTP border already answered for this request,
      // if it did. The server's user rule may honour it; the default does not.
      cleared: req.gateClearedKey || null,
    };
  }

  /// A contract as plain data: what a field is, not how it is checked.
  function describeSpec(rawSpec, depth = 0) {
    const spec = typeof rawSpec === 'function' ? rawSpec() : rawSpec || {};
    const out = { type: spec.type || 'any' };
    for (const key of ['required', 'nullable', 'nonEmpty', 'enum', 'min', 'max', 'gt']) {
      if (spec[key] !== undefined && spec[key] !== false) out[key] = spec[key];
    }
    // Recursive shapes (a variation tree) are described a few levels deep.
    if (spec.items && depth < 4) out.items = describeSpec(spec.items, depth + 1);
    if (spec.fields && depth < 4) out.fields = describeFields(spec.fields, depth + 1);
    return out;
  }

  function describeFields(fields = {}, depth = 0) {
    return Object.fromEntries(
      Object.entries(fields).map(([field, spec]) => [field, describeSpec(spec, depth)]),
    );
  }

  /// Every operation with its contract, who may ask for it and how strictly it
  /// is held. This is the module's API written down: contract-surface.test.js
  /// pins it, so a contract cannot change without the change being seen.
  function catalogue() {
    const askedBy = new Map();
    for (const [module, names] of uses) {
      for (const name of names) {
        if (!askedBy.has(name)) askedBy.set(name, []);
        askedBy.get(name).push(module);
      }
    }
    return [...operations.entries()]
      .map(([name, operation]) => ({
        name,
        module: operation.module,
        // Who it is for: a user holding this permission, or other modules only.
        permission: operation.permission,
        ...(operation.access ? { access: operation.access } : {}),
        ...(operation.roles ? { roles: operation.roles } : {}),
        internal: operation.internal,
        mode: operation.mode,
        joinsCallerTransaction: operation.joinsCallerTransaction,
        summary: operation.summary,
        input: describeFields(operation.input.fields),
        output: operation.output ? describeFields(operation.output.fields) : null,
        usedBy: (askedBy.get(name) || []).sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /// Who has declared they ask what — the dependency map, as data.
  function declaredUses() {
    return Object.fromEntries(
      [...uses.entries()]
        .filter(([, names]) => names.size)
        .map(([module, names]) => [module, [...names].sort()]),
    );
  }

  /// Calls served per operation, grouped by module, for the territory meter.
  function stats() {
    const out = {};
    for (const [name, count] of calls) {
      const module = operations.get(name).module;
      (out[module] ||= {})[name] = count;
    }
    return out;
  }

  /// Contract violations seen per operation since boot; only those with any.
  function violationCounts() {
    return Object.fromEntries(
      [...violations.entries()].filter(([, seen]) => seen.input || seen.output),
    );
  }

  return {
    register,
    call,
    /// For tests: the next call of `name` throws `error` instead of running.
    trip: (name, error) => tripped.set(name, error || new Error(`tripped: ${name}`)),
    as,
    actorFromRequest,
    catalogue,
    declaredUses,
    stats,
    violationCounts,
    has: (name) => operations.has(name),
    setUserCheck(fn) {
      userCheck = fn;
    },
  };
}

module.exports = { createDesk, refusal };
