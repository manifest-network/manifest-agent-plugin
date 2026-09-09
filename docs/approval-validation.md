# Approval boundary validation

The plugin now pins `@manifest-network/manifest-mcp-node@0.22.0`. The Claude
host evidence below was collected for 0.10.0 in ENG-892; it remains historical
host-boundary evidence, not a new end-to-end validation of 0.22.0. The current
release adds the gated `restore_app` mutation and a dedicated read-only
`lookup_custom_domain_orchestrated`; every manage-domain call stays gated.
ENG-893 runs the installed-inventory and real-launcher transport checks against
the new locked package.
Approval applies to host-visible MCP entry points. Claude Code evaluates
PreToolUse before starting an outer orchestrated mutation. Once allowed,
the server requests native elicitation for the plan or action, mainnet
warning, or recovery choice. The pinned deploy plan includes estimated
fees; domain and close recaps do not guarantee numeric fee estimates. Internal SDK operations do not generate
additional host PreToolUse events.

Claude Code renders and answers native elicitation through its own user
interface. The agent should not reprint those requests, supply answers on
the user's behalf, or introduce duplicate prose confirmations. A host
permission decision authorizes entering the workflow; it is distinct from
the in-call plan confirmation.

## What the checks establish

| Check | Evidence | Limit |
| --- | --- | --- |
| Hook payload tests | Scoped mutations request permission; dedicated read-only lookup is outside the matcher; malformed payloads, configuration, and child output fail closed; inherited Node preloads are disabled | Invoking the script with JSON does not show how Claude delivers events or renders permission requests |
| Installed MCP inventory | `initialize` and `tools/list` from each configured server in the pinned package expose tool names and mutation metadata that agree with the matcher | Published metadata does not prove a handler has no unreported side effects |
| Runtime-policy and documentation checks | The injected policy, hook matcher, and developer gated-tool list agree | Matching prose cannot prove the user saw a fee estimate or made a choice |
| Protocol/transport fixtures, when run | Simulated denial prevents entry; native elicitation acceptance/decline controls a fixture's mutation path | A simulated host does not establish real Claude UI or bypass-mode behavior |
| Actual Claude-host characterization | Observed tool names, event order, denial, native elicitation protocol responses, and permission-mode behavior for a recorded host version | Evidence is specific to the tested version, mode, and local fixture |

The inventory check uses synthetic credentials in an isolated temporary
environment with outbound network operations blocked. It invokes no
transaction or provider tools. The probe sets `DOTENV_CONFIG_QUIET=true`
to suppress dependency banners on MCP stdout. ENG-893 also tests ordinary
startup through the shipped launcher with a public encrypted wallet, full
runtime completion validation, dotenv isolation and outbound network denial.
Run both checks against the installed runtime:

```bash
node ci/mcp-tool-policy.cjs --data-dir <install-directory>
node ci/launcher-transport.cjs --data-dir <install-directory>
```

The check combines `readOnlyHint` and Manifest `broadcasts` metadata,
rejects missing/invalid or contradictory metadata, and handles the explicit
testnet faucet exception. A complete inventory survives an ordinary nonzero
shutdown exit, but the network guard's exit code 97 always fails discovery
and reports the blocked attempt, including during shutdown. Tool source
review remains necessary: a handler
incorrectly marked read-only and non-broadcasting can still mutate state.

## Actual-host evidence

Automated policy checks alone do not complete host validation. Record an
actual Claude run separately, using a local fixture without live keys,
chain broadcasts, or provider mutations:

1. Record `claude --version`, OS, plugin loading method, permission mode,
   and the fixture/repository revision.
2. Capture the actual scoped tool name and PreToolUse payload. Deny an
   outer mutation and verify that the fixture's handler never starts.
3. Allow a mutation and record host permission before handler entry,
   native elicitation after entry, and the simulated mutation only after
   elicitation acceptance. Declining elicitation must skip that mutation.
4. Exercise read-only diagnostics and exact domain lookup without a
   mutating-call permission request. Verify set/clear still request it.
5. Report bypass-mode behavior only if that mode was actually exercised.
   An older upstream issue about bypass-mode resets is historical context,
   not proof of current behavior.

The reproducible host harness uses installed Claude and loopback sockets:

```bash
node ci/claude-hook-smoke.cjs
```

It writes a fresh `/tmp/manifest-claude-hook-smoke-*/report.json` and
per-case logs. It uses local simulated API/MCP counterparts with dummy
credentials, not the user's configured model account or chain signer.
The isolated configuration includes an empty `plugins/cache` directory
because Claude scans it at startup, even when loading via `--plugin-dir`.

All **14 host-harness cases passed on Claude Code 2.1.263**:

| Case | Observed result |
| --- | --- |
| Old unscoped matcher | Missed the host tool name; the fixture marker ran |
| Scoped deny | Blocked handler entry |
| Polluted deny output (negative control) | A banner before deny JSON made Claude drop the decision; normal preapproval allowed one marker |
| Project hook with a printing Node shim | Unexpected child stdout produced a clean deny and zero markers despite preapproval |
| Internal-only matcher | Missed the outer server-side dispatch |
| Scoped outer deny | Blocked the outer handler |
| Project hook, direct write | `ask` blocked despite exact `--allowedTools` preapproval with prompts disabled |
| Project hook, orchestrated write | `ask` blocked the outer handler under the same conditions |
| Scoped deny in bypass mode | Blocked handler entry with `--permission-prompts none` |
| Project direct `ask` in bypass mode | Blocked the preallowed tool with prompts disabled |
| Project hook, domain lookup | Returned no plugin decision; the read-only query ran with zero mutation |
| Native elicitation acceptance | Host permission and elicitation acceptance preceded exactly one harmless internal marker |
| Native elicitation decline | Host permission preceded handler entry; decline reached the fixture and skipped mutation |
| Native elicitation cancel | Host permission preceded handler entry; cancel reached the fixture and skipped mutation |

