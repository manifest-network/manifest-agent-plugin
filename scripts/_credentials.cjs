'use strict';

// Native helpers receive secrets through private pipes, never process arguments.
// References are portable metadata; existing references always select their own
// backend, regardless of an operator's preference for future credential writes.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { atomicWrite } = require('./_io.cjs');
const { ownerAlive, processStartTime } = require('./_runtime.cjs');

const SERVICE = 'org.manifest-network.manifest-agent';
const BACKENDS = new Set(['libsecret', 'keychain', 'wincred', 'file']);
const REF_ID = /^[a-f0-9]{24}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LOCK_NAME = '.config.lock';
const RECLAIM_NAME = '.config.lock.reclaim';
const MIGRATION_FAILURE_NAME = '.credential-migration-failure.json';
const MIGRATION_RETRY_MS = 30000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

class CredentialError extends Error {
  constructor(message) { super(message); this.name = 'CredentialError'; }
}

function credentialError(backend, operation) {
  const help = backend === 'file'
    ? 'Check the private credentials directory and restore the credential backup if needed.'
    : 'Unlock the OS credential store and retry. On headless systems, explicitly choose MANIFEST_CREDENTIAL_STORE=file for new credentials or legacy migration; existing references still require their original store.';
  const error = new CredentialError(`Credential ${operation} failed (${backend}). ${help}`);
  // Only failures from an actual store operation may suppress automatic
  // retries. Validation and platform errors must retain their own guidance.
  Object.defineProperty(error, 'storeAccess', { value: true });
  return error;
}

function selectBackend(options) {
  const selected = (options.env || process.env).MANIFEST_CREDENTIAL_STORE;
  if (selected && selected !== 'auto' && selected !== 'file') {
    throw new CredentialError('MANIFEST_CREDENTIAL_STORE must be auto or file.');
  }
  if (selected === 'file') return 'file';
  const backend = { linux: 'libsecret', darwin: 'keychain', win32: 'wincred' }[options.platform || process.platform];
  if (!backend) throw new CredentialError('No native credential store for this platform. Explicitly choose MANIFEST_CREDENTIAL_STORE=file to use private local storage.');
  return backend;
}

function validateRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !BACKENDS.has(ref.backend) || typeof ref.id !== 'string' || !REF_ID.test(ref.id)) {
    throw new CredentialError('Invalid agent.keyPasswordRef in config.json. Restore a valid credential reference.');
  }
  return ref;
}

function run(command, args, input, backend, options) {
  let result;
  try {
    result = (options.spawnSync || spawnSync)(command, args, {
      input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      timeout: options.commandTimeoutMs ?? 15000, maxBuffer: 65536,
      env: options.env || process.env,
    });
  } catch { throw credentialError(backend, 'access'); }
  // Never attach an underlying exception, argv, stdout, or stderr to an error.
  if (!result || result.error || result.status !== 0 || result.signal) throw credentialError(backend, 'access');
  return typeof result.stdout === 'string' ? result.stdout : '';
}

function windowsCommand(request, options) {
  const systemRoot = (options.env || process.env).SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '_wincred.ps1')],
    JSON.stringify(request), request.operation.startsWith('protect-') ? 'file' : 'wincred', options);
}

