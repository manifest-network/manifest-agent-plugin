---
description: >
  Deploy a containerized app to the Manifest blockchain end-to-end.
  Use when the user wants to ship a container image to a Fred provider
  lease. Optional argument: a JSON deployment spec path, an image
  reference (e.g. nginx:1.27 or ghcr.io/me/app@sha256:...) for a
  single-service fast-path, or two-or-more image refs separated by
  spaces (or +) for a multi-service stack fast-path. Omit the argument
  for interactive authoring.
allowed-tools: Bash(*), Read, Write
---

# Deploy App (orchestrator)

You are running the full deployment workflow. The flow is the same whether
the user supplied a spec file path or not — only the input-handling step
differs.

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Labels like "Step 2", "Step 6a-bis", "Step 11.a" are scaffolding for
skill authors only. To the user, just describe what you're doing in
plain language — e.g. "I'll use that as the image and ask you for the
SKU and port", not "I'm following Step 6a-bis". Skip phrases like "Now
in Step N" or "Switching to the failure branch"; describe the action
itself.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart Claude Code so the SessionStart hook runs, then stop.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it fails, tell the user to run `/manifest-agent:init-agent` first and
stop. Otherwise parse the JSON; you need `activeChain`, `address`, and
`chains.<activeChain>.chainId`.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly.

## Step 1 — Mainnet confirmation

If `activeChain == "mainnet"`, ask via `AskUserQuestion`:

> You are about to deploy on mainnet. The lease and any retries will spend
> real funds. Continue?

Options: **Yes** (proceed) / **No** (stop). If No, stop immediately.

(The custom-domain mainnet warning — about FQDN reservations being
permanent — fires later, in Step 4, because at this point in the flow
the spec hasn't been loaded or built yet. By the time the recap runs,
both the spec and the chosen FQDN are in hand.)

## Step 2 — Get the manifest spec

Four input modes based on `$ARGUMENTS`. Classify deterministically using
`dispatch-deploy-input.cjs` — do NOT do this dispatch in prose:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/dispatch-deploy-input.cjs" --arguments "$ARGUMENTS"
```

The script's stdout JSON has `{ mode, tokens, spec_path?, services?, collisions?, reason? }`.
Branch on `mode`:

- **`empty`** | **`spec_file`** | **`multi_image`** | **`single_image`** →
  `Read` `skills/deploy-app/references/spec-input-modes.md` and follow the
  matching section. The reference walks each mode's authoring flow,
  custom-domain collection, env-file merging, and the final services-map
  SPEC shape.
- **`error`** → surface `reason` to the user verbatim and stop. The reason
  is human-readable and explains exactly why the input wasn't recognized
  (e.g. "argument is neither a readable file path nor a recognizable image
  reference"). Do not guess — fail loudly.


## Step 3 — Validate the spec

Always validate, even when loading from a path (the user may have edited the
file). Call:

```
mcp__manifest-fred__build_manifest_preview(<SPEC fields splatted>)
```

If `validation.valid === false`, surface every entry in `validation.errors[]`
verbatim and stop. Recovery instructions to give the user depend on how
they got here: if they passed a spec file path, they should edit the file
and re-run `/manifest-agent:deploy-app <path>`; if they used the image
fast-paths or interactive authoring, they can re-run `/manifest-agent:deploy-app`
with their corrected inputs.

Capture from the response:
- `META_HASH` ← `meta_hash_hex`
- `MANIFEST_JSON` ← `manifest_json` (the canonical Fred-rendered string;
  Step 10 needs it for the durable post-deploy record)
- The `format` (`single` or `stack`) — surfaces in the DeploymentPlan
  summary.

For `IMAGE`: the SKU pre-flight in Step 5 wants a single image. Pipe the
spec through `extract-primary-image.cjs` (do NOT inline the shape branch
in prose — the script wraps `_spec.cjs.firstImage` so this orchestrator,
the intent recap, and the manifest summary all agree on which image is
"primary"). Materialize SPEC to a tmpfile (the spec can carry env values
that mustn't echo through chat), then:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/extract-primary-image.cjs" < /tmp/.spec-PROCESS_PID.json
```

