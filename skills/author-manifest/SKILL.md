---
name: author-manifest
description: >
  Build and validate a Fred container deployment manifest interactively. Walks
  the user through SKU selection, image reference, environment, ports, and
  optional fields, then validates via build_manifest_preview. Emits a
  MANIFEST_PREVIEW handoff block ready for /manifest-agent:deploy-app or for
  direct use with mcp__manifest-fred__deploy_app.
allowed-tools: Bash(*), Read, Write, mcp__manifest-fred__*, mcp__manifest-lease__*
---

# Author Container Manifest

You are interactively building a Fred container deployment manifest. The output
is a validated manifest plus its `meta_hash`, ready to broadcast.

**For all user choices in this skill, use the AskUserQuestion tool to present
the options so the user can select from a list instead of typing.**

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If the output is empty, tell the user:
> `MANIFEST_PLUGIN_ROOT` is not set. Please restart Claude Code so the
> SessionStart hook can run, then try again.

Stop here if empty.

## Step 1 — Read current config

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If the command fails, tell the user:
> No agent configuration found. Run `/manifest-agent:init-agent` first.

Stop here.

Parse the JSON output. Show the user their `activeChain` and `address`.

**IMPORTANT**: Do NOT read `~/.manifest-agent/config.json` directly — it contains
the key password. Always use `update-config.cjs --status` for safe reads.

## Step 2 — Choose SKU size

Call `mcp__manifest-fred__browse_catalog` to list available providers and SKUs.

Use AskUserQuestion to ask which SKU size to deploy on. Show the **SKU name**,
**price** (amount + denom), and **provider name** for each option taken from
the catalog. Store the chosen SKU name as `SIZE`.

## Step 3 — Image reference

State up-front:
> The image registry allowlist is enforced by the provider at deploy-time, not
> in pre-flight. A permitted-looking string can still be rejected when
> `deploy_app` runs.

Ask the user to provide the image reference. Format hint:
- Preferred (immutable): `registry/name@sha256:<digest>`
- Acceptable: `registry/name:tag`

Store it as `IMAGE`.

## Step 4 — Pre-flight readiness

Call `mcp__manifest-fred__check_deployment_readiness` with `{ size: SIZE, image: IMAGE }`. Inspect the result:

- If `SIZE` is not in `available_sku_names`: stop and tell the user the SKU is
  not currently offered by any provider; suggest a different size from
  `available_sku_names`.
- If `wallet_balances` is empty or below what's needed for gas: stop and tell
  the user. On testnet, suggest `mcp__manifest-chain__request_faucet`. On
  mainnet, ask them to top up the agent's address.
- If `credits` is missing **or** `hours_remaining < 24`: warn the user that
  credits will be exhausted soon. Offer to invoke
  `mcp__manifest-lease__fund_credit` (this tool is gated by the PreToolUse
  hook — the user will see a permission prompt). Wait for their decision
  before continuing.
- If `hours_remaining >= 24`: silent pass.

**Save the full readiness JSON object** — it's emitted in the MANIFEST_PREVIEW
block in Step 7 so `/manifest-agent:deploy-app` can reuse it without
re-calling `check_deployment_readiness`.

## Step 5 — Author the manifest

**v1 ships single-service authoring only.** If the user describes a
multi-service stack, redirect them to call `mcp__manifest-fred__deploy_app`
directly with a `services` map.

Walk through these fields, using AskUserQuestion where there's a clear set of
choices:

- **Port** (required): the container port to expose (1–65535). Ask.
- **Environment variables** (optional): ask if any. Collect as `{ KEY: value }`
  pairs. Do NOT pre-validate names — `build_manifest_preview` is the
  authoritative validator.
- **Labels** (optional): ask if any. Collect as `{ key: value }` pairs.
- **Command** (optional): override container ENTRYPOINT. Array of strings.
- **Args** (optional): arguments to the command. Array of strings.
- **Health check** (optional): if yes, collect `test` (array of strings, e.g.
  `["CMD", "curl", "-f", "http://localhost:8080/health"]`), and optional
  `interval`, `timeout`, `retries`, `start_period`.
- **Storage SKU** (optional): ask if persistent disk is needed. If yes, present
  storage SKU choices from `browse_catalog`.
- **tmpfs mounts** (optional): array of strings like `"/tmp:size=64M"`.
- **Init process** (optional): boolean, defaults to false.

## Step 6 — Validate via build_manifest_preview

Assemble the structured input from Step 5 and call
`mcp__manifest-fred__build_manifest_preview` with it.

If the response contains `validation.errors`:
1. Show each error to the user with field paths and the offending value.
2. Loop back to Step 5 to fix. Common gotchas:
   - Reserved env names (e.g. `PATH`, `HOME`) — pick a different name.
   - Label keys starting with `fred.` — `fred.` is reserved.
   - Service names not matching RFC 1123 DNS labels — only lowercase
     alphanumeric + hyphens, no leading/trailing hyphens, max 63 chars.
3. Re-call `build_manifest_preview` with the corrected input. Repeat until
   `validation.errors` is empty (or absent).

## Step 7 — Emit the MANIFEST_PREVIEW handoff block

Print the block exactly in this format (a fenced code block in your message):

````
MANIFEST_PREVIEW
image: <IMAGE>
size: <SIZE>
meta_hash: <hex from build_manifest_preview>
readiness: <single-line JSON of the check_deployment_readiness result from Step 4>
manifest:
<pretty-printed manifest_json from build_manifest_preview, indented two spaces>
````

The block is the canonical handoff format for `/manifest-agent:deploy-app`.
Keep it intact verbatim.

## Step 8 — Next steps

Tell the user:
> The manifest is validated. To deploy it, run `/manifest-agent:deploy-app`
> and paste the MANIFEST_PREVIEW block back when prompted, or invoke
> `mcp__manifest-fred__deploy_app` directly with the manifest fields above.
>
> The image registry will be checked by the provider at deploy-time. If the
> registry is rejected, `deploy_app` will fail with a clear error.