function nativeCommand(ref, operation, payload, options) {
  const { backend, id } = ref;
  const actualPlatform = options.platform || process.platform;
  if ({ libsecret: 'linux', keychain: 'darwin', wincred: 'win32' }[backend] !== actualPlatform) {
    throw new CredentialError('The credential reference belongs to a different operating system. Restore access on the original system before migrating this wallet.');
  }
  if (backend === 'libsecret') {
    const attrs = ['service', SERVICE, 'account', id];
    return operation === 'store'
      ? run('secret-tool', ['store', '--label=Manifest agent wallet', ...attrs], payload, backend, options)
      : run('secret-tool', ['lookup', ...attrs], undefined, backend, options);
  }
  if (backend === 'keychain') {
    if (operation === 'store') {
      // Apple's security interactive parser is bounded to 4096 bytes. Base64
      // keeps arbitrary passwords, including newlines/empty strings, one token.
      // https://github.com/apple-oss-distributions/SecurityTool/blob/main/security.c
      const input = `add-generic-password -a ${id} -s ${SERVICE} -w ${payload}\n`;
      if (Buffer.byteLength(input) >= 4096) throw new CredentialError('Password is too long for the macOS credential helper.');
      return run('/usr/bin/security', ['-i', '-q'], input, backend, options);
    }
    return run('/usr/bin/security', ['find-generic-password', '-a', id, '-s', SERVICE, '-w'], undefined, backend, options);
  }
  return windowsCommand({ operation, target: `${SERVICE}/${id}`, payload }, options);
}

function privateDirectory(dataDir, options) {
  const dir = path.join(dataDir, 'credentials');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw credentialError('file', 'access');
  fs.chmodSync(dir, 0o700);
  // chmod does not implement owner-only Windows ACLs. Protect inherited access
  // before any fallback secret is created in this directory.
  if ((options.platform || process.platform) === 'win32') windowsCommand({ operation: 'protect-directory', target: path.resolve(dir) }, options);
  return dir;
}

function readStored(ref, dataDir, options) {
  try {
    if (ref.backend === 'file') {
      const dir = path.join(dataDir, 'credentials');
      if (!fs.lstatSync(dir).isDirectory()) throw credentialError('file', 'read');
      const target = path.join(dir, `${ref.id}.json`);
      const stat = fs.lstatSync(target);
      // Mode bits belong to the real OS; the injected platform only selects
      // helper commands so Windows ACL contracts can also be tested on POSIX.
      if (!stat.isFile() || (process.platform !== 'win32' && ((stat.mode & 0o077) || (fs.statSync(dir).mode & 0o077)))) {
        throw credentialError('file', 'read');
      }
      if ((options.platform || process.platform) === 'win32') windowsCommand({ operation: 'protect-file', target: path.resolve(target) }, options);
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (value.version !== 1 || typeof value.password !== 'string') throw credentialError('file', 'read');
      return value.password;
    }
    const encoded = nativeCommand(ref, 'read', undefined, options).trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw credentialError(ref.backend, 'read');
    const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (value.version !== 1 || typeof value.password !== 'string') throw credentialError(ref.backend, 'read');
    return value.password;
  } catch (err) {
    if (err instanceof CredentialError) throw err;
    throw credentialError(ref.backend, 'read');
  }
}

function storePassword(dataDir, keyFile, password, options = {}) {
  if (typeof password !== 'string') throw new CredentialError('Wallet password must be a string.');
  if (typeof keyFile !== 'string' || !keyFile) throw new CredentialError('Wallet keyFile is required for credential storage.');
  const backend = selectBackend(options);
  const namespace = createHash('sha256').update(path.resolve(dataDir)).update('\0').update(path.resolve(dataDir, keyFile)).digest('hex').slice(0, 24);
  const ref = { backend, id: `${namespace}-${randomUUID()}` };
  const serialized = JSON.stringify({ version: 1, password });
  try {
    if (backend === 'file') {
      const dir = privateDirectory(dataDir, options);
      atomicWrite(path.join(dir, `${ref.id}.json`), serialized + '\n');
    } else {
      const payload = Buffer.from(serialized).toString('base64');
      if (backend === 'libsecret' && Buffer.byteLength(payload) >= 8192) throw new CredentialError('Password is too long for the Linux credential helper.');
      if (backend === 'wincred' && Buffer.byteLength(payload) > 2560) throw new CredentialError('Password is too long for Windows Credential Manager.');
      nativeCommand(ref, 'store', payload, options);
    }
    if (readStored(ref, dataDir, options) !== password) throw credentialError(backend, 'verification');
    return ref;
  } catch (err) {
    // A failed transaction can leave an unused, private entry. Never delete or
    // overwrite the last usable credential as part of creating its replacement.
    if (err instanceof CredentialError) throw err;
    throw credentialError(backend, 'write');
  }
}

