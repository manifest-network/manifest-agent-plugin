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

**Do not narrate the skill's internal structure in your chat output.**
Step numbers (e.g. "Step 4", "Step 6b") are scaffolding for skill authors
only. To the user, just describe what you're doing in plain language —
e.g. "Now let me check your wallet and credit balance", not "Now in Step 5
the readiness check". Skip phrases like "Now in Step N" or "Switching to
the multi-service branch"; describe the action itself.

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

Store as `IMAGE`. **Then immediately inspect the image** to (a) verify it
exists / is reachable on the public registry — failing here saves a wasted
broadcast — and (b) auto-detect ports, default cmd/entrypoint, and any
known-needed tmpfs paths so we don't ask the user about things the image
already declares:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/inspect-image.cjs" --image "<IMAGE>"
```

The script prints a JSON object on stdout. Capture it as `IMAGE_INFO`.
Possible outcomes:

- **Empty `{}`**: inspection failed (image not found, registry refused
  anonymous access, network issue — see stderr). Show the user the stderr
  reason and ask: "proceed without auto-detection? You'll need to provide
  ports / tmpfs manually. (yes / abort)". On yes, set `IMAGE_INFO = {}` and
  continue.
- **Non-empty**: surface a brief detected-from-image summary so the user
  knows what we picked up:
    > Detected from `<IMAGE_INFO.image>`:
    >   ports: `<IMAGE_INFO.ports>`
    >   default cmd: `<IMAGE_INFO.cmd>` (will be used unless you override)
    >   suggested tmpfs: `<IMAGE_INFO.suggestedTmpfs>` (offered in Step 6)
  `env` from the image is informational only (usually system stuff like
  `PATH`, `NGINX_VERSION`); do NOT auto-populate user env from it.

If `SHAPE == stack`: defer image collection (and per-service inspection)
to Step 6b.

## Step 5 — Pre-flight readiness

Call `mcp__manifest-fred__check_deployment_readiness({ size: SIZE, image: IMAGE })`
(`image` may be omitted for stacks — it's display-only on the readiness side).

Pipe the response to the evaluator. Pass `--gas-price` from the config you
read in Step 1 (it's the `gasPrice` field, e.g. `"1umfx"` or `"0.37upwr"`)
so the script knows which wallet denom to check for gas:

```bash
echo '<readiness JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/evaluate-readiness.cjs" --gas-price '<gasPrice from config>'
```

The script prints `{ status, reasons, suggested_actions }`. Branch on `status`:

- **`block`** — print the `reasons` to the user and stop. If
  `suggested_actions` includes `pick_different_sku`, return to Step 3 (the
  user may pick a different SKU and retry); otherwise stop entirely.
- **`warn`** — present `reasons` to the user. Use `AskUserQuestion` to ask
  what to do, with options derived from `suggested_actions`:
    - `fund_credit` → "Fund credits and continue". When the user picks
      this, ask them how much to fund (e.g. `"10000000umfx"`). Then —
      per the runtime policy — estimate the tx fee BEFORE broadcasting:
      ```
      mcp__manifest-chain__cosmos_estimate_fee({
        module: "billing",
        subcommand: "fund-credit",
        args: ["<amount>"]   // same string you'll pass to fund_credit
      })
      ```
      Surface the estimated `gasEstimate` + `fee.amount` and ask the user
      to confirm: "Fund credits with `<amount>`? Estimated tx fee:
      `<human-readable fee>` (gas `<gasEstimate>`). (yes / no)". On yes,
      call `mcp__manifest-lease__fund_credit({ amount: <amount> })`
      (gated by PreToolUse hook), then re-run Step 5. If the estimate
      itself fails, surface the error and ask whether to proceed without
      one — do not silently skip.
    - `request_faucet` → "Request testnet faucet funds" → call
      `mcp__manifest-chain__request_faucet`, then re-run Step 5.
      (No fee estimate — the faucet is a free testnet operation.)
    - `topup_wallet` → "I'll top up the wallet myself" → stop, ask the user
      to top up and re-run the skill.
    - Always include "Proceed anyway" and "Abort" options.
- **`ok`** — silent pass.

## Step 6 — Author the spec

Use the `AskUserQuestion` tool throughout. Build a JavaScript object literal
in your working memory; you'll feed it to `build_manifest_preview` in Step 7.

### 6a — Single-service (`SHAPE == single`)

We always emit the **services-map shape** for the spec — even when there's
only one service — because we need per-port `ingress: boolean` control,
which the simpler `{ image, port }` form doesn't expose. Default service
name: `"app"` (the user can override).

**Ports** — driven by `IMAGE_INFO.ports`:
- If `IMAGE_INFO.ports.length === 1`: use it directly (e.g. `"80/tcp"`).
  Don't ask which port.
- If `IMAGE_INFO.ports.length > 1`: ask the user (`AskUserQuestion`,
  multi-select) which ports to expose.
- If `IMAGE_INFO.ports` is empty (or `IMAGE_INFO == {}` from a failed
  inspection): ask the user to type each port-protocol pair (e.g.
  `"80/tcp"`).

**Ingress per port** — for each chosen port:
- If it's the only port AND its number is one of `80, 443, 8080, 8443`
  (common web ports): `AskUserQuestion` "Default ingress=true (port appears
  to be a standard web port — Recommended). Confirm?" with options
  `["Yes (Recommended)", "No (internal only)"]`.
- Otherwise (multiple ports, OR single non-web port): ask explicitly per
  port: "Should `<port>` be publicly reachable via the provider's ingress?
  (yes / no)" — no default. Be explicit, do not guess.

The chosen `ports` map is `{ "<port>/<proto>": { ingress: <bool> }, ... }`
even when ingress is true (encode it explicitly so the spec is unambiguous
when re-loaded later).

**Cmd / Entrypoint / User / WorkingDir** — DO NOT ask. The image's defaults
(`IMAGE_INFO.cmd`, `IMAGE_INFO.entrypoint`, `IMAGE_INFO.user`,
`IMAGE_INFO.workingDir`) are used by Fred unless overridden in the spec.
Skip these fields entirely. If the user later needs to override, they can
edit the saved spec file by hand.

**Health check** — if `IMAGE_INFO.healthcheck` is non-null, mention it
("the image declares a HEALTHCHECK; Fred will use it") and skip. Otherwise
ask: "Add a health check? (yes / skip)". On yes, collect `test` (string
array, e.g. `["CMD", "curl", "-f", "http://localhost:8080/health"]`), and
optional `interval`, `timeout`, `retries`, `start_period`.

**Storage** — image can't tell us. Ask: "Add a persistent disk?
(yes / no)". On yes, present storage SKU options from `browse_catalog`.

**tmpfs** — driven by `IMAGE_INFO.suggestedTmpfs`:
- If non-empty: `AskUserQuestion` "This image typically needs the following
  tmpfs mounts on a read-only rootfs: `<paths joined>`. Add them?" with
  options `["Yes (Recommended)", "No", "Customize"]`. On Customize, let the
  user edit the list.
- If empty: ask "Need any tmpfs mounts? (yes / skip)". On yes, collect a
  list of paths.

**env** — `AskUserQuestion` for the input mode:
- **From a file (recommended for secrets)** — user provides an absolute path
  to a dotenv file (`KEY=VALUE` per line, `#` comments, blank lines OK).
  See "Sensitive env values" below for what flows through chat vs. what
  doesn't.
