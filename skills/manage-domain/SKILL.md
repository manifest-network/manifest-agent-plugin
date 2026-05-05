---
name: manage-domain
description: >
  Set, clear, or look up the custom domain (FQDN) attached to a Manifest
  lease item. Use after a lease exists. With no argument, asks which
  action and which lease. With a lease UUID argument, treats it as the
  target. Set/clear go through cosmos_estimate_fee, textual confirmation,
  and the PreToolUse permission prompt; lookup is read-only.
allowed-tools: Bash(*), Read
---

# Manage Custom Domain

You are setting, clearing, or looking up a custom domain on a Manifest
lease item. Custom domains are claimed permanently on-chain until cleared
or the lease closes; the chain validates format, lowercase, and reserved
suffixes.

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers (e.g. "Step 4", "Step 6") are scaffolding for skill authors
only. To the user, just describe what you're doing in plain language —
e.g. "I'll estimate the tx fee and ask you to confirm before broadcasting",
not "Now in Step 5 the fee estimation". Skip phrases like "Now in Step N"
or "Branching to..."; describe the action itself.

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
stop. Otherwise parse the JSON; you need `activeChain` and `address`.

**Never** read `~/.manifest-agent/config.json` directly.

## Step 1 — Pick the action

Use `AskUserQuestion`:

- **Set** — attach a new FQDN to a lease item.
- **Clear** — remove the FQDN currently attached to a lease item.
- **Lookup** — find which lease (and which service inside it) currently
  owns a given FQDN.

Store as `ACTION`.

If `ACTION === "lookup"`, jump to Step 6 (read-only).

## Step 2 — Mainnet warning

If `activeChain == "mainnet"` AND `ACTION === "set"`, ask via
`AskUserQuestion`:
> You are about to claim a custom domain on mainnet. The FQDN is
> permanently associated with this lease until you `--clear` it or close
> the lease. FQDN squatting is irreversible. Continue?

Options: **Yes** / **No**. Stop on No.

For `clear` on mainnet, no extra warning beyond the textual confirmation
in Step 5 — clearing a domain frees the reservation but doesn't burn
funds beyond the small tx fee.

## Step 3 — Pick the lease (set / clear)

Skip this section if `ACTION === "lookup"`.

Branches in priority order, mirroring `troubleshoot-deployment` Step 1:

1. **From `$ARGUMENTS`**: if `$ARGUMENTS` is a non-empty UUID-shaped
   string, use it directly. Validate against the strict UUID pattern
   (8-4-4-4-12 lowercase hex with dashes — same regex used in
   `scripts/save-manifest.cjs:60`); reject anything else with a clear
   error.
2. **From `manifest://leases/active` MCP resource**: read the resource.
   If it returns one or more leases, present them via `AskUserQuestion`
   (lease UUID, image, current `customDomain` per item if known). Let
   the user pick.
3. **Fallback to saved manifests**:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/list-saved-manifests.cjs"
   ```
   Each entry includes `lease_uuid, image, custom_domain?,
   custom_domain_service_name?` — surface those in the picker.
4. **Last resort**: ask the user to paste a UUID. Validate against the
   UUID regex before continuing.

Store the chosen UUID as `LEASE_UUID`.

## Step 4 — Pick the service (stacks only, set/clear)

Skip this section if `ACTION === "lookup"`.

Query `mcp__manifest-lease__leases_by_tenant({ tenant: <address from
Step 0> })` and find the lease matching `LEASE_UUID`. Examine its
`items[]` array:

- **Single item** (no `serviceName`, or one item only): no picker; the
  domain attaches implicitly. Set `SERVICE_NAME = ""`.
- **Multiple items** (stack lease): present each item's
  `serviceName` (and current `customDomain` if any) via
  `AskUserQuestion`. Let the user pick. Store as `SERVICE_NAME`.

Brief note when offering set/clear on a service that already has a
domain: "This service currently holds `<existing-fqdn>`; setting will
replace it; clearing will free it. Switching the domain on a live lease
may cause a brief routing gap while the provider reconciles."

## Step 5 — FQDN + DNS pre-check (set only)

Skip this section if `ACTION === "clear"` or `"lookup"`.

Ask the user for the FQDN. Validate client-side:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/validate-domain.cjs" --domain "<fqdn>"
```

If `valid === false`, surface each entry in `reasons[]` and re-ask. On
valid, store as `FQDN`.

