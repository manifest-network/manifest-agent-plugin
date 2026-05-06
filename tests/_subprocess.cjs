'use strict';

/**
 * Tiny helper for tests that exercise CLI scripts via subprocess.
 *
 * Spawns `node <script>` with the given argv tail and stdin, returns
 * `{ status, stdout, stderr, json? }`. JSON-parses stdout when it looks
 * like a single JSON object/array (most of this plugin's CLI scripts
 * emit a single one-line JSON result) — the test then asserts on
 * `result.json` directly.
 */

const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const SCRIPTS_DIR = join(__dirname, '..', 'scripts');

function runScript(scriptName, argv = [], stdin = '') {
  const res = spawnSync(process.execPath, [join(SCRIPTS_DIR, scriptName), ...argv], {
    input: stdin,
    encoding: 'utf8',
  });
  const out = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  const trimmed = (res.stdout || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { out.json = JSON.parse(trimmed); } catch { /* not single-line JSON */ }
  }
  return out;
}

module.exports = { runScript };
