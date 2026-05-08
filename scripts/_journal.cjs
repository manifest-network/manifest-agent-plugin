'use strict';

/**
 * Append-only operation journal helpers (ENG-124).
 *
 * The journal is a daily-rotating JSONL file at
 * `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl` that every state-changing
 * skill writes one record to per invocation. See `journal-write.cjs` for the
 * CLI wrapper and the schema docstring for the record shape.
 *
 * Underscore prefix marks this as a sibling-only helper. Skills MUST NOT
 * shell out to it — they pipe a pre-built JSON record to `journal-write.cjs`.
 *
 * Concurrency: `appendRecord` uses `fs.appendFileSync` with the implicit
 * `O_APPEND` flag. POSIX guarantees writes <= PIPE_BUF (4096 bytes on Linux)
 * are atomic with O_APPEND, so two writers in different OS processes do not
 * interleave. Records exceeding that bound are replaced with a smaller
 * `journal_truncated` marker so the historical line stays intact.
 *
 * Exports:
 *   - SCHEMA_VERSION (1) — bump when the record shape changes.
 *   - MAX_RECORD_BYTES (4096) — PIPE_BUF on Linux; the atomic-append bound.
 *   - SECRET_KEY_DENYLIST — regex of keys that must NEVER appear in a record.
 *   - SUSPECT_KEY_PATTERN — regex of keys whose values get redacted in
 *     generic args walks (defense in depth for unknown tools).
 *   - appendRecord(record) — validate + append, returns the journal file path.
 *   - redactArgs(toolName, rawArgs) — produce the `args_redacted` block for a
 *     `tool_calls[]` entry. Tool-specific reductions (spec → summary for
 *     deploy_app / build_manifest_preview), pass-through for known-safe
 *     tools, defensive walk for unknown tools.
 *   - validateRecord(record) — throws if any key in the record matches the
 *     secret denylist anywhere in the tree.
 *   - todayUtcDate() — `YYYY-MM-DD` of the current UTC date.
 *   - journalDir() / journalFilePath(date) — path helpers.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./_io.cjs');
const { isStack, normalizeServices } = require('./_spec.cjs');

const SCHEMA_VERSION = 1;

// PIPE_BUF on Linux. POSIX promises atomic writes below this size with
// O_APPEND; above it, two concurrent appenders may interleave. The writer
// reserves one byte for the trailing newline.
const MAX_RECORD_BYTES = 4096;

// Keys that must NEVER appear in a record. Case-insensitive substring match
// on the KEY name only (not the value) so the user-typed `intent` field can
// freely mention "password rotation" without tripping the check.
const SECRET_KEY_DENYLIST = /(mnemonic|password)/i;

// Keys whose value is replaced with `<redacted>` in `redactArgs` walks. This
// is defense in depth; the canonical reduction for known-shaped tools (e.g.
// deploy_app) happens via the spec-summarizer, not via this regex.
const SUSPECT_KEY_PATTERN = /(MNEMONIC|PASSWORD|TOKEN|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY)/i;

// Mirrors summarize-spec.cjs in-process. Skills that already shell out to
// summarize-spec.cjs for the deployment plan can keep doing so; this is for
// callers (the journal layer) that want the same shape without a subprocess.
function summarizeSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const format = isStack(spec) ? 'stack' : 'single';
  const services = normalizeServices(spec);
  let port_count = 0;
  const env_keys = new Set();
  const images = [];
  for (const { raw: svc } of services) {
    if (svc.image) images.push(svc.image);
    if (typeof svc.port === 'number') port_count += 1;
    if (svc.ports && typeof svc.ports === 'object') port_count += Object.keys(svc.ports).length;
    if (svc.env && typeof svc.env === 'object') {
      for (const k of Object.keys(svc.env)) env_keys.add(k);
    }
  }
  return {
    format,
    service_count: services.length,
    port_count,
    env_count: env_keys.size,
    env_keys: Array.from(env_keys).sort(),
    images,
  };
}

function deepRedactByKey(value) {
  if (Array.isArray(value)) return value.map(deepRedactByKey);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SUSPECT_KEY_PATTERN.test(k) ? '<redacted>' : deepRedactByKey(v);
    }
    return out;
  }
  return value;
}

function deepRedactByKeyAndLongStrings(value) {
  if (Array.isArray(value)) return value.map(deepRedactByKeyAndLongStrings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SUSPECT_KEY_PATTERN.test(k) ? '<redacted>' : deepRedactByKeyAndLongStrings(v);
    }
    return out;
  }
  // Long strings in unknown tool args are suspicious — values long enough to
  // be a base64-encoded credential or a JWT. Whitelist short strings (UUIDs,
  // FQDNs, image refs are all under 256 chars).
  if (typeof value === 'string' && value.length > 256) return '<redacted-long-string>';
  return value;
}

// Tools whose args are structurally safe to capture verbatim. Lease-module
// args carry lease UUIDs / FQDNs / amounts (all whitelisted by the ticket as
// captured), cosmos_query is read-only, fred provider tools take lease UUIDs
// and sku names. None of these accept user-supplied secrets.
const SAFE_TOOL_PREFIXES = [
  'mcp__manifest-lease__',
];
const SAFE_TOOLS = new Set([
  'mcp__manifest-cosmwasm__convert_mfx_to_pwr',
  'mcp__manifest-fred__update_app',
  'mcp__manifest-fred__restart_app',
  'mcp__manifest-fred__app_status',
  'mcp__manifest-fred__app_diagnostics',
  'mcp__manifest-fred__get_logs',
  'mcp__manifest-fred__check_deployment_readiness',
  'mcp__manifest-fred__wait_for_app_ready',
  'mcp__manifest-chain__cosmos_query',
  'mcp__manifest-chain__request_faucet',
]);

function isSafeTool(toolName) {
  if (SAFE_TOOLS.has(toolName)) return true;
  return SAFE_TOOL_PREFIXES.some((p) => toolName.startsWith(p));
}

function redactArgs(toolName, rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') return rawArgs;

  // deploy_app / build_manifest_preview accept a structured spec (potentially
  // carrying user env values). Reduce it to summarize-spec.cjs's shape.
  if (
    toolName === 'mcp__manifest-fred__deploy_app'
    || toolName === 'mcp__manifest-fred__build_manifest_preview'
  ) {
    // Tolerate two call shapes: a bare spec, or `{ spec: ... }`.
    const spec = rawArgs.spec && typeof rawArgs.spec === 'object' ? rawArgs.spec : rawArgs;
    const out = { summary: summarizeSpec(spec) };
    for (const key of ['customDomain', 'serviceName', 'size']) {
      if (typeof spec[key] === 'string') out[key] = spec[key];
    }
    return out;
  }

  // Cosmos broadcast/estimate args are CLI-flag arrays with no secrets. Keep
  // them verbatim so audit grep can find specific subcommands and sku UUIDs.
  if (
    toolName === 'mcp__manifest-chain__cosmos_tx'
    || toolName === 'mcp__manifest-chain__cosmos_estimate_fee'
  ) {
    const out = {};
    if (rawArgs.module !== undefined) out.module = rawArgs.module;
    if (rawArgs.subcommand !== undefined) out.subcommand = rawArgs.subcommand;
    if (rawArgs.gas_multiplier !== undefined) out.gas_multiplier = rawArgs.gas_multiplier;
    if (Array.isArray(rawArgs.args)) out.args = rawArgs.args.slice();
    return out;
  }

  if (isSafeTool(toolName)) {
    return deepRedactByKey(rawArgs);
  }

  // Unknown tool: walk recursively, redact suspect keys + long string values.
  return deepRedactByKeyAndLongStrings(rawArgs);
}

function validateRecord(record) {
  // Iterative DFS to avoid recursion depth issues on pathologically nested
  // payloads. Throws on the first match so the writer can refuse to append.
  if (!record || typeof record !== 'object') {
    throw new Error('record must be a JSON object');
  }
  const stack = [record];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    for (const [k, v] of Object.entries(node)) {
      if (SECRET_KEY_DENYLIST.test(k)) {
        throw new Error(
          `Refusing to append: key '${k}' matches the secret-key denylist (${SECRET_KEY_DENYLIST}). ` +
          `Strip or rename the key before passing the record to the journal writer.`
        );
      }
      stack.push(v);
    }
  }
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function journalDir() {
  return path.join(getDataDir(), 'journal');
}

function journalFilePath(date) {
  return path.join(journalDir(), `${date || todayUtcDate()}.jsonl`);
}

function tightenIgnoringExpectedErrors(filepath, mode) {
  // chmod is best-effort: caller may not own the path (system tmpdir,
  // shared mountpoint), the FS may be read-only, etc. Mirrors the catch
  // narrowing in `_io.cjs#atomicWrite`.
  try {
    fs.chmodSync(filepath, mode);
  } catch (err) {
    const ignored = new Set(['EPERM', 'EACCES', 'EROFS', 'ENOSYS', 'ENOENT']);
    if (!err || !ignored.has(err.code)) throw err;
  }
}

function appendRecord(record) {
  validateRecord(record);

  const dir = journalDir();
  const file = journalFilePath();

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // recursive mkdir won't tighten a pre-existing dir, so chmod unconditionally.
  tightenIgnoringExpectedErrors(dir, 0o700);

  const line = JSON.stringify(record);
  let toAppend = line;
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_RECORD_BYTES) {
    // Replace with a small marker. The original record is dropped (not
    // truncated mid-line — that would corrupt JSONL). The marker keeps the
    // history visible: future readers see "something happened here, it was
    // too big to atomically append".
    const marker = {
      schema_version: SCHEMA_VERSION,
      timestamp_iso: record.timestamp_iso || new Date().toISOString(),
      timestamp_unix: record.timestamp_unix || Math.floor(Date.now() / 1000),
      session_id: record.session_id || null,
      skill: record.skill || null,
      outcome: 'journal_truncated',
      original_size_bytes: Buffer.byteLength(line, 'utf8'),
    };
    toAppend = JSON.stringify(marker);
  }

  // appendFileSync's `mode` option only applies on file creation. For a
  // pre-existing file with looser permissions, we tighten after the write.
  fs.appendFileSync(file, toAppend + '\n', { mode: 0o600, flag: 'a' });
  tightenIgnoringExpectedErrors(file, 0o600);
  return file;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_RECORD_BYTES,
  SECRET_KEY_DENYLIST,
  SUSPECT_KEY_PATTERN,
  appendRecord,
  redactArgs,
  validateRecord,
  todayUtcDate,
  journalDir,
  journalFilePath,
  // Exported for testing only.
  _summarizeSpec: summarizeSpec,
};
