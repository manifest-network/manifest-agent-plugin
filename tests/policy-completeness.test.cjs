'use strict';

/**
 * Demonstrated-drift unit test for the PreToolUse policy-completeness
 * check (`ci/policy-completeness.cjs`, ENG-213 Check 2).
 *
 * The principle-#2 (ENG-214) red-green proof that the check fires on:
 *   - the R3 bug class (a tool in the matcher but missing from the
 *     session-start.sh runtime policy heredoc), and
 *   - the principle-#6 multi-site drift class (the CLAUDE.md gated-tools
 *     list falling out of sync with the matcher).
 *
 * Everything is driven with FIXTURE matcher / policy / CLAUDE.md strings
 * (no real files) so the test is hermetic and stable.
 *
 * The heart of the check is `isNamed`'s matching contract:
 *   named  <=>  the FULL name appears as a plain substring
 *              OR the SHORT name appears snake-token-bounded.
 * The four `isNamed` cases below pin that contract — especially case 2
 * (`<tool>_orchestrated` must NOT count), which is what proves the check
 * isn't a lying guard that a plain-substring strategy would create.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMatcher,
  isNamed,
  extractClaudeMdGatedList,
  checkPolicyCompleteness,
} = require('../ci/policy-completeness.cjs');

// ---------------------------------------------------------------------------
// parseMatcher
// ---------------------------------------------------------------------------

test('parseMatcher splits {full, short} from anchored alternation; short = after last __', () => {
  const hooks = {
    hooks: {
      PreToolUse: [{
        matcher: '^mcp__manifest-chain__cosmos_tx$|^mcp__manifest-lease__set_item_custom_domain$',
      }],
    },
  };
  const tools = parseMatcher(hooks);
  assert.deepEqual(tools, [
    { full: 'mcp__manifest-chain__cosmos_tx', short: 'cosmos_tx' },
    { full: 'mcp__manifest-lease__set_item_custom_domain', short: 'set_item_custom_domain' },
  ]);
});

test('plugin-scoped callable names are extracted and retain the full policy contract', () => {
  const full = 'mcp__plugin_manifest-agent_manifest-chain__cosmos_tx';
  const tools = parseMatcher({ hooks: { PreToolUse: [{ matcher: `^${full}$` }] } });
  assert.deepEqual(tools, [{ full, short: 'cosmos_tx' }]);
  const md = `Tools gated by the PreToolUse hook\n\n- \`${full}\`\n\nRead-only tools are omitted.`;
  assert.deepEqual(extractClaudeMdGatedList(md), [full]);
  assert.equal(isNamed(tools[0], `Call \`${full}\`.`), true);
});

test('parseMatcher rejects an unanchored alternative', () => {
  const hooks = { hooks: { PreToolUse: [{ matcher: '^mcp__a__b$|mcp__c__d' }] } };
  assert.throws(() => parseMatcher(hooks), /unanchored/i);
});

// ---------------------------------------------------------------------------
// isNamed — the matching contract (the heart of the blocking fix)
// ---------------------------------------------------------------------------

const DEPLOY = { full: 'mcp__manifest-fred__deploy_app', short: 'deploy_app' };
const COSMOS = { full: 'mcp__manifest-chain__cosmos_tx', short: 'cosmos_tx' };

test('isNamed case 1: present ONLY in full mcp__…__<tool> form -> NAMED (F-substring clause)', () => {
  // This is the real deploy_app baseline: there is NO bare boundaried
  // `deploy_app` anywhere in session-start.sh; it is named via the full form.
  const policy = 'Route through `mcp__manifest-fred__deploy_app` internally.';
  assert.equal(isNamed(DEPLOY, policy), true);
});

test('isNamed case 2: present ONLY as <tool>_orchestrated -> NOT named -> drift RED', () => {
  // THE lying-guard proof. A plain-substring strategy on the short name
  // would wrongly pass here ("deploy_app" ⊂ "deploy_app_orchestrated"),
  // leaving the guard green even after the real mention was deleted.
  const policy = 'The wrapper deploy_app_orchestrated handles plan + confirm.';
  assert.equal(isNamed(DEPLOY, policy), false);
  // And prove the buggy plain-substring strategy WOULD have matched:
  assert.equal(policy.includes(DEPLOY.short), true, 'sanity: plain substring is present (the trap)');
});

test('isNamed case 3: present as a bare snake-bounded short -> NAMED (S clause)', () => {
  const policy = 'For `cosmos_tx` (chain server) call cosmos_estimate_fee first.';
  assert.equal(isNamed(COSMOS, policy), true);
});

test('isNamed case 4: the chosen predicate does NOT regress to plain \\bS\\b word-boundary', () => {
  // `\bdeploy_app\b` matches NOTHING inside `...fred__deploy_app` (`_` is a
  // regex word char so there is no left boundary) and nothing inside
  // `deploy_app_orchestrated` (no right boundary). A check built on \bS\b
  // would therefore false-RED on a clean repo. Demonstrate the bug, then
  // show the F-OR-S contract gets it right.
  const policy = 'see mcp__manifest-fred__deploy_app';
  const naiveWordBoundary = new RegExp(`\\b${DEPLOY.short}\\b`);
  assert.equal(naiveWordBoundary.test(policy), false, 'demonstrates why \\bS\\b is wrong');
  assert.equal(isNamed(DEPLOY, policy), true, 'F-substring clause rescues the full-form-only case');
});

// ---------------------------------------------------------------------------
// extractClaudeMdGatedList
// ---------------------------------------------------------------------------

const CLAUDE_MD_FIXTURE = [
  '## Transaction Behavior',
  '',
  '**Tools gated by the PreToolUse hook** (add to the matcher when new tools ship):',
  '',
  '- `mcp__manifest-chain__cosmos_tx`',
  '- `mcp__manifest-fred__deploy_app`',
  '- `mcp__manifest-lease__close_lease`',
  '',
  'Read-only tools and the testnet faucet (`mcp__manifest-chain__request_faucet`) are intentionally not gated.',
  '',
  '**Something else** mentions `mcp__manifest-fred__deploy_app` again in prose.',
].join('\n');

test('extractClaudeMdGatedList collects only the bullet-list tokens, not the trailing not-gated paragraph', () => {
  const list = extractClaudeMdGatedList(CLAUDE_MD_FIXTURE);
  assert.deepEqual(list, [
    'mcp__manifest-chain__cosmos_tx',
    'mcp__manifest-fred__deploy_app',
    'mcp__manifest-lease__close_lease',
  ]);
  // request_faucet lives in a following paragraph -> must NOT be picked up,
  // otherwise set-equality with the matcher would false-RED on baseline.
  assert.ok(!list.includes('mcp__manifest-chain__request_faucet'));
});

test('extractClaudeMdGatedList throws LOUDLY when the heading is absent (heading rename must fail, not silently pass)', () => {
  const md = '## Some other section\n\n- `mcp__manifest-chain__cosmos_tx`\n';
  assert.throws(() => extractClaudeMdGatedList(md), /Tools gated by the PreToolUse hook/);
});

// ---------------------------------------------------------------------------
// checkPolicyCompleteness — integration of the three assertions
// ---------------------------------------------------------------------------

// A small self-consistent fixture: 3 matcher tools named three different
// ways (full-form-only, bare-short, both) + a matching CLAUDE.md list.
const MATCHER = [
  { full: 'mcp__manifest-fred__deploy_app', short: 'deploy_app' },        // full-form-only
  { full: 'mcp__manifest-chain__cosmos_tx', short: 'cosmos_tx' },         // bare-short
  { full: 'mcp__manifest-lease__close_lease', short: 'close_lease' },     // both
];
const POLICY_OK = [
  'The wrapper drives `mcp__manifest-fred__deploy_app` internally.',
  'For `cosmos_tx` call cosmos_estimate_fee first.',
  'Route close_lease through `mcp__manifest-lease__close_lease`.',
].join('\n');
const CLAUDE_LIST_OK = [
  'mcp__manifest-fred__deploy_app',
  'mcp__manifest-chain__cosmos_tx',
  'mcp__manifest-lease__close_lease',
];

test('GREEN: all tools named + CLAUDE.md list set-equal -> ok', () => {
  const r = checkPolicyCompleteness({
    matcherTools: MATCHER,
    policyText: POLICY_OK,
    claudeMdList: CLAUDE_LIST_OK,
    allowlist: [],
  });
  assert.equal(r.ok, true, `failures: ${r.failures.join(' | ')}`);
});

test('RED (R3 drift, assertion 1): a matcher tool missing from the policy fails; message names the tool + session-start.sh', () => {
  // Drop the cosmos_tx mention (it's the bare-short one).
  const policy = [
    'The wrapper drives `mcp__manifest-fred__deploy_app` internally.',
    'Route close_lease through `mcp__manifest-lease__close_lease`.',
  ].join('\n');
  const r = checkPolicyCompleteness({
    matcherTools: MATCHER, policyText: policy, claudeMdList: CLAUDE_LIST_OK, allowlist: [],
  });
  assert.equal(r.ok, false);
  const msg = r.failures.join('\n');
  assert.match(msg, /cosmos_tx/, 'names the offending tool');
  assert.match(msg, /session-start\.sh/, 'points at the site');
});

test('RED (R3 via _orchestrated trap): a tool present ONLY as <tool>_orchestrated fails assertion 1', () => {
  // This is the exact lying-guard scenario at the integration level: the
  // real mention deleted, only the orchestrated wrapper name left behind.
  const policy = [
    'The wrapper deploy_app_orchestrated handles plan + confirm.', // NOT the full form
    'For `cosmos_tx` call cosmos_estimate_fee first.',
    'Route close_lease through `mcp__manifest-lease__close_lease`.',
  ].join('\n');
  const r = checkPolicyCompleteness({
    matcherTools: MATCHER, policyText: policy, claudeMdList: CLAUDE_LIST_OK, allowlist: [],
  });
  assert.equal(r.ok, false, 'a bare _orchestrated mention must NOT satisfy naming');
  assert.match(r.failures.join('\n'), /deploy_app/);
});

test('RED (principle-#6 drift, assertion 2): CLAUDE.md list missing a matcher tool', () => {
  const r = checkPolicyCompleteness({
    matcherTools: MATCHER,
    policyText: POLICY_OK,
    claudeMdList: ['mcp__manifest-fred__deploy_app', 'mcp__manifest-chain__cosmos_tx'], // missing close_lease
    allowlist: [],
  });
  assert.equal(r.ok, false);
  const msg = r.failures.join('\n');
  assert.match(msg, /CLAUDE\.md/);
  assert.match(msg, /missing/);
  assert.match(msg, /close_lease/);
});

test('RED (principle-#6 drift, assertion 2): CLAUDE.md list carries an extra tool', () => {
  const r = checkPolicyCompleteness({
    matcherTools: MATCHER,
    policyText: POLICY_OK,
    claudeMdList: [...CLAUDE_LIST_OK, 'mcp__manifest-lease__bogus_extra'],
    allowlist: [],
  });
  assert.equal(r.ok, false);
  const msg = r.failures.join('\n');
  assert.match(msg, /extra/);
  assert.match(msg, /bogus_extra/);
});

// ---------------------------------------------------------------------------
// allowlist (assertion 1 only)
// ---------------------------------------------------------------------------

test('allowlist: a valid exception (unnamed tool + non-empty reason) suppresses the assertion-1 failure', () => {
  // cosmos_tx not named, but allowlisted with a reason.
  const policy = [
    'The wrapper drives `mcp__manifest-fred__deploy_app` internally.',
    'Route close_lease through `mcp__manifest-lease__close_lease`.',
  ].join('\n');
  const r = checkPolicyCompleteness({
    matcherTools: MATCHER,
    policyText: policy,
    claudeMdList: CLAUDE_LIST_OK,
    allowlist: [{ tool: 'cosmos_tx', reason: 'covered only by cross-reference for the X flow' }],
  });
  assert.equal(r.ok, true, `failures: ${r.failures.join(' | ')}`);
});

test('allowlist: a reasonless entry is itself a failure', () => {
  const policy = [
    'The wrapper drives `mcp__manifest-fred__deploy_app` internally.',
    'Route close_lease through `mcp__manifest-lease__close_lease`.',
  ].join('\n');
  const r = checkPolicyCompleteness({
    matcherTools: MATCHER,
    policyText: policy,
    claudeMdList: CLAUDE_LIST_OK,
    allowlist: [{ tool: 'cosmos_tx', reason: '' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.failures.join('\n'), /reason/i);
});

test('allowlist: a stale entry for a tool NOT in the matcher is a failure', () => {
  const r = checkPolicyCompleteness({
    matcherTools: MATCHER,
    policyText: POLICY_OK,
    claudeMdList: CLAUDE_LIST_OK,
    allowlist: [{ tool: 'not_a_real_tool', reason: 'whatever' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.failures.join('\n'), /not_a_real_tool/);
});

test('allowlist: a stale entry for a tool that IS named is a failure', () => {
  // close_lease IS named in POLICY_OK, so allowlisting it is dead weight.
  const r = checkPolicyCompleteness({
    matcherTools: MATCHER,
    policyText: POLICY_OK,
    claudeMdList: CLAUDE_LIST_OK,
    allowlist: [{ tool: 'close_lease', reason: 'no longer needed' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.failures.join('\n'), /close_lease/);
});
