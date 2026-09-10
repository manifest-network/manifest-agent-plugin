'use strict';

// Shared, dependency-free runtime checks. This file is not a CLI.
const { createHash } = require('node:crypto');
const { readFileSync, lstatSync, readdirSync, readlinkSync, statSync, accessSync, constants } = require('node:fs');
const { join, posix } = require('node:path');

const MIN_NODE_VERSION = '22.19.0';
const COMPLETION_FILE = '.runtime-install.json';
const LOCK_FILE = '.runtime-setup.lock';
// The locked runtime is JavaScript-only and install scripts are disabled.
// Supported Node majors share it; revisit this if native addons are introduced.
const RUNTIME_PLATFORM = `${process.platform}/${process.arch}`;

function parseProcessStartTime(stat) {
  // comm (field 2) may itself contain spaces or parentheses. Fields after
  // its closing parenthesis begin with state (3), so starttime (22) is 19.
  const end = stat.lastIndexOf(')');
  if (end < 0) return undefined;
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  return /^\d+$/.test(fields[19] || '') ? fields[19] : undefined;
}

function processStartTime(pid) {
  if (process.platform !== 'linux') return undefined;
  try { return parseProcessStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch { return undefined; }
}

function ownerAlive(pid, expectedStartTime) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') return true;
  }
  const currentStartTime = processStartTime(pid);
  // Unknown identity (including pre-upgrade locks) is conservative: an
  // existing process may be an installer. Never evict it merely by age.
  return !currentStartTime || typeof expectedStartTime !== 'string' ||
    !/^\d+$/.test(expectedStartTime) || currentStartTime === expectedStartTime;
}


