#!/usr/bin/env node
'use strict';

/**
 * Render the full troubleshoot-deployment Markdown report from the three
 * MCP responses (app_status / app_diagnostics / get_logs) plus an optional
 * pre-rendered saved-manifest summary.
 *
 * Replaces what used to be inline prose in two skills (the
 * `/manifest-agent:troubleshoot-deployment` Step 4 report AND the
 * post-broadcast diagnostic flow in `deploy-app/references/troubleshoot-after-deploy-failure.md`).
 * Pinning the structural extraction here means the two consumers can't
 * drift apart on field labels or section ordering.
 *
 * The fuzzy "suggest next steps" interpretation (Step 5 of
 * troubleshoot-deployment) stays in prose — that's genuinely LLM-judgment
 * territory and not something to script.
 *
 * Stdin (JSON object):
 *   {
 *     "app_status":      <app_status MCP response>,
 *     "app_diagnostics": <app_diagnostics MCP response> | null,
 *     "get_logs":        <get_logs MCP response> | null,
 *     "saved_manifest":  "<pre-rendered summarize-manifest.cjs stdout>" | null
 *   }
 *
 * Any of the three MCP responses can be null (the orchestrator runs the
 * three calls in parallel and may have a partial failure — render what
 * we have).
 *
 * Output (stdout): a Markdown block with `### Status`, `### Diagnostics`,
 * `### Recent logs`, and (when supplied) `### Saved manifest` sections.
 * Print verbatim from the orchestrator; do NOT paraphrase or splice.
 */

const { readFileSync } = require('node:fs');
const { renderStatusSection } = require('./summarize-app-status.cjs');

function renderDiagnosticsSection(d) {
  if (d === null || d === undefined) {
    return '_(app_diagnostics call failed or returned null)_';
  }
  if (typeof d !== 'object' || Array.isArray(d)) {
    return '_(app_diagnostics returned unexpected shape; expected an object)_';
  }
  const lines = [];
  const ps = d.provision_status;
  if (typeof ps === 'string' && ps.length > 0) {
    lines.push(`- provision_status: \`${ps}\``);
  } else {
    lines.push('- provision_status: (not set)');
  }

  const fc = d.fail_count;
  if (typeof fc === 'number') {
    lines.push(`- fail_count: ${fc}`);
  } else {
    lines.push('- fail_count: (not set)');
  }

  const le = d.last_error;
  if (typeof le === 'string' && le.length > 0) {
    // Code fence at column 0 per CommonMark; an indented fence (>=4 spaces)
    // is rendered as an indented-code-block, and the >3 spaces that the
    // previous "  ``` " form used was unreliable across renderers.
    lines.push('- last_error:');
    lines.push('```');
    for (const lineText of le.split(/\r?\n/)) lines.push(lineText);
    lines.push('```');
  } else {
    lines.push('- last_error: (none reported)');
  }

  return lines.join('\n');
}

function renderLogsSection(l) {
  if (l === null || l === undefined) {
    return '_(get_logs call failed or returned null)_';
  }
  // Tolerate both the stringly response shape and a wrapped object shape.
  let text = null;
  if (typeof l === 'string') {
    text = l;
  } else if (l && typeof l === 'object') {
    if (typeof l.logs === 'string') text = l.logs;
    else if (typeof l.text === 'string') text = l.text;
    else if (Array.isArray(l.lines)) text = l.lines.join('\n');
  }
  if (text === null) {
    return '_(get_logs returned unexpected shape; expected string or `{logs|text|lines}`)_';
  }
  if (text.trim().length === 0) {
    return '_(no logs — container has not produced output yet)_';
  }
  return ['```', text, '```'].join('\n');
}

(async () => {
  const raw = readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    console.error('stdin must be a JSON object with app_status / app_diagnostics / get_logs / saved_manifest fields');
    process.exit(1);
  }

  const sections = [];

  sections.push('### Status');
  if (payload.app_status === null || payload.app_status === undefined) {
    sections.push('_(app_status call failed or returned null)_');
  } else {
    sections.push(renderStatusSection(payload.app_status));
  }

  sections.push('');
  sections.push('### Diagnostics');
  sections.push(renderDiagnosticsSection(payload.app_diagnostics));

  sections.push('');
  sections.push('### Recent logs');
  sections.push(renderLogsSection(payload.get_logs));

  if (typeof payload.saved_manifest === 'string' && payload.saved_manifest.trim().length > 0) {
    sections.push('');
    sections.push('### Saved manifest');
    sections.push(payload.saved_manifest);
  }

  console.log(sections.join('\n'));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