function resolvePassword(config, dataDir, options = {}) {
  const ref = validateRef(config?.agent?.keyPasswordRef);
  return readStored(ref, dataDir, options);
}

function readConfig(dataDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new CredentialError('Unable to read config.json. Check the data directory permissions.');
  }
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    return config;
  } catch { throw new CredentialError('Invalid config.json: expected a JSON object.'); }
}

function sameLock(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.mtimeMs === second.mtimeMs;
}

function releaseLock(lockPath, owner, ownedStat) {
  if (!ownedStat) return;
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current.token === owner.token && sameLock(ownedStat, fs.lstatSync(lockPath))) fs.unlinkSync(lockPath);
  } catch { /* Never remove another owner or replace the operation's outcome. */ }
}

function withReclaimGuard(guardPath, callback) {
  const owner = { pid: process.pid, pidStartTime: processStartTime(process.pid), token: randomUUID() };
  let fd, ownedStat;
  try { fd = fs.openSync(guardPath, 'wx', 0o600); }
  catch (err) { if (err.code === 'EEXIST') return false; throw err; }
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(owner));
      ownedStat = fs.fstatSync(fd);
    } catch (err) {
      try { if (sameLock(fs.fstatSync(fd), fs.lstatSync(guardPath))) fs.unlinkSync(guardPath); }
      catch { /* Preserve the write error. */ }
      throw err;
    } finally { fs.closeSync(fd); }
    callback();
    return true;
  } finally { releaseLock(guardPath, owner, ownedStat); }
}

// Called only while holding the separate reclaim guard. A stat/unlink pair
// alone is not atomic: two reapers could otherwise unlink a live successor.
// Always reread owner and metadata after acquiring that guard.
function reclaimLock(lockPath, legacyPid) {
  let before, owner;
  try {
    before = fs.lstatSync(lockPath);
    if (!before.isFile()) return;
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
    catch (err) { if (!(err instanceof SyntaxError)) throw err; }
    // Legacy filenames also identify their owner, including damaged records.
    const pid = legacyPid || owner?.pid;
    const pidStartTime = owner?.pid === pid ? owner?.pidStartTime : undefined;
    // Exclusive open precedes the owner write; allow a creator to publish it.
    if (pid ? ownerAlive(pid, pidStartTime) : Date.now() - before.mtimeMs <= 1000) return;
    if (sameLock(before, fs.lstatSync(lockPath))) fs.unlinkSync(lockPath);
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

function retireLegacyLockDirectory(lockPath) {
  // Older versions used a directory of bakery records. Never recursively
  // remove it: live/unknown records must continue to block the upgrade. An
  // atomic rmdir succeeds only if no old contender has published a record.
  for (const name of fs.readdirSync(lockPath)) {
    const match = /^([1-9][0-9]*)-[a-f0-9-]{36}\.json$/.exec(name);
    if (!match) continue;
    reclaimLock(path.join(lockPath, name), Number(match[1]));
  }
  try { fs.rmdirSync(lockPath); }
  catch (err) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(err.code)) throw err; }
}

