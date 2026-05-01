---
name: deploy-app
description: >
  Deploy a containerized app on Manifest end-to-end: pre-flight, manifest
  authoring, deployment plan + textual confirmation, broadcast, ready polling,
  URL output. Assumes the image is already built and pushed to a Fred-allowed
  public registry.
allowed-tools: Bash(*), Read, Write, mcp__manifest-fred__*, mcp__manifest-lease__*
---

# Deploy App (orchestrator)

You are running the full deployment workflow. Your responsibilities:

1. Mainnet safety check.
2. Drive `author-manifest` to produce a validated manifest.
3. Render a `DeploymentPlan` and wait for textual confirmation.
4. Broadcast `deploy_app`, persist the manifest, wait for the app to be ready.
5. Print the live URL on success, or invoke `troubleshoot-deployment` and
   offer cleanup on failure.

The runtime policy in `scripts/session-start.sh` defines the canonical
`DeploymentPlan` block format — keep it in sync.

**For all user choices, use the AskUserQuestion tool.**

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

If it fails, tell the user to run `/manifest-agent:init-agent` first and stop.
Parse the JSON output — you need `activeChain`, `address`, and `chains.<activeChain>.chainId`.

**IMPORTANT**: Do NOT read `~/.manifest-agent/config.json` directly.

## Step 1 — Mainnet confirmation

If `activeChain == "mainnet"`, ask the user via AskUserQuestion:

> You are about to deploy on mainnet. The lease and any retries will spend
> real funds. Continue?

- **Yes** — proceed.
- **No** — stop.

If they decline, stop immediately.

## Step 2 — Manifest authoring

Read the file `$MANIFEST_PLUGIN_ROOT/skills/author-manifest/SKILL.md` and
follow its **steps 1–8** to author and validate the manifest. The output is a
`MANIFEST_PREVIEW` block containing:

- `image`
- `size`
- `meta_hash`
- `readiness` (the `check_deployment_readiness` JSON — reuse it; do **not** call
  the tool again here)
- `manifest` (the validated manifest JSON)

Carry these values forward as `IMAGE`, `SIZE`, `META_HASH`, `READINESS`, and
`MANIFEST` for the rest of this skill.

## Step 3 — Render the DeploymentPlan

Render the `DeploymentPlan` block from the SessionStart-injected runtime
policy verbatim — that heredoc in `scripts/session-start.sh` is the single
source of truth for the field names, ordering, spacing, and indentation. Do
not restate or reformat the template here.

Populate the canonical block with these values:

- `Image` ← `IMAGE`
- `Size` ← `SIZE`
- `Manifest` ← one-line summary: service-count, port-count, env-count
- `meta_hash` ← `META_HASH`
- `Est. cost` ← `READINESS.sku.price.amount + READINESS.sku.price.denom`
- `Wallet` ← comma-separated `denom:amount` from `READINESS.wallet_balances`
- `Credits` ← `READINESS.credits.amount` + denom (or `"none"`), and
  `hours_remaining=READINESS.hours_remaining`

The `Provider` field is intentionally absent (the chain selects the provider
internally during `deploy_app`). The success block in Step 8 prints the
resolved provider name.

## Step 4 — Wait for textual confirmation

Ask the user explicitly:

> Confirm to broadcast `deploy_app` with the plan above? (yes / no)

This textual confirmation is the primary gate (per runtime policy). The
PreToolUse permission prompt that fires next is a safety net, not a
substitute. Do not call `deploy_app` without an explicit affirmative.

If the user says no, ask whether they want to amend the manifest (return to
Step 2) or abort entirely.

## Step 5 — Broadcast

Call `mcp__manifest-fred__deploy_app` with the manifest fields from the
`MANIFEST_PREVIEW` block. The PreToolUse hook (already wired in
`hooks/hooks.json`) forces a permission prompt — that is expected.

Stream `notifications/progress` events to the user as they arrive (M1 wires
them in 0.7.0).

If `deploy_app` fails:

- **Registry rejected at upload** (most common surprise — pre-flight does not
  check the allowlist): surface the error verbatim. If the broadcast created
  a lease (the response will contain a `lease_uuid` even on later failure),
  go to Step 8b. Otherwise, stop with no cleanup.
