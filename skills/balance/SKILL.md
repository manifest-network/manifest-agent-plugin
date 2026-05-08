---
description: >
  Show wallet balances, billing credit balance, burn rate, and runway
  hours for a Manifest tenant. Read-only. Defaults to the agent's own
  address; pass a bech32 address as the argument to query a different
  tenant.
allowed-tools: Bash(*), Read
---

# Balance

You are reporting wallet + billing-credit state for a Manifest tenant.
Read-only — no broadcasts, no state mutation.

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only. To the user, just
describe what you're doing in plain language — e.g. "Fetching the
balance", not "Now in Step 2 the MCP call".

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart
Claude Code so the SessionStart hook runs, then stop.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it fails, tell the user to run `/manifest-agent:init-agent` first
and stop. Otherwise parse the JSON; you need:
- `activeChain` — used to point the renderer at
  `$MANIFEST_PLUGIN_DATA/chains/<activeChain>.json` for denom
  humanization.
- `address` — the agent's own bech32, used as the default tenant when
  `$ARGUMENTS` is empty.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly.

## Step 1 — Resolve the target tenant

If `$ARGUMENTS` is a non-empty string, treat it as the target tenant
(`TENANT = $ARGUMENTS`). Otherwise use the agent's own address from
Step 0 (`TENANT = address`).

Do not validate the bech32 client-side — `credit_balance` calls the
chain's `validateAddress` and will surface a precise error on bad
input.

## Step 2 — Fetch the balance

Call:

```
mcp__manifest-lease__credit_balance({ tenant: TENANT })
```

(Omit `tenant` entirely when `$ARGUMENTS` was empty — the MCP tool
defaults to the caller, which avoids a redundant round-trip.)

## Step 3 — Render

Pipe the JSON response through the renderer:

```bash
echo '<credit_balance response>' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/render-balance.cjs" \
      --chain-data-file "$MANIFEST_PLUGIN_DATA/chains/<activeChain>.json" \
      --address "$TENANT"
```

**Print the script's stdout verbatim.** It's a four-line Markdown block
covering wallet balances, credit balance, burn rate (with running-app
count), and runway hours. Optional fields render as `(unavailable)` —
do not paraphrase or rearrange.

## Step 4 — Optional follow-ups

If the rendered burn rate is non-zero and `Hours remaining` is small
(rough rule of thumb: under 24 hours), suggest topping up the credit
account via `mcp__manifest-lease__fund_credit` (the runtime policy
will gate the broadcast). Don't push the suggestion when credits are
healthy or the credit account doesn't exist.