// An exclusive file create supplies mutual exclusion without relying on a
// directory listing (which can omit concurrently replaced records on btrfs).
// Lock records contain process identity and an ownership token, never secrets.
function withConfigLock(dataDir, callback, options = {}) {
  const lockPath = path.join(dataDir, LOCK_NAME);
  const guardPath = path.join(dataDir, RECLAIM_NAME);
  // Leave room for the launcher handshake within the host's 30-second limit.
  const deadline = performance.now() + (options.lockTimeoutMs ?? 20000);
  const owner = { pid: process.pid, pidStartTime: processStartTime(process.pid), token: randomUUID() };
  let ownedStat;
  function wait() {
    if (performance.now() >= deadline) {
      // Diagnose the state now, not whichever transient guard the last poll
      // encountered. Observation never removes a guard, even for a dead PID.
      let abandonedGuard = false;
      let unreadableGuard = false;
      try {
        const guardOwner = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
        abandonedGuard = !ownerAlive(guardOwner?.pid, guardOwner?.pidStartTime);
      } catch (err) {
        if (err instanceof SyntaxError) {
          // Exclusive open precedes the owner write. A recent empty/partial
          // record can belong to a live publisher, just like the main lock.
          try { abandonedGuard = Date.now() - fs.lstatSync(guardPath).mtimeMs > 1000; }
          catch (statError) { unreadableGuard = statError.code !== 'ENOENT'; }
        } else unreadableGuard = err.code !== 'ENOENT';
      }
      if (unreadableGuard) throw new CredentialError(`Timed out waiting for configuration lock recovery (${guardPath}). Unable to read its owner record. Check this path and its permissions before retrying; do not remove it while configuration processes are active.`);
      if (abandonedGuard) throw new CredentialError(`Timed out waiting for configuration lock recovery (${guardPath}). If a recovery process crashed, stop all configuration writers and MCP launchers, verify none are running, then remove only this recovery guard and reconnect. Never remove it while a configuration process is active.`);
      let unknownLegacyRecords = false;
      try {
        unknownLegacyRecords = fs.lstatSync(lockPath).isDirectory() &&
          fs.readdirSync(lockPath).some((name) => !/^([1-9][0-9]*)-[a-f0-9-]{36}\.json$/.test(name));
      } catch { /* A disappearing lock or unreadable directory is not proof of an orphan. */ }
      if (unknownLegacyRecords) throw new CredentialError(`Timed out waiting for the legacy configuration lock directory (${lockPath}). It contains unrecognized records that cannot be removed automatically. Stop all configuration writers and MCP launchers, verify none are running, then move only this lock directory aside as a private backup and reconnect.`);
      throw new CredentialError(`Timed out waiting for the configuration lock (${lockPath}). Another process may be migrating credentials or updating config.json; reconnect after it finishes.`);
    }
    Atomics.wait(sleeper, 0, 0, 25);
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (;;) {
      let fd;
      try { fd = fs.openSync(lockPath, 'wx', 0o600); }
      catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          withReclaimGuard(guardPath, () => {
            const stat = fs.lstatSync(lockPath);
            if (stat.isDirectory()) retireLegacyLockDirectory(lockPath);
            else if (stat.isFile()) reclaimLock(lockPath);
            else throw new CredentialError(`Invalid configuration lock (${lockPath}). Restore a regular lock file or remove the invalid entry after configuration processes exit.`);
          });
          wait();
        } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
        continue;
      }
      try {
        fs.writeFileSync(fd, JSON.stringify(owner));
        ownedStat = fs.fstatSync(fd);
      } catch (err) {
        try { if (sameLock(fs.fstatSync(fd), fs.lstatSync(lockPath))) fs.unlinkSync(lockPath); }
        catch { /* Preserve the write error. */ }
        throw err;
      } finally { fs.closeSync(fd); }
      // A creator can be paused between exclusive open and owner publication.
      // Let any reaper finish before verifying that it did not reclaim that
      // formerly empty record. Never enter using an already-unlinked inode.
      while (fs.existsSync(guardPath)) wait();
      try {
        if (!sameLock(ownedStat, fs.lstatSync(lockPath))) { ownedStat = undefined; continue; }
      } catch (err) { if (err.code !== 'ENOENT') throw err; ownedStat = undefined; continue; }
      break;
    }
  } catch (err) {
    releaseLock(lockPath, owner, ownedStat);
    if (err instanceof CredentialError) throw err;
    throw new CredentialError(`Unable to acquire the configuration lock (${lockPath}). Check the data-directory permissions.`);
  }
  try { return callback(); }
  finally { releaseLock(lockPath, owner, ownedStat); }
}

