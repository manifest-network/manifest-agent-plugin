# Approval boundary validation

The plugin remains pinned to `@manifest-network/manifest-mcp-node@0.10.0`.
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
| Hook payload tests | Scoped direct writes and deploy/manage/close orchestrators request permission; exact domain lookup is exempt; malformed payloads fail closed | Invoking the script with JSON does not show how Claude delivers events or renders permission requests |
| Installed MCP inventory | `initialize` and `tools/list` from each configured server in the pinned package expose tool names and mutation metadata that agree with the matcher | Published metadata does not prove a handler has no unreported side effects |
| Runtime-policy and documentation checks | The injected policy, hook matcher, and developer gated-tool list agree | Matching prose cannot prove the user saw a fee estimate or made a choice |
| Protocol/transport fixtures, when run | Simulated denial prevents entry; native elicitation acceptance/decline controls a fixture's mutation path | A simulated host does not establish real Claude UI or bypass-mode behavior |
| Actual Claude-host characterization | Observed tool names, event order, denial, native elicitation protocol responses, and permission-mode behavior for a recorded host version | Evidence is specific to the tested version, mode, and local fixture |

The inventory check uses synthetic credentials in an isolated temporary
environment with outbound network operations blocked. It invokes no
transaction or provider tools. The probe sets `DOTENV_CONFIG_QUIET=true`
to suppress dependency banners on MCP stdout; it does not establish that
an ordinary plugin startup has a clean transport. The startup correction
is tracked separately under ENG-893. Run it against installed
runtime dependencies:

```bash
node ci/mcp-tool-policy.cjs --data-dir <install-directory>
```

The check combines `readOnlyHint` and Manifest `broadcasts` metadata,
rejects missing/invalid or contradictory metadata, and handles the explicit
testnet faucet exception. Tool source review remains necessary: a handler
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

All **12 host-harness cases passed on Claude Code 2.1.263**:

| Case | Observed result |
| --- | --- |
| Old unscoped matcher | Missed the host tool name; the fixture marker ran |
| Scoped deny | Blocked handler entry |
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

All runs used isolated configuration, a local simulated Anthropic API,
dummy API credentials, and harmless MCP fixtures. Live-model choices,
production orchestrator behavior, chain/provider mutations, and native
interactive UI rendering were not tested. Interactive UI validation
remains pending.

## ENG-892 validation record

The change passed 281 local unit tests, the documentation/policy checks,
and the installed-inventory check for 5 pinned servers exposing 32 tools
and 11 gated mutation entry points. The 12 host cases above exercise
Claude dispatch with local fixtures; they do not add live chain coverage.

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
