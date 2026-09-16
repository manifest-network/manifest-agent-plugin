#!/usr/bin/env node
'use strict';

const { getDataDir } = require('./_io.cjs');
const { migrateConfig, CredentialError } = require('./_credentials.cjs');

try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 1 || args[0] !== '--automatic')) {
    throw new CredentialError('Usage: node migrate-credentials.cjs [--automatic]');
  }
  // A deliberate user retry may follow unlocking the store. Only automatic
  // hook/launcher starts share the cooldown that prevents repeated prompts.
  migrateConfig(getDataDir(), args[0] === '--automatic' ? {} : { migrationRetryMs: 0 });
} catch (err) {
  // The helper's errors are constant diagnostics, never native tool output or
  // JSON.parse excerpts that could repeat a stored password.
  console.error(err instanceof CredentialError ? err.message : 'Credential migration failed. Check MANIFEST_PLUGIN_DATA and its permissions.');
  process.exitCode = 1;
}
