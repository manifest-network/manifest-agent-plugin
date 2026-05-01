---
name: deploy-app
description: >
  Deploy a containerized app on Manifest end-to-end. With no argument, walks
  the user through interactive authoring (single-service or multi-service
  stack). With a path argument, loads that JSON spec and deploys it.
  Pre-flight check, deployment plan + textual confirmation, broadcast,
  persistence, success output. Failure path runs troubleshoot inline and
  offers cleanup.
allowed-tools: Bash(*), Read, Write
---

# Deploy App (orchestrator)

You are running the full deployment workflow. The flow is the same whether
the user supplied a spec file path or not — only Step 2 differs.

**For all user choices, use the `AskUserQuestion` tool.**

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, tell the user to restart Claude Code and stop.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it fails, tell the user to run `/manifest-agent:init-agent` first and
stop. Otherwise parse the JSON; you need `activeChain`, `address`, and
`chains.<activeChain>.chainId`.

**Never** read `~/.manifest-agent/config.json` directly.

## Step 1 — Mainnet confirmation

If `activeChain == "mainnet"`, ask via `AskUserQuestion`:

> You are about to deploy on mainnet. The lease and any retries will spend
> real funds. Continue?

Options: **Yes** (proceed) / **No** (stop). If No, stop immediately.

## Step 2 — Get the manifest spec

### Branch A — `$ARGUMENTS` is a non-empty path

Treat `$ARGUMENTS` as a path to a JSON spec file. Verify:

```bash
test -f "$ARGUMENTS" && cat "$ARGUMENTS"
```

If the file is missing or unreadable, tell the user and stop.

Parse the file as JSON. If parsing fails, tell the user "spec file is not
valid JSON" with the parse error and stop.

This is your `SPEC` object.

### Branch B — no argument

Drive a thin authoring sequence inline (do NOT `Read` the
`author-manifest/SKILL.md` file — the prose below is sufficient). The
standalone `/manifest-agent:author-manifest` is the right entry point if the
user wants a reusable saved spec; here we just author + deploy in one shot.

1. Use `AskUserQuestion` for shape: **Single-service** or **Multi-service stack**.
2. Use `AskUserQuestion` for SKU size, populated from
   `mcp__manifest-fred__browse_catalog`.
3. **Single-service**: ask for image (preferred form `registry/name@sha256:…`),
   port, then optional `env` / `labels` / `command` / `args` / `health_check` /
   `storage` / `tmpfs` / `init`.
   **Multi-service**: ask service count; for each service ask name (must be
   RFC 1123), image, ports map, then the optional fields.
4. Build the `SPEC` object with the same shape `build_manifest_preview` and
   `deploy_app` accept.

Do NOT call `save-manifest-draft.cjs` in this branch — the spec lives only
in memory; the post-deploy wrapper at
`~/.manifest-agent/manifests/<lease_uuid>.json` (Step 10) is the durable
record.

## Step 3 — Validate the spec

Always validate, even when loading from a path (the user may have edited the
file). Call:

```
mcp__manifest-fred__build_manifest_preview(<SPEC fields splatted>)
```

If `validation.valid === false`, surface every entry in `validation.errors[]`
verbatim and stop. (For Branch B, the user can re-run `/deploy-app` with
their fixes; for Branch A, the user should edit the spec file and re-run.)

Capture from the response:
- `META_HASH` ← `meta_hash_hex`
- The `format` (`single` or `stack`) — surfaces in the DeploymentPlan
  summary.

For `IMAGE`: the SKU pre-flight in Step 4 wants a single image. For single-
service, that's `SPEC.image`. For multi-service stacks, pick the first
service's image as the representative. (The provider validates all of them
at deploy-time.)

For `SIZE`: in Branch A the spec doesn't carry SKU. Use `AskUserQuestion`
populated from `browse_catalog` to ask the user. In Branch B you already
collected `SIZE` in Step 2.

## Step 4 — Pre-flight readiness

Always re-fetch — balances at broadcast time are what matter, not whatever
the spec was authored against. Call:

```
mcp__manifest-fred__check_deployment_readiness({ size: SIZE, image: IMAGE })
```

Pipe to the evaluator. Pass `--gas-price` from the config you read in Step 0
(the `gasPrice` field, e.g. `"1umfx"` or `"0.37upwr"`) so the script knows
which wallet denom to check for gas:

```bash
echo '<readiness JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/evaluate-readiness.cjs" --gas-price '<gasPrice from config>'
```

Branch on `status` exactly as `author-manifest` Step 5 does:
- **`block`** → print `reasons`, stop.
- **`warn`** → ask the user to proceed / fund_credit / request_faucet /
  topup_wallet / abort. On fund_credit/request_faucet, re-run Step 4.
- **`ok`** → silent.

Save the readiness JSON as `READINESS`.

## Step 5 — Render the DeploymentPlan

