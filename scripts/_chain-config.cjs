'use strict';

// String predicates mirror @manifest-network/manifest-mcp-core v0.22.0,
// packages/core/src/config.ts (published as dist/config.js). Keep these in
// sync with the installed runtime via ci/chain-config-parity.cjs. Registry
// shape checks and transport-safe endpoint spelling live in _chain-registry.cjs.
const { URL } = require('node:url');

// Plugin-supported registry networks (separate from the upstream predicates).
const NETWORKS = Object.freeze(['testnet', 'mainnet']);

function validateEndpointUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch {
    return { valid: false, reason: `${label} must be a valid URL` };
  }
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && localhost)) {
    return { valid: true };
  }
  return { valid: false, reason: `${label} must use HTTPS; HTTP is only allowed for localhost, 127.0.0.1 or ::1.` };
}

function isValidChainId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][\w-]*$/.test(value);
}

function isValidGasPrice(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d+(?:\.\d+)?)([a-zA-Z][a-zA-Z0-9.:_-]*(?:\/[a-zA-Z0-9.:_-]+)*)$/);
  return !!match && match[2].length >= 3 && match[2].length <= 128;
}

function isValidGasDenom(value) {
  // A leading digit would be consumed as part of the amount when concatenated.
  return typeof value === 'string' && /^[a-zA-Z]/.test(value) && isValidGasPrice(`0${value}`);
}

module.exports = { NETWORKS, validateEndpointUrl, isValidChainId, isValidGasPrice, isValidGasDenom };
