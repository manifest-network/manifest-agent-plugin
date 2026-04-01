#!/usr/bin/env node
'use strict';

/**
 * Write ~/.manifest-agent/config.json from key script output + chain selection.
 *
 * Reads key JSON from stdin (piped from gen-agent-key.cjs or import-key.cjs).
 * Reads chain data from ~/.manifest-agent/chains/{mainnet,testnet}.json.
 * Writes config.json with the password — so the password never enters the conversation.
 *
 * Usage:
 *   node gen-agent-key.cjs | node write-config.cjs --chain testnet --gas-price 1umfx
 *   cat mnemonic.txt | node import-key.cjs | node write-config.cjs --chain testnet --gas-price 1umfx
 *
 * Outputs JSON to stdout (safe to show): { "address": "manifest1...", "activeChain": "testnet" }
 * The password is NOT included in stdout.
 */

const { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const AGENT_DIR = join(homedir(), '.manifest-agent');
const CONFIG_PATH = join(AGENT_DIR, 'config.json');
const CHAINS_DIR = join(AGENT_DIR, 'chains');

function parseArgs(argv) {
  const args = { chain: null, gasPrice: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--chain' && argv[i + 1]) args.chain = argv[++i];
    else if (argv[i] === '--gas-price' && argv[i + 1]) args.gasPrice = argv[++i];
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

function readChainFile(network) {
  const p = join(CHAINS_DIR, `${network}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

(async () => {
  const args = parseArgs(process.argv);

  if (!args.chain || !['testnet', 'mainnet'].includes(args.chain)) {
    console.error('Usage: ... | node write-config.cjs --chain <testnet|mainnet> --gas-price <price><denom>');
    process.exit(1);
  }

  if (!args.gasPrice) {
    console.error('--gas-price is required (e.g., "1umfx").');
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
  } catch (err) {
    console.error(`Failed to parse key JSON from stdin: ${err.message}`);
    process.exit(1);
  }

  const { address, keyfile, password } = keyData;
  if (!address || !keyfile || !password) {
    console.error('Key JSON missing required fields (address, keyfile, password).');
    process.exit(1);
  }

  // Read chain data
  const mainnetData = readChainFile('mainnet');
  const testnetData = readChainFile('testnet');

  const activeChainData = args.chain === 'mainnet' ? mainnetData : testnetData;
  if (!activeChainData) {
    console.error(`Chain data not found for ${args.chain}. Run fetch-chain-registry.cjs first.`);
    process.exit(1);
  }

  // Build config
  const chains = {};
  if (mainnetData) chains.mainnet = mainnetData;
  if (testnetData) chains.testnet = testnetData;

  const config = {
    activeChain: args.chain,
    gasPrice: args.gasPrice,
    chains,
    agent: {
      keyFile: keyfile,
      keyPassword: password,
      address,
    },
  };

  // Write config.json
  mkdirSync(AGENT_DIR, { recursive: true });
  chmodSync(AGENT_DIR, 0o700);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  chmodSync(CONFIG_PATH, 0o600);

  console.error(`Config written to ${CONFIG_PATH}`);
  console.error(`Agent address: ${address}`);
  console.error(`Active chain: ${args.chain}`);

  // Output safe JSON to stdout (NO password)
  console.log(JSON.stringify({ address, activeChain: args.chain }));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
