#!/usr/bin/env node
'use strict';

/**
 * Read-only query over the operation journal.
 *
 * Reads daily JSONL files at `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`
 * (UTC), filters by date / skill / lease UUID / outcome / signer, renders to
 * Markdown (default, for LLM consumption via the journal skill) or JSONL
 * (for tests and future programmatic use).
 *
 * Tolerates a torn final line silently — append() can be cut mid-write on
 * power loss. Earlier unparseable lines log to stderr and are skipped (rest
 * of file is still processed).
 *
 * Usage:
 *   node journal-read.cjs [filters] [--format markdown|jsonl] [--limit N]
 *
 * Filters:
 *   --date <YYYY-MM-DD>            single day (default: today UTC)
 *   --since <YYYY-MM-DD>           inclusive start of range (with --until)
 *   --until <YYYY-MM-DD>           inclusive end of range (with --since)
 *   --skill <name>                 e.g. deploy-app
 *   --lease <uuid>                 matches both final_state.lease_uuid and
 *                                  any tool_calls[].args_redacted.lease_uuid
 *   --outcome <success|partial|failed|cancelled|journal_truncated>
 *   --signer <address>             filters on signer_address
 *
 * --date is mutually exclusive with --since/--until.
 *
 * Output:
 *   Markdown (default) — one section per record with bullet lists.
 *   JSONL (--format jsonl) — one record per line.
 *
 * Exit codes:
 *   0 — query succeeded (zero matches is success; markdown emits "(no
 *       records match)", jsonl emits empty stdout).
 *   1 — argv error, missing journal directory, or IO failure.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./_io.cjs');
const { UUID_RE } = require('./_uuid.cjs');
const { journalDir, todayUtcDate } = require('./_journal.cjs');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_OUTCOMES = new Set(['success', 'partial', 'failed', 'cancelled', 'journal_truncated']);

function parseArgs(argv) {
  const args = { format: 'markdown' };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--date' && next) { args.date = next; i++; }
    else if (flag === '--since' && next) { args.since = next; i++; }
    else if (flag === '--until' && next) { args.until = next; i++; }
    else if (flag === '--skill' && next) { args.skill = next; i++; }
    else if (flag === '--lease' && next) { args.lease = next; i++; }
    else if (flag === '--outcome' && next) { args.outcome = next; i++; }
    else if (flag === '--signer' && next) { args.signer = next; i++; }
    else if (flag === '--format' && next) { args.format = next; i++; }
    else if (flag === '--limit' && next) { args.limit = Number(next); i++; }
    else {
      console.error(`Unknown or malformed argument: ${flag}`);
      process.exit(1);
    }
  }
  return args;
}

function validateArgs(args) {
  if (args.date && (args.since || args.until)) {
    console.error('--date is mutually exclusive with --since/--until');
    process.exit(1);
  }
  if ((args.since && !args.until) || (args.until && !args.since)) {
    console.error('--since and --until must be passed together');
    process.exit(1);
  }
  for (const key of ['date', 'since', 'until']) {
    if (args[key] && !DATE_RE.test(args[key])) {
      console.error(`--${key} must be YYYY-MM-DD; got "${args[key]}"`);
      process.exit(1);
    }
  }
  if (args.lease && !UUID_RE.test(args.lease)) {
    console.error(`--lease must be a UUID; got "${args.lease}"`);
    process.exit(1);
  }
  if (args.outcome && !VALID_OUTCOMES.has(args.outcome)) {
    console.error(`--outcome must be one of ${[...VALID_OUTCOMES].join('|')}; got "${args.outcome}"`);
    process.exit(1);
  }
  if (args.format !== 'markdown' && args.format !== 'jsonl') {
    console.error(`--format must be markdown or jsonl; got "${args.format}"`);
    process.exit(1);
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    console.error(`--limit must be a positive integer; got "${args.limit}"`);
    process.exit(1);
  }
}

function datesInRange(since, until) {
  // Inclusive on both ends. Iterates calendar days at UTC midnight.
  const out = [];
  const start = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    console.error(`--since/--until must be valid YYYY-MM-DD dates`);
    process.exit(1);
  }
  if (start > end) return out;
  const cur = new Date(start);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function readRecordsForDate(date, filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  // Drop a trailing newline if present, then split. The "trailing partial
  // line" case is the LAST array element after splitting on \n if the file
  // didn't end with \n.
  const hasTrailingNewline = raw.endsWith('\n');
  const lines = (hasTrailingNewline ? raw.slice(0, -1) : raw).split('\n');
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    const isLastLine = i === lines.length - 1;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      // The very last line is allowed to be torn (power-loss truncation);
      // drop it silently per the ticket. Earlier lines are unexpected and
      // get a stderr breadcrumb so a human can investigate.
      if (isLastLine && !hasTrailingNewline) continue;
      process.stderr.write(`(line ${i + 1} of ${filePath} unparseable; skipped)\n`);
    }
  }
  return records;
}

function recordMatches(record, filters) {
  if (filters.skill && record.skill !== filters.skill) return false;
  if (filters.outcome && record.outcome !== filters.outcome) return false;
  if (filters.signer && record.signer_address !== filters.signer) return false;
  if (filters.lease) {
    const target = filters.lease;
    const final = record.final_state && record.final_state.lease_uuid === target;
    let inToolCalls = false;
    if (Array.isArray(record.tool_calls)) {
      for (const tc of record.tool_calls) {
        const a = tc && tc.args_redacted;
        if (a && typeof a === 'object' && a.lease_uuid === target) {
          inToolCalls = true;
          break;
        }
      }
    }
    if (!final && !inToolCalls) return false;
  }
  return true;
}

function renderMarkdown(records) {
  if (records.length === 0) return '(no records match)\n';
  const sections = records.map((r) => renderMarkdownRecord(r));
  return sections.join('\n\n') + '\n';
}

function renderMarkdownRecord(r) {
  const lines = [];
  const ts = r.timestamp_iso || '<unknown>';
  const skill = r.skill || '<unknown>';
  const outcome = r.outcome || '<unknown>';
  lines.push(`### ${ts}  ${skill}  ${outcome}`);
  if (r.session_id) lines.push(`- session: \`${r.session_id}\``);
  if (r.active_chain) lines.push(`- chain: ${r.active_chain}`);
  if (r.signer_address) lines.push(`- signer: \`${r.signer_address}\``);
  if (r.intent) lines.push(`- intent: ${truncate(r.intent, 240)}`);
  if (r.plan_summary) lines.push(`- plan: ${truncate(r.plan_summary, 240)}`);
  if (Array.isArray(r.tool_calls) && r.tool_calls.length > 0) {
    lines.push(`- tool_calls (${r.tool_calls.length}):`);
    for (const tc of r.tool_calls) {
      const tool = tc && tc.tool ? tc.tool : '<unknown>';
      const oc = tc && tc.outcome ? tc.outcome : '?';
      const ms = tc && typeof tc.latency_ms === 'number' ? ` (${tc.latency_ms}ms)` : '';
      lines.push(`    - ${tool} -> ${oc}${ms}`);
    }
  }
  if (r.final_state && typeof r.final_state === 'object') {
    lines.push(`- final_state:`);
    for (const [k, v] of Object.entries(r.final_state)) {
      lines.push(`    - ${k}: ${formatValue(v)}`);
    }
  }
  if (Array.isArray(r.errors) && r.errors.length > 0) {
    lines.push(`- errors:`);
    for (const e of r.errors) {
      const cls = e && e.class ? e.class : '<unknown>';
      const msg = e && e.message ? truncate(e.message, 200) : '';
      lines.push(`    - ${cls}: ${msg}`);
    }
  }
  if (Array.isArray(r.recovery_actions) && r.recovery_actions.length > 0) {
    lines.push(`- recovery_actions:`);
    for (const a of r.recovery_actions) {
      lines.push(`    - ${formatValue(a)}`);
    }
  }
  return lines.join('\n');
}

function truncate(s, n) {
  if (typeof s !== 'string') return String(s);
  return s.length <= n ? s : s.slice(0, n) + '...';
}

function formatValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

(async () => {
  const args = parseArgs(process.argv);
  validateArgs(args);

  // Resolve target dates. Default = today UTC. Range overrides single date.
  let dates;
  if (args.since && args.until) {
    dates = datesInRange(args.since, args.until);
  } else {
    dates = [args.date || todayUtcDate()];
  }

  // Verify the journal directory at least exists; if not, return empty.
  // getDataDir() throws a friendly error if MANIFEST_PLUGIN_DATA is unset.
  const dir = journalDir();
  if (!fs.existsSync(dir)) {
    if (args.format === 'markdown') process.stdout.write('(no records match)\n');
    return;
  }

  let records = [];
  for (const d of dates) {
    const file = path.join(dir, `${d}.jsonl`);
    records = records.concat(readRecordsForDate(d, file));
  }

  records = records.filter((r) => recordMatches(r, args));

  // Sort newest first (records are appended chronologically per file, but
  // multi-day ranges can produce out-of-order results within the array).
  records.sort((a, b) => {
    const ta = typeof a.timestamp_unix === 'number' ? a.timestamp_unix : 0;
    const tb = typeof b.timestamp_unix === 'number' ? b.timestamp_unix : 0;
    return tb - ta;
  });

  if (args.limit !== undefined) {
    records = records.slice(0, args.limit);
  }

  if (args.format === 'jsonl') {
    for (const r of records) {
      process.stdout.write(JSON.stringify(r) + '\n');
    }
  } else {
    process.stdout.write(renderMarkdown(records));
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
