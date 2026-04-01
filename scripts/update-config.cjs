#!/usr/bin/env node
'use strict';

/**
 * Update ~/.manifest-agent/config.json without exposing the key password.
 *
 * Updates activeChain and/or refreshes chain data from ~/.manifest-agent/chains/.
 * Preserves the existing agent section (keyFile, keyPassword, address) untouched.
 *
 * Usage:
 *   node update-config.cjs --status                  # Read-only: show safe config fields
 *   node update-config.cjs --chain testnet           # Switch active chain
 *   node update-config.cjs --refresh-chains          # Update chains from chain files
 *   node update-config.cjs --chain mainnet --refresh-chains  # Both
 *
 * Outputs JSON to stdout (safe to show): { "activeChain": "...", "address": "...", "chains": {...} }
 * The key password is NEVER output.
 */

const { existsSync, readFileSync, writeFileSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const AGENT_DIR = join(homedir(), '.manifest-agent');
const CONFIG_PATH = join(AGENT_DIR, 'config.json');
const CHAINS_DIR = join(AGENT_DIR, 'chains');

function parseArgs(argv) {
  const args = { chain: null, refreshChains: false, status: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--chain' && argv[i + 1]) args.chain = argv[++i];
    else if (argv[i] === '--refresh-chains') args.refreshChains = true;
    else if (argv[i] === '--status') args.status = true;
  }
  return args;
}

function readChainFile(network) {
  const p = join(CHAINS_DIR, `${network}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

(async () => {
  const args = parseArgs(process.argv);

  if (!args.chain && !args.refreshChains && !args.status) {
    console.error('Usage: node update-config.cjs [--status] [--chain <testnet|mainnet>] [--refresh-chains]');
    process.exit(1);
  }

  if (args.chain && !['testnet', 'mainnet'].includes(args.chain)) {
    console.error('--chain must be "testnet" or "mainnet".');
    process.exit(1);
  }

  // Read existing config
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found at ${CONFIG_PATH}. Run /manifest-agent:init-agent first.`);
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }

  // Read-only status check
  if (args.status) {
    const safeOutput = {
      activeChain: config.activeChain,
      address: config.agent?.address || null,
      chains: config.chains,
    };
    console.log(JSON.stringify(safeOutput, null, 2));
    return;
  }

  // Update active chain
  if (args.chain) {
    config.activeChain = args.chain;
  }

  // Refresh chain data from files
  if (args.refreshChains) {
    const mainnetData = readChainFile('mainnet');
    const testnetData = readChainFile('testnet');

    if (!mainnetData && !testnetData) {
      console.error('No chain data files found. Run fetch-chain-registry.cjs first.');
      process.exit(1);
    }

    if (!config.chains) config.chains = {};
    if (mainnetData) config.chains.mainnet = mainnetData;
    if (testnetData) config.chains.testnet = testnetData;
  }

  // Write config back (preserves agent section with password untouched)
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  chmodSync(CONFIG_PATH, 0o600);

  console.error(`Config updated at ${CONFIG_PATH}`);

  // Output safe JSON (NO password)
  const safeOutput = {
    activeChain: config.activeChain,
    address: config.agent?.address || null,
    chains: config.chains,
  };
  console.log(JSON.stringify(safeOutput, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
