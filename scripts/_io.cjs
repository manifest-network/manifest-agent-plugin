'use strict';

/**
 * Shared I/O helpers for plugin scripts.
 *
 * - `atomicWrite(target, contents, {mode})` — write to a sibling tmpfile,
 *   chmod it, rename over the target. Cleans up the tmpfile on error.
 *   Default mode 0o600 reflects this plugin's secrets-by-default posture
 *   (config.json carries the wallet password, encrypted keyfiles, manifest
 *   JSON contains user env values). Pass `mode: 0o644` for non-secret data
 *   like the chain registry.
 *
 * - `readJsonFile(path)` — read + JSON.parse + shape-check (must be a plain
 *   object). Throws a descriptive error; caller decides exit handling.
 *
 * Underscore prefix marks this as a sibling-only helper, not a CLI entry
 * point. Skills MUST NOT invoke it directly via Bash.
 */

const { existsSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } = require('node:fs');
const { dirname, basename, join } = require('node:path');

function atomicWrite(targetPath, contents, options = {}) {
  const mode = options.mode ?? 0o600;
  const dir = dirname(targetPath);
  const tmp = join(dir, `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, contents, { mode });
    chmodSync(tmp, mode); // belt-and-suspenders for runtimes that ignore the mode option
    renameSync(tmp, targetPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath} as JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
}

module.exports = { atomicWrite, readJsonFile };
