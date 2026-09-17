# ENG-85: agent identity hardening

Issue: [ENG-85](https://linear.app/liftedinit/issue/ENG-85).

Status: merged in [PR #19](https://github.com/manifest-network/manifest-agent-plugin/pull/19)
for 0.5.0. Native macOS and Windows credential-store acceptance remains
untested because platform access is unavailable. Validation entries below
record the implementation and review runs; release acceptance is tracked in
[host-acceptance.md](host-acceptance.md).

## Implementation plan

1. Add one shared credential-store adapter for Linux Secret Service
   (`secret-tool` / libsecret), macOS Keychain, and Windows Credential Manager.
   Send passwords through stdin, verify storage by reading it back, and persist
   only a nonsecret reference in `agent.keyPasswordRef`.
2. Provide an explicit `MANIFEST_CREDENTIAL_STORE=file` fallback for headless
   environments. Keep its secrets outside config in a private directory; never
   silently replace an unavailable keychain with file storage.
3. Migrate existing plaintext config under a process lock. Store and verify the
   password before atomically removing `agent.keyPassword`; record a durable,
   one-time breadcrumb. Preserve the original config if storage fails. Coordinate
   migration with config writers and all five launchers, including Codex.
4. Extend new Claude sessions with a bounded identity report delivered through
   structured hook context and a user message (manual CLI output uses stderr):
   address, chain, gas denom, and the balance returned by the chain MCP server.
   Use exact arithmetic for the low-funds threshold (gas price × 200,000 × 2).
   Offer a faucet hint on testnet only; startup never requests funds itself.
5. Update initialization/import instructions, recovery and backup documentation,
   both host manifests and package metadata to 0.5.0; regenerate shared skills.

## Validation

- Exercise storage round trips and platform command contracts with isolated
  fakes, including hostile passwords, unavailable stores, missing entries,
  permissions, migration retries and concurrent callers.
- Exercise fresh config creation, wallet replacement, legacy migration and
  launcher resolution without ever accessing the developer's real keychain.
- Drive a mock MCP peer to cover funded/zero/boundary balances, mainnet,
  unavailable RPC, malformed replies, timeouts and stdout/secret isolation.
- Run the complete unit suite, package build, syntax and documentation checks,
  plus installed-runtime contract checks when dependencies are available.
- Record platform limitations accurately: command-contract tests do not establish
  live macOS/Windows keychain behavior. Existing host acceptance evidence remains
  historical; it does not certify this version's migration or UI behavior.

## Initial implementation validation

- Node 24.15.0: all 631 unit/integration tests passed with test concurrency 2.
- A real isolated D-Bus/GNOME Keyring session passed four libsecret flows:
  special/newline password, empty password, legacy migration and fresh
  `write-config.cjs` initialization. Synthetic wallet data and temporary XDG
  directories kept the user's keychain untouched.
- The actual pinned chain MCP initialized and reached the guarded read-only
  balance query in 2.876 seconds, inside the five-second budget. The check denied
  network access, emitted no stdout and exposed no fixture credential.
- Executable documentation: three examples passed; two network examples were
  intentionally skipped. Generated skills, version/JSON consistency, syntax and
  policy completeness passed. The generic skill validator also passed for the
  generated Codex setup/import skills; Claude-specific metadata is validated by
  this repository's package checks.
- Pinned MCP inventory: five servers, 34 tools and 12 gated mutations; all six
  numeric lease states matched the installed runtime. Shared launcher transport
  initialized the five installed servers with outbound networking disabled.
- Both-host contracts passed: five installed servers per host, 25 workflow
  tool references and six callback cases. Heavy system load caused the standard
  combined check to time out; the same assertions passed with the per-server
  discovery deadline extended from 20 to 60 seconds in a temporary harness.
  The production and committed CI deadlines were unchanged.
- Historical evidence checks passed. The Codex release gate correctly reports
  `eligible=false`: existing interactive/testnet evidence does not certify 0.5.0.

This validates implementation and local contracts. No live balance query,
faucet request, deployment, release or real-user wallet operation was performed.

## PR review follow-up

The verified [PR review](https://github.com/manifest-network/manifest-agent-plugin/pull/19#issuecomment-5701516729)
led to these corrections:

- Forward the credential selector, Linux session bus variables and Windows
  `SystemRoot` through every Codex MCP entry. The native smoke now starts with
  legacy config and checks migration and preservation across reinstall.
- Deliver startup identity and migration failures through Claude's structured
  context/user-message fields while preserving the complete runtime policy.
  Resume, clear, compact and fork skip the expensive balance probe.
- Release config locks after validation errors; use exclusive file creation and
  Linux PID start times, with serialized stale recovery and bounded diagnostics.
  Concurrent native migration failures share a short, secret-free retry marker.
- Preserve damaged configs with explicit private repair/backup instructions;
  report retained encrypted keyfiles after storage failure. Reject concurrent
  config changes during launcher startup.
- Decode PowerShell stdin as UTF-8, skip native type compilation for ACL-only
  operations, label file ACL failures correctly, and add a parser gate.
- Send TERM before closing probe stdin, retry shutdown, and distinguish launcher
  failure from chain-query failure. Reject unsupported manual CLI arguments.
- Ship the linked recovery guide in the Codex package, include it in provenance,
  regenerate onboarding skills and synchronize the script inventory.

Additional integration evidence:

- The final full suite passed all 665 tests on Node 24.15.0 with no skips.
  Package generation, syntax/JSON/version checks, executable docs and historical
  provenance checks passed. Stale-reaper and paused-creator races have
  deterministic regression tests; the btrfs stress check preserved 240 updates.
- Real Codex 0.153.4 and 0.154.0 passed eight isolated host cases, including all
  five servers receiving credential environment values and one verified migration.
- Real Claude Code 2.1.270 received the entire 9,092-character policy and public
  zero-balance/faucet report in its API prompt through the actual SessionStart
  hook. Its successful hook response contained the complete `systemMessage`.
  This used a local fixture API/MCP peer in print mode; interactive display was
  not observed.
- Three probes against MCP 0.22.0 reached a local bank RPC that deliberately
  withheld its response. Each finished in about 5.1 seconds; helper, launcher
  and MCP processes exited, sockets closed, and no temporary working directory
  remained. The fixture used a public encrypted wallet and explicit file storage.
- PowerShell 7.6.6 parsed the shipped scripts, rejected a malformed fixture and
  preserved a Unicode request under a simulated ASCII console. Native Windows
  Credential Manager/ACL and macOS Keychain execution still need platform
  acceptance.
- Both-host pinned runtime contracts passed with their committed deadlines:
  five servers per host, 25 workflow references and six callback cases, with
  outbound networking blocked.

## Second review follow-up

The [second review](https://github.com/manifest-network/manifest-agent-plugin/pull/19#issuecomment-5703109720)
confirmed the earlier fixes and identified additional retry, diagnostic and hook
failure cases. Automatic migration now caches only store-access failures; manual
migration and explicit config writes retry immediately. Shared legacy validation
keeps specific recovery guidance, and lock timeout messages use the current owner
state, including a publication grace for incomplete records. Unknown legacy lock
files remain intact with explicit manual recovery steps.

Optional reporter crashes, signals and malformed output preserve the complete
policy with a successful hook exit. Private descriptors isolate Node wrapper
noise from source selection, reports and environment exports. Closed stdin no
longer hangs. Writer failures after valid key input report the cause before the
retained keyfile, including chain/gas validation failures. PowerShell dispatch
tests now prove ACL operations avoid native compilation; a hoisted-compilation
mutation fails the same regression.

All 690 tests passed on Node 24.15.0 with no skips. Generated packages, executable
docs, policy completeness, syntax/JSON/version and provenance checks passed.
Real Claude 2.1.270 received the full policy in healthy, noisy-Node and reporter
crash scenarios using local fixture APIs; healthy/noisy runs also delivered the
complete public report. Pinned Codex 0.153.4 passed all eight host cases and
validated all 68 current source hashes. These checks do not add live Windows or
macOS credential-store coverage; closed-stdin behavior was exercised on Bash
5.3.15, without a Bash 3.2 runtime available.

## Hook compatibility follow-up

The [third review](https://github.com/manifest-network/manifest-agent-plugin/pull/19#issuecomment-5703993623)
confirmed the previous corrections and identified two rare hook-startup failures:
module-input `NODE_OPTIONS` changed inline JavaScript semantics, and spawn-style
Node wrappers dropped the private descriptor used for hook output. Both failures
were reproduced through real Claude 2.1.270 with local fixture APIs.

The hook now invokes one CommonJS helper as a file. It appends quoted exports
directly, selects the startup path through an exit status, and atomically writes
validated report output to an owned private temporary directory. Wrapper and
preload stdout cannot become environment exports or a host report. Report
failures preserve the complete policy with safe phase/class/status diagnostics.
Tests cover the remaining schema-validation branches and attempted direct output
that previously bypassed validation.

Credential diagnostics now distinguish corrupt existing entries from failed
verification of a new write, preserve recovery steps for invalid legacy
references, and identify dangling recovery guards without changing them.
Automatic migration classifies local validation separately so the hook supplies
repair guidance instead of an unlock hint. A launcher regression verifies that
all five servers share the automatic cooldown; disabling it makes the test fail.

The final full suite passed all 737 tests on Node 24.15.0 with no skips. Package,
syntax/JSON/version, executable-doc, policy and historical-provenance checks
passed, as did both-host pinned runtime contracts with their committed deadlines.
Seven actual Claude 2.1.270 scenarios passed: healthy startup, module-input options,
a descriptor-closing wrapper, ordinary wrapper noise, reporter crash, spoofed
error details, and preload load/exit noise. Each received the complete policy;
the preload fixture safely reported an unavailable balance when its noise also
corrupted the mock MCP stream. Environment exports stayed clean and temporary
report directories were removed. Pinned Codex 0.153.4 passed eight host cases
and validated all 69 source hashes, including the new helper. No live Windows
or macOS credential-store validation was added.