The script's stdout IS `IMAGE`. For multi-service stacks the provider
validates all images at deploy time, so the readiness pre-flight on the
first one is sufficient.

For `SIZE`: spec files don't carry the SKU choice — when the user
provided a spec file path, use `AskUserQuestion` populated from
`browse_catalog` to ask. When the user came in via any of the
interactive flows (image fast-path, multi-image stack fast-path, or
no-arg interactive authoring), `SIZE` was already collected in Step 2;
reuse it.

## Step 4 — Confirm intent

Before any chain round-trips (readiness, fee estimate), show the user a
plain-English **Intent recap** so misinterpretations get caught before any
broadcast. This is distinct from the structural `DeploymentPlan` rendered
later: that one captures technical truth (gas, balances); this one captures
*what you understood the user is trying to do*.

The recap has two parts:

**Part A — structural (rendered by script).** Materialize the SPEC to a
tmpfile (use the `Write` tool, not heredoc — the spec can carry user-supplied
env values), then run:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/render-intent-recap.cjs" \
  --active-chain "<activeChain from Step 0>" \
  < /tmp/.spec-PROCESS_PID.json
rm -f /tmp/.spec-PROCESS_PID.json
```

The script's stdout IS the structural recap. Print it to the user verbatim.
It covers: deploy surface (service count + images), connectivity (per-port
publicly-reachable / internal-only), redacted-keys inventory (env keys and
label keys per service, never values), and the custom-domain block (with
dual-tx clarification + mainnet warning when applicable). Do NOT paraphrase
it; the script pins the wording so adjacent runs cannot disagree.

**Part B — LLM-judgment (you append in plain prose, after the script's
output).** Up to two short sections.

**Output discipline — read this BEFORE writing Part B:**
- **Each bullet must be a single, complete sentence ending in a period.**
  Do not start a bullet you can't finish in one sentence.
- **Hard cap: 3 bullets per section, each ≤ 25 words.** Long explanations
  belong in chat *after* the user responds to the AskUserQuestion, not
  before it. Brevity here matters because the AskUserQuestion fires
  immediately after Part B, and a half-written bullet looks truncated.
- **Never print a header you can't immediately follow with at least one
  complete bullet.** Empty headers look like the output got cut off.
- **Verify every bullet ends with `.` before you call AskUserQuestion.**
  If the model's draft ends mid-sentence ("…the MCP server has"), rewrite
  to end mid-thought-but-complete ("…the MCP server uses stdio.") or drop
  that bullet entirely.

1. **What you provided vs auto-detected** — call out which fields the
   agent pulled from the image inspector (cmd / entrypoint / user /
   workingDir / tmpfs hints) versus what the user supplied. Always print
   this section when `IMAGE_INFO` was non-empty (i.e. inspect-image
   returned data); skip it entirely (no header) when `IMAGE_INFO` is
   `{}` from a failed inspection.
2. **Heads-up: obvious gaps** — apply your knowledge of common app
   patterns to flag things the user probably forgot. Examples:
   `WORDPRESS_DB_HOST` missing on a wordpress service; `POSTGRES_PASSWORD`
   missing on postgres; an MCP server image whose default `CB_MCP_TRANSPORT`
   is `stdio` won't serve over HTTP without an override. Be conservative
   — only flag cases you're confident about. **If you have zero concrete
   gaps to flag, OMIT the entire section — do not print the header.**

Then ask via `AskUserQuestion`:

> Does this match what you want?
>   - **Yes, proceed** → continue to readiness check + DeploymentPlan
>   - **Amend** → return to spec authoring; the recovery path depends on
>     how the spec got here (edit the spec file when one was passed,
>     otherwise re-collect interactively)
>   - **Abort** → stop without broadcasting

On Amend: re-enter spec authoring. On Abort: stop. Only on Yes do you
proceed to readiness.

## Step 5 — Pre-flight readiness

Always re-fetch — balances at broadcast time are what matter, not whatever
the spec was authored against. Call:

```
mcp__manifest-fred__check_deployment_readiness({ size: SIZE, image: IMAGE })
```

Pipe to the evaluator. Pass `--gas-price` from the config you read in Step 0
(the `gasPrice` field, e.g. `"1umfx"` or `"0.37upwr"`) so the script knows
which wallet denom to check for gas. Also pass `--chain-data-file` pointing
at the active chain's registry JSON (`$MANIFEST_PLUGIN_DATA/chains/<activeChain>.json`)
so reasons[] are rendered with friendly token symbols (PWR / MFX) instead
of raw chain denoms:

```bash
echo '<readiness JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/evaluate-readiness.cjs" \
  --gas-price '<gasPrice from config>' \
  --chain-data-file "$MANIFEST_PLUGIN_DATA/chains/<activeChain>.json"
