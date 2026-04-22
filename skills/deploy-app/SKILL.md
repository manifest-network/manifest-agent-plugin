---
name: deploy-app
description: >
  Deploy a containerized application on a Manifest provider. Creates the
  on-chain lease, uploads the manifest payload, and polls until the app is
  reachable. Supports a single container (image + port) or a multi-service
  stack. Reads a DeployAppInput-shaped JSON spec file or gathers the inputs
  interactively.
allowed-tools: Bash(*), Read
---

# Deploy an App

You are deploying a containerized app on the Manifest blockchain. The
`deploy_app` tool in `manifest-mcp-fred` does the end-to-end flow in a
single call: creates the on-chain lease (with a `--meta-hash` commitment),
uploads the container manifest to the assigned provider (ADR-036
authenticated), then polls until the app reports ready. Never try to
reproduce this from raw `cosmos_tx` calls — the lease creation and the
payload upload must stay coupled to avoid orphan leases that consume
credit.

**For user choices in this skill, use the `AskUserQuestion` tool to present
options the user can pick from a list.**

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If the output is empty, tell the user to restart Claude Code so the
`SessionStart` hook can run, then stop.

## Step 1 — Verify the agent is configured

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If the command fails, tell the user:
> No agent configuration found. Run `/manifest-agent:init-agent` first.

Stop here.

Parse the JSON output and note the `address`, `activeChain`, and
`gasPrice`. Show these to the user so they know which account and chain
they are deploying from.

**IMPORTANT:** Do NOT read `~/.manifest-agent/config.json` directly — it
contains the key password. Always use `update-config.cjs --status` for
safe fields.

## Step 2 — Pre-flight queries (read-only)

Call these MCP tools in parallel and summarize the results:

1. `mcp__manifest-lease__credit_balance` — the agent's billing account
   balance and spending outlook. No arguments. Response shape:
   `{balances: [{denom, amount}], spending_per_hour?, hours_remaining?,
   running_apps?, credits: {active_leases, pending_leases, reserved_amounts}|null}`.
2. `mcp__manifest-fred__browse_catalog` — available service tiers with
   live provider health checks. No arguments. Response shape:
   `{providers: [{uuid, address, apiUrl, active, healthy, healthError?, providerUuid?}],
   tiers: {<name>: [{provider, price, unit}]}}`. Prefer this over
   `get_skus` in this flow because it pre-stringifies `unit` (e.g.
   `"UNIT_PER_HOUR"`) and `price`, and annotates provider health. Fall
   back to `mcp__manifest-lease__get_skus` if `browse_catalog` errors
   out — but note that `get_skus` returns `unit` as a raw enum number
   (`1` = per-hour, `2` = per-day, `0` = unspecified) and `metaHash`
   as a byte-object that can be ignored.
3. `mcp__manifest-chain__cosmos_query` with
   `{module: "bank", subcommand: "balances", args: ["<address>"]}` —
   the wallet's gas-denom balance (used as the upper bound on the
   broadcast fee). Use the `address` from Step 1. Top-level response
   shape: `{module, subcommand, result: {balances: [{denom, amount}], pagination?}}`.
   The balances are nested under `result`, not at the top level.

Display:
- Current credit balance: each `balances[]` entry plus
  `hours_remaining` if present.
- Tier list from `browse_catalog.tiers`: for each tier name, show the
  provider options (health + price + unit). The user will pick a
  `size` from the list of tier names. Skip tiers whose only providers
  are `healthy: false`.
