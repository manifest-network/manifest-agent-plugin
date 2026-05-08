#!/usr/bin/env node
'use strict';

/**
 * Render a `get_providers` MCP response as a Markdown provider table.
 *
 * The MCP tool returns `{ providers: [{ uuid, address, payoutAddress,
 * metaHash, active, apiUrl }, ...] }` per the
 * `liftedinit.sku.v1.Provider` proto. The renderer surfaces the four
 * fields users actually care about (UUID, address, API URL, active);
 * `payoutAddress` and `metaHash` are intentionally omitted — they're
 * not actionable for an agent picking a provider, and surfacing
 * `metaHash` (a Uint8Array) requires a hex-encode the script doesn't
 * own. If those become useful later, add columns here.
 *
 * Stdin (JSON object): the raw `get_providers` response.
 *
 * Output (stdout, Markdown):
 *   ### Providers (<count>)
 *
 *   | UUID | Address | API URL | Active |
 *   |---|---|---|---|
 *   | <uuid> | <address> | <apiUrl> | yes/no |
 *
 * Empty `providers[]` renders `(no providers registered)` instead of an
 * empty table. The script does not sort — chain order is preserved so
 * adjacent calls render the same row order until the chain itself
 * reorders.
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

  if (!payload || typeof payload !== 'object') {
    console.error('expected a JSON object on stdin');
    process.exit(1);
  }

  const providers = Array.isArray(payload.providers) ? payload.providers : [];

  const lines = [];
  lines.push(`### Providers (${providers.length})`);
  lines.push('');

  if (providers.length === 0) {
    lines.push('(no providers registered)');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  lines.push('| UUID | Address | API URL | Active |');
  lines.push('|---|---|---|---|');
  for (const p of providers) {
    const uuid = typeof p.uuid === 'string' && p.uuid ? p.uuid : '(unknown)';
    const address = typeof p.address === 'string' && p.address ? p.address : '(unknown)';
    const apiUrl = typeof p.apiUrl === 'string' && p.apiUrl ? p.apiUrl : '(unknown)';
    const active = p.active === true ? 'yes' : p.active === false ? 'no' : '(unknown)';
    lines.push(`| ${uuid} | ${address} | ${apiUrl} | ${active} |`);
  }

  process.stdout.write(lines.join('\n') + '\n');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
