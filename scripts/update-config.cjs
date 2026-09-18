#!/usr/bin/env node
'use strict';

/**
 * Update $MANIFEST_PLUGIN_DATA/config.json without exposing the key password.
 *
 * Updates activeChain and/or refreshes chain data from $MANIFEST_PLUGIN_DATA/chains/.
 * Preserves the selected wallet and credential reference; migrates legacy secrets
 * before a configuration update. --status remains read-only.
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
 * post-update activeChain (i.e. respects --chain in the same invocation) and
 * requires its chains/<network>.json file; config.chains is not a fallback.
 * That file must match config metadata, or be merged with --refresh-chains.
 * Interactive workflows refresh before presenting fee-token choices.
 * --refresh-chains merges existing files, never downloads them.
 *
 * Outputs JSON to stdout (safe to show): { "activeChain": "...", "gasPrice": "...", "address": "...", "chains": {...} }
 * The key password is NEVER output.
 */

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { atomicWrite, readJsonFile, getDataDir } = require('./_io.cjs');
const { composeGasPrice } = require('./_gas-price.cjs');
const { NETWORKS } = require('./_chain-config.cjs');
const { migrateConfig, withConfigLock, readConfig } = require('./_credentials.cjs');

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

(async () => {
  // getDataDir() inside the IIFE so a missing MANIFEST_PLUGIN_DATA produces
  // the helper's friendly error via the .catch handler, not a raw stack.
  const AGENT_DIR = getDataDir();
  const CONFIG_PATH = join(AGENT_DIR, 'config.json');
  const CHAINS_DIR = join(AGENT_DIR, 'chains');

  const args = parseArgs(process.argv);

  if (!args.chain && !args.gasPrice && !args.gasToken && !args.gasMultiplier && !args.refreshChains && !args.status) {
    console.error('Usage: node update-config.cjs [--status] [--chain <testnet|mainnet>] [--gas-price <price> | --gas-token <symbol>] [--gas-multiplier <n>] [--refresh-chains]');
    process.exit(1);
  }

  if (args.gasPrice && args.gasToken) {
    console.error('--gas-price and --gas-token are mutually exclusive');
    process.exit(1);
  }

  if (args.status && (args.chain || args.gasPrice || args.gasToken || args.gasMultiplier || args.refreshChains)) {
    console.error('--status is read-only and cannot be combined with mutating flags (--chain, --gas-price, --gas-token, --gas-multiplier, --refresh-chains)');
    process.exit(1);
  }

  if (args.chain && !NETWORKS.includes(args.chain)) {
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
    config = readConfig(AGENT_DIR);
    if (!config) throw new Error('Config disappeared before reading.');
  } catch {
    console.error(`Could not read ${CONFIG_PATH}. Repair its JSON to preserve any legacy password, or move it aside as a private backup before running init-agent. Do not paste its contents into chat.`);
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

  withConfigLock(AGENT_DIR, () => {
    // Reread while locked so a concurrent migration or writer cannot be undone.
    // Stage changes before migration so validation failures preserve even a
    // legacy config byte-for-byte and do not create credentials.
    config = readConfig(AGENT_DIR);
    if (!config) throw new Error('Config disappeared before the update.');
    const updates = {};

    // Update active chain
    if (args.chain) {
      updates.activeChain = args.chain;
    }
    const targetChain = args.chain || config.activeChain;
    if (args.chain || args.gasToken || args.refreshChains) {
      if (!NETWORKS.includes(targetChain)) {
        throw new Error('No valid active chain selected. Ask the user to choose testnet or mainnet through the switch-chain skill (including its mainnet confirmation), then retry with --chain <chosen-network>; include --refresh-chains to merge existing chain files.');
      }
      if (config.chains !== undefined && (!config.chains || typeof config.chains !== 'object' || Array.isArray(config.chains))) {
        throw new Error('Invalid config.chains: expected a JSON object. Repair config privately; do not paste its contents into chat.');
      }
    }
    const mergeCommand = () => `update-config.cjs --chain ${targetChain} --refresh-chains`;
    const registryRecovery = network => `Use the refresh-registry skill to fetch and merge ${network} metadata. CLI equivalent: run fetch-chain-registry.cjs, verify ${network} was saved, then run ${mergeCommand()}. Review the updated settings before retrying the original command.`;
    const chainFiles = new Map();
    function readChainFile(network) {
      if (!chainFiles.has(network)) {
        const file = join(CHAINS_DIR, `${network}.json`);
        let data = null;
        if (existsSync(file)) {
          try { data = readJsonFile(file); }
          catch {
            throw new Error(`Could not read ${file} as a JSON object. Check file permissions and contents. ${registryRecovery(network)}`);
          }
        }
        chainFiles.set(network, data);
      }
      return chainFiles.get(network);
    }

    // Read each file at most once so gas resolution and refresh share a snapshot.
    if (args.refreshChains) {
      const diskChains = Object.fromEntries(NETWORKS.map(network => [network, readChainFile(network)])
        .filter(([, data]) => data));
      if (Object.keys(diskChains).length === 0) {
        throw new Error(`No chain data files found. ${registryRecovery(targetChain)}`);
      }
      updates.chains = { ...config.chains, ...diskChains };
    }

    // Update gas price (either by raw string or by token symbol)
    if (args.gasPrice) {
      updates.gasPrice = args.gasPrice;
    } else if (args.gasToken) {
      // Resolve symbol against the post-update activeChain (so combining
      // --chain X --gas-token Y in one invocation does the right thing).
      const chainData = readChainFile(targetChain);
      if (!chainData) {
        throw new Error(`Chain data file chains/${targetChain}.json not found. ${registryRecovery(targetChain)}`);
      }
      updates.gasPrice = composeGasPrice(chainData, args.gasToken);
      // An interactive choice comes from config's safe status fields. Refuse
      // stale metadata instead of silently writing a different minimum price.
      // Missing config entries use the shared recovery diagnostic below.
      const configuredChainData = (updates.chains || config.chains)?.[targetChain];
      if (configuredChainData && !isDeepStrictEqual(chainData, configuredChainData)) {
        throw new Error(`Registry metadata for ${targetChain} differs from config. Run ${mergeCommand()}, review the refreshed fee tokens, then retry the original command.`);
      }
    }

    // Update gas multiplier
    if (args.gasMultiplier) {
      const val = Number(args.gasMultiplier);
      if (!Number.isFinite(val) || val < 1) {
        throw new Error('--gas-multiplier must be a number >= 1.');
      }
      updates.gasMultiplier = val;
    }

    // A partial registry fetch may leave only the other network available.
    // Validate after merging files so a newly fetched target is usable, while
    // chain selection and gas-token updates require metadata in the config.
    if ((args.chain || args.gasToken || args.refreshChains) && !(updates.chains || config.chains)?.[targetChain]) {
      const recovery = readChainFile(targetChain)
        ? 'Local metadata is available; retry the original command with --refresh-chains. No fetch is needed.'
        : registryRecovery(targetChain);
      throw new Error(`Chain data not found for ${targetChain}. ${recovery}`);
    }

    // An explicit config edit retries immediately after credential repair;
    // automatic hook/launcher migrations retain the shared failure cooldown.
    config = migrateConfig(AGENT_DIR, { locked: true, migrationRetryMs: 0 });
    if (!config) throw new Error('Config disappeared before the update.');
    Object.assign(config, updates);
    // Write config back with the credential reference preserved.
    atomicWrite(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  });

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
