# Billing-tx confirm + broadcast (shared scaffold)

Plugin-root reference loaded by every skill that broadcasts a billing-module
tx outside the deploy-app flow. The runtime policy mandates the same
ordering each time — estimate → humanize → confirm in chat → broadcast
(PreToolUse fires) → verify on-chain — and inlining that ordering at every
call site is exactly the kind of duplication that erodes through
paraphrasing.

Consumers (update both sides if you change the contract):

- `skills/troubleshoot-deployment/SKILL.md` Step 6 (close_lease)
- `skills/manage-domain/SKILL.md` Step 6 (set / clear custom domain)
- `skills/deploy-app/references/troubleshoot-after-deploy-failure.md`
  cleanup section (close_lease after a failed deploy)

This file does NOT cover the deploy-app happy-path broadcast — that flow
is its own beast (intent recap → pre-flight readiness → DeploymentPlan
render → confirm → broadcast → response classify) and gets its scaffolding
from `skills/deploy-app/SKILL.md` directly. The flows here are simpler:
single-tx broadcasts where the only structural variation is the args
construction, the prompt copy, and the post-broadcast verification.

## Variables in scope

The orchestrator must have these in scope before loading this file:

- `<activeChain>` — `"testnet"` or `"mainnet"`, captured at Step 0 from
  `update-config.cjs --status`. Used in `humanize-fee.cjs`'s
  `--chain-data-file` argument.
- `<estimate-args>` — the `args` array for `cosmos_estimate_fee`, supplied
  by the call site (close-lease passes `["<LEASE_UUID>"]`; manage-domain
  passes the JSON output of `build-set-domain-args.cjs`).
- `<estimate-subcommand>` — the `subcommand` string for the estimate
  call (`"close-lease"` / `"set-item-custom-domain"` / etc.).
