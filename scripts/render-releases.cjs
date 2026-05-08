#!/usr/bin/env node
'use strict';

/**
 * Render an `app_releases` MCP response as a Markdown release table.
 *
 * The MCP tool returns `{ lease_uuid, releases: [{ version, image, status,
 * created_at }, ...] }`. Pinning the renderer in a script (rather than
 * paraphrasing in skill prose) means the column order, sort order, and
 * empty-state copy can't drift between adjacent runs.
 *
 * Stdin (JSON object): the raw `app_releases` response.
 *
 * Output (stdout, Markdown):
 *   ### Releases for <lease_uuid>
 *
 *   | Version | Image | Status | Created |
 *   |---|---|---|---|
 *   | <int> | <image> | <status> | <created_at> |
 *
 * Releases are sorted by `version` descending so the newest is first.
 * Missing optional fields (`image`, `status`, `created_at`) render as
 * `(unknown)` rather than being omitted, so the column count is stable.
 *
 * Exit codes: 0 success; 1 unparseable stdin / unrecognized shape.
 */

const { readFileSync } = require('node:fs');

(async () => {
  const raw = readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    console.error('expected a JSON object on stdin');
    process.exit(1);
  }

  const leaseUuid = typeof payload.lease_uuid === 'string' ? payload.lease_uuid : '(unknown)';
  const releases = Array.isArray(payload.releases) ? payload.releases : [];

  const lines = [];
  lines.push(`### Releases for ${leaseUuid}`);
  lines.push('');

  if (releases.length === 0) {
    lines.push('(no releases yet)');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  const sorted = releases.slice().sort((a, b) => {
    const av = typeof a.version === 'number' ? a.version : -Infinity;
    const bv = typeof b.version === 'number' ? b.version : -Infinity;
    return bv - av;
  });

  lines.push('| Version | Image | Status | Created |');
  lines.push('|---|---|---|---|');
  for (const r of sorted) {
    const version = typeof r.version === 'number' ? String(r.version) : '(unknown)';
    const image = typeof r.image === 'string' && r.image ? r.image : '(unknown)';
    const status = typeof r.status === 'string' && r.status ? r.status : '(unknown)';
    const created = typeof r.created_at === 'string' && r.created_at ? r.created_at : '(unknown)';
    lines.push(`| ${version} | ${image} | ${status} | ${created} |`);
  }

  process.stdout.write(lines.join('\n') + '\n');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