```

Bind two variables before reading the reference:
- `READINESS_RAW` — the raw `check_deployment_readiness` MCP response
  (the JSON you piped into the evaluator). Step 6 needs `sku.uuid`,
  `wallet_balances`, and `credits` from it.
- `READINESS_VERDICT` — the evaluator's stdout (the
  `{ status, reasons, suggested_actions }` JSON).

`Read` `references/readiness-branching.md` (plugin-root shared reference;
same file is loaded by author-manifest) and follow it to handle the
three statuses (`block` / `warn` / `ok`). For this skill, "return to
the SKU pick step" recovery is N/A (deploy-app takes SIZE as input, not
via a pick step) — surface the SKU rejection and stop. "Re-run the
readiness check" means returning to this Step 5.

## Step 6 — Estimate the deploy_app tx fee, then render the DeploymentPlan

### 6a — Estimate the chain tx fee

The runtime policy mandates calling `cosmos_estimate_fee` before any
billing-module broadcast. `deploy_app` wraps `cosmosTx("billing",
"create-lease", [...])` under the hood, so call:

```
mcp__manifest-chain__cosmos_estimate_fee({
  module: "billing",
  subcommand: "create-lease",
  args: [
    "--meta-hash", META_HASH,
    "<skuUuid>:1",                     // single-service
    // OR for stacks: "<skuUuid>:1:<svcName1>", "<skuUuid>:1:<svcName2>", ...
    // OR with storage: append "<storageSkuUuid>:1"
  ]
})
```

Where `skuUuid` is `READINESS_RAW.sku.uuid` (the raw response captured in
Step 5) and `META_HASH` is from Step 3.

**Storage SKU lookup**: if `SPEC.storage` is set, you need the storage
SKU's UUID. Call `mcp__manifest-lease__get_skus` (no args), find the
entry whose `name` matches `SPEC.storage`, take its `uuid`, and append
`<storageSkuUuid>:1` to the `args` array.

Capture the response as `ESTIMATE` — it has `gasEstimate` (string,
e.g. `"142000"`) and `fee.amount` (an array of `{denom, amount}`).

If `cosmos_estimate_fee` itself errors out, surface the error and confirm
via `AskUserQuestion` (Yes / No): "estimate failed; proceed without an
estimate?". Do NOT silently skip. On Yes, set `ESTIMATE = null` and
continue.

### 6a-bis — Estimate the set-domain tx fee (custom domain only)

Skip this if `SPEC.customDomain` is unset.

If set, `Read`
`skills/deploy-app/references/set-domain-fee-estimate.md` and follow it
inline. The reference covers the representative-lease lookup, the
`build-set-domain-args.cjs` invocation, the `cosmos_estimate_fee` call,
and the approach-3 fallback when no representative lease is available.
Capture `SET_DOMAIN_ESTIMATE` as the result.

### 6b — Render the DeploymentPlan

Compute a structural summary of the spec. Pass the spec via stdin from a
file (NOT inline `echo` — the spec can carry user-supplied env values that
would be re-rendered into chat as a literal bash command):

1. Use the `Write` tool to materialize the SPEC JSON at
   `/tmp/.spec-PROCESS_PID.json` (uppercase placeholder — substitute the
   agent's bash `$$` here, do not leave it as a literal).
2. Run:

   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/summarize-spec.cjs" < /tmp/.spec-PROCESS_PID.json
   rm -f /tmp/.spec-PROCESS_PID.json
   ```

The summary output (`{ format, service_count, port_count, env_count, env_keys, images }`)
contains only env *keys*, never values — safe to keep inline for the next
step.

