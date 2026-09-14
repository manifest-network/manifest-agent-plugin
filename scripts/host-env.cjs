#!/usr/bin/env node
'use strict';

// Dependency-free path discovery. --shell emits only trusted, quoted exports;
// stdout never contains config, key material or remote tool content.
const { resolveHost, shellExports } = require('./_host.cjs');

function main(argv = process.argv.slice(2)) {
  if (argv.length < 1 || argv.length > 2 || (argv[1] && argv[1] !== '--shell')) {
    throw new Error('Usage: node host-env.cjs <claude|codex> [--shell]');
  }
  const host = resolveHost(argv[0]);
  process.stdout.write(argv[1] ? shellExports(host.env) : JSON.stringify(host) + '\n');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