- Other broadcast errors (insufficient gas, network, etc.): surface verbatim,
  stop.

On success, capture `lease_uuid` from the response.

## Step 6 — Persist the manifest

Write the manifest JSON to a temp file, then call `save-manifest.cjs`.

```bash
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT
cat > "$TMPFILE" <<'JSON'
<paste the validated manifest_json here>
JSON
node "$MANIFEST_PLUGIN_ROOT/scripts/save-manifest.cjs" \
  --lease-uuid LEASE_UUID \
  --image IMAGE \
  --size SIZE \
  --meta-hash META_HASH \
  --chain-id CHAIN_ID \
  --manifest-file "$TMPFILE"
```

The `trap ... EXIT` ensures the tmpfile (which contains the manifest JSON,
including any user-supplied env values) is removed even if `save-manifest.cjs`
fails or the shell exits early.

Replace `LEASE_UUID`, `IMAGE`, `SIZE`, `META_HASH`, and `CHAIN_ID` (from
`activeChain`'s entry in the config) with their actual values.

The script prints the saved file path on stdout; show it to the user briefly
("Saved manifest to ...").

## Step 7 — Determine outcome

`deploy_app` in `manifest-mcp-fred@0.7.0` already polls internally until the
lease reaches `LEASE_STATE_ACTIVE` (or throws on terminal failure / timeout).
Inspect its response payload from Step 5:

- `lease_uuid`, `provider_uuid` — always present on a successful broadcast.
- `state` — typically the integer `2` (= `LEASE_STATE_ACTIVE`) on success;
  may also be returned as the string `"LEASE_STATE_ACTIVE"` depending on
  encoding. Treat either form as success.
- `connection.instances[]` — populated when the provider has the container
  up, with `fqdn`, `status` (e.g. `"running"`), and `ports` (a map of
  `"<containerPort>/<proto>"` to `{ host_ip, host_port }`).

Branch:

- **Happy path (typical):** if the response has an active state AND at least
  one `connection.instances[*]` with `status: "running"`, skip ahead to
  Step 8 Success and use this response directly. Do not call
  `wait_for_app_ready` or `app_status` — the data you need is already in
  hand, and the extra calls just add latency.
- **Fallback (rare):** if the response is missing `connection` or shows a
  non-active state, call
  `mcp__manifest-fred__wait_for_app_ready({ lease_uuid: LEASE_UUID, timeout_seconds: 300 })`
  to keep waiting. It throws on timeout or terminal failure — treat any
  thrown error as triggering Step 8b. On a successful return, call
  `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })` to fetch the
  typed `connection` payload, then proceed to Step 8 Success.

## Step 8 — Outcome

### 8a — Success

Build the externally-reachable URL from the `connection` payload (whether
sourced from `deploy_app` directly or from the fallback `app_status` call):

For each `connection.instances[i]` with `status: "running"`, format
`http://<instance.fqdn>:<host_port>/`, where `<host_port>` is read from the
single entry under `instance.ports` (e.g. `instance.ports["8080/tcp"].host_port`).
For a single-service deploy there is exactly one instance and one port; show
that URL. For multi-port instances, show one URL per port.

Resolve the provider's human-readable name from
`mcp__manifest-fred__browse_catalog` by matching `provider_uuid` from the
response. If no match, fall back to printing the UUID.

Print:

```
Deployed.
  URL:        <url>
  Lease UUID: <LEASE_UUID>
  Provider:   <provider name or uuid>
For logs / status:  /manifest-agent:troubleshoot-deployment
```

### 8b — Failure

Read `$MANIFEST_PLUGIN_ROOT/skills/troubleshoot-deployment/SKILL.md` and
follow its steps 2–5 with `LEASE_UUID` already set (skip its Step 1 — you
already have the UUID).

After the report renders, offer to reclaim the lease:

> Close the lease to free its credits? (yes / no)

If yes, call `mcp__manifest-lease__close_lease` with `LEASE_UUID`. The
PreToolUse hook will prompt for permission. On a successful close, run:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/remove-manifest.cjs" --lease-uuid LEASE_UUID
```

(no-op if the saved manifest is already gone).