- **Type in chat (KEY=VALUE pairs)** — loop: ask for KEY then VALUE; offer
  "add another" / "done". Use this for non-sensitive values like log
  levels, feature flags, etc. Do NOT pre-validate names —
  `build_manifest_preview` is the validator.
- **Skip** — no env vars.

If the user picks **From a file**, ask them to create the file in a
**separate terminal**, e.g.:
```bash
cat > /tmp/<service>.env
KEY1=value1
KEY2=value2
^D
chmod 600 /tmp/<service>.env
```
Tell them not to use `echo` (it lands in shell history). Wait for them to
type the path back in chat. Store the path; the values are merged into the
spec file in Step 8 — they do not flow through this conversation now.

You may combine **Type in chat** and **From a file** (collect non-sensitive
in chat, then offer the file option for the rest). The file overlays — keys
present in both are taken from the file.

The image's `IMAGE_INFO.env` is informational only (usually system stuff
like `PATH`, `NGINX_VERSION`); do NOT auto-populate user env from it.

**Sensitive env values — what this protects, what it doesn't:**
- The chat input box stays clean — the user does not paste secrets.
- The values do not enter Claude's conversation context during authoring;
  the script merges them into the spec file directly.
- The values **will** appear in the deploy_app MCP tool call args at
  broadcast time (when `/manifest-agent:deploy-app` later reads the saved
  spec). Eliminating that exposure entirely needs upstream MCP support.

