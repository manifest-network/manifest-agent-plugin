#!/usr/bin/env node
'use strict';

const { getDataDir } = require('./_io.cjs');
const { migrateConfig, CredentialError } = require('./_credentials.cjs');

try {
  if (process.argv.length !== 2) throw new CredentialError('Usage: node migrate-credentials.cjs');
  migrateConfig(getDataDir());
} catch (err) {
  // The helper's errors are constant diagnostics, never native tool output or
  // JSON.parse excerpts that could repeat a stored password.
  console.error(err instanceof CredentialError ? err.message : 'Credential migration failed. Check MANIFEST_PLUGIN_DATA and its permissions.');
  process.exitCode = 1;
}
