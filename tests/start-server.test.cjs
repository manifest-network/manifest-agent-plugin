'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = join(__dirname, '..', 'scripts', 'start-server.cjs');

// Build a self-contained $MANIFEST_PLUGIN_DATA tree: config.json with the
// minimum required fields + a fake `manifest-mcp-<name>` binary that prints
// the agent-relevant env vars on stdout (one KEY=VALUE per line) and exits 0.
// The wrapper uses `spawn(binaryPath, [], { stdio: 'inherit', env })`, so
// stdout from the fake binary flows through to spawnSync's captured stdout.
//
// All env vars we care about (COSMOS_*, MANIFEST_*) start with one of those
// two prefixes — the shim filters on them so unrelated parent-env noise
// (PATH, HOME, etc.) doesn't pollute the assertion target.
function buildPluginData({ activeChain = 'testnet', faucetUrl, gasPrice = '0.025umfx', restUrl, converterAddress } = {}) {
  const data = mkdtempSync(join(tmpdir(), 'start-server-data-'));
  const chains = {
    testnet: {
      chainId: 'manifest-ledger-testnet',
      rpcUrl: 'https://rpc.testnet.example',
    },
    mainnet: {
      chainId: 'manifest-ledger-mainnet',
      rpcUrl: 'https://rpc.mainnet.example',
    },
  };
  if (restUrl) chains[activeChain].restUrl = restUrl;
  if (converterAddress) chains[activeChain].converterAddress = converterAddress;
  if (faucetUrl) chains[activeChain].faucetUrl = faucetUrl;
  const config = { activeChain, gasPrice, chains, agent: {} };
  writeFileSync(join(data, 'config.json'), JSON.stringify(config));
  const binDir = join(data, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  // Each VALID_SERVERS entry needs a binary on disk for the existsSync
  // check to pass. The fake binary prints filtered env keys=values to stdout.
  for (const name of ['chain', 'lease', 'fred', 'cosmwasm', 'agent']) {
    const binPath = join(binDir, `manifest-mcp-${name}`);
    writeFileSync(
      binPath,
      [
        '#!/usr/bin/env bash',
        // Print every env var matching MANIFEST_* or COSMOS_*. Sort for
        // deterministic ordering across runs. printf %s\n keeps values
        // intact even when they contain spaces.
        'env | grep -E "^(MANIFEST_|COSMOS_)" | sort',
      ].join('\n'),
    );
    chmodSync(binPath, 0o755);
  }
  return data;
}

// Run start-server.cjs with the given server name + plugin data dir + any
// parent-env overrides. Returns { status, stdout, stderr } and cleans up
// the data dir.
function runWrapper(serverName, { data, extraEnv = {} } = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || '/tmp',
    MANIFEST_PLUGIN_DATA: data,
    ...extraEnv,
  };
  const res = spawnSync('node', [SCRIPT, serverName], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function parseEnvLines(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function withData(fn, opts = {}) {
  const data = buildPluginData(opts);
  try {
    return fn(data);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}

// ---------- Happy path: agent server sets ENG-204 env vars ----------

test('agent server sets MANIFEST_AGENT_DATA_DIR to plugin data dir', () => {
  withData((data) => {
    const r = runWrapper('agent', { data });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const got = parseEnvLines(r.stdout);
    assert.equal(got.MANIFEST_AGENT_DATA_DIR, data);
  });
});

test('agent server sets MANIFEST_CHAIN_DATA_FILE to <data>/chains/<activeChain>.json', () => {
  withData((data) => {
    const r = runWrapper('agent', { data });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const got = parseEnvLines(r.stdout);
    assert.equal(got.MANIFEST_CHAIN_DATA_FILE, join(data, 'chains', 'testnet.json'));
  });
});

test('agent server omits MANIFEST_AGENT_FETCH_GUARDED when unset in parent env', () => {
  withData((data) => {
    const r = runWrapper('agent', { data });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const got = parseEnvLines(r.stdout);
    assert.equal(got.MANIFEST_AGENT_FETCH_GUARDED, undefined);
  });
});

test('agent server forwards MANIFEST_AGENT_FETCH_GUARDED when set in parent env', () => {
  withData((data) => {
    const r = runWrapper('agent', { data, extraEnv: { MANIFEST_AGENT_FETCH_GUARDED: '0' } });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const got = parseEnvLines(r.stdout);
    assert.equal(got.MANIFEST_AGENT_FETCH_GUARDED, '0');
  });
});

test('agent server picks the correct chain file for mainnet', () => {
  withData((data) => {
    const r = runWrapper('agent', { data });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const got = parseEnvLines(r.stdout);
    // testnet by default — sanity-check we're testing what we think.
    assert.equal(got.COSMOS_CHAIN_ID, 'manifest-ledger-testnet');
    assert.equal(got.MANIFEST_CHAIN_DATA_FILE, join(data, 'chains', 'testnet.json'));
  }, { activeChain: 'testnet' });

  withData((data) => {
    const r = runWrapper('agent', { data });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const got = parseEnvLines(r.stdout);
    assert.equal(got.COSMOS_CHAIN_ID, 'manifest-ledger-mainnet');
    assert.equal(got.MANIFEST_CHAIN_DATA_FILE, join(data, 'chains', 'mainnet.json'));
  }, { activeChain: 'mainnet' });
});

// ---------- Existing servers stay unaffected ----------

test('chain server does NOT receive agent-only env vars', () => {
  withData((data) => {
    const r = runWrapper('chain', { data });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const got = parseEnvLines(r.stdout);
    assert.equal(got.MANIFEST_AGENT_DATA_DIR, undefined);
    assert.equal(got.MANIFEST_CHAIN_DATA_FILE, undefined);
    assert.equal(got.MANIFEST_AGENT_FETCH_GUARDED, undefined);
    // But the core required vars are still set.
    assert.equal(got.COSMOS_CHAIN_ID, 'manifest-ledger-testnet');
    assert.equal(got.COSMOS_GAS_PRICE, '0.025umfx');
  });
});

test('lease server does NOT receive the wrapper-computed agent env vars', () => {
  withData((data) => {
    const r = runWrapper('lease', { data });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const got = parseEnvLines(r.stdout);
    // The wrapper only ADDS these under serverName === 'agent'. Confirm
    // they don't appear when the parent env didn't set them either.
    // (The wrapper's `...process.env` spread will pass through any var
    // the operator chooses to set in the parent shell — that's expected
    // and consistent with how PATH / NODE_PATH / HOME etc. flow through.)
    assert.equal(got.MANIFEST_AGENT_DATA_DIR, undefined);
    assert.equal(got.MANIFEST_CHAIN_DATA_FILE, undefined);
    assert.equal(got.MANIFEST_AGENT_FETCH_GUARDED, undefined);
  });
});

// ---------- Server-name validation ----------

test('rejects unknown server name', () => {
  withData((data) => {
    const r = runWrapper('bogus', { data });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Usage:/);
    // Agent must be listed as a valid choice in the usage diagnostic.
    assert.match(r.stderr, /agent/);
  });
});

// ---------- Diagnostic line still hides MANIFEST_KEY_PASSWORD ----------

test('agent server diagnostic line lists new env keys but never KEY_PASSWORD', () => {
  withData((data) => {
    const r = runWrapper('agent', { data });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // The diagnostic line goes to stderr.
    assert.match(r.stderr, /Starting manifest-mcp-agent with env:/);
    assert.match(r.stderr, /MANIFEST_AGENT_DATA_DIR/);
    assert.match(r.stderr, /MANIFEST_CHAIN_DATA_FILE/);
    assert.doesNotMatch(r.stderr, /MANIFEST_KEY_PASSWORD/);
  });
});