Convert `ESTIMATE.fee.amount` to a single human-readable string for the
`--tx-fee` flag using the `humanize-fee.cjs` script (do NOT compute it
inline — the script pins the format so adjacent fee prompts in the same
flow can't disagree on rounding):

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/humanize-fee.cjs" \
  --chain-data-file "$MANIFEST_PLUGIN_DATA/chains/<activeChain>.json" \
  --fee-json '<ESTIMATE.fee.amount as JSON, e.g. [{"denom":"umfx","amount":"2300"}]>'
```

The script's stdout (e.g. `0.0023 MFX`) IS the value for `--tx-fee`.
For `--tx-gas`, pass `ESTIMATE.gasEstimate` verbatim. If `ESTIMATE` is
null (the user proceeded without an estimate), omit both flags — the
plan renderer prints a "(not estimated)" marker so the omission is
visible.

Then render the canonical block. The summary + readiness JSON together
contain no env values, so inline echo is acceptable here:

```bash
echo '{"summary": <summary JSON from above>, "readiness": <READINESS_RAW JSON>}' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/render-deployment-plan.cjs" \
      --meta-hash "$META_HASH" \
      --image "$IMAGE" \
      --size "$SIZE" \
      --tx-gas "<ESTIMATE.gasEstimate>" \
      --tx-fee "<output of humanize-fee.cjs above>" \
      --chain-data-file "$MANIFEST_PLUGIN_DATA/chains/<activeChain>.json"
```

`--chain-data-file` lets the script humanize the SKU price, wallet, and
credits lines using the chain registry's denom -> symbol map (`umfx -> MFX`,
`factory/.../upwr -> PWR`). Without it the script falls back to raw
denoms which is harder to read.

**When `SPEC.customDomain` is set**, also pass:
- `--custom-domain "<SPEC.customDomain>"`
- `--custom-domain-service "<SPEC.serviceName>"` (for stacks; omit for
  single-service)
- `--set-domain-tx-gas "<SET_DOMAIN_ESTIMATE.gasEstimate>"` (when the
  second estimate succeeded)
- `--set-domain-tx-fee "<output of humanize-fee.cjs on SET_DOMAIN_ESTIMATE.fee.amount>"`
  OR `--set-domain-tx-fee skipped` (when approach-3 fallback fired)

The script's stdout IS the plan. Print it to the user verbatim. Do not
restate, reformat, or splice in additional fields — the script owns the
canonical format. With a custom domain set, the plan automatically
shows two `Tx fee:` lines plus a `Total fee:` line.

## Step 7 — Wait for textual confirmation

Ask the user via `AskUserQuestion`:

> Confirm to broadcast `deploy_app` with the plan above? (Yes / No)

This textual confirmation is the primary gate (per runtime policy). The
PreToolUse permission prompt that fires next is a safety net, not a
substitute. Do not call `deploy_app` without an explicit affirmative.

If the user says no, ask whether to amend the spec (return to Step 2) or
abort entirely.

## Step 8 — Broadcast

Call `mcp__manifest-fred__deploy_app` with the spec fields splatted as
arguments. **When `SPEC.customDomain` is set**, splat
`custom_domain: SPEC.customDomain` and (for stacks)
`service_name: SPEC.serviceName` alongside the other fields. (deploy_app
uses snake_case in its MCP input schema; the SPEC stores camelCase to
mirror the underlying TypeScript signature — translate on the call.)

The PreToolUse hook will prompt for permission — that is expected. Note
that ONE permission prompt covers BOTH txes when `custom_domain` is set
(the second tx fires server-side via `setItemCustomDomain`, never via
the MCP tool surface).

Stream `notifications/progress` events to the user as they arrive.

**On a thrown error**: capture the error envelope as
`{ message, details, code? }` and route through the error classifier:

```bash
echo '<error envelope JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/classify-deploy-error.cjs"
# When SPEC.customDomain is set, also pass:
#   --expected-custom-domain "<SPEC.customDomain>"
```

Branch on the script's `outcome`:
- **`partially_succeeded`**: `create-lease` confirmed but the downstream
  step (set-domain or upload/poll) fell over. The lease exists at
  `details.lease_uuid` (or extracted from the message by the script).
  Jump to **Step 11 partial-success sub-branch** with that UUID.
- **`failed`**: no lease was created. Surface `reason` verbatim and
  stop. No cleanup needed.

If `deploy_app` returns a response (no throw), capture it as
`DEPLOY_RESPONSE` and proceed to Step 9.

## Step 9 — Classify the response

```bash
echo '<DEPLOY_RESPONSE JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/classify-deploy-response.cjs"
```

The script prints `{ outcome, lease_uuid?, provider_uuid?, urls, state_name?, error_summary? }`.

Capture `LEASE_UUID` from the script's output (always present except on
`failed`-with-no-lease).

Branch on `outcome`:

- **`active`** → proceed directly to Step 10.
- **`needs_wait`** → call
  `mcp__manifest-fred__wait_for_app_ready({ lease_uuid: LEASE_UUID, timeout_seconds: 300 })`.
  On thrown error → Step 11. On success, call
  `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })` and merge its
  `connection` into the response. Re-run `classify-deploy-response.cjs` on
  the merged response and **re-branch on the new outcome** (do not assume
  the wait succeeded — the lease may have transitioned to a terminal
  failure state during the poll, or never picked up a running instance):
  - new outcome `active` → proceed to Step 10.
  - new outcome `failed` → Step 11.
  - new outcome `needs_wait` again (rare — provider still pending after
    300s) → treat as failure: route to Step 11 with a clear "ready timeout"
    message in `error_summary` so the user can decide whether to retry or
    cleanup.
- **`failed`** → Step 11.

## Step 10 — Persist + success output

**Persist**:

Write the canonical `MANIFEST_JSON` (captured in Step 3) to a temporary
file using the `Write` tool — NOT a bash heredoc. The heredoc form would
require re-rendering `MANIFEST_JSON` (which can contain sensitive env
values) into chat as a literal bash code block; the `Write` tool writes
the file as a structured tool call instead. The value was already
visible in chat from `build_manifest_preview`'s response, so we don't add
a third on-screen rendering of the secret-bearing payload.

1. Pick the temp path: `/tmp/.manifest-${LEASE_UUID}.json` (the lease UUID
   is unique per broadcast — no collision with concurrent sessions).
2. Use `Write` with `file_path` set to that path and `content` set to
   `MANIFEST_JSON`.
3. Run the persistence with a `trap` so the tmpfile (which carries
   `MANIFEST_JSON`'s possibly-sensitive env values) is removed even if
   `save-manifest.cjs` fails:

```bash
TMPFILE="/tmp/.manifest-${LEASE_UUID}.json"
trap 'rm -f "$TMPFILE"' EXIT
node "$MANIFEST_PLUGIN_ROOT/scripts/save-manifest.cjs" \
  --lease-uuid "$LEASE_UUID" \
  --image "$IMAGE" \
  --size "$SIZE" \
  --meta-hash "$META_HASH" \
  --chain-id "$CHAIN_ID" \
  --manifest-file "$TMPFILE"
