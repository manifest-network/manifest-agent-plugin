---
description: >
  Set, clear, or look up the custom domain (FQDN) attached to a Manifest
  lease item. Use after a lease exists when the user wants to attach a
  hostname, free a reservation, or reverse-resolve which lease owns an
  FQDN. With no argument, asks which action and which lease. With a
  lease UUID argument, treats it as the target. Set/clear go through
  cosmos_estimate_fee, textual confirmation, and the PreToolUse permission
  prompt; lookup is read-only.
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

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart Claude Code so the SessionStart hook runs, then stop.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it fails, tell the user to run `/manifest-agent:init-agent` first and
stop. Otherwise parse the JSON; you need `activeChain` and `address`.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly.

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
> Mainnet warning: this transaction permanently associates the FQDN with
> this lease on-chain until you clear it via `/manifest-agent:manage-domain`
> or close the lease. FQDN squatting is irreversible. Continue?

Options: **Yes** / **No**. Stop on No.

(This wording mirrors the `render-intent-recap.cjs` mainnet warning the
deploy-app flow shows on `customDomain`-bearing specs — same substance,
same phrasing, so users see consistent warnings whether they reach a
domain claim through deploy-app or this skill.)

For `clear` on mainnet, no extra warning beyond the textual confirmation
in Step 5 — clearing a domain frees the reservation but doesn't burn
funds beyond the small tx fee.

## Step 3 — Pick the lease (set / clear)

Skip this section if `ACTION === "lookup"`.

Branches in priority order, mirroring `troubleshoot-deployment` Step 1:

1. **From `$ARGUMENTS`**: if `$ARGUMENTS` is a non-empty UUID-shaped
   string, use it directly. Validate against the strict UUID pattern
   (8-4-4-4-12 lowercase hex with dashes — the canonical regex lives in
   `scripts/_uuid.cjs`); reject anything else with a clear error.
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
Step 0> })`. Pipe the response through `extract-lease-items.cjs` (do
NOT decode the typed shape in prose — the script handles
camelCase/snake_case key tolerance and shape variations):

```bash
echo '<leases_by_tenant response>' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/extract-lease-items.cjs" --lease-uuid "$LEASE_UUID"
```

Parse the script's stdout (`{ found, items, single_item }`):

- **`found: false`** → the lease UUID isn't in the signer's leases.
  Surface that and stop (the user may have typed the wrong UUID, or
  the lease belongs to a different tenant).
- **`single_item: true`** → no picker; the domain attaches implicitly.
  Set `SERVICE_NAME = ""`.
- **Otherwise** (stack lease) → present each entry in `items[]` via
  `AskUserQuestion` showing `serviceName` and current `customDomain`
  (when non-empty). Store the chosen `serviceName` as `SERVICE_NAME`.

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

Build the `cosmos_estimate_fee` args[] array via
`build-set-domain-args.cjs` (do NOT hand-construct the array — the script
pins the shape across all set/clear/single/stack permutations):

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/build-set-domain-args.cjs" \
  --lease-uuid "$LEASE_UUID" \
  <set-mode: --fqdn "$FQDN" | clear-mode: --clear> \
  <stacks-only: --service-name "$SERVICE_NAME">
```

Capture the script's stdout (a JSON array) as `SET_DOMAIN_ARGS`.

Set up the inputs for the shared billing-tx confirm reference:

- `<estimate-subcommand>` = `"set-item-custom-domain"`
- `<estimate-args>` = `SET_DOMAIN_ARGS` (from the script above)
- `<broadcast-call>` (set) =
  `mcp__manifest-lease__set_item_custom_domain({ lease_uuid: LEASE_UUID, custom_domain: FQDN, service_name: SERVICE_NAME || undefined })`
- `<broadcast-call>` (clear) =
  `mcp__manifest-lease__set_item_custom_domain({ lease_uuid: LEASE_UUID, service_name: SERVICE_NAME || undefined, clear: true })`
- `<prompt-body>` (set):
  > Set custom domain `<FQDN>` on lease `<LEASE_UUID>` (service
  > `<SERVICE_NAME>` if set; "single-item lease" otherwise)?
  > The chain validates format / reserved-suffix rules at broadcast time;
  > if it rejects, no funds beyond gas are spent.
- `<prompt-body>` (clear):
  > Clear the custom domain currently on lease `<LEASE_UUID>` (service
  > `<SERVICE_NAME>` if applicable)?
  > Clearing frees the reverse-lookup entry so the FQDN can be re-claimed.

Then `Read` `references/billing-tx-confirm.md` (plugin-root shared
reference; same file is loaded by troubleshoot-deployment Step 6 and
deploy-app's post-failure cleanup) and follow Steps 1–4 (estimate,
humanize, textual confirm, broadcast). The PreToolUse hook will prompt
— that's expected. Step 5a (close-lease verify) doesn't apply here;
the custom-domain verify (Step 5b in the reference) is handled inline
below.

