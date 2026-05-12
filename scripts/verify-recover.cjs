#!/usr/bin/env node
'use strict';

/**
 * Generalized post-broadcast verify-and-recover driver.
 *
 * Reads a verification spec on stdin, spawns the named verifier script
 * (inside `scripts/`), maps the verifier's outcome to a recovery branch
 * via the spec's `branches` dictionary, and emits a structured result the
 * skill prose consumes (printing `user_message`, splicing
 * `journal_action_tags` into the journal record's `recovery_actions[]`,
 * branching on `branch_id`).
 *
 * Stdin (JSON object): `{ spec, payloads?, context? }`. See
 * `references/verify-recover.md` for the full annotated shape. Quick form:
 *
 *   spec.verifier.script        bare filename inside `scripts/` (no `..`,
 *                               `/`, or `\`; realpath must resolve inside
 *                               the dir — defeats symlink escape).
 *   spec.verifier.args          argv tail. `{{key}}` slots interpolated
 *                               against `context` before `spawnSync`.
 *   spec.verifier.stdin_source  `null` → no stdin piped. String → look up
 *                               `payloads[key]` and pipe `JSON.stringify`.
 *                               Missing key → exit 1.
 *   spec.success.field          name of the verifier-output field to read.
 *   spec.success.values         array of values that count as success.
 *   spec.branches               dict from outcome value to
 *                               `{branch_id, journal_action_tag, user_message}`.
 *                               Reserved key `"other"` matches anything not
 *                               listed and not in `success.values`.
 *
 * Output (stdout, single-line JSON):
 *   {
 *     result:               "success" | "failure",
 *     verifier_outcome:     <whatever the verifier emitted>,
 *     branch_id:            string | null,
 *     journal_action_tags:  string[],
 *     user_message:         string | null,     // pre-interpolated
 *     diagnostic_delta:     object             // verifier stdout minus
 *                                              // success.field, denylist-stripped
 *   }
 *
 * Exit codes:
 *   0 — driver classified the outcome (success OR failure). The skill
 *       branches on the JSON; non-zero exit would defeat that contract.
 *   1 — driver-internal error: bad spec JSON, missing payload key, path
 *       traversal on `verifier.script`, verifier subprocess crashed
 *       (non-zero exit), verifier stdout not a JSON object, verifier
 *       stdout missing the `success.field` key.
 *
 * Security notes:
 *   - `verifier.script` is sanitized in two layers. The string-pattern
 *     check rejects obvious traversal attempts (`..`, `/`, `\`); the
 *     `realpathSync` check rejects symlinks inside `scripts/` that point
 *     outside the directory. Both must pass.
 *   - `diagnostic_delta` is stripped of any key matching
 *     `_journal.SECRET_KEY_DENYLIST` before emit. Belt-and-braces with
 *     the journal writer's own fail-closed check — if a future verifier
 *     accidentally emits a denylisted key in its output, neither the
 *     driver's stdout (which feeds skill prose) nor the journal record
 *     will carry it.
 *   - `user_message` is rendered verbatim from possibly provider-
 *     influenced data (`diagnostic_delta` comes from verifier stdout,
 *     which for `verify-domain-state.cjs` is derived from an MCP
 *     response). Skill prose treats it as untrusted narrative — print
 *     verbatim, never re-interpret.
 */

const { readFileSync, realpathSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join, sep } = require('node:path');
const { SECRET_KEY_DENYLIST } = require('./_journal.cjs');

function failDriver(msg) {
  console.error(`verify-recover: ${msg}`);
  process.exit(1);
}

// Production: SCRIPTS_DIR is the directory this script lives in (canonical
// `scripts/`). The env-var override exists ONLY so tests can point the
// driver at a temp directory carrying a fixture verifier (e.g. to exercise
// the denylist-stripping and non-object-stdout paths against contrived
// outputs that no production verifier emits).
//
// Hard-gate: the override is honored ONLY when `NODE_ENV === 'test'`. Any
// other value (including unset / production) silently ignores it. This
// closes the gap between the comment's "test-only" claim and the runtime —
// a user (or attacker, or an errant config) that sets
// `VERIFY_RECOVER_TEST_SCRIPTS_DIR` outside a test run cannot redirect the
// verifier-resolution root. Tests pass `NODE_ENV: 'test'` alongside the
// override in their `spawnSync` env block (see `withFixtureDir` in
// `tests/verify-recover.test.cjs`).
const TEST_OVERRIDE = process.env.NODE_ENV === 'test' ? process.env.VERIFY_RECOVER_TEST_SCRIPTS_DIR : undefined;
const SCRIPTS_DIR = TEST_OVERRIDE || __dirname;
// `realpathSync` throws on missing/unreadable paths. Route the error through
// `failDriver` so consumers always see a `verify-recover: …` diagnostic
// instead of an unformatted ENOENT stack trace. In production
// `SCRIPTS_DIR === __dirname` so the dir necessarily exists (the script is
// in it); the only realistic failure is a misconfigured test override.
let SCRIPTS_DIR_REAL;
try {
  SCRIPTS_DIR_REAL = realpathSync(SCRIPTS_DIR);
} catch (err) {
  failDriver(`SCRIPTS_DIR '${SCRIPTS_DIR}' could not be resolved: ${err.message}`);
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function interpolate(template, vars) {
  // Replace `{{key}}` with vars[key] if defined. Leave literal otherwise.
  // Keys are alnum + `_` only — anything else falls through as-is.
  return String(template).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null) {
      return String(vars[key]);
    }
    return m;
  });
}

