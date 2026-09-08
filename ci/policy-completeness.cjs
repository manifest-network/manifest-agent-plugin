#!/usr/bin/env node
'use strict';

/**
 * PreToolUse policy-completeness check (ENG-213 Check 2).
 *
 * Closes the PR #9 R3 gap (a tool present in the PreToolUse matcher but
 * missing from the runtime-policy heredoc) AND — per ENG-214 principle #6
 * (sweep ALL sites with the same enumeration) — machine-enforces that the
 * gated-tool list stays in sync across the doc sites that restate it.
 *
 * SOURCE OF TRUTH: the `hooks/hooks.json` PreToolUse matcher.
 *
 * Three assertions:
 *
 *   1. session-start.sh naming (the R3 fix). Every matcher-gated tool must
 *      be "named" in scripts/session-start.sh's runtime-policy heredoc.
 *      MATCHING CONTRACT (see isNamed): a tool counts as named iff its FULL
 *      name `mcp__server__tool` appears as a plain substring, OR its SHORT
 *      name appears snake-token-bounded. This is the only correct contract:
 *        - plain `\bS\b` word-boundary FAILS (`_` is a regex word char, so
 *          `\bdeploy_app\b` matches nothing inside `...fred__deploy_app`) →
 *          false RED on a clean repo.
 *        - plain substring on the short name WRONGLY matches inside
 *          `deploy_app_orchestrated` → a lying guard that stays green after
 *          the real mention is deleted (ENG-214 #2).
 *      The ALLOW_MISSING_FROM_POLICY allowlist applies to this assertion.
 *
 *   2. CLAUDE.md gated-tools list parity (principle #6). The "Tools gated by
 *      the PreToolUse hook" bullet list in CLAUDE.md must set-equal the
 *      matcher's full names (no missing, no extra). No allowlist — the doc
 *      list must match exactly.
 *
 *   3. docs/scripts.md is EXEMPT (documented, not silently skipped): it
 *      cross-references the CLAUDE.md list rather than enumerating the
 *      tools, so there is nothing to set-compare. The live tools/list check
 *      in ci/mcp-tool-policy.cjs verifies installed MCP coverage separately.
 *
 * The four enumeration sites triangulate:
 *   matcher ↔ live tools/list (ci/mcp-tool-policy.cjs)
 *   matcher ↔ CLAUDE.md      (assertion 2 here)
 *   matcher → session-start.sh (assertion 1 here)
 *   scripts.md → cross-ref-only (exempt)
 *
 * Usage: node ci/policy-completeness.cjs   (run from the repo root)
 * Exit:  0 if all assertions hold; 1 otherwise (or on a parse error).
 */

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { matcherNames } = require('./mcp-tool-policy.cjs');

/**
 * Allowlist for assertion 1 (session-start.sh naming) ONLY.
 *
 * Entries: { tool: '<short_name>', reason: '<non-empty justification>' }.
 * Use ONLY for a legitimately-unnamed gated tool — e.g. a future tool whose
 * runtime guidance is covered solely by a cross-reference rather than a
 * direct mention. STARTS EMPTY: on baseline all gated tools are named under
 * the contract above, so the check is green with no exceptions.
 *
 * Strictness (anti-"lying-guard", ENG-214 #2), enforced by the check:
 *   - an entry with an empty/missing `reason` is a CI failure;
 *   - an entry for a tool NOT in the matcher (stale) is a CI failure;
 *   - an entry for a tool that IS actually named (dead weight) is a CI
 *     failure — forcing the exception to be removed once it's moot.
 */
const ALLOW_MISSING_FROM_POLICY = [
  // (empty — all gated tools are named in scripts/session-start.sh)
];

const CLAUDE_MD_HEADING = 'Tools gated by the PreToolUse hook';

/**
 * Parse the PreToolUse matcher into [{ full, short }].
 * Reuse the live inventory guard's exact, anchored, unique tool-name parser
 * so both policy checks reject the same malformed or permissive matchers.
 * SHORT is the substring after the last `__`.
 */
function parseMatcher(hooksJson) {
  return [...matcherNames(hooksJson)].map((full) => ({
    full,
    short: full.slice(full.lastIndexOf('__') + 2),
  }));
}

/**
 * The matching contract. A tool is "named" in `policyText` iff:
 *   - its FULL name appears as a plain substring (the only clause that can
 *     cover a full-form-only tool like deploy_app), OR
 *   - its SHORT name appears snake-token-bounded:
 *     (?<![A-Za-z0-9_]) S (?![A-Za-z0-9_])
 *     — matches a bare mention like `cosmos_tx` but NOT inside
 *     `deploy_app_orchestrated` (the `_` after `app` blocks the right
 *     boundary) nor inside `mcp__…__deploy_app` (the `_` before blocks the
 *     left boundary, which is why the full-form clause is needed).
 */