# When the deploy_app response carried a custom_domain (set-domain tx
# confirmed), pass it through to the wrapper so troubleshoot-deployment
# can surface it later. Add --custom-domain-service-name only for stacks.
#   --custom-domain "<DEPLOY_RESPONSE.custom_domain>" \
#   --custom-domain-service-name "<DEPLOY_RESPONSE.service_name>"   # stacks only
```

(`CHAIN_ID` comes from `chains.<activeChain>.chainId` in the config status
from Step 0.)

`save-manifest.cjs` re-computes SHA-256 of the manifest bytes and compares
against `$META_HASH`. If they don't match the script exits non-zero with a
diagnostic — surface that error verbatim to the user. The most common
cause is writing the structured spec to the tmpfile instead of the
canonical `MANIFEST_JSON` string captured in Step 3; double-check the
Write tool was passed `MANIFEST_JSON` (the long Fred-rendered string),
not `SPEC` (the structured input).

The script prints the saved file path on stdout. Show it briefly:
"Saved manifest record: `<path>`".

**Success output**: render the success block via `format-success.cjs`:

```bash
echo '{"deploy_response": <DEPLOY_RESPONSE>}' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/format-success.cjs" --lease-uuid "$LEASE_UUID"
```

**Print the script's stdout VERBATIM.** Do NOT add explanatory prose
around it, do NOT paraphrase its labels, do NOT invent fields the
deploy_app response doesn't have (e.g. there is no `connection.urls[]` —
don't reference it). The script's output is the success message — the
labels (Provider / Lease UUID / Lease Status / Ingress / troubleshoot
pointer) and their order are intentional and complete. If the user wants
more detail about logs or diagnostics, they can run
`/manifest-agent:troubleshoot-deployment <uuid>` as the script's last
line suggests.

If the script reports `Ingress: (none — service is internal or no FQDN
reported)`, just print that as-is. The user knows what an internal-only
service is; do not narrate around it.

After printing the success block, continue to Step 12 with
`JOURNAL_OUTCOME = "success"` and the success `final_state` shape.

## Step 11 — Failure

Three sub-cases.

### When `classify-deploy-error.cjs` returned `partially_succeeded`

`Read` `skills/deploy-app/references/partial-success-recovery.md` and
follow it inline. The file covers state diagnosis (Step 11.a), the
recovery prompt rendering (Step 11.b via `render-partial-success-prompt.cjs`),
and the three recovery paths (retry set-domain + upload / salvage without
domain / cancel-or-close, with PENDING-vs-ACTIVE branching for the
correct chain primitive).

After the recovery branch resolves, continue to Step 12 with
`JOURNAL_OUTCOME = "partial"` and a `final_state` reflecting which path
the user picked (retry / salvage / cancel) plus the chosen lease state.
Track the user's pick as `RECOVERY_ACTION` (one of `retry-set-domain`,
`salvage-without-domain`, `cancel-or-close`) and add it to
`recovery_actions[]` in the journal record.

### When the broadcast created a lease (`LEASE_UUID` present)

`Read` `skills/deploy-app/references/troubleshoot-after-deploy-failure.md`
and follow it inline. The file contains the streamlined post-broadcast
diagnostic + cleanup flow (parallel `app_status` / `app_diagnostics` /
`get_logs`, brief Markdown report, fee-estimated close-lease offer,
on-chain verification with `terminal`-flag branching for
`remove-manifest.cjs` cleanup).

After the cleanup branch resolves, continue to Step 12 with
`JOURNAL_OUTCOME = "failed"` and a `final_state` carrying `lease_uuid`
and the user's close-or-keep choice.

### When no lease was created (`LEASE_UUID` absent)

The broadcast failed before any lease was created (most commonly: registry
rejected at upload time, insufficient gas, network error). Surface the
`error_summary` from the classify-deploy-response output verbatim. No
cleanup needed.

After surfacing the error, continue to Step 12 with
`JOURNAL_OUTCOME = "failed"` and a minimal `final_state` (no lease_uuid).

## Step 12 — Record this run in the journal

Append one record to the operation journal at
`$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. The writer auto-fills
`timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` —
omit them. Do NOT include any key matching the writer's secret denylist
— `_journal.SECRET_KEY_DENYLIST` (mnemonic, password, private_key,
secret_key, api_key, auth_token, bearer_token — case-insensitive,
optional `_`/`-` separators; canonical regex in `scripts/_journal.cjs`);
the writer is fail-closed and will exit 1 rather than append such
records. Do NOT embed `MANIFEST_JSON` or any spec env values; the
redaction discipline (env keys-only, never values) is mandatory in
`args_redacted` for `build_manifest_preview` and `deploy_app` — the
rules live in `scripts/_journal.cjs#redactArgs`.

