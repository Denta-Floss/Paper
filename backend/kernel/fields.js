'use strict';

// ---------------------------------------------------------------------------
// The words a contract is written in.
//
// A contract says what each field IS: text, a number, an id, a list of such.
// It does not repeat a rule the service already has (that a name is needed,
// that a factor must be positive), because the service says those in its own
// words and a contract would only change the wording. So nothing here is
// `required` except an id that came from the path, which cannot be absent.
//
// Numbers accept numeric strings, because query values are strings. Booleans
// accept true, false, 0, 1, 'true', 'false'; a query flag written as '1' is
// therefore typed as text, not as a flag.
// ---------------------------------------------------------------------------

const text = { type: 'string' };
const int = { type: 'integer' };
const num = { type: 'number' };
const flag = { type: 'boolean' };

/// A row id from the path: an integer above zero, and it has to be there.
const id = { type: 'integer', required: true, gt: 0 };
/// A string id from the path (pipeline templates, production runs, barcodes).
const key = { type: 'string', required: true, nonEmpty: true };

const list = (items) => (items ? { type: 'array', items } : { type: 'array' });
const obj = (fields) => ({ type: 'object', fields });
/// A body or query the operation reads nothing from. Still an object.
const none = { type: 'object' };

/// The same field under its camelCase and snake_case names, as the challan
/// and invoice payloads have always accepted both.
const both = (camel, snake, spec) => ({ [camel]: spec, [snake]: spec });

module.exports = { text, int, num, flag, id, key, list, obj, none, both };
