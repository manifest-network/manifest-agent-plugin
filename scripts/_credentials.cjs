'use strict';

// Native helpers receive secrets through private pipes, never process arguments.
// References are portable metadata; existing references always select their own
// backend, regardless of an operator's preference for future credential writes.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { atomicWrite } = require('./_io.cjs');

const SERVICE = 'org.manifest-network.manifest-agent';
const BACKENDS = new Set(['libsecret', 'keychain', 'wincred', 'file']);
const REF_ID = /^[a-f0-9]{24}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LOCK_NAME = '.config.lock';
const sleeper = new Int32Array(new SharedArrayBuffer(4));

class CredentialError extends Error {
  constructor(message) { super(message); this.name = 'CredentialError'; }
}

function credentialError(backend, operation) {
  const help = backend === 'file'
    ? 'Check the private credentials directory and restore the credential backup if needed.'
    : 'Unlock the OS credential store and retry. On headless systems, explicitly choose MANIFEST_CREDENTIAL_STORE=file for new credentials or legacy migration; existing references still require their original store.';
  return new CredentialError(`Credential ${operation} failed (${backend}). ${help}`);
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
    JSON.stringify(request), 'wincred', options);
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

function ownerAlive(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}

// A filesystem bakery lock avoids a shared stale-lock removal race. Each
// process owns one unique, atomically published choosing/ticket record; crashed
// records can be unlinked without ever removing a successor's lock. The parent
// directory stays in place. No secret is written into these records.
function withConfigLock(dataDir, callback, options = {}) {
  const lockPath = path.join(dataDir, LOCK_NAME);
  const deadline = Date.now() + (options.lockTimeoutMs ?? 35000);
  const owner = { pid: process.pid, token: randomUUID(), ticket: 0 };
  const name = `${owner.pid}-${owner.token}.json`;
  const recordPath = path.join(lockPath, name);
  const namePattern = /^([1-9][0-9]*)-[a-f0-9-]{36}\.json$/;
  function names() { return fs.readdirSync(lockPath).filter((entry) => namePattern.test(entry)); }
  function read(name) {
    let raw;
    try { raw = fs.readFileSync(path.join(lockPath, name), 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    const pid = Number(name.match(namePattern)[1]);
    if (!ownerAlive({ pid })) {
      try { fs.unlinkSync(path.join(lockPath, name)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      return null;
    }
    let other;
    try { other = JSON.parse(raw); } catch { throw new CredentialError('Invalid configuration lock record. Retry after the other configuration process exits.'); }
    if (other.pid !== pid || !Number.isSafeInteger(other.ticket) || other.ticket < 0) throw new CredentialError('Invalid configuration lock record.');
    return other;
  }
  function wait() {
    if (Date.now() >= deadline) throw new CredentialError('Timed out waiting for another configuration update. Retry after it completes.');
    Atomics.wait(sleeper, 0, 0, 25);
  }
  try {
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(lockPath).isDirectory()) throw new CredentialError('Invalid configuration lock directory.');
    atomicWrite(recordPath, JSON.stringify(owner));
    const maxTicket = names().reduce((max, entry) => Math.max(max, read(entry)?.ticket || 0), 0);
    if (maxTicket >= Number.MAX_SAFE_INTEGER) throw new CredentialError('Invalid configuration lock ticket.');
    owner.ticket = maxTicket + 1;
    atomicWrite(recordPath, JSON.stringify(owner));
    for (const otherName of names()) {
      if (otherName === name) continue;
      for (;;) {
        const other = read(otherName);
        if (!other) break;
        // ticket=0 means choosing; wait until its atomic ticket write completes.
        if (other.ticket !== 0 && (other.ticket > owner.ticket || (other.ticket === owner.ticket && otherName > name))) break;
        wait();
      }
    }
  } catch (err) {
    try { fs.unlinkSync(recordPath); } catch { /* not published, or already gone */ }
    if (err instanceof CredentialError) throw err;
    throw new CredentialError('Unable to acquire the configuration lock.');
  }
  try { return callback(); }
  finally { try { fs.unlinkSync(recordPath); } catch { /* preserve callback outcome */ } }
}

function migrateConfig(dataDir, options = {}) {
  function migrate() {
    const config = readConfig(dataDir);
    if (!config || !config.agent || !Object.hasOwn(config.agent, 'keyPassword')) return config;
    const password = config.agent.keyPassword;
    if (typeof password !== 'string') throw new CredentialError('Invalid legacy agent.keyPassword: expected a string.');
    // A partially transitioned file may contain both fields. Reuse a verified
    // reference only; a broken reference must never silently select a new store.
    const ref = config.agent.keyPasswordRef;
    if (Object.hasOwn(config.agent, 'keyPasswordRef')) {
      if (resolvePassword(config, dataDir, options) !== password) throw new CredentialError('Legacy password does not match its credential reference. Migration left config.json unchanged.');
    } else {
      config.agent.keyPasswordRef = storePassword(dataDir, config.agent.keyFile, password, options);
    }
    delete config.agent.keyPassword;
    config.credentialMigration = { version: 1, backend: config.agent.keyPasswordRef.backend, completedAt: new Date().toISOString() };
    try { (options.atomicWrite || atomicWrite)(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2) + '\n'); }
    catch { throw new CredentialError('Could not commit credential migration. The previous config and credential remain available; retry after checking data-directory permissions.'); }
    (options.log || console.error)('Manifest wallet credential migrated; plaintext password removed from config.json.');
    return config;
  }
  // Avoid creating mutable state during SessionStart when there is no wallet.
  if (!fs.existsSync(path.join(dataDir, 'config.json'))) return null;
  return options.locked ? migrate() : withConfigLock(dataDir, migrate, options);
}

module.exports = { storePassword, resolvePassword, migrateConfig, withConfigLock, readConfig, CredentialError };
