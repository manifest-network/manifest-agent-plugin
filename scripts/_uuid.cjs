'use strict';

/**
 * UUID-shaped regex (8-4-4-4-12 lowercase hex with dashes), shared across
 * scripts. Permissive on the version byte: accepts any hex value, including
 * v6/v7/v8 and v0. Chain-issued lease UUIDs are v4 today, but the regex is
 * intentionally lenient so a future chain version-byte change doesn't break
 * validation.
 *
 * Used to validate chain-issued lease UUIDs before joining them into file
 * paths under ~/.manifest-agent/manifests/. Without this guard a malicious
 * value containing path separators or `..` could escape the manifests
 * directory and overwrite agent state (e.g. config.json).
 *
 * Two forms:
 *   UUID_RE       — anchored. Use for strict-equality validation.
 *   UUID_PATTERN  — unanchored. Use to extract a UUID embedded in a
 *                   longer string (e.g. parsing
 *                   "Deploy partially succeeded: lease <uuid>...").
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

module.exports = { UUID_RE, UUID_PATTERN, isUuid };