`tool_calls[]` MUST enumerate every MCP tool call this skill made, in
order. For each entry, set `outcome` to `"ok"` or `"error"` and use the
fully-qualified MCP tool name (the same string that fires in chat) so
the journal stays grep-friendly. The critical entries (omit any not
used on the path you took):

- `mcp__manifest-fred__build_manifest_preview` (Step 3)
- `mcp__manifest-fred__check_deployment_readiness` (Step 5)
- `mcp__manifest-chain__cosmos_estimate_fee` for `create-lease` (Step 6a)
- `mcp__manifest-chain__cosmos_estimate_fee` for `set-item-custom-domain` (Step 6a-bis, when custom domain is set)
- `mcp__manifest-fred__deploy_app` (Step 8)
- `mcp__manifest-fred__wait_for_app_ready` (Step 9, only when classify said `needs_wait`)
- `mcp__manifest-fred__app_status` (Step 9 needs_wait branch, or Step 11 has-lease branch)
- `mcp__manifest-fred__app_diagnostics`, `mcp__manifest-fred__get_logs` (Step 11 has-lease branch)
- `mcp__manifest-chain__cosmos_estimate_fee` for `close-lease` + `mcp__manifest-lease__close_lease` (Step 11 cleanup)
- `mcp__manifest-fred__update_app` (Step 11 partial salvage / retry branch)
- `mcp__manifest-lease__set_item_custom_domain` (Step 11 partial retry branch)