function sanitizeScriptName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    failDriver(`spec.verifier.script must be a non-empty string`);
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    failDriver(`spec.verifier.script must be a bare filename inside scripts/ (got '${name}')`);
  }
  const candidate = join(SCRIPTS_DIR, name);
  let resolved;
  try {
    resolved = realpathSync(candidate);
  } catch (err) {
    failDriver(`spec.verifier.script '${name}' could not be resolved: ${err.message}`);
  }
  if (!resolved.startsWith(SCRIPTS_DIR_REAL + sep) && resolved !== SCRIPTS_DIR_REAL) {
    failDriver(`spec.verifier.script '${name}' resolves outside scripts/ (symlink escape)`);
  }
  // Return the realpath (not the unresolved candidate) so `spawnSync` runs
  // the exact path the containment check just validated. Returning
  // `candidate` would leave a TOCTOU window: an attacker who can swap a
  // symlink inside scripts/ between the realpath check above and the
  // spawn below could redirect execution outside the dir. Using
  // `resolved` resolves the symlink once, at check time, and pins the
  // execution target.
  return resolved;
}

// Recursive strip — `_journal.validateRecord` walks the entire tree and
// fail-closes on denylisted keys at any depth. The driver's stdout (which
// feeds skill prose, including verbatim user_message print) must follow the
// same posture: a verifier emitting `{outcome: "ok", details: {api_key: …}}`
// would otherwise leak the nested key through `diagnostic_delta` even though
// the journal record itself would later be rejected.
//
// Prototype-pollution guard: `JSON.parse` materializes `__proto__` as a
// regular own property, which `Object.entries` then enumerates. A bare
// `out[k] = …` assignment with `k === "__proto__"` re-sets the prototype
// of the local `out` object — a textbook prototype-pollution sink. We skip
// the three constructor-related keys (`__proto__`, `constructor`,
// `prototype`) explicitly before the denylist check.
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function stripDenylist(value) {
  if (Array.isArray(value)) return value.map(stripDenylist);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PROTOTYPE_POLLUTION_KEYS.has(k)) continue;
      if (SECRET_KEY_DENYLIST.test(k)) continue;
      out[k] = stripDenylist(v);
    }
    return out;
  }
  return value;
}

function selectBranch(outcome, branches) {
  if (branches && Object.prototype.hasOwnProperty.call(branches, outcome)) {
    return { matched: true, branch: branches[outcome] };
  }
  if (branches && Object.prototype.hasOwnProperty.call(branches, 'other')) {
    return { matched: true, branch: branches.other };
  }
  return {
    matched: false,
    branch: {
      branch_id: 'unclassified',
      journal_action_tag: 'verify-unclassified',
      user_message: `Verifier returned outcome '${outcome}' — unrecognized; no branch matched.`,
    },
  };
}