function isNamed(tool, policyText) {
  if (policyText.includes(tool.full)) return true;
  const s = tool.short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9_])${s}(?![A-Za-z0-9_])`);
  return re.test(policyText);
}

/**
 * Extract the backticked `mcp__manifest-*` tokens from CLAUDE.md's
 * "Tools gated by the PreToolUse hook" bullet list.
 *
 * Scoped to the consecutive bullet-list items following the heading; stops
 * at the first non-blank, non-bullet line (or a markdown heading). This
 * deliberately EXCLUDES the "Read-only tools and the testnet faucet
 * (`mcp__manifest-chain__request_faucet`) are intentionally not gated"
 * paragraph that follows the list — otherwise request_faucet would be
 * counted and set-equality would false-RED on baseline.
 *
 * Throws LOUDLY if the heading is absent so a heading rename FAILS the
 * check rather than silently passing with an empty list (anti-lying-guard).
 */
function extractClaudeMdGatedList(mdText) {
  const lines = mdText.split('\n');
  const headIdx = lines.findIndex((l) => l.includes(CLAUDE_MD_HEADING));
  if (headIdx === -1) {
    throw new Error(
      `extractClaudeMdGatedList: heading "${CLAUDE_MD_HEADING}" not found in CLAUDE.md — `
      + 'a heading rename must FAIL the policy-completeness check, not silently pass',
    );
  }
  const tools = [];
  let started = false;
  for (let i = headIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*[-*]\s+/.test(line)) {
      started = true;
      for (const m of line.matchAll(/`(mcp__(?:plugin_manifest-agent_)?manifest-[^`]+)`/g)) tools.push(m[1]);
      continue;
    }
    if (line.trim() === '') continue; // blank lines don't terminate the list
    if (/^#{1,6}\s/.test(line)) break; // a markdown heading ends the section
    if (started) break; // first non-blank, non-bullet line after the list ends it
    // before the list begins: intro prose under the heading — skip it
  }
  return tools;
}

/**
 * Run all three assertions against pre-loaded inputs. Pure: no file I/O, so
 * the unit test drives it with fixtures.
 *
 * { matcherTools, policyText, claudeMdList, allowlist } -> { ok, failures[] }
 */
function checkPolicyCompleteness({ matcherTools, policyText, claudeMdList, allowlist = [] }) {
  const failures = [];
  const matcherShorts = new Set(matcherTools.map((t) => t.short));

  // Allowlist hygiene (independent of naming): reasonless + not-in-matcher.
  for (const entry of allowlist) {
    if (!entry.reason || String(entry.reason).trim() === '') {
      failures.push(
        `allowlist: entry for "${entry.tool}" has no reason — every `
        + 'ALLOW_MISSING_FROM_POLICY entry must carry a non-empty justification',
      );
    }
    if (!matcherShorts.has(entry.tool)) {
      failures.push(
        `allowlist: entry for "${entry.tool}" is stale — that tool is not in the `
        + 'PreToolUse matcher; remove it from ALLOW_MISSING_FROM_POLICY',
      );
    }
  }
  // Only entries with a real reason are allowed to suppress a naming failure.
  const suppressed = new Set(
    allowlist.filter((e) => e.reason && String(e.reason).trim() !== '').map((e) => e.tool),
  );

  // Assertion 1: every gated tool named in scripts/session-start.sh.
  for (const tool of matcherTools) {
    const named = isNamed(tool, policyText);
    if (named && suppressed.has(tool.short)) {
      failures.push(
        `allowlist: entry for "${tool.short}" is stale — the tool IS named in `
        + 'scripts/session-start.sh; remove it from ALLOW_MISSING_FROM_POLICY',
      );
    } else if (!named && !suppressed.has(tool.short)) {
      failures.push(
        `policy-completeness: matcher gates "${tool.short}" but scripts/session-start.sh `
        + `names neither "${tool.full}" nor a snake-bounded "${tool.short}" `
        + `(note: a bare match inside "${tool.short}_orchestrated" does NOT count)`,
      );
    }
  }

  // Assertion 2: CLAUDE.md gated-tools list set-equality (no allowlist).
  const matcherFull = new Set(matcherTools.map((t) => t.full));
  const claudeSet = new Set(claudeMdList);
  const missing = [...matcherFull].filter((t) => !claudeSet.has(t));
  const extra = [...claudeSet].filter((t) => !matcherFull.has(t));
  if (missing.length || extra.length) {
    failures.push(
      'policy-completeness: CLAUDE.md "Tools gated by the PreToolUse hook" list drift — '
      + `missing: [${missing.join(', ')}] extra: [${extra.join(', ')}]`,
    );
  }

  return { ok: failures.length === 0, failures };
}

function main() {
  const root = process.cwd();
  let hooksJson;
  let policyText;
  let claudeMd;
  try {
    hooksJson = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
    policyText = readFileSync(join(root, 'scripts', 'session-start.sh'), 'utf8');
    claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  } catch (err) {
    console.error(`policy-completeness: cannot read inputs — ${err.message}`);
    process.exit(1);
  }

  let matcherTools;
  let claudeMdList;
  try {
    matcherTools = parseMatcher(hooksJson);
    claudeMdList = extractClaudeMdGatedList(claudeMd);
  } catch (err) {
    console.error(`policy-completeness: ${err.message}`);
    process.exit(1);
  }

  const { ok, failures } = checkPolicyCompleteness({
    matcherTools,
    policyText,
    claudeMdList,
    allowlist: ALLOW_MISSING_FROM_POLICY,
  });

  if (!ok) {
    console.error('policy-completeness: FAILED');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    `policy-completeness: OK — all ${matcherTools.length} matcher-gated tools are named in `
    + 'scripts/session-start.sh and set-equal to the CLAUDE.md gated-tools list',
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  parseMatcher,
  isNamed,
  extractClaudeMdGatedList,
  checkPolicyCompleteness,
  ALLOW_MISSING_FROM_POLICY,
};
