#!/usr/bin/env node
'use strict';

/**
 * Check recorded storage-selection metadata against a fresh browse_catalog.
 *
 * Usage: node check-storage-selection.cjs --spec-file <path> < catalog.json
 * Read the saved spec directly; stdin is the JSON browse_catalog payload.
 * Serialize the catalog to a file with the host's Write tool, never embed
 * catalog names or other data in shell source. Environment values in the
 * saved spec are neither emitted nor changed.
 * The catalog uses the MCP 0.22.0 { providers: [...], skus: [...] } shape;
 * SKU identities are named sku_uuid and provider_uuid on that wire surface.
 *
 * This validates one catalog observation. MCP 0.22.0 still resolves storage
 * by name at deployment time; this check does not pin its UUID immutably.
 * The catalog has no SKU category field; checked does not certify storage
 * suitability, pricing, or inclusion in the upstream deployment estimate.
 * Legacy drafts without selection metadata should skip this helper. Partial
 * metadata is an error, never a request to fall back to name-only selection.
 *
 * Exit 0: JSON containing only the checked identities and checked: true.
 * Exit 1: a one-line diagnostic without raw input or catalog contents.
 */

const { readFileSync } = require('node:fs');
const { isUuid } = require('./_uuid.cjs');
const { skuIdentity } = require('./_spec.cjs');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(source, label) {
  let raw;
  try {
    raw = readFileSync(source, 'utf8');
  } catch {
    throw new Error(`could not read ${label}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Parser diagnostics may include user-controlled or secret excerpts.
    throw new Error(`${label} is not valid JSON`);
  }
}

function oneActiveSku(catalog, uuid, label) {
  const matches = catalog.skus.filter((sku) => sku.sku_uuid === uuid);
  if (matches.length > 1) {
    throw new Error(`catalog contains duplicate ${label} SKU UUID records`);
  }
  if (matches.length === 0 || !matches[0].active) {
    throw new Error(`selected ${label} SKU UUID is missing or inactive; choose ${label} again`);
  }
  return matches[0];
}

function checkSelection(spec, catalog) {
  if (!isObject(spec)) throw new Error('spec must be a JSON object');
  if (typeof spec.storage !== 'string' || spec.storage.trim().length === 0) {
    throw new Error('storage must be a non-empty SKU name');
  }
  // Match upstream name lookup without mutating the user's saved draft.
  const storage = spec.storage.trim();
  for (const field of ['storageSkuUuid', 'storageProviderUuid']) {
    if (!isUuid(spec[field])) {
      throw new Error(`${field} must be a UUID; selection metadata is incomplete or invalid`);
    }
  }

  if (!isObject(catalog) || !Array.isArray(catalog.skus)) {
    throw new Error('catalog must be a browse_catalog response with a skus array');
  }
  for (const sku of catalog.skus) {
    // Match the published catalog shape. Unrelated identifiers need not
    // conform to the selected draft's UUID validation policy.
    if (!isObject(sku) || typeof sku.name !== 'string' || typeof sku.sku_uuid !== 'string' ||
        typeof sku.provider_uuid !== 'string' || typeof sku.active !== 'boolean') {
      throw new Error('catalog contains a malformed SKU identity; refresh browse_catalog');
    }
  }

  const identity = skuIdentity(spec);
  let providerUuid = identity.providerUuid;
  if (identity.skuUuid) {
    const compute = oneActiveSku(catalog, identity.skuUuid, 'compute');
    if (providerUuid && providerUuid !== compute.provider_uuid) {
      throw new Error('selected compute SKU UUID belongs to a different provider');
    }
    providerUuid = compute.provider_uuid;
  }
  if (!providerUuid) {
    throw new Error('spec must identify the compute provider with providerUuid or skuUuid');
  }
  if (spec.storageProviderUuid !== providerUuid) {
    throw new Error('storageProviderUuid does not match the selected compute providerUuid');
  }

  // Deliberately match the upstream resolver's case-sensitive identifiers.
  const selected = oneActiveSku(catalog, spec.storageSkuUuid, 'storage');
  if (selected.provider_uuid !== spec.storageProviderUuid) {
    throw new Error('selected storage SKU UUID belongs to a different provider; choose storage again');
  }
  if (selected.name !== storage) {
    throw new Error('selected storage SKU UUID has a different name; choose storage again');
  }
  const matches = catalog.skus.filter((sku) => sku.active &&
    sku.provider_uuid === providerUuid && sku.name === storage);
  if (matches.length !== 1) {
    throw new Error('storage name is ambiguous on the selected provider; MCP cannot pin storage by UUID');
  }

  return {
    checked: true,
    storage: selected.name,
    storageSkuUuid: selected.sku_uuid,
    storageProviderUuid: selected.provider_uuid,
    providerUuid,
  };
}

(async () => {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--spec-file' || !args[1]) {
    throw new Error('usage: check-storage-selection.cjs --spec-file <path> < catalog.json');
  }
  const spec = readJson(args[1], 'spec file');
  const catalog = readJson(0, 'catalog on stdin');
  process.stdout.write(`${JSON.stringify(checkSelection(spec, catalog))}\n`);
})().catch((err) => {
  console.error(`Storage selection check failed: ${err.message}`);
  process.exit(1);
});