- Wallet balance for the gas denom derived from the `gasPrice` value
  returned by `update-config.cjs --status` in Step 1 (e.g., a
  `gasPrice` of `"1umfx"` means query the wallet's `umfx` balance).

## Step 3 — Auto-offer `fund_credit` when credit is empty

Treat the billing account as **empty** when either:
- `balances` is an empty array, or
- every entry in `balances` has `amount === "0"` (amounts are strings).

If empty, ask the user whether they want to fund the billing account
before deploying. Use `AskUserQuestion` with two options:

- **Fund now** — send tokens to the billing account before deploying
- **Skip** — attempt the deploy anyway (will fail if the lease cannot
  charge its first billing tick)

If the user picks **Fund now**:

1. Ask how much to fund. Prefer the same denom as `gasPrice`. Express
   the amount in base units with its denom concatenated, e.g.
   `10000000umfx`. Explain that this sends tokens from the wallet to
   the on-chain billing account and is irreversible.
2. Follow the runtime transaction policy: describe the action concretely
   (source = wallet `address`, destination = billing account, amount,
   denom), show the wallet balance from Step 2 as the upper bound on
   potential loss, and note the exact fee will be determined at
   broadcast time.
3. Wait for explicit textual confirmation. A Claude Code permission
   prompt will also fire — that is a safety net, not a substitute.
4. Call `mcp__manifest-lease__fund_credit` with
   `{amount: "<amount><denom>"}`.
5. On success, re-call `mcp__manifest-lease__credit_balance` and show
   the new balance. On failure, surface the error and ask whether to
   continue without funding or stop.

**If the credit balance is non-zero**, do not offer funding. Proceed to
Step 4.

## Step 4 — Choose input mode

Use `AskUserQuestion` with two options:

- **Spec file** — load a `DeployAppInput`-shaped JSON file from disk
- **Interactive** — answer a few prompts (single-container apps only)

### Spec file mode

1. Ask the user for the file path.
2. Read the file.
3. Parse as JSON. Reject anything that is not a JSON object.
4. Validate required fields:
   - `size` must be a string that matches one of the SKU names from
     Step 2. If it does not match, stop and list available SKUs.
   - Exactly one of: (`image` + `port`) OR `services`. Reject if both
     or neither are present.
5. Show the parsed spec back to the user, pretty-printed.

### Interactive mode

Ask in order:
1. **Container image** (e.g., `nginx:1.27`, `ghcr.io/org/app:v1.2.3`).
2. **Port** (integer, 1–65535). Will be exposed as `<port>/tcp` with a
   random host port assigned by the provider. For `host_port`,
   `ingress`, UDP, or multiple ports, ask the user to switch to spec
   file mode — `DeployAppInput` does not expose those in its
   `port: number` shortcut.
3. **SKU size** — use `AskUserQuestion` with the SKU names from Step 2.
4. **Environment variables** (optional). Collect zero or more
   `KEY=VALUE` pairs. Build an object `{KEY: "VALUE"}`. Skip if none.
5. **Persistent storage SKU** (optional). If the user wants storage,
   show storage-tier SKUs from Step 2 and let them pick one; that goes
   in `storage`. Skip if none.

Construct the `DeployAppInput` object from these answers.

## Step 5 — Echo and confirm

Display the resolved `DeployAppInput` as pretty JSON alongside:

- Wallet `address`.
- Chain and gas denom.
- Wallet balance for the gas denom (from Step 2) — the upper bound on
  potential loss on the broadcast.
- A reminder that `deploy_app` has no matching estimate call, so the
  exact fee is determined at broadcast time.

Ask the user to confirm before continuing. Do NOT proceed to Step 6
until the user answers yes in the conversation. A Claude Code
permission prompt will also fire when `deploy_app` runs — that is the
safety net, not a substitute for this confirmation.

## Step 6 — Deploy

Call `mcp__manifest-fred__deploy_app` with the resolved
`DeployAppInput` object. Do not set `gas_multiplier` unless the user
explicitly asked for one.

The tool will:
1. Look up the SKU + provider UUID on-chain.
2. Build the container manifest and SHA-256 it as the `--meta-hash`.
3. Broadcast `billing create-lease` with the SKU items and meta hash.
4. Upload the manifest payload to the provider (ADR-036 authenticated).
5. Poll the provider until the app reports ready.

This can take up to a minute or two depending on image pull time.

**If the tool reports a partial failure** (the error will say
something like `Deploy partially succeeded: lease <uuid> was created
but subsequent steps failed. Close this lease with close_lease if
needed.`), surface that guidance to the user verbatim — orphan leases
continue consuming credit until closed.

## Step 7 — Report results

Display:
- `lease_uuid` — store this; the user needs it for `app_status`,
  `get_logs`, `/manifest-agent:update-app`, `restart_app`, and
  `close_lease`.
- `provider_uuid` and `provider_url`.
- `state` — the lease state.
- `url` if the tool returned one (host + first port). This is the
  connection URL for the app.
- `connection` — the full host/ports map if available.
- `connectionError` — if the tool could not fetch connection info
  despite the lease being ready. Tell the user they can re-fetch with
  `mcp__manifest-fred__app_status` later.

Offer next steps:
- `mcp__manifest-fred__app_status` — check state at any time.
- `mcp__manifest-fred__get_logs` — tail container logs.
- `/manifest-agent:update-app` — change the manifest without closing
  the lease.

## Gas retry

If `deploy_app` fails with an out-of-gas error, the runtime policy
permits exactly one retry with `gas_multiplier` bumped by `0.1` from
the server-configured default. Before the retry, describe the new
multiplier and get a fresh confirmation — the original approval was
for a different implied fee. Do not retry a second time; report both
failures and stop.

## Notes

- The `deploy_app` tool spends credit on an ongoing basis once the
  lease is active. Close the lease with
  `mcp__manifest-lease__close_lease` when the app is no longer needed.
- The on-chain `--meta-hash` commits to the exact manifest bytes the
  provider will see. Do not try to build the manifest client-side and
  pass it through a raw `cosmos_tx` — the tooling handles that
  coupling and getting it wrong produces leases the provider will
  refuse to serve.
- For multi-service stacks, the SKU items are expanded automatically
  based on the `services` keys — one item per service, each
  identified by service name. Service names must be RFC 1123 DNS
  labels (1–63 chars, lowercase alphanumeric + hyphens, no leading or
  trailing hyphen).
