#!/usr/bin/env node
'use strict';

/**
 * Classify the `$ARGUMENTS` value passed to /manifest-agent:deploy-app and
 * derive service names + collision info for the image-fast-path modes.
 *
 * Pins the input dispatch state machine that was previously prose. The
 * priority order matters: spec-file existence beats image-shape detection,
 * because a path containing a colon (e.g. `/tmp/spec:v1.json`) would
 * otherwise be mis-classified as an image ref.
 *
 * Modes:
 *   "empty"        — no arguments → orchestrator drives interactive authoring
 *   "spec_file"    — argument is an existing readable file path → load it
 *   "multi_image"  — 2+ image-shaped tokens → multi-service stack fast-path
 *   "single_image" — exactly 1 image-shaped token → single-service fast-path
 *   "error"        — input matches none of the above → orchestrator stops
 *                    and surfaces `reason`
 *
 * Image reference shape: contains `:` (tag form) or `@sha256:` (digest form).
 * Plain bare names like `nginx` (no tag) match neither and are rejected;
 * users typing those should be told to add a tag explicitly.
 *
 * Service-name derivation (multi_image / single_image): strip @sha256:...
 * suffix, strip :tag suffix, take basename, lowercase, validate against
 * RFC 1123 DNS label regex. Names that don't conform have valid: false
 * and the orchestrator asks the user for a name.
 *
 * Usage:
 *   node dispatch-deploy-input.cjs --arguments "$ARGUMENTS"
 *
 * Output (stdout, single-line JSON):
 *   {
 *     "mode":      "empty" | "spec_file" | "multi_image" | "single_image" | "error",
 *     "tokens":    string[],          // post-tokenization (always present, may be empty)
 *     "spec_path": string,            // only when mode=spec_file (absolute or as-passed)
 *     "services":  Array<{
 *                    token:        string,
 *                    derived_name: string,    // empty when valid=false and derivation failed
 *                    valid:        boolean,   // RFC 1123 conformance
 *                  }>,                // only when mode=multi_image | single_image
 *     "collisions": string[],         // duplicate derived names; only when present
 *     "reason":    string             // human-readable error context for mode=error
 *   }
 */

const { existsSync, statSync } = require('node:fs');

const RFC1123_DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// "image-shaped" heuristic. Errs on inclusion: a string that LOOKS like
// an image ref always passes; the chain rejects garbage at deploy time.
function looksLikeImageRef(token) {
  if (!token) return false;
  if (token.includes('@sha256:')) return true;
  // A path-shaped string with no colon is NOT an image ref. A token like
  // "registry/name:tag" has a colon AFTER the last slash; absolute
  // filesystem paths like "/tmp/foo.json" never have a colon after their
  // last slash either, so this rule discriminates well in practice.
  const lastSlash = token.lastIndexOf('/');
  const tail = lastSlash >= 0 ? token.slice(lastSlash + 1) : token;
  return tail.includes(':');
}

function deriveServiceName(token) {
  let s = token;
  // Strip digest suffix first — it can contain `:` so must come before the
  // tag strip.
  const atIdx = s.indexOf('@sha256:');
  if (atIdx >= 0) s = s.slice(0, atIdx);
  // Strip the tag (last `:` after the last `/`).
  const lastSlash = s.lastIndexOf('/');
  const tail = lastSlash >= 0 ? s.slice(lastSlash + 1) : s;
  const colon = tail.indexOf(':');
  if (colon >= 0) s = (lastSlash >= 0 ? s.slice(0, lastSlash + 1) : '') + tail.slice(0, colon);
  // Take basename.
  const last = s.lastIndexOf('/');
  if (last >= 0) s = s.slice(last + 1);
  // Lowercase.
  s = s.toLowerCase();
  // Truncate to 63 chars per RFC 1123 (hard limit).
  if (s.length > 63) s = s.slice(0, 63);
  return s;
}

function parseArgs(argv) {
  const args = { arguments: '' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--arguments' && argv[i + 1] !== undefined) {
      args.arguments = argv[++i];
    }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  const trimmed = args.arguments.trim();

  // Mode: empty
  if (trimmed === '') {
    console.log(JSON.stringify({ mode: 'empty', tokens: [] }));
    return;
  }

  // Mode: spec_file (priority over image detection — handles paths with colons)
  if (existsSync(trimmed)) {
    let isFile = false;
    try { isFile = statSync(trimmed).isFile(); } catch { /* fall through */ }
    if (isFile) {
      console.log(JSON.stringify({ mode: 'spec_file', tokens: [trimmed], spec_path: trimmed }));
      return;
    }
    // Path exists but is a directory — fall through to error after token scan
  }

  // Tokenize: split on whitespace, drop bare `+` separators.
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0 && t !== '+');

  if (tokens.length === 0) {
    console.log(JSON.stringify({ mode: 'error', tokens: [], reason: 'arguments contained only whitespace or bare `+` separators' }));
    return;
  }

  // Classify by image-shape match across tokens.
  const imageLike = tokens.filter(looksLikeImageRef);

  if (imageLike.length === 0) {
    console.log(JSON.stringify({
      mode: 'error',
      tokens,
      reason: `argument is neither a readable file path nor a recognizable image reference: "${trimmed}". Image refs need a tag (e.g. "nginx:1.27") or digest (e.g. "ghcr.io/me/app@sha256:...").`,
    }));
    return;
  }

  if (imageLike.length !== tokens.length) {
    // Mixed: some tokens look like images, others don't. Refuse rather
    // than guess which one is the spec path or extra noise.
    console.log(JSON.stringify({
      mode: 'error',
      tokens,
      reason: `mixed input: ${imageLike.length} of ${tokens.length} tokens look like image refs but the rest do not. Pass either a single spec file path, or a list of image refs only.`,
    }));
    return;
  }

  // All image-shaped → derive names.
  const services = tokens.map((token) => {
    const derived = deriveServiceName(token);
    const valid = RFC1123_DNS_LABEL.test(derived);
    return { token, derived_name: valid ? derived : '', valid };
  });

  // Detect collisions among valid derivations.
  const counts = new Map();
  for (const svc of services) {
    if (!svc.valid) continue;
    counts.set(svc.derived_name, (counts.get(svc.derived_name) || 0) + 1);
  }
  const collisions = [];
  for (const [name, count] of counts) {
    if (count > 1) collisions.push(name);
  }

  const out = {
    mode: tokens.length === 1 ? 'single_image' : 'multi_image',
    tokens,
    services,
  };
  if (collisions.length > 0) out.collisions = collisions;
  console.log(JSON.stringify(out));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