function migrateConfig(dataDir, options = {}) {
  const failurePath = path.join(dataDir, MIGRATION_FAILURE_NAME);
  const now = options.now || Date.now;
  const retryMs = options.migrationRetryMs ?? MIGRATION_RETRY_MS;
  function clearFailure() {
    try { fs.unlinkSync(failurePath); } catch { /* A retry hint is best effort. */ }
  }
  function migrate() {
    const config = readConfig(dataDir);
    if (!config || !config.agent || !Object.hasOwn(config.agent, 'keyPassword')) { clearFailure(); return config; }
    const password = config.agent.keyPassword;
    const recovery = `Repair the previous config at ${path.join(dataDir, 'config.json')} to preserve any legacy password, or move it aside as a private backup before re-running init-agent. Do not paste its contents into chat.`;
    if (typeof password !== 'string') throw new CredentialError(`Invalid legacy agent.keyPassword: expected a string. ${recovery}`);
    if (typeof config.agent.keyFile !== 'string' || !config.agent.keyFile.trim()) {
      throw new CredentialError(`The previous config is missing a valid agent.keyFile. ${recovery}`);
    }
    // A partially transitioned file may contain both fields. Reuse a verified
    // reference only; a broken reference must never silently select a new store.
    const hasRef = Object.hasOwn(config.agent, 'keyPasswordRef');
    const backend = hasRef ? validateRef(config.agent.keyPasswordRef).backend : selectBackend(options);
    let fingerprint;
    if (backend !== 'file') {
      try { fingerprint = createHash('sha256').update(fs.readFileSync(path.join(dataDir, 'config.json'))).digest('hex'); }
      catch { throw new CredentialError('Unable to read config.json. Check the data directory permissions.'); }
      let failure;
      try { failure = JSON.parse(fs.readFileSync(failurePath, 'utf8')); } catch { /* Missing/invalid hint permits retry. */ }
      const age = now() - failure?.failedAt;
      if (failure?.version === 1 && failure.backend === backend && failure.fingerprint === fingerprint && Number.isFinite(age) && age >= 0 && age < retryMs) {
        const seconds = Math.ceil((retryMs - age) / 1000);
        throw new CredentialError(`${credentialError(backend, 'access').message} Credential migration retry is paused for ${seconds} second${seconds === 1 ? '' : 's'} after the recent failure; reconnect after that delay.`);
      }
    }
    try {
      if (hasRef) {
        if (resolvePassword(config, dataDir, options) !== password) throw new CredentialError('Legacy password does not match its credential reference. Migration left config.json unchanged.');
      } else {
        config.agent.keyPasswordRef = storePassword(dataDir, config.agent.keyFile, password, options);
      }
    } catch (err) {
      if (backend !== 'file' && err instanceof CredentialError && err.storeAccess === true) {
        // Shared by the hook and concurrent launchers: one blocking native
        // attempt per config/backend during the short retry window. Never save
        // passwords, helper output, exception text, or credential references.
        try { atomicWrite(failurePath, JSON.stringify({ version: 1, backend, fingerprint, failedAt: now() }) + '\n'); }
        catch { /* Preserve the actionable credential-store failure. */ }
      }
      throw err;
    }
    delete config.agent.keyPassword;
    config.credentialMigration = { version: 1, backend: config.agent.keyPasswordRef.backend, completedAt: new Date().toISOString() };
    try { (options.atomicWrite || atomicWrite)(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2) + '\n'); }
    catch { throw new CredentialError('Could not commit credential migration. The previous config and credential remain available; retry after checking data-directory permissions.'); }
    clearFailure();
    (options.log || console.error)('Manifest wallet credential migrated; plaintext password removed from config.json.');
    return config;
  }
  // Avoid creating mutable state during SessionStart when there is no wallet.
  if (!fs.existsSync(path.join(dataDir, 'config.json'))) return null;
  return options.locked ? migrate() : withConfigLock(dataDir, migrate, options);
}

module.exports = { storePassword, resolvePassword, migrateConfig, withConfigLock, readConfig, CredentialError };
