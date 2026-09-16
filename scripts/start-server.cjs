#!/usr/bin/env node
'use strict';

/**
 * MCP server wrapper for the manifest-agent plugin.
 *
 * Reads $MANIFEST_PLUGIN_DATA/config.json, builds env vars, and spawns the
 * appropriate MCP server binary from $MANIFEST_PLUGIN_DATA/node_modules/.bin/.
 *
 * Usage: node start-server.cjs <chain|lease|fred|cosmwasm|agent>
 */

const { assertNodeVersion, waitForRuntime, LOCK_FILE } = require('./_runtime.cjs');
try {
  assertNodeVersion();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir, constants: { signals, errno } } = require('node:os');
const { spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { getDataDir } = require('./_io.cjs');
const { migrateConfig, resolvePassword, CredentialError } = require('./_credentials.cjs');

const skillCommand = (name) => `${process.env.MANIFEST_PLUGIN_HOST === 'codex' ? '$' : '/'}manifest-agent:${name}`;
const VALID_SERVERS = ['chain', 'lease', 'fred', 'cosmwasm', 'agent'];
let AGENT_DIR;
try {
  AGENT_DIR = resolve(getDataDir());
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const CONFIG_PATH = join(AGENT_DIR, 'config.json');

// --- Validate server name ---
const serverName = process.argv[2];
if (!VALID_SERVERS.includes(serverName)) {
  console.error(`Usage: node start-server.cjs <${VALID_SERVERS.join('|')}>`);
  process.exit(1);
}

// --- Signal handlers registered BEFORE spawn ---
// Track child state explicitly. The `child` reference stays truthy after
// the child exits, so a second signal arriving post-exit must NOT try to
// kill an already-dead process and must fall through to process.exit
// rather than relying on Node's empty-event-loop heuristic.
let child;
let childExited = false;
function forwardSignal(signal) {
  if (child && !childExited) {
    child.kill(signal);
    return;
  }
  // Either child never spawned, or it has already exited. Translate the
  // signal to a Unix exit code and terminate.
  process.exit(128 + (signals[signal] || 1));
}
process.on('SIGTERM', () => forwardSignal('SIGTERM'));
process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGHUP', () => forwardSignal('SIGHUP'));

// Error messages/stacks may contain config values. Only known diagnostic codes
// and phase labels defined by this launcher may accompany an unexpected error.
const SAFE_ERROR_CODES = new Set([
  ...Object.keys(errno), 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE',
]);
let startupPhase = 'initializing the launcher';

async function startServer() {
  startupPhase = 'reading config.json';
  // --- Pre-flight: config.json ---
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found at ${CONFIG_PATH}`);
    console.error(`Run ${skillCommand('init-agent')} to set up.`);
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    // Filesystem failures need their reading phase and safe errno diagnostic.
    if (!(error instanceof SyntaxError)) throw error;
    // JSON parser messages can include the invalid source text, including a
    // wallet password. Report only the file to repair.
    console.error(`Failed to parse ${CONFIG_PATH}. Repair the JSON or re-run ${skillCommand('init-agent')}.`);
    process.exit(1);
  }

  // --- Validate config fields ---
  startupPhase = 'validating config.json';
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    console.error(`Invalid config: config.json must contain a JSON object. Re-run ${skillCommand('init-agent')}.`);
    process.exit(1);
  }
  const { activeChain, gasPrice, gasMultiplier, chains, agent } = config;
  if (!activeChain || !chains || !chains[activeChain]) {
    console.error(`Invalid config: missing activeChain or chains.${activeChain}`);
    process.exit(1);
  }

  if (!gasPrice) {
    console.error(`Invalid config: missing gasPrice. Re-run ${skillCommand('init-agent')}.`);
    process.exit(1);
  }

  const chain = chains[activeChain];
  const missing = ['chainId', 'rpcUrl'].filter((k) => !chain[k]);
  if (missing.length > 0) {
    console.error(`Invalid config: chains.${activeChain} missing fields: ${missing.join(', ')}`);
    process.exit(1);
  }

  // The plugin owns wallet selection. Never fall back to an unrelated shell
  // mnemonic or the upstream binary's default ~/.manifest/key.json wallet.
  if (typeof agent?.keyFile !== 'string' || !agent.keyFile.trim()
    || (typeof agent.keyPassword !== 'string' && !agent.keyPasswordRef)) {
    console.error(`Invalid config: agent.keyFile and agent.keyPasswordRef (or legacy agent.keyPassword) are required. Re-run ${skillCommand('init-agent')}.`);
    process.exit(1);
  }
  const keyFile = resolve(AGENT_DIR, agent.keyFile);
  if (!existsSync(keyFile)) {
    console.error(`Configured wallet file not found at ${keyFile}`);
    console.error(`Run ${skillCommand('import-key')} to restore the configured wallet.`);
    process.exit(1);
  }

  startupPhase = 'resolving wallet credentials';
  // All hosts share this path, including Codex without a SessionStart hook.
  const migrated = migrateConfig(AGENT_DIR);
  // A concurrent wallet/config change requires a reconnect; never combine
  // one wallet's file/chain snapshot with another wallet's password.
  const { keyPassword: legacyPassword, keyPasswordRef: oldRef, ...oldAgent } = agent;
  const { keyPassword: migratedLegacy, keyPasswordRef: newRef, ...newAgent } = migrated?.agent ?? {};
  const { agent: oldIdentity, credentialMigration: oldMigration, ...oldConfig } = config;
  const { agent: newIdentity, credentialMigration: newMigration, ...newConfig } = migrated ?? {};
  if (!isDeepStrictEqual(oldAgent, newAgent) || !isDeepStrictEqual(oldConfig, newConfig)
    || (oldRef && !isDeepStrictEqual(oldRef, newRef))) {
    console.error('Manifest configuration changed during startup. Reconnect the MCP server.');
    process.exit(1);
  }
  const keyPassword = resolvePassword(migrated, AGENT_DIR);

  // --- Pre-flight: runtime setup may still be starting in SessionStart ---
  startupPhase = 'checking runtime dependencies';
  const binaryPath = join(AGENT_DIR, 'node_modules', '.bin', `manifest-mcp-${serverName}`);
  const runtime = await waitForRuntime(AGENT_DIR, resolve(__dirname, '..'), {
    onWaiting: () => console.error('Waiting for Manifest runtime setup to complete...'),
  });
  if (!runtime.ready) {
    console.error(`MCP runtime dependencies are missing, incomplete, or out of date: ${runtime.reason}`);
    console.error('Run node "$MANIFEST_PLUGIN_ROOT/scripts/setup-runtime.cjs" to repair dependencies, then reconnect the MCP servers.');
    process.exit(1);
  }

  // --- Build env from the selected config, including deliberately absent fields ---
  startupPhase = 'building the MCP environment';
  // Deleting first prevents stale testnet endpoints, gas settings, or a different
  // wallet from surviving when the selected config omits an optional field.
  const env = { ...process.env };
  for (const key of [
    'COSMOS_CHAIN_ID', 'COSMOS_RPC_URL', 'COSMOS_REST_URL',
    'COSMOS_GAS_PRICE', 'COSMOS_GAS_MULTIPLIER', 'COSMOS_MNEMONIC',
    'COSMOS_ADDRESS_PREFIX', 'MANIFEST_CONVERTER_ADDRESS', 'MANIFEST_FAUCET_URL',
    'MANIFEST_KEY_FILE', 'MANIFEST_KEY_PASSWORD',
    'MANIFEST_AGENT_DATA_DIR', 'MANIFEST_CHAIN_DATA_FILE',
  ]) delete env[key];
  Object.assign(env, {
    COSMOS_CHAIN_ID: chain.chainId,
    COSMOS_RPC_URL: chain.rpcUrl,
    COSMOS_GAS_PRICE: gasPrice,
    COSMOS_ADDRESS_PREFIX: 'manifest',
    MANIFEST_KEY_FILE: keyFile,
    // Preserve the configured bytes, including empty strings. Upstream decides
    // which passwords its wallet formats support; never substitute shell input.
    MANIFEST_KEY_PASSWORD: keyPassword,
    // dotenv 17 logs to stdout by default, which corrupts MCP JSON-RPC framing.
    DOTENV_CONFIG_QUIET: 'true',
  });

  if (chain.restUrl) env.COSMOS_REST_URL = chain.restUrl;
  if (chain.converterAddress) env.MANIFEST_CONVERTER_ADDRESS = chain.converterAddress;
  if (chain.faucetUrl) env.MANIFEST_FAUCET_URL = chain.faucetUrl;
  if (gasMultiplier) env.COSMOS_GAS_MULTIPLIER = String(gasMultiplier);

  // --- Agent server: ENG-204 env contract ---
  // MANIFEST_AGENT_DATA_DIR: agent-core's saveManifest() writes to
  //   <dataDir>/manifests/<lease_uuid>.json. Setting it to AGENT_DIR makes
  //   agent-core write to the same $MANIFEST_PLUGIN_DATA/manifests/ tree
  //   the plugin's existing helpers (list-saved-manifests.cjs, etc.) read
  //   from — keeping v2/v3 wrappers cross-readable.
  // MANIFEST_CHAIN_DATA_FILE: denom-map humanization (the agent server's
  //   replacement for the old --chain-data-file flag the deleted renderers
  //   used). Points at the active chain's registry JSON.
  // MANIFEST_AGENT_FETCH_GUARDED: SSRF-guarded fetch toggle. The agent
  //   server defaults this to ON; we only forward it when the operator
  //   has explicitly set it in the parent shell, letting the package's
  //   default stand otherwise.
  // Config-owned agent paths were stripped above. FETCH_GUARDED is an operator
  // override retained only for the agent server; clear it for the other four.
  if (serverName === 'agent') {
    env.MANIFEST_AGENT_DATA_DIR = AGENT_DIR;
    env.MANIFEST_CHAIN_DATA_FILE = join(AGENT_DIR, 'chains', `${activeChain}.json`);
    if (process.env.MANIFEST_AGENT_FETCH_GUARDED !== undefined) {
      env.MANIFEST_AGENT_FETCH_GUARDED = process.env.MANIFEST_AGENT_FETCH_GUARDED;
    }
  } else {
    delete env.MANIFEST_AGENT_FETCH_GUARDED;
  }

  // Warn loudly when a testnet config pre-dates the faucetUrl field — otherwise
  // `request_faucet` silently fails to register and the user has no signal why.
  if (serverName === 'chain' && activeChain === 'testnet' && !chain.faucetUrl) {
    console.error(
      'Warning: testnet config has no faucetUrl — the request_faucet tool will not be available. ' +
      `Run ${skillCommand('refresh-registry')} to pick up the latest chain data.`
    );
  }

  // Log env key names (not values) for diagnostics. Filter out KEY_PASSWORD
  // even though only the name appears — a paste of an MCP startup banner
  // in a bug report shouldn't include the literal name "MANIFEST_KEY_PASSWORD"
  // alongside other context that might tip an attacker that the wallet is hot.
  const envKeys = Object.keys(env)
    .filter((k) => k.startsWith('COSMOS_') || k.startsWith('MANIFEST_'))
    .filter((k) => k !== 'MANIFEST_KEY_PASSWORD');
  console.error(`Starting manifest-mcp-${serverName} with env: ${envKeys.join(', ')}`);

  // --- Spawn ---
  // Upstream loads dotenv.config() from cwd. Use an empty private working
  // directory so a workspace or data-directory .env cannot restore fields that
  // this wrapper deliberately omitted. Absolute paths keep runtime files in the
  // plugin data directory; only this disposable cwd is removed at exit.
  // SIGKILL cannot run cleanup and may leave an empty 0700 directory for the OS
  // temp cleaner. Do not sweep other sessions' directories from this process.
  startupPhase = 'creating the MCP working directory';
  const serverCwd = mkdtempSync(join(tmpdir(), 'manifest-mcp-cwd-'));
  process.on('exit', () => rmSync(serverCwd, { recursive: true, force: true }));
  startupPhase = `launching manifest-mcp-${serverName}`;
  child = spawn(binaryPath, [], { stdio: 'inherit', env, cwd: serverCwd });

  child.on('error', (err) => {
    // Mark exited before exiting: a SIGINT/SIGTERM landing during this window
    // would otherwise drive forwardSignal() into child.kill() against a child
    // that never started (ESRCH) and crash the wrapper with an unhandled throw.
    childExited = true;
    console.error(`Failed to start manifest-mcp-${serverName}: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    childExited = true;
    if (signal) {
      // Report the conventional shell status directly. Re-signalling this
      // process can leave signal delivery queued behind an empty event loop,
      // which would incorrectly report success before the handler executes.
      forwardSignal(signal);
      return;
    }
    process.exit(code ?? 1);
  });

}

startServer().catch((error) => {
  if (startupPhase === 'resolving wallet credentials' && error instanceof CredentialError) {
    console.error(`Manifest MCP startup failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  // Inspect an own data property rather than invoking an arbitrary getter.
  const code = error && typeof error === 'object'
    ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  const detail = SAFE_ERROR_CODES.has(code) ? ` (${code})` : '';
  let guidance = 'Check config.json and runtime setup';
  if (startupPhase === 'checking runtime dependencies') {
    guidance = `Check runtime data at ${AGENT_DIR}, including ${LOCK_FILE}, and the plugin package.json/package-lock.json`;
  } else if (startupPhase === 'creating the MCP working directory') {
    guidance = 'Check the system temporary directory';
  } else if (startupPhase === 'resolving wallet credentials') {
    guidance = 'Unlock the OS keychain and check credential setup; headless installs can explicitly select MANIFEST_CREDENTIAL_STORE=file for legacy migration. See docs/identity.md';
  }
  console.error(`Manifest MCP startup failed while ${startupPhase}${detail}. ${guidance}, then reconnect the server.`);
  process.exitCode = 1;
});