- `<prompt-body>` — the call-site-specific Markdown the user sees in the
  AskUserQuestion confirmation. The boilerplate (estimated fee + gas)
  is appended below; the body provides the action context (image, lease,
  what's being claimed/cleared/closed, mainnet warnings).
- `<broadcast-call>` — the MCP tool the call site fires on Yes (e.g.
  `mcp__manifest-lease__close_lease({ lease_uuid: LEASE_UUID })`).

The post-broadcast verification varies by call site (close-lease checks
`terminal: yes`; set/clear domain checks `customDomain` equality), so
this reference stops at the broadcast step and hands back to the call
site for verification. That's deliberate — the verify logic is genuinely
different per consumer and shouldn't be jammed into a one-size-fits-all
template.

## Steps

### 1. Estimate the tx fee

```
mcp__manifest-chain__cosmos_estimate_fee({
  module: "billing",
  subcommand: "<estimate-subcommand>",
  args: <estimate-args>
})
```

If `cosmos_estimate_fee` itself errors out, surface the error and confirm
via `AskUserQuestion` (Yes / No): "estimate failed; proceed without an
estimate?". Do NOT silently skip. On Yes, set `ESTIMATE = null` and skip
the fee line in the prompt below.

Otherwise capture the response as `ESTIMATE` — it has `gasEstimate`
(string, e.g. `"142000"`) and `fee.amount` (an array of `{denom,
amount}`).

### 2. Humanize the fee

If `ESTIMATE` is null, skip this step (the prompt body should note
"(not estimated)" instead of a fee).

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/humanize-fee.cjs" \
  --chain-data-file "$MANIFEST_PLUGIN_DATA/chains/<activeChain>.json" \
  --fee-json '<ESTIMATE.fee.amount as JSON>'
```

Capture the script's stdout as `FEE_HUMAN` (e.g. `0.0023 MFX`). Don't
inline the math — the script pins the format so adjacent fee prompts in
the same flow can't disagree on rounding.

### 3. Textual confirm

Use `AskUserQuestion` with the call-site `<prompt-body>` and the
following two-line append:

```
> Estimated tx fee: <FEE_HUMAN> (gas <ESTIMATE.gasEstimate>).
```

Or, when `ESTIMATE` is null:

```
> Estimated tx fee: (not estimated — proceeding without one per your earlier confirmation).
```

Options: **Yes** / **No**. On No, stop without broadcasting.

### 4. Broadcast

On Yes, fire `<broadcast-call>`. The PreToolUse permission prompt will
fire — that is expected. The textual confirmation in step 3 is the
primary gate per runtime policy; the permission prompt is a safety net,
not a substitute.

### 5. Verify on-chain

A successful broadcast doesn't guarantee state actually transitioned.
The call site MUST verify before any downstream cleanup. Two shapes
follow.

#### 5a — Close-lease verify (close-lease consumers)

Used by both close-lease call sites
(troubleshoot-deployment Step 6, deploy-app's
troubleshoot-after-deploy-failure.md cleanup). Both walk the same
sequence — pinning it here keeps them in sync. Both go through the
shared verify-and-recover driver (see `references/verify-recover.md` for
the full spec/output contract).

1. Call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`.
   Capture the response; extract `chainState.state` (integer) as
   `STATE_INT`. If `app_status` itself errors out: surface the error
   and tell the user the tx was sent but verification failed; do NOT
   remove the local manifest record; skip the rest of this step.

2. `Read` `references/verify-recover.md` if you haven't yet — the
   driver contract is shared with three other consumers.

3. Build the verify-recover envelope and pipe to the driver:
   ```bash
   echo '{
     "spec": {
       "verifier": { "script": "decode-lease-state.cjs",
                     "args": ["--state", "{{state_int}}", "--json"],
                     "stdin_source": null },
       "success": { "field": "terminal", "values": [true] },
       "branches": {
         "other": { "branch_id": "close-not-yet-terminal",
                    "journal_action_tag": "close-lease-verify-pending",
                    "user_message": "close_lease tx accepted but lease state is still `{{name}}`; chain may need ~30s. Re-run `/manifest-agent:troubleshoot-deployment {{lease_uuid}}` in ~30s to recheck. Local saved manifest record NOT removed yet." }
       }
     },
     "payloads": {},
     "context": { "state_int": "<STATE_INT>", "lease_uuid": "<LEASE_UUID>" }
   }' | node "$MANIFEST_PLUGIN_ROOT/scripts/verify-recover.cjs"
   ```

   Both `LEASE_STATE_CLOSED` (4) and `LEASE_STATE_INSUFFICIENT_FUNDS` (3)
   count as terminal — the chain may transition through
   INSUFFICIENT_FUNDS on a successful close-lease before settling on
   CLOSED. `decode-lease-state.cjs --json` returns `terminal: true` for
   both. Capture the driver's stdout as `VERIFY_RESULT`.

4. Branch on `VERIFY_RESULT.result`:
   - **`success`** → cleanup. Run:
     ```bash
     node "$MANIFEST_PLUGIN_ROOT/scripts/remove-manifest.cjs" --lease-uuid "$LEASE_UUID"
     ```
     (no-op if the saved manifest record is already gone). Tell the
     user "Lease is terminal on-chain
     (`<VERIFY_RESULT.diagnostic_delta.name>`). Removed local saved
     manifest record."
   - **`failure`** (branch_id `close-not-yet-terminal`) → print
     `VERIFY_RESULT.user_message` verbatim. Do NOT run
     `remove-manifest.cjs`.

#### 5b — Custom-domain verify (set/clear consumers)

Used by manage-domain Step 6. The verify also goes through the shared
verify-recover driver (`scripts/verify-recover.cjs`), but with a
different verifier (`verify-domain-state.cjs` instead of
`decode-lease-state.cjs`) and `success.field`/`branches` tuned for the
customDomain equality check rather than the terminal-state check. See
`references/verify-recover.md` for the shared spec contract; see
`skills/manage-domain/SKILL.md` Step 6 for the canonical caller.
