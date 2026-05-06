#!/usr/bin/env node
'use strict';

/**
 * Fetch chain registry data from the Cosmos chain registry on GitHub.
 *
 * Usage: node fetch-chain-registry.cjs [--data-dir $MANIFEST_PLUGIN_DATA]
 *
 * Writes to <data-dir>/chains/{mainnet,testnet}.json and updates .last-registry-fetch.
 * Outputs JSON summary to stdout.
 */

const major = parseInt(process.versions.node, 10);
if (major < 18) {
  console.error(`Node 18+ required (found ${process.version}).`);
  process.exit(1);
}

const { mkdirSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
const { atomicWrite, getDataDir } = require('./_io.cjs');

const REGISTRY_BASE = 'https://raw.githubusercontent.com/cosmos/chain-registry/master';
const CHAINS = {
  mainnet: {
    chain: `${REGISTRY_BASE}/manifest/chain.json`,
    assets: `${REGISTRY_BASE}/manifest/assetlist.json`,
    converterAddress: 'manifest1wug8sewp6cedgkmrmvhl3lf3tulagm9hnvy8p0rppz9yjw0g4wtqdnm0gk',
  },
  testnet: {
    chain: `${REGISTRY_BASE}/testnets/manifesttestnet/chain.json`,
    assets: `${REGISTRY_BASE}/testnets/manifesttestnet/assetlist.json`,
    converterAddress: 'manifest1c4p5p0eajlymxak8z5ugmksfpvp5zmm3scrwdrtd5a6mwxnhsa9qnsfftk',
    faucetUrl: 'https://faucet.testnet.manifest.network/',
  },
};

function parseArgs(argv) {
  const args = { dataDir: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--data-dir' && argv[i + 1]) args.dataDir = argv[++i];
  }
  return args;
}

function buildDenomSymbolMap(assetList) {
  const map = {};
  for (const asset of assetList?.assets || []) {
    if (asset.base && asset.symbol) {
      map[asset.base] = asset.symbol;
    }
  }
  return map;
}

function extractChainData(chainRaw, assetList) {
  const rpc = chainRaw.apis?.rpc?.[0]?.address;
  const rest = chainRaw.apis?.rest?.[0]?.address;
  const symbolMap = buildDenomSymbolMap(assetList);
  const feeTokens = (chainRaw.fees?.fee_tokens || []).map((t) => ({
    denom: t.denom,
    symbol: symbolMap[t.denom] || t.denom,
    fixedMinGasPrice: Number(t.fixed_min_gas_price),
    lowGasPrice: Number(t.low_gas_price),
    averageGasPrice: Number(t.average_gas_price),
    highGasPrice: Number(t.high_gas_price),
  }));
  const explorerUrl = chainRaw.explorers?.[0]?.url;

  return {
    chainId: chainRaw.chain_id,
    rpcUrl: rpc,
    restUrl: rest,
    feeTokens,
    explorerUrl,
  };
}

(async () => {
  const args = parseArgs(process.argv);
  const dataDir = args.dataDir || getDataDir();
  const chainsDir = join(dataDir, 'chains');

  mkdirSync(chainsDir, { recursive: true });
  chmodSync(dataDir, 0o700);

  const result = {};

  for (const [network, urls] of Object.entries(CHAINS)) {
    console.error(`Fetching ${network} chain data...`);
    try {
      const [chainRes, assetRes] = await Promise.all([
        fetch(urls.chain),
        fetch(urls.assets),
      ]);
      if (!chainRes.ok) {
        console.error(`  Failed: HTTP ${chainRes.status} for ${urls.chain}`);
        continue;
      }
      const chainRaw = await chainRes.json();
      const assetList = assetRes.ok ? await assetRes.json() : null;
      const data = extractChainData(chainRaw, assetList);
      if (urls.converterAddress) data.converterAddress = urls.converterAddress;
      if (urls.faucetUrl) data.faucetUrl = urls.faucetUrl;
      result[network] = data;

      const outPath = join(chainsDir, `${network}.json`);
      // Chain registry data is public — explicitly write at 0o644 so the
      // file mode matches its sensitivity. The parent dir is 0o700 so the
      // file is still effectively private to the user; this is just for
      // future-proofing if the dir mode ever loosens.
      atomicWrite(outPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o644 });
      console.error(`  Wrote ${outPath}`);
    } catch (err) {
      console.error(`  Error fetching ${network}: ${err.message}`);
    }
  }

  const tsPath = join(dataDir, '.last-registry-fetch');
  atomicWrite(tsPath, String(Math.floor(Date.now() / 1000)), { mode: 0o644 });

  console.log(JSON.stringify(result, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