Each `args_redacted` follows the per-tool reduction in
`scripts/_journal.cjs#redactArgs`:
- `deploy_app` / `build_manifest_preview` → `{ summary: { format, service_count, env_count, env_keys, images }, customDomain?, serviceName?, size? }`. Env values MUST NOT appear.
- `cosmos_estimate_fee` → `{ module, subcommand, args: [...], gas_multiplier }` verbatim (billing args carry no secrets).
- Lease-module / fred provider tools → deep-redact-by-key: top-level fields like `lease_uuid`, `fqdn`, `service_name`, `sku name`, `amount` are preserved verbatim, but any nested key matching `MNEMONIC|PASSWORD|TOKEN|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY` (case-insensitive) is replaced with `<redacted>`. None of today's lease/fred tools accept such keys, so the practical effect is a pass-through; the deep-redact is defense in depth for future tool surface.

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" <<'JOURNAL_EOF'
{
  "skill": "deploy-app",
  "active_chain": "<activeChain from Step 0>",
  "signer_address": "<address from Step 0>",
  "intent": "<the user's request, in their words, max ~240 chars>",
  "plan_summary": "deploy <format> spec, <service_count> services, image=<primary image>, size=<SIZE>, custom_domain=<fqdn|null>",
  "tool_calls": [
    "<populate per the rules above; see scripts/_journal.cjs#redactArgs>"
  ],
  "outcome": "<JOURNAL_OUTCOME>",
  "final_state": "<see per-branch shapes below>",
  "errors": "<list of { class, message, mcp_error_code? } from any errored tool calls or empty []>",
  "recovery_actions": "<list of recovery actions taken, e.g. ['retry-set-domain'] for partial branch>"
}
JOURNAL_EOF
```

`final_state` shapes by branch:

- **success** (Step 10): `{ "lease_uuid": "<LEASE_UUID>", "image": "<IMAGE>", "size": "<SIZE>", "chain_id": "<CHAIN_ID>", "format": "<single|stack>", "meta_hash_hex": "<META_HASH>", "custom_domain": "<fqdn or null>", "custom_domain_service_name": "<service or null>", "provider_uuid": "<DEPLOY_RESPONSE.provider_uuid or null>", "url": "<first url from format-success.cjs output, or null>" }`
- **partial** (Step 11 partial-success): `{ "lease_uuid": "<LEASE_UUID>", "what_succeeded": "create-lease", "what_failed": "<set-domain|upload>", "decoded_state": "<DECODED_STATE>", "recovery_choice": "<retry-set-domain|salvage-without-domain|cancel-or-close>" }`
- **failed with lease** (Step 11 has-lease): `{ "lease_uuid": "<LEASE_UUID>", "close_choice": "<close|keep>", "verified_terminal": "<true|false>" }`
- **failed no lease** (Step 11 no-lease): `{ "error_summary": "<error_summary from classify-deploy-response>" }`

If the user cancelled at the textual confirm in Step 7 (or earlier in
Step 1 mainnet warning, Step 4 intent-recap Abort), set `outcome` to
`"cancelled"`, truncate `tool_calls[]` to whatever ran before the
cancellation, and set `final_state` to a small object with at least the
cancelled-step name (e.g. `{ "cancelled_at": "step-7-confirm" }`). Do
NOT mention the journal write in your reply to the user — it's an
internal audit trail.
