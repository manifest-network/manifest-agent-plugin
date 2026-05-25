'use strict';

/**
 * Regression guard pinning skills/restart-app/SKILL.md's LeaseState
 * decode strategy.
 *
 * BACKGROUND
 *
 * The canonical Cosmos LeaseState integer ↔ name mapping lives in
 * `scripts/_lease-state.cjs` and is exposed as a CLI by
 * `scripts/decode-lease-state.cjs`. The companion test at
 * `tests/_lease-state.test.cjs` pins every encoding form the chain
 * may return (int, stringy-int, canonical `LEASE_STATE_*` string,
 * unrecognized → undefined).
 *
 * During ENG-130's delete sweep, the architect's #14 task inlined
 * restart-app's state decode into skill prose and removed the helper
 * + its test. The inline rewrite landed with two consecutive bugs
 * (`STATE === 1` instead of `=== 2`; missing the stringy-int form),
 * both caught only by PR #9's Copilot review. The team's post-mortem
 * concluded that canonical deterministic decoders belong in tested
 * CJS scripts, not in prose ("Hindsight from ENG-130" in CLAUDE.md's
 * Scripts-vs-prose section; "delete orchestration; keep primitives").
 *
 * Post-restore the skill shells out to `decode-lease-state.cjs` and
 * compares the DECODED name string against the canonical
 * `"LEASE_STATE_ACTIVE"`. No integer literals, no encoding-form
 * gymnastics in the skill prose.
 *
 * This test pins that arrangement. If a future contributor re-inlines
 * the decode (e.g. drops the helper call and writes `STATE === 2 ||
 * STATE === 'LEASE_STATE_ACTIVE'` directly in the skill), the
 * positive assertion fires. If they inline-compare any STATE-bound
 * name against an integer literal (the original bug class), the
 * negative assertion fires.
 *
 * CONTRACT
 *
 * 1. POSITIVE: the skill MUST invoke `decode-lease-state.cjs` at
 *    least twice (Step 2 pre-check + Step 6 post-verify).
 * 2. NEGATIVE: the skill MUST NOT contain any literal `<STATE-bound
 *    name> === <integer>` comparison anywhere. Comparing the
 *    DECODED name against the canonical string
 *    `"LEASE_STATE_ACTIVE"` is allowed and is the intended pattern.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const SKILL_PATH = join(__dirname, '..', 'skills', 'restart-app', 'SKILL.md');
const SKILL = readFileSync(SKILL_PATH, 'utf8');

test('restart-app SKILL.md invokes scripts/decode-lease-state.cjs at the pre-check + post-verify sites', () => {
  // Count the invocations rather than just `assert.match(...)` so a
  // future restructure that accidentally consolidates them into a
  // single call (or drops one) gets caught.
  const calls = SKILL.match(/scripts\/decode-lease-state\.cjs/g) || [];
  assert.ok(
    calls.length >= 2,
    `Expected at least 2 invocations of scripts/decode-lease-state.cjs in skills/restart-app/SKILL.md ` +
    `(Step 2 pre-check + Step 6 post-verify); found ${calls.length}. ` +
    'If the skill was restructured, audit each state-decode site by hand. Re-inlining the decode is the ' +
    'failure mode PR #9 caught; see the "Hindsight from ENG-130" callout in CLAUDE.md.',
  );
});

test('restart-app SKILL.md does NOT inline integer-literal comparisons against STATE-bound names', () => {
  // Match `<bareword-containing-STATE> === <integer>` anywhere. The
  // post-restore skill compares the DECODED name string against
  // 'LEASE_STATE_ACTIVE' (a string compare on a different binding,
  // `STATE_NAME` / `POST_STATE_NAME`); integer compares against
  // STATE-bound names are the pre-fix inlining pattern and must not
  // re-appear.
  //
  // Backticks on either side allowed (skill prose wraps inline code
  // with `…`). The character class for the bareword is conservative
  // (ASCII letters + digits + underscore).
  // Leading char-class is `*` (zero-or-more), NOT `+` (one-or-more), so
  // that the bare `STATE` binding — which is the exact shape the
  // original Copilot bug had (`STATE === 1`) and which the skill still
  // binds at Step 2 — is matched. A mandatory leading character would
  // skip bare `STATE` and let the historical bug shape re-enter
  // undetected; QA caught this gap on the prior `2c000bd` revision.
  const inlineIntComparePattern = /`?\b[A-Za-z_]*STATE[A-Za-z0-9_]*\b\s*===\s*\d+\b/g;
  const hits = [...SKILL.matchAll(inlineIntComparePattern)].map((m) => m[0]);
  assert.equal(
    hits.length,
    0,
    `restart-app SKILL.md re-inlines a state-decode integer comparison: ${hits.join(', ')}. ` +
    'Post-ENG-130, the decode lives in scripts/decode-lease-state.cjs (with companion test at ' +
    'tests/_lease-state.test.cjs). The skill should shell out and compare the DECODED .name field ' +
    'against the canonical "LEASE_STATE_ACTIVE" string. See CLAUDE.md "Hindsight from ENG-130" for ' +
    'the rationale (delete orchestration; keep primitives).',
  );
});

test('restart-app SKILL.md compares the decoded name against the canonical "LEASE_STATE_ACTIVE" string', () => {
  // Positive existence check — the skill must somewhere compare a
  // `*_NAME`-suffixed binding (or any STATE-bound binding) against
  // the canonical name string. This catches the case where someone
  // drops the helper call AND the name-comparison, leaving no
  // state-eligibility check at all.
  assert.match(
    SKILL,
    /STATE_NAME\s*===\s*["']LEASE_STATE_ACTIVE["']/,
    'restart-app SKILL.md must compare a *_NAME binding (e.g. STATE_NAME or POST_STATE_NAME) ' +
    'against the canonical "LEASE_STATE_ACTIVE" string — the post-decode eligibility gate. ' +
    'If this assertion fires, the skill either dropped the eligibility check or renamed the ' +
    'binding in a way that breaks the convention.',
  );
});
