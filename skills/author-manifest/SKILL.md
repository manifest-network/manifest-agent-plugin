---
name: author-manifest
description: >
  Build and validate a Fred container deployment spec interactively
  (single-service or multi-service stack). Saves a JSON spec file ready to
  feed to /manifest-agent:deploy-app or directly to mcp__manifest-fred__deploy_app.
allowed-tools: Bash(*), Read, Write
---

# Author Container Deployment Spec

You are interactively building a Fred container deployment spec. The output is
a validated JSON file the user can hand to `/manifest-agent:deploy-app` or
inspect / edit / version-control as a normal file.

The spec uses the same shape `mcp__manifest-fred__deploy_app` and
`mcp__manifest-fred__build_manifest_preview` accept:

- **Single-service**: `{ image, port, env?, labels?, command?, args?, health_check?, storage?, tmpfs?, init? }`
- **Multi-service**: `{ services: { <name>: { image, ports, env?, ... }, ... }, storage?, depends_on? }`

**For all user choices in this skill, use the `AskUserQuestion` tool to
present options as a list rather than asking the user to type.**

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, tell the user to restart Claude Code so the SessionStart hook can
run, then stop.

## Step 1 — Read current config

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it fails, tell the user to run `/manifest-agent:init-agent` first and
stop. Otherwise parse the JSON; show the user `activeChain` and `address`.

**Never** read `~/.manifest-agent/config.json` directly — it contains the key
password.

## Step 2 — Choose deployment shape

Use `AskUserQuestion`:

- **Single-service** — one container image, one port. Simplest case.
- **Multi-service stack** — multiple named services (e.g. `web` + `db`),
  each with its own image and ports.

Store the choice as `SHAPE` (`single` or `stack`).

## Step 3 — Choose SKU size

Call `mcp__manifest-fred__browse_catalog`. From the response, build an
`AskUserQuestion` showing each available SKU's name, price (amount + denom),
and provider name. The user picks one. Store as `SIZE`.

## Step 4 — Image reference (single-service only)

If `SHAPE == single`:

State up-front:
> The image registry allowlist is enforced by the provider at deploy-time,
> not in pre-flight. A permitted-looking string can still be rejected when
> `deploy_app` runs.

Ask the user for the image reference. Format hint:
- Preferred (immutable): `registry/name@sha256:<digest>`
- Acceptable: `registry/name:tag`

Store as `IMAGE`.

If `SHAPE == stack`: defer image collection to Step 6b.

## Step 5 — Pre-flight readiness