// Shared read-only lock observation. Only setup may reclaim an inactive lock.
// Allow a creator one second to write its owner record after exclusive open.
function readSetupLock(dataDir, { now = Date.now } = {}) {
  const path = join(dataDir, LOCK_FILE);
  let stat;
  try { stat = statSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let owner;
  try { owner = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    // A read failure does not establish a live owner. Let callers report its
    // filesystem code instead of waiting on an installer we cannot identify.
    if (!(error instanceof SyntaxError)) throw error;
    return { active: now() - stat.mtimeMs <= 1000, stat };
  }
  return { active: owner ? ownerAlive(owner.pid, owner.pidStartTime) ||
    ownerAlive(owner.childPid, owner.childStartTime) : now() - stat.mtimeMs <= 1000, stat };
}

function assertNodeVersion(version = process.versions.node) {
  if (/^\d+\.\d+\.\d+-/.test(version)) {
    throw new Error(`Prerelease Node builds are not supported (found ${version}). Install a stable Node ${MIN_NODE_VERSION}+ release.`);
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unrecognized Node version string: ${version}. Install a stable Node ${MIN_NODE_VERSION}+ release.`);
  const parts = match && match.slice(1).map(Number);
  if (!parts || parts[0] < 22 || (parts[0] === 22 && parts[1] < 19)) {
    throw new Error(`Node ${MIN_NODE_VERSION}+ required (found ${version}). Install a supported Node version and restart Claude Code.`);
  }
}

function readRuntimeDefinition(pluginRoot) {
  const packageText = readFileSync(join(pluginRoot, 'package.json'), 'utf8');
  const lockText = readFileSync(join(pluginRoot, 'package-lock.json'), 'utf8');
  const pkg = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  if (lock.lockfileVersion !== 3 || !lock.packages?.[''] || !pkg.dependencies) {
    throw new Error('Plugin package.json and package-lock.json must contain a locked runtime dependency set.');
  }
  const fingerprint = createHash('sha256').update(packageText).update('\0').update(lockText).digest('hex');
  return { packageText, lockText, pkg, lock, fingerprint };
}

function safeDependencyPath(relative) {
  return typeof relative === 'string' && relative.startsWith('node_modules/') &&
    !relative.includes('\\') && posix.normalize(relative) === relative && !relative.split('/').includes('..');
}

function verifyInstalledPackages(dataDir, definition) {
  for (const [relative, metadata] of Object.entries(definition.lock.packages)) {
    if (!relative || metadata.dev) continue;
    if (!safeDependencyPath(relative)) throw new Error('Unsupported path in runtime package lock.');
    let installed;
    try { installed = JSON.parse(readFileSync(join(dataDir, relative, 'package.json'), 'utf8')); }
    catch (error) {
      if (metadata.optional && error.code === 'ENOENT') continue;
      throw new Error(`Missing or invalid installed dependency: ${relative}`);
    }
    if (installed.version !== metadata.version) throw new Error(`Installed dependency version differs from lock: ${relative}`);
  }
  const mcp = definition.pkg.dependencies['@manifest-network/manifest-mcp-node'];
  if (mcp) {
    for (const server of ['chain', 'lease', 'fred', 'cosmwasm', 'agent']) {
      const binary = join(dataDir, 'node_modules', '.bin', `manifest-mcp-${server}`);
      if (!statSync(binary).isFile()) throw new Error(`Invalid MCP binary: manifest-mcp-${server}`);
      accessSync(binary, constants.X_OK);
    }
  }
}

function snapshotDependencies(dataDir) {
  const files = [];
  function visit(relative) {
    const absolute = join(dataDir, relative);
    const stat = lstatSync(absolute);
    if (stat.isFile() && relative.endsWith('.node')) throw new Error(`Native addon requires Node-specific runtime support: ${relative}`);
    if (stat.isSymbolicLink()) files.push([relative, 'link', readlinkSync(absolute)]);
    else if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) files.push([relative, 'file', stat.size]);
    else throw new Error(`Unexpected dependency file type: ${relative}`);
  }
  visit('node_modules');
  if (files.length === 0) throw new Error('The installed runtime dependency tree is empty.');
  return files;
}

function inspectRuntime(dataDir, pluginRoot) {
  const definition = readRuntimeDefinition(pluginRoot);
  try {
    if (readFileSync(join(dataDir, 'package.json'), 'utf8') !== definition.packageText ||
        readFileSync(join(dataDir, 'package-lock.json'), 'utf8') !== definition.lockText) {
      throw new Error('The runtime dependency definition changed.');
    }
    const completion = JSON.parse(readFileSync(join(dataDir, COMPLETION_FILE), 'utf8'));
    const compatiblePlatform = completion?.runtime === RUNTIME_PLATFORM ||
      (typeof completion?.runtime === 'string' && completion.runtime.startsWith(`${RUNTIME_PLATFORM}/node-`) &&
       /^\d+$/.test(completion.runtime.slice(`${RUNTIME_PLATFORM}/node-`.length)));
    if (!completion || typeof completion !== 'object' || Array.isArray(completion)) {
      throw new Error('The runtime completion record must be a JSON object.');
    }
    if (completion.schema !== 1) throw new Error('The runtime completion record uses an unsupported schema.');
    if (completion.fingerprint !== definition.fingerprint) {
      throw new Error('The runtime completion fingerprint differs from the plugin package/lock.');
    }
    if (!compatiblePlatform) throw new Error(`The runtime completion record belongs to a different or invalid platform; expected ${RUNTIME_PLATFORM}.`);
    if (!Array.isArray(completion.files) || !completion.files.length) {
      throw new Error('The runtime completion record has no valid dependency file inventory.');
    }
    verifyInstalledPackages(dataDir, definition);
    for (const entry of completion.files) {
      if (!Array.isArray(entry) || entry.length !== 3 || !safeDependencyPath(entry[0])) {
        throw new Error('The runtime completion record is invalid.');
      }
      const [relative, type, expected] = entry;
      const absolute = join(dataDir, relative);
      const stat = lstatSync(absolute);
      if (stat.isFile() && relative.endsWith('.node')) throw new Error(`Native addon requires Node-specific runtime support: ${relative}`);
      if (type === 'file' ? !stat.isFile() || stat.size !== expected :
          type === 'link' ? !stat.isSymbolicLink() || readlinkSync(absolute) !== expected : true) {
        throw new Error(`The installed runtime is incomplete: ${relative}`);
      }
    }
    return { ready: true, fingerprint: definition.fingerprint };
  } catch (error) {
    return { ready: false, reason: error.message, fingerprint: definition.fingerprint };
  }
}

// Claude starts MCP servers concurrently with SessionStart. Give setup time to
// acquire its lock, then wait for verified completion without installing here.
// Stay below Claude's default 30s MCP initialization timeout, leaving room for
// wallet loading/handshake. Neither observed lock changes nor retries extend it.
async function waitForRuntime(dataDir, pluginRoot, {
  graceMs = 2000, timeoutMs = 25000, pollMs = 100, onWaiting = () => {},
  now = () => performance.now(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  const started = now();
  let sawSetup = false;
  let notified = false;
  while (true) {
    const active = readSetupLock(dataDir)?.active === true;
    const runtime = inspectRuntime(dataDir, pluginRoot);
    if (runtime.ready && !active) return runtime;
    sawSetup ||= active;
    const elapsed = now() - started;
    if (!active && (sawSetup || elapsed >= graceMs)) return runtime;
    if (elapsed >= timeoutMs) return {
      ...runtime, ready: false,
      reason: `Timed out waiting for runtime setup (${join(dataDir, LOCK_FILE)}). ${runtime.reason || 'An installer is still active.'}`,
    };
    if (!notified) { onWaiting(); notified = true; }
    await sleep(Math.min(pollMs, timeoutMs - elapsed));
  }
}

module.exports = {
  parseProcessStartTime, processStartTime, ownerAlive, readSetupLock,
  MIN_NODE_VERSION, COMPLETION_FILE, LOCK_FILE, RUNTIME_PLATFORM, waitForRuntime, assertNodeVersion, readRuntimeDefinition,
  verifyInstalledPackages, snapshotDependencies, inspectRuntime,
};
