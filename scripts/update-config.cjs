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
 *   node update-config.cjs --gas-price 1umfx         # Set gas price (raw <amount><denom>)
 *   node update-config.cjs --gas-token MFX           # Set gas price by token symbol
 *                                                    #   (script resolves the chain's
 *                                                    #    fixedMinGasPrice + raw denom from
 *                                                    #    the active chain's feeTokens —
 *                                                    #    avoids the symbol-vs-denom footgun
 *                                                    #    where prose tells the LLM to compose
 *                                                    #    the price string by hand)
 *   node update-config.cjs --refresh-chains          # Update chains from chain files
 *   node update-config.cjs --chain mainnet --refresh-chains  # Combine flags
 *
 * --gas-price and --gas-token are mutually exclusive. --gas-token uses the
 * post-update activeChain (i.e. respects --chain in the same invocation).
 *
 * Outputs JSON to stdout (safe to show): { "activeChain": "...", "gasPrice": "...", "address": "...", "chains": {...} }
 * The key password is NEVER output.
 */

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { atomicWrite, readJsonFile } = require('./_io.cjs');
const { composeGasPrice } = require('./_gas-price.cjs');

const AGENT_DIR = join(homedir(), '.manifest-agent');
const CONFIG_PATH = join(AGENT_DIR, 'config.json');
const CHAINS_DIR = join(AGENT_DIR, 'chains');

function parseArgs(argv) {
  const args = { chain: null, gasPrice: null, gasToken: null, gasMultiplier: null, refreshChains: false, status: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--chain' && argv[i + 1]) args.chain = argv[++i];
    else if (argv[i] === '--gas-price' && argv[i + 1]) args.gasPrice = argv[++i];
    else if (argv[i] === '--gas-token' && argv[i + 1]) args.gasToken = argv[++i];
    else if (argv[i] === '--gas-multiplier' && argv[i + 1]) args.gasMultiplier = argv[++i];
    else if (argv[i] === '--refresh-chains') args.refreshChains = true;
    else if (argv[i] === '--status') args.status = true;
  }
  return args;
}

function readChainFile(network) {
  const p = join(CHAINS_DIR, `${network}.json`);
  if (!existsSync(p)) return null;
  return readJsonFile(p);
}

(async () => {
  const args = parseArgs(process.argv);

  if (!args.chain && !args.gasPrice && !args.gasToken && !args.gasMultiplier && !args.refreshChains && !args.status) {
    console.error('Usage: node update-config.cjs [--status] [--chain <testnet|mainnet>] [--gas-price <price> | --gas-token <symbol>] [--gas-multiplier <n>] [--refresh-chains]');
    process.exit(1);
  }

  if (args.gasPrice && args.gasToken) {
    console.error('--gas-price and --gas-token are mutually exclusive');
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
    config = readJsonFile(CONFIG_PATH);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Read-only status check
  if (args.status) {
    const safeOutput = {
      activeChain: config.activeChain,
      gasPrice: config.gasPrice || null,
      gasMultiplier: config.gasMultiplier || null,
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

  // Update gas price (either by raw string or by token symbol)
  if (args.gasPrice) {
    config.gasPrice = args.gasPrice;
  } else if (args.gasToken) {
    // Resolve symbol against the post-update activeChain (so combining
    // --chain X --gas-token Y in one invocation does the right thing).
    const targetChain = args.chain || config.activeChain;
    if (!targetChain) {
      console.error('--gas-token requires an active chain (pass --chain or set one previously)');
      process.exit(1);
    }
    const chainData = readChainFile(targetChain);
    if (!chainData) {
      console.error(`Chain data not found for ${targetChain}. Run fetch-chain-registry.cjs or pass --refresh-chains first.`);
      process.exit(1);
    }
    try {
      config.gasPrice = composeGasPrice(chainData, args.gasToken);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // Update gas multiplier
  if (args.gasMultiplier) {
    const val = Number(args.gasMultiplier);
    if (!Number.isFinite(val) || val < 1) {
      console.error('--gas-multiplier must be a number >= 1.');
      process.exit(1);
    }
    config.gasMultiplier = val;
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
  atomicWrite(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  console.error(`Config updated at ${CONFIG_PATH}`);

  // Output safe JSON (NO password)
  const safeOutput = {
    activeChain: config.activeChain,
    gasPrice: config.gasPrice || null,
    gasMultiplier: config.gasMultiplier || null,
    address: config.agent?.address || null,
    chains: config.chains,
  };
  console.log(JSON.stringify(safeOutput, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
