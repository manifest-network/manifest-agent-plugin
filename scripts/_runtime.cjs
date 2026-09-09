'use strict';

// Shared, dependency-free runtime checks. This file is not a CLI.
const { createHash } = require('node:crypto');
const { readFileSync, lstatSync, readdirSync, readlinkSync, statSync, accessSync, constants } = require('node:fs');
const { join, posix } = require('node:path');

const MIN_NODE_VERSION = '22.19.0';
const COMPLETION_FILE = '.runtime-install.json';
const RUNTIME_PLATFORM = `${process.platform}/${process.arch}/node-${process.versions.node.split('.')[0]}`;

function assertNodeVersion(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
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
    if (completion.schema !== 1 || completion.fingerprint !== definition.fingerprint || completion.runtime !== RUNTIME_PLATFORM ||
        !Array.isArray(completion.files) || !completion.files.length) {
      throw new Error('The runtime install has no matching completion record.');
    }
    verifyInstalledPackages(dataDir, definition);
    for (const entry of completion.files) {
      if (!Array.isArray(entry) || entry.length !== 3 || !safeDependencyPath(entry[0])) {
        throw new Error('The runtime completion record is invalid.');
      }
      const [relative, type, expected] = entry;
      const absolute = join(dataDir, relative);
      const stat = lstatSync(absolute);
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

module.exports = {
  MIN_NODE_VERSION, COMPLETION_FILE, RUNTIME_PLATFORM, assertNodeVersion, readRuntimeDefinition,
  verifyInstalledPackages, snapshotDependencies, inspectRuntime,
};
