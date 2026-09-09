'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, chmodSync, existsSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const { COMPLETION_FILE, RUNTIME_PLATFORM, readRuntimeDefinition, snapshotDependencies } = require('../scripts/_runtime.cjs');

function stampRuntime(data) {
  const root = join(data, '.fixture-plugin');
  const definition = readRuntimeDefinition(root);
  copyFileSync(join(root, 'package.json'), join(data, 'package.json'));
  copyFileSync(join(root, 'package-lock.json'), join(data, 'package-lock.json'));
  writeFileSync(join(data, COMPLETION_FILE), JSON.stringify({
    schema: 1, fingerprint: definition.fingerprint, runtime: RUNTIME_PLATFORM,
    files: snapshotDependencies(data),
  }));
}

// Build a self-contained $MANIFEST_PLUGIN_DATA tree: config.json with the
// minimum required fields + a fake `manifest-mcp-<name>` binary that prints
// the agent-relevant env vars on stdout (one KEY=VALUE per line) and exits 0.
// The wrapper uses `spawn(binaryPath, [], { stdio: 'inherit', env })`, so
// stdout from the fake binary flows through to spawnSync's captured stdout.
//
// All env vars we care about (COSMOS_*, MANIFEST_*) start with one of those
// two prefixes — the shim filters on them so unrelated parent-env noise
// (PATH, HOME, etc.) doesn't pollute the assertion target.
function buildPluginData({ activeChain = 'testnet', faucetUrl, gasPrice = '0.025umfx', gasMultiplier,
  restUrl, converterAddress, keyPassword = 'fixture-password' } = {}) {
  const data = mkdtempSync(join(tmpdir(), 'start-server-data-'));
  const plugin = join(data, '.fixture-plugin');
  mkdirSync(join(plugin, 'scripts'), { recursive: true });
  // Copy the actual launcher and its two dependency-free helpers. A minimal
  // locked package makes corruption checks realistic without installing the
  // full published runtime separately for each subprocess test.
  for (const name of ['start-server.cjs', '_runtime.cjs', '_io.cjs']) {
    copyFileSync(join(__dirname, '..', 'scripts', name), join(plugin, 'scripts', name));
  }
  const dependencies = { '@manifest-network/manifest-mcp-node': 'fixture' };
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ dependencies }));
  writeFileSync(join(plugin, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies }, 'node_modules/@manifest-network/manifest-mcp-node': { version: 'fixture' },
  } }));
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
  const keyFile = join(data, 'fixture-wallet.json');
  writeFileSync(keyFile, '{}', { mode: 0o600 });
  const config = { activeChain, gasPrice, gasMultiplier, chains, agent: { keyFile, keyPassword } };
  writeFileSync(join(data, 'config.json'), JSON.stringify(config));
  const binDir = join(data, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const packageDir = join(data, 'node_modules', '@manifest-network', 'manifest-mcp-node');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: 'fixture' }));
  writeFileSync(join(packageDir, 'dependency.cjs'), '// fixture runtime dependency\n');
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
        'env | grep -E "^(MANIFEST_|COSMOS_|DOTENV_|HTTP_PROXY=|HTTPS_PROXY=|NO_PROXY=)" | sort',
        'printf "FIXTURE_CWD=%s\\n" "$PWD"',
      ].join('\n'),
    );
    chmodSync(binPath, 0o755);
  }
  stampRuntime(data);
  return data;
}

// Run start-server.cjs with the given server name + plugin data dir + any
// parent-env overrides. Returns { status, stdout, stderr }. Cleanup of
// the data dir is the caller's responsibility — see `withData()`'s
// finally block for the canonical pattern (every call site in this
// file wraps `runWrapper(...)` in `withData(...)` so the dir gets torn
// down even on assertion failure).
function runWrapper(serverName, { data, extraEnv = {}, cwd } = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || '/tmp',
    MANIFEST_PLUGIN_DATA: data,
    ...extraEnv,
  };
  const script = join(data, '.fixture-plugin', 'scripts', 'start-server.cjs');
  const res = spawnSync(process.execPath, [script, serverName], {
    encoding: 'utf8',
    env,
    cwd,
    timeout: 10_000,
  });
  if (res.error) throw res.error;
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
    // (Parent-env values of these specific vars are STRIPPED for non-
    // agent servers — see the "strips agent-only env vars" test below
    // for the parent-env-set case.)
    assert.equal(got.MANIFEST_AGENT_DATA_DIR, undefined);
    assert.equal(got.MANIFEST_CHAIN_DATA_FILE, undefined);
    assert.equal(got.MANIFEST_AGENT_FETCH_GUARDED, undefined);
  });
});

