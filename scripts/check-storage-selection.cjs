#!/usr/bin/env node
'use strict';

/**
 * Check recorded storage-selection metadata against a fresh browse_catalog.
 *
 * Stdin: { storage, storageSkuUuid, storageProviderUuid, providerUuid, catalog }.
 * Pass only these fields, never the full deployment spec or its environment.
 * The catalog uses the MCP 0.22.0 { providers: [...], skus: [...] } shape;
 * SKU identities are named sku_uuid and provider_uuid on that wire surface.
 *
 * This validates one catalog observation. MCP 0.22.0 still resolves storage
 * by name at deployment time; this check does not pin its UUID immutably.
 * Legacy drafts without selection metadata should skip this helper. Partial
 * metadata is an error, never a request to fall back to name-only selection.
 *
 * Exit 0: JSON containing only the checked identities and checked: true.
 * Exit 1: a one-line diagnostic without raw input or catalog contents.
 */

const { readFileSync } = require('node:fs');
const { isUuid } = require('./_uuid.cjs');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isName(value) {
  // Upstream trims the storage lookup string; preserve all other label bytes.
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isExactUuid(value) {
  // The shared regex permits a final newline via JavaScript's `$` anchor.
  return isUuid(value) && value.length === 36;
}

function checkSelection(input) {
  if (!isObject(input)) throw new Error('expected a JSON object on stdin');
  if (!isName(input.storage)) {
    throw new Error('storage must be a non-empty trimmed SKU name');
  }
  for (const field of ['storageSkuUuid', 'storageProviderUuid', 'providerUuid']) {
    if (!isExactUuid(input[field])) {
      throw new Error(`${field} must be a UUID; selection metadata is incomplete or invalid`);
    }
  }
  if (input.storageProviderUuid !== input.providerUuid) {
    throw new Error('storageProviderUuid does not match the selected compute providerUuid');
  }

  const { catalog } = input;
  if (!isObject(catalog) || !Array.isArray(catalog.skus)) {
    throw new Error('catalog must be a browse_catalog response with a skus array');
  }
  const seenUuids = new Set();
  for (const sku of catalog.skus) {
    if (!isObject(sku) || typeof sku.name !== 'string' || !isExactUuid(sku.sku_uuid) ||
        !isExactUuid(sku.provider_uuid) || typeof sku.active !== 'boolean') {
      throw new Error('catalog contains a malformed SKU identity; refresh browse_catalog');
    }
    if (seenUuids.has(sku.sku_uuid)) {
      throw new Error('catalog contains duplicate SKU UUID records; refresh browse_catalog');
    }
    seenUuids.add(sku.sku_uuid);
  }

  const selected = catalog.skus.find((sku) => sku.sku_uuid === input.storageSkuUuid);
  if (!selected || !selected.active) {
    throw new Error('selected storage SKU UUID is missing or inactive; choose storage again');
  }
  if (selected.provider_uuid !== input.storageProviderUuid) {
    throw new Error('selected storage SKU UUID belongs to a different provider; choose storage again');
  }
  if (selected.name !== input.storage) {
    throw new Error('selected storage SKU UUID has a different name; choose storage again');
  }
  const matches = catalog.skus.filter((sku) => sku.active &&
    sku.provider_uuid === input.providerUuid && sku.name === input.storage);
  if (matches.length !== 1) {
    throw new Error('storage name is ambiguous on the selected provider; MCP cannot pin storage by UUID');
  }

  return {
    checked: true,
    storage: selected.name,
    storageSkuUuid: selected.sku_uuid,
    storageProviderUuid: selected.provider_uuid,
    providerUuid: input.providerUuid,
  };
}

(async () => {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    throw new Error('could not read JSON from stdin');
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    // JSON parser diagnostics can contain fragments of the supplied payload.
    throw new Error('stdin is not valid JSON');
  }
  process.stdout.write(`${JSON.stringify(checkSelection(input))}\n`);
})().catch((err) => {
  console.error(`Storage selection check failed: ${err.message}`);
  process.exit(1);
});
