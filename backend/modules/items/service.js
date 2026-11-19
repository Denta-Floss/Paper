'use strict';

// The items service: the logic that lived in server.js until 2026-11-19,
// assembled from the files beside this one. Every function is on the one
// object, and the files reach each other through it at call time.

const { createSchemaProps } = require('./schema-props');
const { createDevelopedFor } = require('./developed-for');
const { createVariations } = require('./variations');
const { createDto } = require('./dto');
const { createReads } = require('./reads');
const { createSave } = require('./save');
const { createDeletes } = require('./deletes');

function createItemsService(deps) {
  const api = {};
  Object.assign(api, createSchemaProps(deps, api));
  Object.assign(api, createDevelopedFor(deps, api));
  Object.assign(api, createVariations(deps, api));
  Object.assign(api, createDto(deps, api));
  Object.assign(api, createReads(deps, api));
  Object.assign(api, createSave(deps, api));
  Object.assign(api, createDeletes(deps, api));
  return api;
}

module.exports = { createItemsService };