For the elicitation cases, the harness approves Claude's outer `can_use_tool`
control request and answers the real MCP elicitation through Claude's
stream control interface. This establishes host protocol handling and
ordering, not interactive rendering. The report and per-case logs are
written to the temporary artifact directory printed by the command.

The bypass cases do not establish whether bypass mode persists after an
interactive permission prompt.

The pollution cases reproduce the review finding and its correction.
`pre-tool-use.sh` now emits fixed JSON from a closed set of private child
tokens; it never forwards child stdout. It also clears inherited
`NODE_OPTIONS` and `NODE_PATH`. A banner causes denial even when a Node
shim exits successfully. A deliberately replaced interpreter remains
outside this guard's trust boundary.

These stream-control runs used isolated configuration, a local simulated
Anthropic API, dummy API credentials, and harmless MCP fixtures. They do
not test interactive rendering. The terminal checks below cover that
separately; neither set exercises production orchestrators or live chains.

## Native terminal UI validation

On 2026-09-09, Claude Code 2.1.263 was also exercised in an actual Linux
terminal at plugin revision `0314a34`. The sessions reused the isolated
plugin, local API, and harmless MCP fixtures from the harness, with
`--permission-mode manual` and the exact outer tool preallowed through
`--allowedTools`. Terminal input was sent through automated keystrokes.
The print-mode stream control interface was not used for these choices.
The [recorded event sequences](evidence/claude-terminal-2.1.263.json) include
the configuration, boundary counts, and reproduction procedure.

The host displayed a **Tool use** permission prompt with **Yes/No** and
the plugin's permission reason. No `tools/call` or mutation marker existed
while it awaited an answer. After **Yes**, the terminal displayed the
MCP server's input request, the fixture's question, an **Approve marker**
checkbox, **Accept/Decline**, and **Esc to cancel**. At this second prompt,
`tools/call` had started but no mutation marker existed.

| Terminal choice | Fixture tool calls | Mutation markers | Result |
| --- | ---: | ---: | --- |
| Host permission No | 0 | 0 | Denied before server entry |
| Host Yes, then Esc | 1 | 0 | Native elicitation returned `cancel` |
| Host Yes, then Decline | 1 | 0 | Native elicitation returned `decline` |
| Host Yes, check the box, then Accept | 1 | 1 | Native elicitation returned `accept` before the marker |

All four sessions and the local API were stopped after capture. This
validates terminal prompt rendering and ordering with automated input.
It does not constitute a human usability assessment, maintainer security
review, or verification of production SDK/chain behavior. Interactive
bypass-mode persistence and other host versions remain untested.

## ENG-892 validation record

The change passed 291 local unit tests, the documentation/policy checks,
and the installed-inventory check for 5 pinned servers exposing 32 tools
and 11 gated mutation entry points. The 14 host cases above exercise
Claude dispatch with local fixtures; the four separate terminal checks
verify native rendering and choices. Neither adds live chain coverage.

## Scope of the boundary

The hook sees the outer tool name and input. It cannot inspect internal SDK
calls, prove a prose recap was shown, or isolate signing credentials from
other processes that can access the plugin data directory. Shell commands
and direct SDK execution do not pass through this MCP hook.

Deployment can partially succeed: lease creation, optional domain
assignment, and manifest upload are sequential operations. Host permission
and plan elicitation do not make those operations atomic; failure reporting
and recovery must preserve the lease and transaction outcomes already
observed.

## ENG-893 compatibility rerun (2026-09-09)

All 14 isolated host cases passed again on Claude Code 2.1.263 using the
current hook and fixture tool names. Dedicated domain lookup produced one
read, zero hook events and zero mutations. Decline/cancel produced zero
mutations; accepted fixture elicitation produced one. The
[machine-readable report](evidence/claude-runtime-0.22.0.json) records tested
file hashes. These are local fixture calls through the real host, not live
chain transactions or end-to-end upstream workflows; terminal UI evidence
above remains the earlier ENG-892 run.

The final locked 0.22.0 package exposes 34 tools across five servers, including
12 gated mutation entry points. All five also initialize through the shipped
launcher with strict JSON-RPC stdout and outbound networking blocked.

## Evidence provenance and source drift

Run `node ci/evidence-check.cjs` to validate the committed evidence records.
Each record explicitly declares `source_status: current` or
`source_status: historical` and SHA-256 hashes for the five hook and host
fixture source files. Current records must match the checked-out files;
missing files, incomplete hash coverage, and source changes fail the check.
At least one current host record is required. A source change requires a
new host run before replacing the current report and its hashes. Matching
hashes bind a report to source bytes; this check does not itself run Claude
or establish new host behavior.

The four native terminal cases remain historical evidence from full commit
`0314a3401b00bd93e1a0dcd3238d7e9188f11977`. Their source hashes were added
retrospectively from that commit's Git objects, without repeating those
terminal sessions or changing their observations. The validator compares
these hashes with the recorded commit when its objects are available and
reports differences from the current workspace as expected historical
drift. It does not treat historical terminal evidence as current coverage.

A shallow checkout may omit that commit, and a full checkout of the main
branch need not include an unmerged source commit from a squashed PR. In
that case the default check explicitly reports historical validation as
metadata only, with historical source bytes unverified. It does not fetch
objects automatically. Use `node ci/evidence-check.cjs --require-history`
when the recorded commit is available locally, or fetch that exact commit
first, to require verification against the historical source as well.