test('strips agent-only env vars (MANIFEST_AGENT_*, MANIFEST_CHAIN_DATA_FILE) from non-agent servers even when set in parent shell', () => {
  // Regression for Copilot R4 finding: the wrapper builds env via
  // `{ ...process.env, ... }` then conditionally ADDS agent-only vars
  // under serverName === 'agent'. Without an explicit strip in the
  // non-agent branch, parent-shell exports of these three vars leak
  // into the chain / lease / fred / cosmwasm server envs.
  //
  // The strip is load-bearing for the "limit blast radius" framing in
  // start-server.cjs's comment: future env-contract drift (e.g. a
  // future manifest-mcp-chain that grows a MANIFEST_AGENT_DATA_DIR
  // sensitivity) would silently break if an operator happened to
  // export the var for an agent run and then started a chain server
  // in the same shell.
  const polluted = {
    MANIFEST_AGENT_DATA_DIR: '/operator/exported/path',
    MANIFEST_CHAIN_DATA_FILE: '/operator/exported/chain.json',
    MANIFEST_AGENT_FETCH_GUARDED: '0',
  };
  for (const serverName of ['chain', 'lease', 'fred', 'cosmwasm']) {
    withData((data) => {
      const r = runWrapper(serverName, { data, extraEnv: polluted });
      assert.equal(r.status, 0, `stderr from ${serverName}: ${r.stderr}`);
      const got = parseEnvLines(r.stdout);
      assert.equal(
        got.MANIFEST_AGENT_DATA_DIR,
        undefined,
        `${serverName} server's env carried parent-set MANIFEST_AGENT_DATA_DIR=${got.MANIFEST_AGENT_DATA_DIR}; should have been stripped.`,
      );
      assert.equal(
        got.MANIFEST_CHAIN_DATA_FILE,
        undefined,
        `${serverName} server's env carried parent-set MANIFEST_CHAIN_DATA_FILE=${got.MANIFEST_CHAIN_DATA_FILE}; should have been stripped.`,
      );
      assert.equal(
        got.MANIFEST_AGENT_FETCH_GUARDED,
        undefined,
        `${serverName} server's env carried parent-set MANIFEST_AGENT_FETCH_GUARDED=${got.MANIFEST_AGENT_FETCH_GUARDED}; should have been stripped.`,
      );
    });
  }
  // Sanity-check: the agent server in the same parent-env still receives
  // the values (computed-from-config for the first two, forwarded for
  // the third) — the strip is non-agent-only.
  withData((data) => {
    const r = runWrapper('agent', { data, extraEnv: polluted });
    assert.equal(r.status, 0, `stderr from agent: ${r.stderr}`);
    const got = parseEnvLines(r.stdout);
    // Wrapper computes MANIFEST_AGENT_DATA_DIR from AGENT_DIR — overrides
    // the parent-set value rather than passing it through. Same for
    // MANIFEST_CHAIN_DATA_FILE.
    assert.equal(got.MANIFEST_AGENT_DATA_DIR, data);
    assert.equal(got.MANIFEST_CHAIN_DATA_FILE, join(data, 'chains', 'testnet.json'));
    // MANIFEST_AGENT_FETCH_GUARDED is forwarded from parent when set.
    assert.equal(got.MANIFEST_AGENT_FETCH_GUARDED, '0');
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

test('selected mainnet config replaces stale chain, gas, wallet, and dotenv settings', () => {
  withData((data) => {
    const r = runWrapper('chain', {
      data,
      extraEnv: {
        COSMOS_CHAIN_ID: 'stale-testnet', COSMOS_RPC_URL: 'https://old-rpc.example',
        COSMOS_GAS_PRICE: '999wrong', COSMOS_GAS_MULTIPLIER: '100',
        COSMOS_ADDRESS_PREFIX: 'cosmos', COSMOS_MNEMONIC: 'stale mnemonic secret',
        MANIFEST_KEY_FILE: '/different/wallet.json', MANIFEST_KEY_PASSWORD: 'old password secret',
        DOTENV_CONFIG_QUIET: 'false',
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const got = parseEnvLines(r.stdout);
    assert.equal(got.COSMOS_CHAIN_ID, 'manifest-ledger-mainnet');
    assert.equal(got.COSMOS_RPC_URL, 'https://rpc.mainnet.example');
    assert.equal(got.COSMOS_GAS_PRICE, '0.05umfx');
    assert.equal(got.COSMOS_GAS_MULTIPLIER, '1.7');
    assert.equal(got.COSMOS_ADDRESS_PREFIX, 'manifest');
    assert.equal(got.MANIFEST_KEY_FILE, join(data, 'fixture-wallet.json'));
    assert.equal(got.MANIFEST_KEY_PASSWORD, 'fixture-password');
    assert.equal(got.COSMOS_MNEMONIC, undefined);
    assert.equal(got.DOTENV_CONFIG_QUIET, 'true');
    assert.doesNotMatch(r.stderr, /stale mnemonic secret|old password secret|fixture-password/);
  }, { activeChain: 'mainnet', gasPrice: '0.05umfx', gasMultiplier: 1.7 });
});

test('absent optional config fields clear inherited endpoint and gas values', () => {
  withData((data) => {
    const extraEnv = {
      COSMOS_REST_URL: 'https://stale-rest.example', COSMOS_GAS_MULTIPLIER: '8',
      MANIFEST_CONVERTER_ADDRESS: 'stale-converter', MANIFEST_FAUCET_URL: 'https://stale-faucet.example',
    };
    for (const server of ['chain', 'lease', 'fred', 'cosmwasm', 'agent']) {
      const r = runWrapper(server, { data, extraEnv });
      assert.equal(r.status, 0, r.stderr);
      const got = parseEnvLines(r.stdout);
      for (const key of Object.keys(extraEnv)) assert.equal(got[key], undefined, `${server}: ${key}`);
    }
  }, { activeChain: 'mainnet' });
});

test('configured optional endpoints override parent values and network proxy settings survive', () => {
  withData((data) => {
    const r = runWrapper('chain', { data, extraEnv: {
      COSMOS_REST_URL: 'https://old-rest.example', MANIFEST_CONVERTER_ADDRESS: 'old-converter',
      MANIFEST_FAUCET_URL: 'https://old-faucet.example',
      COSMOS_MAX_GAS: '1000000',
      HTTP_PROXY: 'http://proxy.example:8080', HTTPS_PROXY: 'http://secure-proxy.example:8080',
      NO_PROXY: 'localhost,.example',
    } });
    assert.equal(r.status, 0, r.stderr);
    const got = parseEnvLines(r.stdout);
    assert.equal(got.COSMOS_REST_URL, 'https://rest.testnet.example');
    assert.equal(got.MANIFEST_CONVERTER_ADDRESS, 'configured-converter');
    assert.equal(got.MANIFEST_FAUCET_URL, 'https://faucet.testnet.example');
    assert.equal(got.HTTP_PROXY, 'http://proxy.example:8080');
    assert.equal(got.HTTPS_PROXY, 'http://secure-proxy.example:8080');
    assert.equal(got.NO_PROXY, 'localhost,.example');
    assert.equal(got.COSMOS_MAX_GAS, '1000000', 'preserve the explicit operator gas ceiling');
  }, { restUrl: 'https://rest.testnet.example', converterAddress: 'configured-converter',
    faucetUrl: 'https://faucet.testnet.example' });
});

test('explicit empty and whitespace passwords reach the child byte-for-byte', () => {
  for (const keyPassword of ['', '  fixture password  ']) {
    withData((data) => {
      const r = runWrapper('agent', { data, extraEnv: { MANIFEST_KEY_PASSWORD: 'stale secret' } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(parseEnvLines(r.stdout).MANIFEST_KEY_PASSWORD, keyPassword);
      assert.doesNotMatch(r.stderr, /stale secret|fixture password/);
    }, { keyPassword });
  }
});

test('incomplete wallet configuration fails before any inherited wallet can be used', () => {
  for (const agent of [{}, { keyFile: '/missing' }, { keyFile: '', keyPassword: '' },
    { keyFile: '/missing', keyPassword: null }]) {
    withData((data) => {
      const path = join(data, 'config.json');
      const config = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...config, agent }));
      const r = runWrapper('agent', { data, extraEnv: {
        MANIFEST_KEY_FILE: join(data, 'fixture-wallet.json'),
        MANIFEST_KEY_PASSWORD: 'old password secret', COSMOS_MNEMONIC: 'stale mnemonic secret',
      } });
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /agent\.keyFile and agent\.keyPassword/);
      assert.doesNotMatch(r.stderr, /old password secret|stale mnemonic secret/);
    });
  }
});

test('missing configured wallet refuses mnemonic fallback and points to wallet repair', () => {
  withData((data) => {
    rmSync(join(data, 'fixture-wallet.json'));
    const r = runWrapper('agent', { data, extraEnv: { COSMOS_MNEMONIC: 'stale mnemonic secret' } });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Configured wallet file not found/);
    assert.match(r.stderr, /manifest-agent:import-key/);
    assert.doesNotMatch(r.stderr, /stale mnemonic secret/);
  });
});

test('missing MCP binary points to explicit dependency repair', () => {
  withData((data) => {
    rmSync(join(data, 'node_modules', '.bin', 'manifest-mcp-agent'));
    const r = runWrapper('agent', { data });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /MCP server binary not found/);
    assert.match(r.stderr, /setup-runtime\.cjs.*repair dependencies/);
  });
});

test('missing dependency with the MCP binary intact refuses startup until explicit repair', () => {
  withData((data) => {
    rmSync(join(data, 'node_modules', '@manifest-network', 'manifest-mcp-node', 'dependency.cjs'));
    assert.equal(existsSync(join(data, 'node_modules', '.bin', 'manifest-mcp-agent')), true);
    const r = runWrapper('agent', { data });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /MCP runtime dependencies are missing, incomplete, or out of date/);
    assert.match(r.stderr, /setup-runtime\.cjs.*repair dependencies/);
  });
});

test('malformed config diagnostic never repeats source text containing a password', () => {
  withData((data) => {
    writeFileSync(join(data, 'config.json'), '{"agent":{"keyPassword":"CONFIG_PASSWORD_SECRET"}, INVALID');
    const r = runWrapper('agent', { data });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Failed to parse .*config\.json/);
    assert.doesNotMatch(r.stderr, /CONFIG_PASSWORD_SECRET|INVALID/);
  });
});

test('child uses an empty private cwd and wrapper removes it after the child exits', () => {
  withData((data) => {
    writeFileSync(join(data, '.env'), 'COSMOS_MNEMONIC=must-not-load\n');
    const binary = join(data, 'node_modules', '.bin', 'manifest-mcp-agent');
    writeFileSync(binary, '#!/usr/bin/env bash\nprintf "FIXTURE_CWD=%s\\n" "$PWD"\ntest ! -e .env\n');
    stampRuntime(data);
    const r = runWrapper('agent', { data, cwd: data });
    assert.equal(r.status, 0, r.stderr);
    const got = parseEnvLines(r.stdout);
    assert.notEqual(got.FIXTURE_CWD, data);
    assert.equal(existsSync(got.FIXTURE_CWD), false, 'disposable cwd must be cleaned up');
    assert.equal(existsSync(join(data, '.env')), true, 'user files must be preserved');
  });
});

test('child failure and signal exit preserve status and remove the isolated cwd', () => {
  for (const [finish, expected] of [['exit 7', 7], ['kill -TERM $$', 143]]) {
    withData((data) => {
      const binary = join(data, 'node_modules', '.bin', 'manifest-mcp-agent');
      writeFileSync(binary, `#!/usr/bin/env bash\nprintf "FIXTURE_CWD=%s\\n" "$PWD"\n${finish}\n`);
      stampRuntime(data);
      const r = runWrapper('agent', { data });
      assert.equal(r.status, expected, r.stderr);
      assert.equal(existsSync(parseEnvLines(r.stdout).FIXTURE_CWD), false);
    });
  }
});

test('configured relative wallet path resolves within plugin data rather than the host workspace', () => {
  withData((data) => {
    const path = join(data, 'config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.agent.keyFile = 'fixture-wallet.json';
    writeFileSync(path, JSON.stringify(config));
    const r = runWrapper('agent', { data });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parseEnvLines(r.stdout).MANIFEST_KEY_FILE, join(data, 'fixture-wallet.json'));
  });
});
