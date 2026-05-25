'use strict';

/**
 * Regression test pinning skills/restart-app/SKILL.md's inline LeaseState
 * enum check.
 *
 * BACKGROUND
 *
 * Pre-rewire, `scripts/_lease-state.cjs` was the single source of truth
 * for the Cosmos LeaseState integer ↔ name mapping. Its companion test
 * (`tests/_lease-state.test.cjs`) verified the canonical table:
 *
 *   0: LEASE_STATE_UNSPECIFIED
 *   1: LEASE_STATE_PENDING
 *   2: LEASE_STATE_ACTIVE          ← the only restart-eligible value
 *   3: LEASE_STATE_INSUFFICIENT_FUNDS
 *   4: LEASE_STATE_CLOSED
 *
 * Post-ENG-130 both files were deleted (per the architect's #14
 * delete-sweep): the only remaining plugin-side consumer was
 * restart-app's Step 6 post-restart verifier, and that was rewired to
 * an inline check (drops the verify-recover envelope per the same
 * task).
 *
 * The inline rewrite landed with `state === 1` instead of `state === 2`
 * (an off-by-one inversion the architect's task description mirrored).
 * The skill was effectively broken: restart refused healthy leases
 * (state 2) and would have accepted PENDING leases (state 1). PR #9's
 * Copilot review caught it.
 *
 * This test exists specifically to prevent the same inversion from
 * re-landing. It reads the skill markdown and pins the enum value at
 * each of the three sites where the comparison appears (Step 2
 * pre-check, Step 6 post-verify, Step 7 journal record). If a future
 * contributor flips any of them back to `=== 1` (or to any value
 * other than `=== 2`), this test will fail.
 *
 * CONTRACT
 *
 * - Match every `<bareword> === <int-literal>` and `<bareword> === '<quoted-string>'`
 *   in the SKILL.md where the LHS bareword is one of the restart-app
 *   skill's known state bindings (`STATE`, `POST_STATE`, or — defensive
 *   against future renames — anything containing the substring `STATE`).
 * - Every such comparison whose RHS is an INT must have RHS === 2.
 *   (No other int compare to a STATE-bound name is currently valid in
 *   this skill; the prose tour through the enum table uses a non-code
 *   form.)
 * - Every such comparison whose RHS is a string must equal
 *   `'LEASE_STATE_ACTIVE'`.
 *
 * The skill MAY also reference other enum values in narrative prose
 * (e.g. the canonical enum table block listing 0=UNSPECIFIED through
 * 4=CLOSED). Those are inside a fenced code block, not in an `===`
 * comparison, and are intentionally excluded from this pin.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const SKILL_PATH = join(__dirname, '..', 'skills', 'restart-app', 'SKILL.md');
const SKILL = readFileSync(SKILL_PATH, 'utf8');

// Match `<bareword> === <int|'string'>` where the bareword's name
// contains `STATE`. The pattern intentionally allows backticks on
// either side (the skill prose wraps inline code with `…`).
//
// The character class for the bareword is conservative: ASCII letters,
// digits, underscore. RHS captures either a bare integer or a
// single-quoted string literal.
const STATE_COMPARE_RE = /`?\b([A-Za-z_][A-Za-z0-9_]*STATE[A-Za-z0-9_]*)\b\s*===\s*(?:(\d+)|'([^']+)')`?/g;

test('restart-app SKILL.md compares STATE-bound bindings against the canonical LEASE_STATE_ACTIVE value (int 2 / string "LEASE_STATE_ACTIVE")', () => {
  const matches = [...SKILL.matchAll(STATE_COMPARE_RE)];
  assert.ok(
    matches.length >= 3,
    `expected at least 3 STATE === ... sites in the skill (Step 2 pre-check, Step 6 post-verify, Step 7 journal); found ${matches.length}. ` +
    'If the skill was restructured, audit each compare site by hand before relaxing this threshold.',
  );

  const violations = [];
  for (const match of matches) {
    const [whole, lhs, intRhs, stringRhs] = match;
    if (intRhs !== undefined) {
      // Integer RHS — must be 2 (LEASE_STATE_ACTIVE per the canonical enum).
      if (intRhs !== '2') {
        violations.push(
          `Found \`${lhs} === ${intRhs}\` — expected \`${lhs} === 2\` (LEASE_STATE_ACTIVE per the canonical Cosmos lease enum: 0=UNSPECIFIED, 1=PENDING, 2=ACTIVE, 3=INSUFFICIENT_FUNDS, 4=CLOSED).`,
        );
      }
    } else if (stringRhs !== undefined) {
      // String RHS — must be 'LEASE_STATE_ACTIVE'.
      if (stringRhs !== 'LEASE_STATE_ACTIVE') {
        violations.push(
          `Found \`${lhs} === '${stringRhs}'\` — expected \`${lhs} === 'LEASE_STATE_ACTIVE'\` (canonical Cosmos lease-state string form).`,
        );
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    'restart-app SKILL.md has stale enum compares:\n  ' + violations.join('\n  '),
  );
});

test('restart-app SKILL.md handles both encoding forms (int 2 AND string "LEASE_STATE_ACTIVE")', () => {
  // The chain returns either the integer form or the canonical string
  // form depending on the encoding path. The skill MUST handle both;
  // pre-rewire `_lease-state.cjs#decode()` was the dual-form arbiter.
  // Post-rewire the inline check must cover both — verify the skill
  // mentions both forms in the same compare context.
  assert.match(
    SKILL,
    /STATE\s*===\s*2\s*\|\|\s*STATE\s*===\s*'LEASE_STATE_ACTIVE'/,
    'Step 2 pre-check must compare STATE against both 2 (int) and "LEASE_STATE_ACTIVE" (string) — the chain returns either form depending on the encoding path.',
  );
  assert.match(
    SKILL,
    /POST_STATE\s*===\s*2\s*\|\|\s*POST_STATE\s*===\s*'LEASE_STATE_ACTIVE'/,
    'Step 6 post-verify must compare POST_STATE against both forms.',
  );
});

test('restart-app SKILL.md does NOT use the inverted (pre-fix) `=== 1` pattern anywhere on a STATE binding', () => {
  // Belt-and-suspenders: even if STATE_COMPARE_RE drifted, this direct
  // grep guards against the specific historical inversion.
  const invertedHits = [...SKILL.matchAll(/`?\b[A-Za-z_]*STATE[A-Za-z0-9_]*\b\s*===\s*1\b/g)];
  assert.equal(
    invertedHits.length,
    0,
    'restart-app SKILL.md uses the inverted enum form `STATE === 1` (LEASE_STATE_PENDING) where it should use `=== 2` (LEASE_STATE_ACTIVE). ' +
    `Hits: ${invertedHits.map((m) => m[0]).join(', ')}`,
  );
});
