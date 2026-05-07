'use strict';

/**
 * Shared I/O helpers for plugin scripts.
 *
 * - `atomicWrite(target, contents, {mode, ensureDir, dirMode})` — write to a
 *   sibling tmpfile, chmod it, rename over the target. Cleans up the tmpfile
 *   on error. Default mode 0o600 reflects this plugin's secrets-by-default
 *   posture (config.json carries the wallet password, encrypted keyfiles,
 *   manifest JSON contains user env values). Pass `mode: 0o644` for
 *   non-secret data like the chain registry. Pass `ensureDir: true` to have
 *   the helper create the parent directory (recursive, default `dirMode`
 *   0o700) AND chmod it to dirMode unconditionally — the chmod runs even
 *   when the directory already existed, so a previously-loose parent gets
 *   tightened to the requested mode rather than silently surviving.
 *   Without `ensureDir`, writing into a not-yet-created parent throws
 *   ENOENT against the tmpfile name, which is hard to read.
 *
 * - `readJsonFile(path)` — read + JSON.parse + shape-check (must be a plain
 *   object). Throws a descriptive error; caller decides exit handling.
 *
 * - `getDataDir()` — return the plugin's persistent data directory. Reads
 *   $MANIFEST_PLUGIN_DATA, which is exported by the SessionStart hook from
 *   Claude Code's `${CLAUDE_PLUGIN_DATA}` substitution (resolves to
 *   `~/.claude/plugins/data/<id>/`). Throws if unset — scripts must be
 *   launched from a Claude Code session or with the env var set manually.
 *
 * Underscore prefix marks this as a sibling-only helper, not a CLI entry
 * point. Skills MUST NOT invoke it directly via Bash.
 */

const { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync, unlinkSync } = require('node:fs');
const { dirname, basename, join } = require('node:path');

function atomicWrite(targetPath, contents, options = {}) {
  const mode = options.mode ?? 0o600;
  const dir = dirname(targetPath);
  if (options.ensureDir) {
    const dirMode = options.dirMode ?? 0o700;
    mkdirSync(dir, { recursive: true, mode: dirMode });
    // mkdirSync({recursive}) does not chmod a pre-existing directory, so
    // tighten unconditionally — this matches the explicit chmodSync that
    // save-manifest.cjs and save-manifest-draft.cjs do by hand after their
    // own mkdirSync calls. Without this, a parent dir created earlier with
    // looser permissions (umask drift, manual mkdir, another tool) would
    // silently survive a 0o700-default ensureDir call.
    //
    // Narrow the catch to known-benign error codes:
    //   EPERM/EACCES — caller doesn't own the dir (system tmpdir, shared
    //                  mountpoint). The intended ignore case.
    //   EROFS        — read-only filesystem; chmod is impossible by design.
    //   ENOSYS       — chmod not supported (rare; some FUSE filesystems).
    //   ENOENT       — directory disappeared between mkdir and chmod (race).
    // Anything else (EINVAL bad mode, ENOTDIR path is a file) signals a
    // programmer error or environment we shouldn't paper over — rethrow
    // so the caller sees it instead of silently leaving a permissive dir.
    try {
      chmodSync(dir, dirMode);
    } catch (err) {
      const ignored = new Set(['EPERM', 'EACCES', 'EROFS', 'ENOSYS', 'ENOENT']);
      if (!err || !ignored.has(err.code)) throw err;
    }
  }
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

function getDataDir() {
  const dir = process.env.MANIFEST_PLUGIN_DATA;
  if (!dir) {
    throw new Error(
      'MANIFEST_PLUGIN_DATA env var is not set. ' +
      'Restart Claude Code so the SessionStart hook runs, ' +
      'or set it manually to ~/.claude/plugins/data/<plugin-id>/.'
    );
  }
  return dir;
}

module.exports = { atomicWrite, readJsonFile, getDataDir };