Run a warn-only DNS pre-check:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/dns-precheck.cjs" --domain "$FQDN"
```

- `resolved: true` → tell the user briefly what was found (a / aaaa /
  cname). Continue.
- `resolved: false` → surface `reason` and ask via `AskUserQuestion`:
  > DNS doesn't resolve `<fqdn>` yet (`<reason>`). The chain claim will
  > succeed regardless, but the domain won't route until DNS catches up.
  > Continue anyway?
  Options: **Continue** / **Abort**.

## Step 6 — Estimate, confirm, broadcast (set / clear)

Skip this section if `ACTION === "lookup"`; jump to Step 7.

Estimate the chain tx fee per the runtime policy:

```
mcp__manifest-chain__cosmos_estimate_fee({
  module: "billing",
  subcommand: "set-item-custom-domain",
  args: [
    "<LEASE_UUID>",
    // For set: include the FQDN positional + optional --service-name:
    "<FQDN>",                                    // omit for clear
    // For stacks: append "--service-name", "<SERVICE_NAME>"
    // For clear: append "--clear" (and omit FQDN positional)
  ]
})
```

If the estimate fails, surface the error and ask whether to proceed
without one — do NOT silently skip.

Then ask via `AskUserQuestion` (set):
> Set custom domain `<FQDN>` on lease `<LEASE_UUID>` (service
> `<SERVICE_NAME>` if set; "single-item lease" otherwise)?
> Estimated tx fee: `<human-readable fee>` (gas `<gasEstimate>`).
> The chain validates format / reserved-suffix rules at broadcast time;
> if it rejects, no funds beyond gas are spent.
> (yes / no)

Or (clear):
> Clear the custom domain currently on lease `<LEASE_UUID>` (service
> `<SERVICE_NAME>` if applicable)?
> Estimated tx fee: `<human-readable fee>` (gas `<gasEstimate>`).
> Clearing frees the reverse-lookup entry so the FQDN can be re-claimed.
> (yes / no)

On yes, call:
```
mcp__manifest-lease__set_item_custom_domain({
  lease_uuid: LEASE_UUID,
  custom_domain: FQDN,                        // omit for clear
  service_name: SERVICE_NAME || undefined,    // omit for single-item
  clear: true                                 // ONLY for clear
})
```
PreToolUse will prompt — that is expected.

**Verify on-chain state after the tx returns** — a successful broadcast
does not guarantee the chain item now holds (or no longer holds) the
domain. Re-query `mcp__manifest-lease__leases_by_tenant`, find the
matching lease's items[], and check the matching item's `customDomain`
field:
- For **set**: confirm `item.customDomain === FQDN`. If yes, tell the
  user "Custom domain `<FQDN>` confirmed on lease `<LEASE_UUID>`. TLS
  may take a few minutes to provision at the provider; the provider's
  default FQDN keeps working in the meantime."
- For **clear**: confirm `item.customDomain` is empty / absent. If yes,
  tell the user "Domain cleared on lease `<LEASE_UUID>`."
- If the verification doesn't match (chain may need a moment to
  settle, or the tx was accepted but reverted): tell the user the tx
  was sent but verification failed; suggest re-running this skill in
  ~30s to re-check.

If the saved manifest wrapper at
`~/.manifest-agent/manifests/<LEASE_UUID>.json` exists, refresh it via
`scripts/save-manifest.cjs` so future `/manifest-agent:troubleshoot-deployment`
runs surface the new state. Use `--custom-domain` for set (or omit it
for clear). The wrapper write requires the original `--manifest-file`
content; for that, fall back to leaving the wrapper untouched if it
predates v3 (it'll get refreshed next deploy). It is acceptable for
the wrapper's `custom_domain` field to be stale until the next
re-deploy — the chain is the canonical source.

## Step 7 — Lookup (read-only)

Skip if `ACTION !== "lookup"`.

Ask the user for the FQDN to look up. Then:

```
mcp__manifest-lease__lease_by_custom_domain({ custom_domain: <fqdn> })
```

Surface the response:
- If the lease exists, render `lease.uuid`, `lease.tenant`,
  `lease.providerUuid`, and the returned `service_name`. Tell the user
  they can run `/manifest-agent:troubleshoot-deployment <uuid>` for a
  full status report on that lease.
- If the lease is empty / not found, tell the user the FQDN is not
  currently claimed and they may attach it via `/manifest-agent:manage-domain`
  → "set".