Suggest the user delete the env file after a successful save.

**labels** — same loop as `env`. Image's `labels` are author-provided
metadata, separate purpose from Fred labels.

**init** — ask "Run an init process inside the container? (yes / skip,
default skip)".

**Final spec object** (always services-map shape, even for one service):
```js
{
  services: {
    "app": {                     // or a name the user picked
      image: IMAGE,
      ports: { "80/tcp": { ingress: true }, ... },
      env?, labels?, health_check?, tmpfs?, init?, ...
    }
  },
  storage?
}
```

### 6b — Multi-service stack (`SHAPE == stack`)

Use `AskUserQuestion` to ask how many services. Then loop: for each service:

Required per service:
- **`name`** — service name. Must be 1–63 chars, lowercase alphanumeric +
  hyphens, no leading/trailing hyphens (RFC 1123 DNS label). The MCP server
  validates this on `build_manifest_preview`; if a user-supplied name is
  rejected, surface the error and re-ask.
- **`image`** — same format hint as Step 4. Then immediately inspect the
  image:
  ```bash
  node "$MANIFEST_PLUGIN_ROOT/scripts/inspect-image.cjs" --image "<image>"
  ```
  Capture the result as `SVC_INFO`. Same fail-soft semantics as Step 4
  (empty `{}` → ask user about everything; non-empty → use to drive the
  per-service prompts below).
- **`ports`** — driven by `SVC_INFO.ports`:
  - 1 port detected: use it.
  - >1 ports detected: ask which (multi-select).
  - 0 / no inspection: ask user to type each port-protocol pair.

  **Ingress per port**: in stacks the typical pattern is one service is
  ingress-true (the public web tier) and the rest are ingress-false
  (internal — DBs, queues, sidecars). For multi-service stacks, **always
  ask explicitly per port** — do not default. The chosen value goes into
  `{ "<port>/<proto>": { ingress: <bool> } }`.

Optional per service (same rules as single-service):
- `env` — same three-option flow as single-service (file / chat / skip);
  pass `--service-name <name>` to `merge-env.cjs` in Step 8 so the file's
  values land in the right service's env map. Inter-service env wiring
  (e.g. `WORDPRESS_DB_HOST=mysql`, `MYSQL_ROOT_PASSWORD=...`) is the
  user's responsibility — pick whichever input mode fits each value.
- `labels`, `tmpfs` (use `SVC_INFO.suggestedTmpfs` to default),
  `health_check` (skip ask if `SVC_INFO.healthcheck` non-null),
  `stop_grace_period`, `depends_on`, `expose`.
- Skip asking about `command` / `args` / `user` — image defaults apply.

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

## Step 6.5 — Optional custom domain

Ask the user via `AskUserQuestion`: "Attach a custom domain (FQDN) to this
lease? Domains are claimed permanently on-chain until cleared. (Yes / Skip)".

On **Skip**: continue to Step 7 with no `customDomain` in the spec.

On **Yes**:

1. Ask for the FQDN. Validate it client-side (catches obvious typos
   before a wasted broadcast — the chain is the authoritative validator):
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/validate-domain.cjs" --domain "<fqdn>"
   ```
   Parse the JSON output. If `valid === false`, surface each entry in
   `reasons[]` and re-ask. If valid, proceed.
2. **For stacks (`SHAPE === 'stack'`)**: ask which service the domain
   should attach to via `AskUserQuestion` populated from the keys of the
   spec's `services` map. Store as `serviceName`.
   **For single-service (`SHAPE === 'single'`)**: skip the picker. The
   single-service shape uses one item; no service name needed.
3. Add to the spec object under construction:
   - top-level `customDomain: <fqdn>`
   - top-level `serviceName: <picked-service>` (stacks only)
4. Tell the user:
   > Domain noted. The chain validates the format + reserved-suffix
   > rules at deploy time; failures surface there. Make sure your DNS
   > (CNAME or A record) is pointing at the provider's ingress before
   > the deploy step runs — `/manifest-agent:deploy-app` runs a warn-only
   > DNS pre-check but does not block on resolution.

The saved spec file (Step 8) carries `customDomain` + `serviceName`
verbatim — `mcp__manifest-fred__build_manifest_preview` and
`mcp__manifest-fred__deploy_app` accept these as top-level input fields,
so the agent can splat the spec into the deploy call without renaming.

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

**Note on file-sourced env values**: `build_manifest_preview` here only sees
the env vars the user typed in chat. Vars merged from a file in Step 8 are
NOT validated at this point — they are validated when the saved spec is
loaded by `/manifest-agent:deploy-app` (which re-runs `build_manifest_preview`
on the merged file). If a file-sourced env key is invalid (e.g. reserved
name like `PATH`), the failure surfaces at deploy time, not here.

Save `meta_hash_hex` for Step 9's report. Note: this hash will become stale
once env vars are merged from files in Step 8; the deploy skill computes a
fresh hash from the merged file.

## Step 8 — Save the spec to disk

Use `AskUserQuestion` to ask where to save the spec:

- **Default** — `~/.manifest-agent/manifests-drafts/<auto-name>.json` (the
  helper picks a name from the first image + timestamp).
- **Custom path** — let the user paste an absolute path.

Write the spec via the helper. The helper handles atomic write + `0600` mode,
and refuses to overwrite an existing file. Note: parent dir auto-creation
applies only to the default `~/.manifest-agent/manifests-drafts/` location;
when the user supplies a custom `--path`, its parent directory must already
exist (the script will fail with `ENOENT` otherwise).

Pipe the spec through stdin via a file (NOT a bash `echo` of the inline JSON
— `echo` would re-render the spec, including any user-supplied env values,
into the chat transcript as a literal command):

1. Use the `Write` tool to materialize the SPEC JSON at a tempfile path,
   e.g. `/tmp/.spec-${process_pid}-${timestamp}.json`. The Write tool
   renders the content as a structured tool call (one render, no shell
   echo).
2. Pipe the file to the helper via stdin redirection. For the default
   path, omit `--path`:

   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/save-manifest-draft.cjs" < /tmp/.spec-XXX.json
   rm -f /tmp/.spec-XXX.json
   ```

   For a user-chosen path:

   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/save-manifest-draft.cjs" --path /absolute/path/to/spec.json < /tmp/.spec-XXX.json
   rm -f /tmp/.spec-XXX.json
   ```

The script prints the saved file path on stdout. Capture it as `SAVED_PATH`.

**If the user picked "From a file" for env in Step 6** (single-service or
per-service in stacks), merge the file values into the saved spec now. For
each (service-name, env-file-path) pair the user provided:

```bash
cat <env-file-path> | node "$MANIFEST_PLUGIN_ROOT/scripts/merge-env.cjs" \
  --spec-file "$SAVED_PATH" \
  --service-name "<service-name>"
```

(Omit `--service-name` only if the spec uses the legacy flat single-service
shape — this skill always emits the services-map shape, so always pass it.)

The script outputs `{"service":"<name>","keys_merged":["KEY1",...]}` —
report the keys to the user (no values appear). If the script errors out
(invalid dotenv line, unknown service, unreadable file), surface the error
verbatim and stop; the saved spec at `$SAVED_PATH` is left in a partial
state and the user should investigate before deploying.

Suggest the user delete each env file once they've confirmed the saved spec
looks right (e.g. `rm /tmp/wordpress.env`). The values are now in the spec
at `$SAVED_PATH` (mode 0600) and on the user's responsibility to manage.

## Step 9 — Report

Tell the user:

```
Saved:           <SAVED_PATH>
meta_hash_hex:   <hex from Step 7>
Format:          single | stack
Custom domain:   <fqdn> -> service <name>      (only when set in Step 6.5)

To deploy:       /manifest-agent:deploy-app <SAVED_PATH>

The file is plain JSON — feel free to edit it by hand or check it into your
repo. Re-running this skill (or `build_manifest_preview` directly) on a
hand-edited spec is the safest way to validate changes before deploying.
```

Omit the `Custom domain:` line if no domain was set in Step 6.5.

The image registry will be checked by the provider at deploy-time. If it's
rejected, `deploy_app` will fail with a clear error.
