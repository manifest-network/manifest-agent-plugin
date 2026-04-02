#!/usr/bin/env node
'use strict';

/**
 * MCP server wrapper for the manifest-agent plugin.
 *
 * Reads ~/.manifest-agent/config.json, builds env vars, and spawns the
 * appropriate MCP server binary from ~/.manifest-agent/node_modules/.bin/.
 *
 * Usage: node start-server.cjs <chain|lease|fred|cosmwasm>
 */

const major = parseInt(process.versions.node, 10);
if (major < 18) {
  console.error(`Node 18+ required (found ${process.version}).`);
  process.exit(1);
}

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { spawn } = require('node:child_process');

const VALID_SERVERS = ['chain', 'lease', 'fred', 'cosmwasm'];
const AGENT_DIR = join(homedir(), '.manifest-agent');
const CONFIG_PATH = join(AGENT_DIR, 'config.json');

// --- Validate server name ---
const serverName = process.argv[2];
if (!VALID_SERVERS.includes(serverName)) {
  console.error(`Usage: node start-server.cjs <${VALID_SERVERS.join('|')}>`);
  process.exit(1);
}

// --- Signal handlers registered BEFORE spawn ---
let child;
function forwardSignal(signal) {
  child?.kill(signal);
  if (!child) {
    process.exit(128 + (signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 1));
  }
}
process.on('SIGTERM', () => forwardSignal('SIGTERM'));
process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGHUP', () => forwardSignal('SIGHUP'));

// --- Pre-flight: config.json ---
if (!existsSync(CONFIG_PATH)) {
  console.error(`Config not found at ${CONFIG_PATH}`);
  console.error('Run /manifest-agent:init-agent to set up.');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`Failed to parse ${CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

// --- Validate config fields ---
const { activeChain, gasPrice, gasMultiplier, chains, agent } = config;
if (!activeChain || !chains || !chains[activeChain]) {
  console.error(`Invalid config: missing activeChain or chains.${activeChain}`);
  process.exit(1);
}

if (!gasPrice) {
  console.error('Invalid config: missing gasPrice. Re-run /manifest-agent:init-agent.');
  process.exit(1);
}

const chain = chains[activeChain];
const missing = ['chainId', 'rpcUrl'].filter((k) => !chain[k]);
if (missing.length > 0) {
  console.error(`Invalid config: chains.${activeChain} missing fields: ${missing.join(', ')}`);
  process.exit(1);
}

// --- Pre-flight: binary ---
const binaryPath = join(AGENT_DIR, 'node_modules', '.bin', `manifest-mcp-${serverName}`);
if (!existsSync(binaryPath)) {
  console.error(`MCP server binary not found at ${binaryPath}`);
  console.error('Run /manifest-agent:init-agent to install dependencies.');
  process.exit(1);
}

// --- Build env (omit optional vars when falsy) ---
const env = {
  ...process.env,
  COSMOS_CHAIN_ID: chain.chainId,
  COSMOS_RPC_URL: chain.rpcUrl,
  COSMOS_GAS_PRICE: gasPrice,
};

if (chain.restUrl) env.COSMOS_REST_URL = chain.restUrl;
if (chain.converterAddress) env.MANIFEST_CONVERTER_ADDRESS = chain.converterAddress;
if (gasMultiplier) env.COSMOS_GAS_MULTIPLIER = String(gasMultiplier);
if (agent?.keyFile) env.MANIFEST_KEY_FILE = agent.keyFile;
if (agent?.keyPassword) env.MANIFEST_KEY_PASSWORD = agent.keyPassword;

// Log env key names (not values) for diagnostics
const envKeys = Object.keys(env).filter((k) => k.startsWith('COSMOS_') || k.startsWith('MANIFEST_'));
console.error(`Starting manifest-mcp-${serverName} with env: ${envKeys.join(', ')}`);

// --- Spawn ---
child = spawn(binaryPath, [], { stdio: 'inherit', env });

child.on('error', (err) => {
  console.error(`Failed to start manifest-mcp-${serverName}: ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (signal) {
    // Re-raise the signal for proper Unix exit semantics
    process.kill(process.pid, signal);
  }
  process.exit(code ?? 1);
});
