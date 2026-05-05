'use strict';

/**
 * UUID v1–v5 / unspecified-version regex, shared across scripts.
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
