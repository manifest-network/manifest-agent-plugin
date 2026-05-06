#!/usr/bin/env node
'use strict';

/**
 * Non-interactive key generation for Claude Code skills.
 *
 * Usage: NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules node gen-agent-key.cjs [--prefix manifest] [--output path/to/key.json]
 *
 * Outputs JSON to stdout: { "address": "manifest1...", "keyfile": "/abs/path/to/key.json", "password": "...", "agentId": "..." }
 * All logs go to stderr so stdout stays machine-readable.
 */

const { mkdirSync, chmodSync } = require('node:fs');
const { dirname, resolve, join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { atomicWrite, getDataDir } = require('./_io.cjs');

function parseArgs(argv) {
  const args = { prefix: 'manifest', output: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--prefix' && argv[i + 1]) args.prefix = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) args.output = argv[++i];
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);

  const password = randomBytes(32).toString('base64url');

  const agentId = randomBytes(4).toString('hex');
  const keyfilePath = resolve(
    args.output ?? join(getDataDir(), 'keys', `agent-${agentId}.json`),
  );

  const wallet = await DirectSecp256k1HdWallet.generate(24, {
    prefix: args.prefix,
  });

  const serialized = await wallet.serialize(password);

  const keyDir = dirname(keyfilePath);
  mkdirSync(keyDir, { recursive: true });
  chmodSync(keyDir, 0o700);

  atomicWrite(keyfilePath, serialized);

  console.error(`Keyfile written to ${keyfilePath}`);

  const [{ address }] = await wallet.getAccounts();
  console.error(`Address: ${address}`);

  console.log(
    JSON.stringify({ address, keyfile: keyfilePath, password, agentId }),
  );
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