**Verify on-chain state after the tx returns** — a successful broadcast
does not guarantee the chain item now holds (or no longer holds) the
domain. Re-query `mcp__manifest-lease__leases_by_tenant` and pipe
through `verify-domain-state.cjs` (do NOT inline the equality check in
prose — the script wraps `extract-lease-items.cjs` and does the
comparison so this site, the partial-success retry path, and any future
verifier all agree on the outcome shape):

```bash
echo '<leases_by_tenant response>' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/verify-domain-state.cjs" \
      --lease-uuid "$LEASE_UUID" \
      <stacks: --service-name "$SERVICE_NAME"> \
      --expected '<set: $FQDN | clear: "">'
```

For set, pass `--expected "$FQDN"`. For clear, pass `--expected ""`.

The script's stdout is `{ outcome, actual?, reason? }`. Branch on `outcome`:

- **`match`** (set): tell the user "Custom domain `<FQDN>` confirmed on
  lease `<LEASE_UUID>`. TLS may take a few minutes to provision at the
  provider; the provider's default FQDN keeps working in the meantime."
- **`match`** (clear): tell the user "Domain cleared on lease
  `<LEASE_UUID>`."
- **`mismatch`**: the chain may need a moment to settle, or the tx was
  accepted but reverted. Tell the user the tx was sent but verification
  shows `<actual>` instead of the expected value; suggest re-running
  this skill in ~30s to re-check.
- **`not_found`**: surface `reason` and tell the user the lease + service
  combination wasn't visible to the tenant query — verification couldn't
  complete.

After branching on the verify outcome, append a journal record (one per
set/clear invocation, regardless of verify result):

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" <<'JOURNAL_EOF'
{
  "skill": "manage-domain",
  "active_chain": "<activeChain from Step 0>",
  "signer_address": "<address from Step 0>",
  "intent": "<a brief paraphrase of the user's request — what they want to accomplish, not their verbatim message; max ~240 chars; do NOT echo any secrets the user may have typed (passwords, API keys, mnemonics) — the value field is not redacted>",
  "plan_summary": "<set|clear> domain on lease <LEASE_UUID>, service=<SERVICE_NAME or 'single-item'>",
  "tool_calls": [
    {
      "tool": "mcp__manifest-chain__cosmos_estimate_fee",
      "args_redacted": { "module": "billing", "subcommand": "set-item-custom-domain", "args": ["<LEASE_UUID>", "<FQDN or omitted on clear>", "--service-name", "<SERVICE_NAME if stacks>", "--clear (clear-mode only)"] },
      "outcome": "ok",
      "result_summary": { "fee_human": "<humanized fee from billing-tx-confirm step>" }
    },
    {
      "tool": "mcp__manifest-lease__set_item_custom_domain",
      "args_redacted": { "lease_uuid": "<LEASE_UUID>", "custom_domain": "<FQDN or null>", "service_name": "<SERVICE_NAME or null>", "clear": <true|false> },
      "outcome": "ok"
    },
    {
      "tool": "mcp__manifest-lease__leases_by_tenant",
      "args_redacted": { "tenant": "<address>" },
      "outcome": "ok",
      "result_summary": { "verify_outcome": "<match|mismatch|not_found>" }
    }
  ],
  "outcome": "<success if match | partial if mismatch | failed if not_found>",
  "final_state": {
    "lease_uuid": "<LEASE_UUID>",
    "action": "<set|clear>",
    "fqdn": "<FQDN or null>",
    "service_name": "<SERVICE_NAME or null>",
    "verified": "<true|false>"
  },
  "errors": [],
  "recovery_actions": []
}
JOURNAL_EOF
```

If the broadcast itself failed (chain rejected the tx, e.g. invalid
FQDN, reserved suffix, lease not owned), set `outcome` to `"failed"`,
include the error in `errors[]`, and adjust the `tool_calls[]` outcomes
accordingly. If the user cancelled at the textual confirm step in the
billing-tx-confirm reference, set `outcome` to `"cancelled"` and
truncate `tool_calls[]` to just the estimate. Lookup-only invocations
(Step 7) do NOT write a journal record — read-only flows are out of
scope. Do NOT mention the journal write in your reply to the user.

**The saved manifest wrapper at
`$MANIFEST_PLUGIN_DATA/manifests/<LEASE_UUID>.json` is intentionally NOT
refreshed here.** `save-manifest.cjs` requires `--manifest-file` with
the canonical `manifest_json` bytes (so it can SHA-256-verify against
`meta_hash_hex`), and this skill never has that payload — re-reading
the existing wrapper would defeat the secrets-handling discipline that
forbids surfacing `manifest_json` content. The wrapper's stored
`custom_domain` may therefore be stale after a set/clear; that's a
known limitation. Consumers needing the live value should query
`mcp__manifest-lease__leases_by_tenant` (or
`mcp__manifest-lease__lease_by_custom_domain`) — the chain is the
canonical source for which FQDN currently belongs to which lease. The
wrapper's `custom_domain` will refresh naturally on the next
`/manifest-agent:deploy-app` run for that lease.

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