Call `mcp__manifest-fred__check_deployment_readiness({ size: SIZE, image: IMAGE })`
(`image` may be omitted for stacks — it's display-only on the readiness side).

Pipe the response to the evaluator:

```bash
echo '<readiness JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/evaluate-readiness.cjs"
```

The script prints `{ status, reasons, suggested_actions }`. Branch on `status`:

- **`block`** — print the `reasons` to the user and stop. If
  `suggested_actions` includes `pick_different_sku`, return to Step 3 (the
  user may pick a different SKU and retry); otherwise stop entirely.
- **`warn`** — present `reasons` to the user. Use `AskUserQuestion` to ask
  what to do, with options derived from `suggested_actions`:
    - `fund_credit` → "Fund credits and continue" → call
      `mcp__manifest-lease__fund_credit` (gated by PreToolUse hook), then
      re-run Step 5.
    - `request_faucet` → "Request testnet faucet funds" → call
      `mcp__manifest-chain__request_faucet`, then re-run Step 5.
    - `topup_wallet` → "I'll top up the wallet myself" → stop, ask the user
      to top up and re-run the skill.
    - Always include "Proceed anyway" and "Abort" options.
- **`ok`** — silent pass.

## Step 6 — Author the spec

Use the `AskUserQuestion` tool throughout. Build a JavaScript object literal
in your working memory; you'll feed it to `build_manifest_preview` in Step 7.

### 6a — Single-service (`SHAPE == single`)

Required:
- **`port`** — container port to expose (1–65535).

Optional (ask one at a time, defaulting to "skip" if the user has nothing):
- **`env`** — environment variables. Loop: ask for KEY then VALUE; offer
  "add another" / "done". Build a `{ KEY: value }` map. Do NOT pre-validate
  names — `build_manifest_preview` is the validator.
- **`labels`** — same loop as `env`.
- **`command`** — ENTRYPOINT override. Array of strings (ask comma-separated).
- **`args`** — arguments to the command. Array of strings.
- **`health_check`** — if yes, collect `test` (string array, e.g.
  `["CMD", "curl", "-f", "http://localhost:8080/health"]`), and optional
  `interval`, `timeout`, `retries`, `start_period`.
- **`storage`** — persistent disk SKU. If yes, present storage SKU options
  from `browse_catalog`.
- **`tmpfs`** — array of strings, e.g. `["/tmp:size=64M"]`.
- **`init`** — boolean.

Final spec object: `{ image: IMAGE, port: <port>, ... }`.

### 6b — Multi-service stack (`SHAPE == stack`)

Use `AskUserQuestion` to ask how many services. Then loop: for each service:

Required per service:
- **`name`** — service name. Must be 1–63 chars, lowercase alphanumeric +
  hyphens, no leading/trailing hyphens (RFC 1123 DNS label). The MCP server
  validates this on `build_manifest_preview`; if a user-supplied name is
  rejected, surface the error and re-ask.
- **`image`** — same format hint as Step 4.
- **`ports`** — at least one. Ask for each port-protocol pair (e.g.
  `"80/tcp"`); the value in the manifest is `{}` per Fred's shape. Build
  `{ "80/tcp": {}, "443/tcp": {} }`.

Optional per service (same set as single-service): `env`, `labels`, `command`,
`args`, `user`, `tmpfs`, `health_check`, `stop_grace_period`, `depends_on`,
`expose`.

After all services collected, ask:
- **`storage`** (top-level) — apply to whole stack? If yes, pick SKU.
- **`depends_on`** (top-level cross-service order) — usually optional.

Final spec object:
```js
{
  services: {
    "<name>": { image, ports, env?, ... },
    ...
  },
  storage?,
  depends_on?
}
```

**Important**: per-service `image` (no top-level `image`); per-service `ports`
(map, not single `port`).

## Step 7 — Validate via build_manifest_preview

Call `mcp__manifest-fred__build_manifest_preview` with the spec object from
Step 6 splatted as input arguments. The response shape is:

```json
{
  "manifest_json": "<stringified Fred manifest>",
  "manifest": { ... },
  "format": "single" | "stack",
  "meta_hash_hex": "<sha256 hex>",
  "validation": { "valid": true|false, "errors": [string] }
}
```

If `validation.valid === false`:
1. Show each entry in `validation.errors[]` to the user with field paths.
2. Common fixes:
   - Reserved env names (e.g. `PATH`, `HOME`) — pick a different name.
   - Label keys starting with `fred.` — `fred.` is reserved.
   - Service names that are not RFC 1123 DNS labels.
3. Loop back to Step 6 to fix. Re-call `build_manifest_preview`. Repeat until
   `validation.valid === true`.

Save `meta_hash_hex` for Step 9's report.

## Step 8 — Save the spec to disk

Use `AskUserQuestion` to ask where to save the spec:

- **Default** — `~/.manifest-agent/manifests-drafts/<auto-name>.json` (the
  helper picks a name from the first image + timestamp).
- **Custom path** — let the user paste an absolute path.

Write the spec via the helper. The helper handles atomic write + `0600` mode +
parent dir creation, and refuses to overwrite an existing file.

For the default path, omit `--path`:

```bash
echo '<spec JSON, single line>' | node "$MANIFEST_PLUGIN_ROOT/scripts/save-manifest-draft.cjs"
```

For a user-chosen path:

```bash
echo '<spec JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/save-manifest-draft.cjs" --path /absolute/path/to/spec.json
```

The script prints the saved file path on stdout. Capture it as `SAVED_PATH`.

## Step 9 — Report

Tell the user:

```
Saved:           <SAVED_PATH>
meta_hash_hex:   <hex from Step 7>
Format:          single | stack

To deploy:       /manifest-agent:deploy-app <SAVED_PATH>

The file is plain JSON — feel free to edit it by hand or check it into your
repo. Re-running this skill (or `build_manifest_preview` directly) on a
hand-edited spec is the safest way to validate changes before deploying.
```

The image registry will be checked by the provider at deploy-time. If it's
rejected, `deploy_app` will fail with a clear error.
