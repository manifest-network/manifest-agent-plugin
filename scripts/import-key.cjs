#!/usr/bin/env node
'use strict';

/**
 * Non-interactive mnemonic import for Claude Code skills.
 *
 * Reads mnemonic from stdin (one line, space-separated words).
 * Usage: echo "word1 word2 ..." | NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules node import-key.cjs [--prefix manifest] [--output path/to/key.json]
 *
 * Outputs JSON to stdout: { "address": "manifest1...", "keyfile": "/abs/path/to/key.json", "password": "...", "agentId": "..." }
 * All logs go to stderr. Mnemonic is NEVER written to stdout or stderr.
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

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

(async () => {
  const args = parseArgs(process.argv);

  const mnemonic = await readStdin();
  if (!mnemonic) {
    console.error('No mnemonic provided on stdin.');
    process.exit(1);
  }

  const words = mnemonic.split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    console.error(`Invalid mnemonic: expected 12-24 words, got ${words.length}.`);
    process.exit(1);
  }

  let wallet;
  try {
    wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: args.prefix,
    });
  } catch (err) {
    console.error(`Invalid mnemonic: ${err.message}`);
    process.exit(1);
  }

  const password = randomBytes(32).toString('base64url');

  const agentId = randomBytes(4).toString('hex');
  const keyfilePath = resolve(
    args.output ?? join(getDataDir(), 'keys', `agent-${agentId}.json`),
  );

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
