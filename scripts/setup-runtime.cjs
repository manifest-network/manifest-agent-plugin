#!/usr/bin/env node
'use strict';

// Install or repair only the external dependency tree. Config, wallets,
// journals, manifests and the installed plugin directory are never rewritten.
const { mkdirSync, chmodSync, readFileSync, writeFileSync, openSync, closeSync,
  unlinkSync, statSync, rmSync, realpathSync, existsSync } = require('node:fs');
const { join, resolve, relative, dirname, basename, isAbsolute } = require('node:path');
const { spawn, fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./_io.cjs');
const { assertNodeVersion, COMPLETION_FILE, RUNTIME_PLATFORM, readRuntimeDefinition,
  verifyInstalledPackages, snapshotDependencies, inspectRuntime } = require('./_runtime.cjs');

const LOCK_FILE = '.runtime-setup.lock';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function acquireLock(dataDir, { timeoutMs = 300000, pollMs = 100 } = {}) {
  const path = join(dataDir, LOCK_FILE);
  const token = randomUUID();
  const started = Date.now();
  while (true) {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      closeSync(fd);
      const release = () => {
        try {
          if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
      release.recordChild = (childPid) => {
        if (JSON.parse(readFileSync(path, 'utf8')).token !== token) throw new Error('Runtime setup lost its installation lock.');
        atomicWrite(path, JSON.stringify({ pid: process.pid, token, childPid }));
      };
      return release;
    } catch (error) {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
      if (error.code !== 'EEXIST') throw error;
    }
    try {
      const before = statSync(path);
      let owner;
      try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch { /* interrupted initial write */ }
      const stale = owner ? !ownerAlive(owner.pid) && !ownerAlive(owner.childPid) : Date.now() - before.mtimeMs > 1000;
      if (stale) {
        const after = statSync(path);
        if (before.ino === after.ino && before.mtimeMs === after.mtimeMs) unlinkSync(path);
        continue;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() - started >= timeoutMs) {
      throw new Error('Timed out waiting for another runtime setup process. Retry after that process finishes.');
    }
    await sleep(pollMs);
  }
}

function runNpmCi(dataDir, logFile) {
  return new Promise((resolveInstall, reject) => {
    const logFd = openSync(logFile, 'w', 0o600);
    chmodSync(logFile, 0o600);
    const child = spawn('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: dataDir, stdio: ['ignore', logFd, logFd], env: process.env,
    });
    const forward = (signal) => child.kill(signal);
    const handlers = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => forward(signal)]));
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    let cleaned = false;
    const clean = () => {
      if (cleaned) return;
      cleaned = true;
      closeSync(logFd);
      for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    };
    child.once('error', (error) => { clean(); reject(new Error(`Could not run npm ci: ${error.message}. See ${logFile}`)); });
    child.once('close', (code, signal) => {
      // A spawn error emits close afterward; its cleanup has already run.
      if (child.pid === undefined) return;
      clean();
      if (code === 0) resolveInstall();
      else reject(new Error(`npm ci failed (${signal || `exit ${code}`}). See ${logFile}; rerun setup-runtime.cjs to retry.`));
    });
  });
}

// The worker must be recorded as a live lock owner BEFORE npm can mutate
// dependencies. If the setup parent is killed, the worker still waits for npm
// and competing setups wait for it; a worker disconnected before start exits.
function npmCi(dataDir, logFile, { recordChild } = {}) {
  return new Promise((resolveInstall, reject) => {
    const worker = fork(__filename, ['--install-worker'], {
      cwd: dataDir, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let reportedError;
    const handlers = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => worker.kill(signal)]));
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    const clean = () => {
      for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    };
    worker.on('message', (message) => { if (typeof message?.error === 'string') reportedError = message.error; });
    worker.once('error', (error) => { clean(); reject(new Error(`Could not start runtime installer: ${error.message}`)); });
    worker.once('close', (code, signal) => {
      clean();
      if (code === 0) resolveInstall();
      else reject(new Error(reportedError || `Runtime installer failed (${signal || `exit ${code}`}). See ${logFile}; rerun setup-runtime.cjs.`));
    });
    worker.once('spawn', () => {
      try {
        recordChild?.(worker.pid);
        worker.send({ start: true, dataDir, logFile });
      } catch (error) {
        worker.kill('SIGTERM');
        reject(error);
      }
    });
  });
}

function installWorker() {
  if (!process.connected) { process.exitCode = 1; return; }
  let started = false;
  process.once('disconnect', () => { if (!started) process.exit(1); });
  process.once('message', async (message) => {
    if (message?.start !== true || typeof message.dataDir !== 'string' || typeof message.logFile !== 'string') {
      process.exitCode = 1;
      if (process.connected) process.disconnect();
      return;
    }
    started = true;
    try { await runNpmCi(message.dataDir, message.logFile); }
    catch (error) {
      process.exitCode = 1;
      if (process.connected) process.send({ error: error.message });
    } finally {
      if (process.connected) process.disconnect();
    }
  });
}

async function setupRuntime({ dataDir, pluginRoot = resolve(__dirname, '..'), install = npmCi, lockOptions } = {}) {
  assertNodeVersion();
  if (!dataDir) throw new Error('MANIFEST_PLUGIN_DATA is not set. Set it to the persistent plugin data directory.');
  const target = resolve(dataDir);
  const source = realpathSync(pluginRoot);
  // Resolve existing parents before creating anything, including a symlinked
  // parent of a not-yet-created data directory.
  let ancestor = target;
  const suffix = [];
  while (!existsSync(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  const canonicalTarget = join(realpathSync(ancestor), ...suffix);
  const contains = (parent, child) => {
    const part = relative(parent, child);
    return part === '' || (part !== '..' && !part.startsWith(`..${require('node:path').sep}`) && !isAbsolute(part));
  };
  if (contains(source, canonicalTarget) || contains(canonicalTarget, source)) {
    throw new Error('Runtime data must be outside the installed plugin directory.');
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const definition = readRuntimeDefinition(source);
  const release = await acquireLock(target, lockOptions);
  try {
    if (inspectRuntime(target, source).ready) return { installed: false };
    rmSync(join(target, COMPLETION_FILE), { force: true });
    atomicWrite(join(target, 'package.json'), definition.packageText);
    atomicWrite(join(target, 'package-lock.json'), definition.lockText);
    const logFile = join(target, '.last-install.log');
    await install(target, logFile, { recordChild: release.recordChild });
    verifyInstalledPackages(target, definition);
    const files = snapshotDependencies(target);
    atomicWrite(join(target, COMPLETION_FILE), JSON.stringify({ schema: 1, fingerprint: definition.fingerprint, runtime: RUNTIME_PLATFORM, files }) + '\n');
    rmSync(logFile, { force: true });
    return { installed: true };
  } finally { release(); }
}

if (require.main === module) {
  if (process.argv[2] === '--install-worker' && typeof process.send === 'function') installWorker();
  else (async () => {
    if (process.argv.length !== 2) throw new Error('Usage: node setup-runtime.cjs');
    const result = await setupRuntime({ dataDir: process.env.MANIFEST_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA });
    console.error(`manifest-agent: runtime dependencies ${result.installed ? 'installed and verified' : 'ready'}.`);
  })().catch((error) => { console.error(`manifest-agent: ${error.message}`); process.exitCode = 1; });
}

module.exports = { setupRuntime, acquireLock, npmCi, LOCK_FILE };
