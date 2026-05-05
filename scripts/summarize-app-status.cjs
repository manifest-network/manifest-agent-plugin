#!/usr/bin/env node
'use strict';

/**
 * Render the "Status" section of the troubleshoot-deployment report from
 * an `app_status` MCP response.
 *
 * Pins the typed-shape extraction (lease state decode, connection URL walk,
 * providerError/connectionError surfacing, fredStatus key dump) so the
 * report wording stays consistent across runs.
 *
 * The fuzzy diagnostic interpretation that needs LLM judgment (the
 * suggested-actions table in troubleshoot-deployment, which maps signals
 * like `provision_status: image_pull_failed` to recovery suggestions)
 * stays in prose — this script handles only the deterministic structural
 * extraction.
 *
 * Two entry points:
 *   - CLI: read JSON from stdin, write Markdown to stdout. Used directly
 *     by skills today.
 *   - Module export `renderStatusSection(s)`: returns the Markdown body
 *     as a string. Used by `render-troubleshoot-report.cjs` to compose
 *     the larger multi-section report without spawning a subprocess.
 *
 * Stdin (JSON object): the `app_status` response. Expected shape (fields
 * are defensive — missing fields render with placeholder lines):
 *   {
 *     lease_uuid?,
 *     chainState?: { providerUuid?, state? },
 *     connection?,
 *     providerError?,
 *     connectionError?,
 *     fredStatus?: { ... }
 *   }
 *
 * Output (stdout): a Markdown block ready to print under a "### Status"
 * heading. The skill prose owns the heading; the script owns the body.
 * The body always contains a `- Terminal: yes/no` line so consumers (the
 * suggestion-table prose in troubleshoot-deployment Step 5, the
 * post-broadcast verification in Step 6) can branch on the flag without
 * re-decoding the chain state themselves.
 */

const { readFileSync } = require('node:fs');
const { decode: decodeLeaseState, isTerminal } = require('./_lease-state.cjs');
const { extractRunningEndpoints, formatEndpointAsUrl } = require('./_connection.cjs');

function renderStatusSection(s) {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) {
    throw new Error('app_status must be a JSON object');
  }

  const lines = [];
  lines.push(`- Lease UUID: ${s.lease_uuid || '(not set in response)'}`);

  const chainState = s.chainState && typeof s.chainState === 'object' ? s.chainState : {};
  if (chainState.providerUuid) {
    lines.push(`- Provider UUID: ${chainState.providerUuid}`);
  } else {
    lines.push('- Provider UUID: (not set in response)');
  }

  let terminal = false;
  if (chainState.state !== undefined) {
    const decoded = decodeLeaseState(chainState.state);
    if (decoded) {
      terminal = isTerminal(decoded);
      const terminalNote = terminal ? ' [terminal — no further transitions]' : '';
      lines.push(`- Lease state: ${decoded} (raw: ${chainState.state})${terminalNote}`);
    } else {
      lines.push(`- Lease state: UNKNOWN (raw: ${chainState.state})`);
    }
  } else {
    lines.push('- Lease state: (not set in response)');
  }
  lines.push(`- Terminal: ${terminal ? 'yes' : 'no'}`);

  const endpoints = extractRunningEndpoints(s.connection);
  if (endpoints.length > 0) {
    lines.push('- URL(s):');
    for (const ep of endpoints) {
      const url = formatEndpointAsUrl(ep);
      if (url) lines.push(`  - ${url}`);
    }
  } else {
    lines.push('- URL(s): (none — service is internal, not yet running, or no FQDN reported)');
  }

  if (typeof s.providerError === 'string' && s.providerError.length > 0) {
    lines.push('', '**Provider error** (surfaced from app_status):', '```', s.providerError, '```');
  }
  if (typeof s.connectionError === 'string' && s.connectionError.length > 0) {
    lines.push('', '**Connection error** (surfaced from app_status):', '```', s.connectionError, '```');
  }

  if (s.fredStatus && typeof s.fredStatus === 'object' && !Array.isArray(s.fredStatus)) {
    const populated = Object.entries(s.fredStatus).filter(([, v]) => {
      if (v === null || v === undefined) return false;
      if (typeof v === 'string' && v.length === 0) return false;
      if (Array.isArray(v) && v.length === 0) return false;
      return true;
    });
    if (populated.length > 0) {
      lines.push('', '**Fred status** (non-empty fields):');
      for (const [k, v] of populated) {
        const rendered = typeof v === 'object' ? JSON.stringify(v) : String(v);
        lines.push(`- ${k}: ${rendered}`);
      }
    }
  }

  return lines.join('\n');
}

module.exports = { renderStatusSection };

// CLI entry — only run when invoked directly, not when require()'d as a module.
if (require.main === module) {
  (async () => {
    const raw = readFileSync(0, 'utf8');
    let s;
    try {
      s = JSON.parse(raw);
    } catch (err) {
      console.error(`stdin is not valid JSON: ${err.message}`);
      process.exit(1);
    }
    console.log(renderStatusSection(s));
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
