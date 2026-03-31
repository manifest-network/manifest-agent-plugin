#!/usr/bin/env node
'use strict';

/**
 * Fetch chain registry data from the Cosmos chain registry on GitHub.
 *
 * Usage: node fetch-chain-registry.cjs [--data-dir ~/.manifest-agent]
 *
 * Writes to <data-dir>/chains/{mainnet,testnet}.json and updates .last-registry-fetch.
 * Outputs JSON summary to stdout.
 */

const major = parseInt(process.versions.node, 10);
if (major < 18) {
  console.error(`Node 18+ required (found ${process.version}).`);
  process.exit(1);
}

const { mkdirSync, writeFileSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const REGISTRY_BASE = 'https://raw.githubusercontent.com/cosmos/chain-registry/master';
const CHAINS = {
  mainnet: `${REGISTRY_BASE}/manifest/chain.json`,
  testnet: `${REGISTRY_BASE}/testnets/manifesttestnet/chain.json`,
};

function parseArgs(argv) {
  const args = { dataDir: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--data-dir' && argv[i + 1]) args.dataDir = argv[++i];
  }
  return args;
}

function extractChainData(raw) {
  const rpc = raw.apis?.rpc?.[0]?.address;
  const rest = raw.apis?.rest?.[0]?.address;
  const feeToken = raw.fees?.fee_tokens?.[0];
  const gasPrice = feeToken
    ? `${Number(feeToken.fixed_min_gas_price)}${feeToken.denom}`
    : undefined;
  const explorerUrl = raw.explorers?.[0]?.url;

  return {
    chainId: raw.chain_id,
    rpcUrl: rpc,
    restUrl: rest,
    gasPrice,
    explorerUrl,
  };
}

(async () => {
  const args = parseArgs(process.argv);
  const dataDir = args.dataDir || join(homedir(), '.manifest-agent');
  const chainsDir = join(dataDir, 'chains');

  mkdirSync(chainsDir, { recursive: true });
  chmodSync(dataDir, 0o700);

  const result = {};

  for (const [network, url] of Object.entries(CHAINS)) {
    console.error(`Fetching ${network} chain data...`);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  Failed: HTTP ${res.status} for ${url}`);
        continue;
      }
      const raw = await res.json();
      const data = extractChainData(raw);
      result[network] = data;

      const outPath = join(chainsDir, `${network}.json`);
      writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');
      console.error(`  Wrote ${outPath}`);
    } catch (err) {
      console.error(`  Error fetching ${network}: ${err.message}`);
    }
  }

  const tsPath = join(dataDir, '.last-registry-fetch');
  writeFileSync(tsPath, String(Math.floor(Date.now() / 1000)));

  console.log(JSON.stringify(result, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
