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
 * Concurrency: `appendRecord` calls `fs.appendFileSync(file, line, { flag: 'a' })`,
 * which opens the file with `O_APPEND` and issues `write(2)` until all bytes
 * are accepted. On Linux, ext4 / xfs serialize concurrent `write(2)` calls
 * to a regular file via the inode mutex, so a single record under
 * `MAX_RECORD_BYTES` (4 KiB) is appended atomically in practice — two
 * writers in different processes do NOT interleave each other's lines.
 * This is best-effort, not a POSIX guarantee: `PIPE_BUF` only formally
 * applies to pipes/FIFOs, and a partial-write retry inside `appendFileSync`
 * could in principle leave a window where another writer's append slips
 * between our two `write(2)` syscalls. Records exceeding 4 KiB are
 * replaced with a smaller `journal_truncated` marker so the historical
 * line stays intact and the realistic-concurrency story stays inside the
 * single-syscall regime.
 *
 * Exports:
 *   - SCHEMA_VERSION (1) — bump when the record shape changes.
 *   - MAX_RECORD_BYTES (4096) — single-`write(2)` target so realistic
 *     concurrent appends don't interleave on Linux ext4 / xfs.
 *   - SECRET_KEY_DENYLIST — regex of keys that must NEVER appear in a record.
 *   - SUSPECT_KEY_PATTERN — regex of keys whose values get redacted in
 *     generic args walks (defense in depth for unknown tools).
 *   - appendRecord(record) — validate + append, returns the journal file path.
 *   - redactArgs(toolName, rawArgs) — produce the `args_redacted` block for a
 *     `tool_calls[]` entry. Tool-specific reductions (spec → summary for
 *     deploy_app / build_manifest_preview), deep-redact-by-key for
 *     known-safe tools (whitelist-shaped fields are preserved verbatim;
 *     SUSPECT_KEY_PATTERN matches are replaced with `<redacted>` as
 *     defense in depth), best-effort walk for unknown tools.
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

// Target single-`write(2)` size. Linux ext4 / xfs serialize concurrent
// `write(2)` to a regular file via the inode mutex, so a record under this
// size is appended without interleaving in practice. Above the bound, a
// partial-write retry inside `appendFileSync` could split the append into
// two `write(2)` calls and leave a window where another writer's append
// slips between them. The writer reserves one byte for the trailing
// newline. PIPE_BUF (4096 on Linux) is the formal POSIX bound for pipes /
// FIFOs only; we use 4096 here because that's the realistic upper limit
// for a single ext4 / xfs write and avoids a separate magic constant.
const MAX_RECORD_BYTES = 4096;

// Keys that must NEVER appear in a record. Case-insensitive substring match
// on the KEY name only (not the value) so the user-typed `intent` field can
// freely mention "password rotation" without tripping the check. The list
// is intentionally narrow: it covers the high-confidence sensitive shapes
// that have appeared in this plugin's secret-bearing flows (mnemonic +
// keyfile password) PLUS a small set of credential-shaped suffixes
// (`api[_-]?key`, `private[_-]?key`, `secret[_-]?key`, `auth[_-]?token`,
// `bearer[_-]?token`) that catch obvious skill-author mistakes outside
// `args_redacted` (e.g. in `final_state` or `errors`). The blanket
// `token` and `secret` keywords are intentionally NOT here — this is a
// blockchain plugin where `gas_token`, `fee_token`, `token_id`,
// `token_symbol` are legitimate non-sensitive field names.
const SECRET_KEY_DENYLIST = /(mnemonic|password|private[_-]?key|secret[_-]?key|api[_-]?key|auth[_-]?token|bearer[_-]?token)/i;

// Keys whose value is replaced with `<redacted>` in `redactArgs` walks. This
// is defense in depth; the canonical reduction for known-shaped tools (e.g.
// deploy_app) happens via the spec-summarizer, not via this regex.
const SUSPECT_KEY_PATTERN = /(MNEMONIC|PASSWORD|TOKEN|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY)/i;

// Mirrors summarize-spec.cjs in-process. Skills that already shell out to
// summarize-spec.cjs for the deployment plan can keep doing so; this is for
// callers (the journal layer) that want the same shape without a subprocess.
function summarizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
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

// Best-effort heuristic redaction for tools we don't have explicit shape
// rules for. NOT a security boundary: a short credential (under 256 chars)
// stored under a benign-looking key like `note` or `value` will pass
// through verbatim. Treat the unknown-tool path as audit-only — if a new
// MCP tool is added that takes secret-bearing inputs, register it in
// SAFE_TOOLS / SAFE_TOOL_PREFIXES with an explicit redaction rule rather
// than relying on this fallback.
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
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return rawArgs;

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
  // `typeof [] === 'object'`, so arrays would slip past a bare typeof check;
  // reject them explicitly here so direct sibling callers (which bypass the
  // CLI's own array guard in journal-write.cjs) can't append a non-object
  // top-level record that the reader would later silently skip.
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
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

  // appendFileSync's `mode` option only applies at file *creation*, so a
  // pre-existing journal file with looser permissions would expose the new
  // record between the write and a post-hoc chmod. Tighten the file mode
  // BEFORE the append when it already exists. We accept the tiny race
  // between the existsSync check and the chmod (an external process would
  // have to recreate the file in between, which doesn't happen for the
  // plugin-private journal/ directory) in exchange for closing the
  // larger write-then-chmod window.
  if (fs.existsSync(file)) {
    tightenIgnoringExpectedErrors(file, 0o600);
  }
  fs.appendFileSync(file, toAppend + '\n', { mode: 0o600, flag: 'a' });
  // Belt-and-suspenders: in the rare case the file was created by this
  // appendFileSync call but the runtime ignored the mode option, tighten
  // again. No-op on Linux when mode was honored at creation.
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