(async () => {
  // ---------------- Stdin parse ----------------
  let envelope;
  try {
    envelope = JSON.parse(readStdin());
  } catch (err) {
    failDriver(`stdin is not valid JSON: ${err.message}`);
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    failDriver(`stdin must be a JSON object`);
  }
  const spec = envelope.spec;
  const payloads = envelope.payloads || {};
  const context = envelope.context || {};
  if (!spec || typeof spec !== 'object') failDriver(`stdin.spec missing or not an object`);
  if (!spec.verifier || typeof spec.verifier !== 'object') failDriver(`spec.verifier missing or not an object`);
  if (!spec.success || typeof spec.success !== 'object') failDriver(`spec.success missing or not an object`);
  if (typeof spec.success.field !== 'string' || spec.success.field.length === 0) {
    failDriver(`spec.success.field must be a non-empty string`);
  }
  if (!Array.isArray(spec.success.values)) failDriver(`spec.success.values must be an array`);
  if (spec.branches !== undefined && (typeof spec.branches !== 'object' || Array.isArray(spec.branches))) {
    failDriver(`spec.branches must be an object when present`);
  }

  // ---------------- Verifier path sanitize ----------------
  const scriptPath = sanitizeScriptName(spec.verifier.script);

  // ---------------- Interpolate verifier args against context ----------------
  const rawArgs = Array.isArray(spec.verifier.args) ? spec.verifier.args : [];
  const verifierArgs = rawArgs.map((a) => interpolate(a, context));

  // ---------------- Resolve stdin source ----------------
  const stdinSource = spec.verifier.stdin_source;
  let verifierStdin = '';
  if (stdinSource !== null && stdinSource !== undefined) {
    if (typeof stdinSource !== 'string') {
      failDriver(`spec.verifier.stdin_source must be a string or null`);
    }
    if (!Object.prototype.hasOwnProperty.call(payloads, stdinSource)) {
      failDriver(`spec.verifier.stdin_source '${stdinSource}' not present in stdin.payloads`);
    }
    try {
      verifierStdin = JSON.stringify(payloads[stdinSource]);
    } catch (err) {
      failDriver(`failed to serialize payloads['${stdinSource}']: ${err.message}`);
    }
  }

  // ---------------- Spawn verifier ----------------
  const res = spawnSync(process.execPath, [scriptPath, ...verifierArgs], {
    input: verifierStdin,
    encoding: 'utf8',
    shell: false,
  });
  if (res.error) {
    failDriver(`failed to spawn verifier '${spec.verifier.script}': ${res.error.message}`);
  }
  if (res.status !== 0) {
    if (res.stderr) process.stderr.write(res.stderr);
    failDriver(`verifier '${spec.verifier.script}' exited ${res.status}`);
  }

  // ---------------- Parse verifier stdout ----------------
  const trimmed = (res.stdout || '').trim();
  if (trimmed === '') {
    failDriver(`verifier '${spec.verifier.script}' produced no stdout`);
  }
  let verifierOut;
  try {
    verifierOut = JSON.parse(trimmed);
  } catch (err) {
    failDriver(`verifier '${spec.verifier.script}' stdout is not valid JSON: ${err.message}`);
  }
  if (!verifierOut || typeof verifierOut !== 'object' || Array.isArray(verifierOut)) {
    failDriver(`verifier '${spec.verifier.script}' stdout must be a JSON object (got ${Array.isArray(verifierOut) ? 'array' : verifierOut === null ? 'null' : typeof verifierOut})`);
  }
  // The success.field key MUST be present in the verifier's stdout. If
  // absent, `outcome` would be `undefined` and the driver would silently
  // route through `branches.other` (or synthesize `unclassified`), exiting
  // 0 — the exact silent-misclassification mode the non-object check above
  // exists to prevent. Treat "field missing" the same way: fail loudly so a
  // future verifier-output drift can't masquerade as a recovery branch.
  if (!Object.prototype.hasOwnProperty.call(verifierOut, spec.success.field)) {
    failDriver(`verifier '${spec.verifier.script}' stdout missing required field '${spec.success.field}' (driver cannot classify an outcome that isn't present)`);
  }

  // ---------------- Classify ----------------
  const outcome = verifierOut[spec.success.field];
  const isSuccess = spec.success.values.some((v) => v === outcome);

  // diagnostic_delta = verifier output minus the success.field key, denylist-stripped.
  const rawDelta = { ...verifierOut };
  delete rawDelta[spec.success.field];
  const diagnosticDelta = stripDenylist(rawDelta);

  if (isSuccess) {
    process.stdout.write(JSON.stringify({
      result: 'success',
      verifier_outcome: outcome,
      branch_id: null,
      journal_action_tags: [],
      user_message: null,
      diagnostic_delta: diagnosticDelta,
    }) + '\n');
    return;
  }

  // Failure path: pick the matching branch (or `other`, or synthesized unclassified).
  const { branch } = selectBranch(outcome, spec.branches);
  if (!branch || typeof branch !== 'object') {
    failDriver(`branch entry for outcome '${outcome}' is not an object`);
  }
  const branchId = typeof branch.branch_id === 'string' ? branch.branch_id : 'unclassified';
  const tag = typeof branch.journal_action_tag === 'string' ? branch.journal_action_tag : 'verify-unclassified';
  const messageTemplate = typeof branch.user_message === 'string' ? branch.user_message : null;
  // Interpolation map (delta wins on collisions with context; the outcome
  // value is also bound under its actual field name so a user_message like
  // `state is now {{name}}` reads naturally when `success.field === "name"`).
  const interpolationVars = {
    ...context,
    ...diagnosticDelta,
    outcome,
    [spec.success.field]: outcome,
  };
  const userMessage = messageTemplate !== null ? interpolate(messageTemplate, interpolationVars) : null;

  process.stdout.write(JSON.stringify({
    result: 'failure',
    verifier_outcome: outcome,
    branch_id: branchId,
    journal_action_tags: [tag],
    user_message: userMessage,
    diagnostic_delta: diagnosticDelta,
  }) + '\n');
})().catch((err) => {
  console.error(`verify-recover: ${err.message || err}`);
  process.exit(1);
});
