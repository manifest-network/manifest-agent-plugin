#!/usr/bin/env node
'use strict';

/**
 * Write $MANIFEST_PLUGIN_DATA/config.json from key script output + chain selection.
 *
 * Reads key JSON from stdin (piped from gen-agent-key.cjs or import-key.cjs).
 * Reads chain data from $MANIFEST_PLUGIN_DATA/chains/{mainnet,testnet}.json.
 * Stores the password in the credential store and writes only its reference.
 *
 * Usage:
 *   node gen-agent-key.cjs | node write-config.cjs --chain testnet --gas-price 1umfx
 *   cat mnemonic.txt | node import-key.cjs | node write-config.cjs --chain testnet --gas-price 1umfx
 *
 * Outputs JSON to stdout (safe to show): { "address": "manifest1...", "activeChain": "testnet" }
 * The password is NOT included in stdout.
 */

const { existsSync, mkdirSync, chmodSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { atomicWrite, readJsonFile, getDataDir } = require('./_io.cjs');
const { composeGasPrice } = require('./_gas-price.cjs');
const { storePassword, migrateConfig, withConfigLock, readConfig } = require('./_credentials.cjs');

function parseArgs(argv) {
  const args = { chain: null, gasPrice: null, gasToken: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--chain' && argv[i + 1]) args.chain = argv[++i];
    else if (argv[i] === '--gas-price' && argv[i + 1]) args.gasPrice = argv[++i];
    else if (argv[i] === '--gas-token' && argv[i + 1]) args.gasToken = argv[++i];
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

function readChainFile(chainsDir, network) {
  const p = join(chainsDir, `${network}.json`);
  if (!existsSync(p)) return null;
  return readJsonFile(p);
}

// Once stdin identifies a valid keyfile, every later failure must name the
// retained file. It may be an existing wallet, so never delete it on failure.
let suppliedKeyfilePath;

(async () => {
  // getDataDir() inside the IIFE so a missing MANIFEST_PLUGIN_DATA produces
  // the helper's friendly error via the .catch handler, not a raw stack.
  const AGENT_DIR = getDataDir();
  const CONFIG_PATH = join(AGENT_DIR, 'config.json');
  const CHAINS_DIR = join(AGENT_DIR, 'chains');

  const args = parseArgs(process.argv);

  if (!args.chain || !['testnet', 'mainnet'].includes(args.chain)) {
    console.error('Usage: ... | node write-config.cjs --chain <testnet|mainnet> --gas-price <price><denom> | --gas-token <symbol>');
    process.exit(1);
  }

  if (args.gasPrice && args.gasToken) {
    console.error('--gas-price and --gas-token are mutually exclusive');
    process.exit(1);
  }
  if (!args.gasPrice && !args.gasToken) {
    console.error('--gas-price (e.g., "1umfx") or --gas-token (e.g., "MFX") is required');
    process.exit(1);
  }

  // Read key JSON from stdin (piped from gen-agent-key.cjs or import-key.cjs)
  const raw = await readStdin();
  if (!raw) {
    console.error('No key JSON received on stdin. Pipe output from gen-agent-key.cjs or import-key.cjs.');
    process.exit(1);
  }

  let keyData;
  try {
    keyData = JSON.parse(raw);
  } catch {
    console.error('Failed to parse key JSON from stdin.');
    process.exit(1);
  }

  const { address, keyfile, password } = keyData ?? {};
  if (typeof address !== 'string' || !address.trim()
    || typeof keyfile !== 'string' || !keyfile.trim() || typeof password !== 'string') {
    console.error('Key JSON missing required fields (address, keyfile, password).');
    process.exit(1);
  }
  suppliedKeyfilePath = resolve(AGENT_DIR, keyfile);

  // Read chain data
  const mainnetData = readChainFile(CHAINS_DIR, 'mainnet');
  const testnetData = readChainFile(CHAINS_DIR, 'testnet');

  const activeChainData = args.chain === 'mainnet' ? mainnetData : testnetData;
  if (!activeChainData) {
    throw new Error(`Chain data not found for ${args.chain}. Run fetch-chain-registry.cjs first.`);
  }

  // Resolve gas-price (raw string or compose from token symbol)
  let resolvedGasPrice;
  if (args.gasPrice) {
    resolvedGasPrice = args.gasPrice;
  } else {
    resolvedGasPrice = composeGasPrice(activeChainData, args.gasToken);
  }

  // Build config
  const chains = {};
  if (mainnetData) chains.mainnet = mainnetData;
  if (testnetData) chains.testnet = testnetData;

  const config = {
    activeChain: args.chain,
    gasPrice: resolvedGasPrice,
    chains,
    agent: {
      keyFile: keyfile,
      address,
    },
  };

  // Write config.json
  mkdirSync(AGENT_DIR, { recursive: true });
  chmodSync(AGENT_DIR, 0o700);
  withConfigLock(AGENT_DIR, () => {
    // A damaged previous config may still hold a recoverable legacy password.
    // Keep readConfig's safe permission/shape diagnostic alongside recovery.
    const recovery = `Repair the previous config at ${CONFIG_PATH} to preserve any legacy password, or move it aside as a private backup before re-running init-agent. Do not paste its contents into chat.`;
    try { readConfig(AGENT_DIR); }
    catch (error) { throw new Error(`${error.message} ${recovery}`); }
    // This explicit user action retries the store immediately after repair;
    // only automatic hook/launcher retries honour the short failure cooldown.
    const previous = migrateConfig(AGENT_DIR, { locked: true, migrationRetryMs: 0 });
    if (previous?.credentialMigration) config.credentialMigration = previous.credentialMigration;
    config.agent.keyPasswordRef = storePassword(AGENT_DIR, keyfile, password);
    atomicWrite(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  });

  console.error(`Config written to ${CONFIG_PATH}`);
  console.error(`Agent address: ${address}`);
  console.error(`Active chain: ${args.chain}`);

  // Output safe JSON to stdout (NO password)
  console.log(JSON.stringify({ address, activeChain: args.chain }));
})().catch((err) => {
  console.error(err.message);
  if (suppliedKeyfilePath) {
    console.error(`Supplied keyfile retained at ${suppliedKeyfilePath}; it was not deleted. Resolve this failure before retrying; repeated key generation or import can leave unused encrypted keyfiles.`);
  }
  process.exit(1);
});
