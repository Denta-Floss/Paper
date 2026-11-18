'use strict';

// ---------------------------------------------------------------------------
// The few lines every module's operations and routes were writing again.
//
// A module's older code says "no" in two ways, and neither is the desk's
// result shape: a service function throws an Error carrying statusCode, or it
// returns `{ refusal: { status, body } }` where body is the HTTP answer. These
// turn both into `{ ok: false, status, … }`, and back into the HTTP answer the
// app has always had, so a module can be put behind the desk without changing
// what its service returns or what its routes send.
// ---------------------------------------------------------------------------

/// A thrown refusal (4xx) becomes a result; anything else is a bug and goes on.
/// The error's `code`, when it has one, travels with it.
async function refusing(work) {
  try {
    return await work();
  } catch (error) {
    const status = Number(error?.statusCode);
    if (status >= 400 && status < 500) {
      return {
        ok: false,
        status,
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      };
    }
    throw error;
  }
}

/// `{ refusal: { status, body } }` from a service, as a result. Everything the
/// body carried except `success` is kept, so the route can send it back whole.
function fromRefusal(refusal) {
  const { success, ...detail } = refusal.body || {};
  return { ok: false, status: refusal.status, ...detail };
}

/// For a route file: `ask` an operation as the signed-in user, and `refuse`
/// with exactly what the result carries.
function httpKit(desk) {
  return {
    ask: (req, name, input) => desk.call(name, input, { actor: desk.actorFromRequest(req) }),
    refuse(res, result) {
      const { ok, status, ...detail } = result;
      return res.status(status || 400).json({ success: false, ...detail });
    },
  };
}

// ---------------------------------------------------------------------------
// For a module whose work lived inside its HTTP handlers.
//
// Such a handler is moved out as a function of a plain request that returns
// answer(status, body) instead of sending. These three carry it the rest of
// the way: the plain request an operation hands the work, the answer turned
// into a result, and the route that sends a result back as the answer it was.
//
// TRACK. A handler that wrote a Track entry cannot do so once it is no longer
// a request: Track reads the actor and the sitting from the request itself. So
// the work calls req.track('create' | 'update' | 'delete', …the same arguments
// minus the request), the entries ride along on the result as `track`, and the
// route writes them with the real request before it answers.
// ---------------------------------------------------------------------------

/// What a moved handler used to send.
const answer = (status, body) => ({ status, body });

/// The same for a handler that sent a file (a PDF) rather than JSON.
const answerFile = (contentType, disposition, buffer) => ({
  status: 200,
  file: { contentType, disposition, buffer },
});

/// The plain request a moved handler reads: params, query, body, the user, and
/// somewhere to note the Track entries it would have written.
function plainRequest(ctx, { params = {}, query = {}, body } = {}) {
  const tracked = [];
  return {
    params,
    query,
    body,
    user: ctx.actor?.user || null,
    track: (...entry) => tracked.push(entry),
    tracked,
  };
}

/// An answer as a desk result. `success` is dropped because it is `ok`; it is
/// kept only in the odd case where the two disagreed. Track entries the work
/// noted are attached when the answer is a success.
function answered({ status, body, file }, tracked = []) {
  // A file is the whole answer: the bytes, and how to label them.
  if (file) return { ok: true, file };
  const { success, ...rest } = body || {};
  if (status < 400) {
    return {
      ok: true,
      ...(status !== 200 ? { httpStatus: status } : {}),
      ...(success !== true ? { success } : {}),
      ...rest,
      ...(tracked.length ? { track: tracked } : {}),
    };
  }
  return { ok: false, status, ...(success !== false ? { success } : {}), ...rest };
}

/// Runs a moved handler for an operation: builds its request, and answers.
async function runMoved(work, ctx, shape) {
  const req = plainRequest(ctx, shape);
  return answered(await work(req), req.tracked);
}

/// For a route file: `send(operation, inputOf)` is a handler that asks the
/// operation and sends its result back with the status and body it always
/// had. `trackers` are the Track helpers ({ create, update, delete }).
function deskRoutes(desk, trackers = {}) {
  return (operation, inputOf = () => ({})) => async (req, res) => {
    try {
      const result = await desk.call(operation, inputOf(req), { actor: desk.actorFromRequest(req) });
      const { ok, status, httpStatus, track, file, ...body } = result;
      for (const [kind, ...args] of track || []) {
        if (trackers[kind]) trackers[kind](...args, req);
      }
      if (ok && file) {
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', file.disposition);
        res.send(file.buffer);
        return;
      }
      res.status(ok ? httpStatus || 200 : status || 400).json({ success: ok, ...body });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  };
}

// ---------------------------------------------------------------------------
// For what one module offers another.
//
// A module lists it once, as ASKS: each row names a function in its ports
// (`port`, one or two levels: 'vendorUsageCount', 'movements.apply'), the
// names of its arguments in order (`args`), whether it must run inside the
// caller's transaction (`joins`), and optionally the operation name when the
// port's own is taken (`as`) and `returns: 'map'` when the port answers a Map.
//
// From that one list come the internal operations the module publishes and the
// client a calling module is handed, so the two cannot drift apart. The client
// has the ports' shape, so a caller written against the ports does not change;
// every call on it is a desk call, checked against what the caller declared.
// A Map crosses as a list of pairs and is a Map again on the other side, so
// nothing that travels is more than plain data.
// ---------------------------------------------------------------------------

const portFunction = (ports, port) => port.split('.').reduce((at, key) => at[key], ports);

/// The ports, each as an internal operation `<module>.<port>`.
function operationsFromAsks(moduleName, asks, ports) {
  const operations = {};
  for (const { port, as, args, joins, summary, returns } of asks) {
    operations[`${moduleName}.${as || port}`] = {
      internal: true,
      joinsCallerTransaction: Boolean(joins),
      summary,
      input: { fields: Object.fromEntries(args.map((arg) => [arg, { type: 'any' }])) },
      run: async (input) => {
        const value = await portFunction(ports, port)(...args.map((arg) => input[arg]));
        return { ok: true, value: returns === 'map' ? [...value.entries()] : value };
      },
    };
  }
  return operations;
}

/// An object shaped like the ports whose every function asks the desk.
function clientFromAsks(moduleName, asks, desk) {
  const client = {};
  for (const { port, as, args, returns } of asks) {
    const path = port.split('.');
    const name = path.pop();
    let at = client;
    for (const key of path) at = at[key] = at[key] || {};
    at[name] = async (...given) => {
      const input = {};
      args.forEach((arg, index) => {
        if (given[index] !== undefined) input[arg] = given[index];
      });
      const { value } = await desk.ask(`${moduleName}.${as || port}`, input);
      return returns === 'map' ? new Map(value) : value;
    };
  }
  return client;
}

/// Refuses two operations with one name. A module's operations are one object,
/// so without this the later would silently replace the earlier.
function joinOperations(...sets) {
  const all = {};
  for (const set of sets) {
    for (const [name, operation] of Object.entries(set)) {
      if (name in all) throw new Error(`operation named twice: ${name}`);
      all[name] = operation;
    }
  }
  return all;
}

module.exports = {
  operationsFromAsks,
  clientFromAsks,
  joinOperations,
  refusing,
  fromRefusal,
  httpKit,
  answer,
  answerFile,
  plainRequest,
  answered,
  runMoved,
  deskRoutes,
};