Compute a structural summary of the spec:

```bash
echo '<SPEC as JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/manifest-summary.cjs"
```

Then render the canonical block:

```bash
echo '{"summary": <summary JSON from above>, "readiness": <READINESS JSON>}' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/render-deployment-plan.cjs" \
      --meta-hash "$META_HASH" \
      --image "$IMAGE" \
      --size "$SIZE"
```

The script's stdout IS the plan. Print it to the user verbatim. Do not
restate, reformat, or splice in additional fields — the script owns the
canonical format.

## Step 6 — Wait for textual confirmation

Ask the user via `AskUserQuestion`:

> Confirm to broadcast `deploy_app` with the plan above? (yes / no)

This textual confirmation is the primary gate (per runtime policy). The
PreToolUse permission prompt that fires next is a safety net, not a
substitute. Do not call `deploy_app` without an explicit affirmative.

If the user says no, ask whether to amend the spec (return to Step 2) or
abort entirely.

## Step 7 — Broadcast

Call `mcp__manifest-fred__deploy_app` with the spec fields splatted as
arguments. The PreToolUse hook will prompt for permission — that is
expected.

Stream `notifications/progress` events to the user as they arrive.

If `deploy_app` raises (no response object), surface the error message and
stop. There is no lease to clean up.

If `deploy_app` returns a response, capture it as `DEPLOY_RESPONSE` and
proceed to Step 8.

## Step 8 — Classify the response

```bash
echo '<DEPLOY_RESPONSE JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/classify-deploy-response.cjs"
```

The script prints `{ outcome, lease_uuid?, provider_uuid?, urls, state_name?, error_summary? }`.

Capture `LEASE_UUID` from the script's output (always present except on
`failed`-with-no-lease).

Branch on `outcome`:

- **`active`** → skip Step 9, go directly to Step 10.
- **`needs_wait`** → call
  `mcp__manifest-fred__wait_for_app_ready({ lease_uuid: LEASE_UUID, timeout_seconds: 300 })`.
  On thrown error → Step 11. On success, call
  `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })` and merge its
  `connection` into the response. Re-run `classify-deploy-response.cjs` on
  the merged response. Then continue to Step 10.
- **`failed`** → Step 11.

## Step 9 — (reserved)

(Kept blank to preserve numbering used by Step 8 references.)

## Step 10 — Persist + success output

**Persist**:

```bash
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT
cat > "$TMPFILE" <<'JSON'
<paste the manifest_json string from build_manifest_preview here, NOT the spec>
JSON
node "$MANIFEST_PLUGIN_ROOT/scripts/save-manifest.cjs" \
  --lease-uuid "$LEASE_UUID" \
  --image "$IMAGE" \
  --size "$SIZE" \
  --meta-hash "$META_HASH" \
  --chain-id "$CHAIN_ID" \
  --manifest-file "$TMPFILE"
```

(`CHAIN_ID` comes from `chains.<activeChain>.chainId` in the config status
from Step 0. The trap ensures the tmpfile is removed even if save-manifest
fails.)

The script prints the saved file path on stdout. Show it briefly:
"Saved manifest record: `<path>`".

**Success output**: call `browse_catalog` once more to resolve provider name
(the deploy may have happened many minutes ago for the `needs_wait` branch),
then:

```bash
echo '{"deploy_response": <DEPLOY_RESPONSE>, "catalog": <browse_catalog response>}' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/format-success.cjs" --lease-uuid "$LEASE_UUID"
```

Print the script's stdout verbatim.

## Step 11 — Failure

Two sub-cases based on whether the broadcast created a lease.

### 11a — Lease was created (`LEASE_UUID` present)

Inline a thin troubleshoot sequence (do NOT `Read` the
`troubleshoot-deployment/SKILL.md` file). Run in parallel:

- `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`
- `mcp__manifest-fred__app_diagnostics({ lease_uuid: LEASE_UUID })`
- `mcp__manifest-fred__get_logs({ lease_uuid: LEASE_UUID, tail: 100 })`

Render a brief Markdown report to the user with three sections (Status /
Diagnostics / Recent logs). Decode the lease state:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state <state-int>
```

Then offer cleanup via `AskUserQuestion`:

> Close the lease to free its credits? (yes / no)

If yes, call `mcp__manifest-lease__close_lease({ lease_uuid: LEASE_UUID })`
(PreToolUse hook will prompt). On a successful close, run:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/remove-manifest.cjs" --lease-uuid "$LEASE_UUID"
```

(no-op if the saved manifest record does not exist).

If the user wants a deeper investigation, suggest
`/manifest-agent:troubleshoot-deployment`.

### 11b — No lease (`LEASE_UUID` absent)

The broadcast failed before any lease was created (most commonly: registry
rejected at upload time, insufficient gas, network error). Surface the
`error_summary` from the classify-deploy-response output verbatim and stop.
No cleanup needed.
