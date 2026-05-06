#!/usr/bin/env node
'use strict';

/**
 * Save a structured manifest spec (the input shape for build_manifest_preview /
 * deploy_app) as a user-managed draft file under
 * $MANIFEST_PLUGIN_DATA/manifests-drafts/.
 *
 * The user can later pass that file path to /manifest-agent:deploy-app, edit
 * it by hand, version-control it, etc. It is the user-facing "deployment spec"
 * file for this plugin.
 *
 * Stdin (JSON object): the structured spec, e.g.
 *   { image, port, env?, ... }            (single-service)
 *   { services: { <name>: { image, ports, env?, ... } } }   (multi-service)
 *
 * Args:
 *   --path <abs-path>   (optional) full file path to write to. Must be
 *                       absolute and resolve inside $MANIFEST_PLUGIN_DATA/manifests-drafts/
 *                       or the system tmpdir; any other location is rejected.
 *                       Parent dir must already exist UNLESS the path is
 *                       inside the drafts dir (which is auto-created).
 *                       If omitted, defaults to
 *                       $MANIFEST_PLUGIN_DATA/manifests-drafts/<auto-name>.json
 *                       where <auto-name> derives from the first image and a
 *                       timestamp (e.g. nginx-1-27-2026-05-01T13-30-00.json).
 *
 * Output (stdout): the absolute path of the file written.
 *
 * File mode: 0600. Parent dir mode: 0700. Atomic write via tmpfile + rename.
 *
 * Safety: refuses to overwrite an existing file at --path to avoid clobbering
 * a user-edited spec. Use a different --path or remove the existing file.
 */

const { existsSync, readFileSync, mkdirSync, chmodSync } = require('node:fs');
const { join, isAbsolute, resolve, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { atomicWrite, getDataDir } = require('./_io.cjs');
const { firstImage } = require('./_spec.cjs');

function isAllowedPath(p, allowedDirs) {
  const r = resolve(p);
  return allowedDirs.some((d) => r.startsWith(d));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--path' && argv[i + 1]) { args.path = argv[++i]; }
  }
  return args;
}

function sanitize(s) {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function autoName(spec) {
  const image = firstImage(spec);
  // Trim digest / tag punctuation for a cleaner filename.
  let stem;
  if (image) {
    const noScheme = image.split('://').pop();
    const noDigest = noScheme.split('@')[0];
    const lastSlash = noDigest.lastIndexOf('/');
    const tail = lastSlash >= 0 ? noDigest.slice(lastSlash + 1) : noDigest;
    stem = sanitize(tail).replace(/:/g, '-') || 'manifest';
  } else {
    stem = 'manifest';
  }
  const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '').replace(/Z$/, '');
  return `${stem}-${ts}.json`;
}

(async () => {
  const args = parseArgs(process.argv);

  // getDataDir() throws when MANIFEST_PLUGIN_DATA is unset; calling it here
  // (inside the IIFE) routes through the .catch handler so the user sees the
  // helper's friendly error message instead of a raw Node exception trace.
  const AGENT_DIR = getDataDir();
  const DRAFTS_DIR = join(AGENT_DIR, 'manifests-drafts');
  // User-supplied --path is restricted to the drafts dir or the system tmpdir
  // (the latter so author-manifest can stage a spec for env-merge before the
  // user picks a final location). An unbounded --path would let a compromised
  // or buggy agent overwrite $MANIFEST_PLUGIN_DATA/config.json or any other
  // plugin state. Mirrors merge-env.cjs's ALLOWED_DIRS pattern.
  const ALLOWED_DIRS = [
    resolve(DRAFTS_DIR) + sep,
    resolve(tmpdir()) + sep,
  ];

  const raw = readFileSync(0, 'utf8');
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    console.error('stdin must be a JSON object');
    process.exit(1);
  }

  let outPath;
  if (args.path) {
    if (!isAbsolute(args.path)) {
      console.error(`--path must be absolute; got "${args.path}"`);
      process.exit(1);
    }
    if (!isAllowedPath(args.path, ALLOWED_DIRS)) {
      console.error(`--path must resolve inside ${DRAFTS_DIR} or the system tmpdir; got "${args.path}"`);
      process.exit(1);
    }
    outPath = args.path;
  } else {
    outPath = join(DRAFTS_DIR, autoName(spec));
  }

  // If writing into the default drafts dir, ensure it exists and is mode 0700.
  if (outPath.startsWith(DRAFTS_DIR + sep)) {
    mkdirSync(DRAFTS_DIR, { recursive: true, mode: 0o700 });
    chmodSync(DRAFTS_DIR, 0o700);
  }

  if (existsSync(outPath)) {
    console.error(`Refusing to overwrite existing file: ${outPath}\nChoose a different --path or remove the existing file.`);
    process.exit(1);
  }

  atomicWrite(outPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(outPath);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
