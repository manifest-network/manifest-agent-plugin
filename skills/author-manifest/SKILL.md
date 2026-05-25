---
description: >
  Build and validate a Fred container deployment spec interactively
  (single-service or multi-service stack), saving a JSON spec file the
  user can hand to /manifest-agent:deploy-app, edit by hand, or
  version-control. Use when the user wants a reusable spec rather than a
  one-shot deploy.
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

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, tell the user to restart Claude Code so the SessionStart hook runs, then stop.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it fails, tell the user to run `/manifest-agent:init-agent` first and stop.
Otherwise parse the JSON; show the user `activeChain` and `address`.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly — it contains the key password.

## Step 1 — Choose deployment shape

Use `AskUserQuestion`:

- **Single-service** — one container image, one port. Simplest case.
- **Multi-service stack** — multiple named services (e.g. `web` + `db`),
  each with its own image and ports.

Store the choice as `SHAPE` (`single` or `stack`).

## Step 2 — Choose SKU size

Call `mcp__manifest-fred__browse_catalog`. From the response, build an
`AskUserQuestion` showing each available SKU's name, price (amount + denom),
and provider name. The user picks one. Store as `SIZE`.

## Step 3 — Image reference (single-service only)

If `SHAPE == single`, ask the user for the image reference. Format hint:
- Preferred (immutable): `registry/name@sha256:<digest>`
- Acceptable: `registry/name:tag`

Store as `IMAGE`. State up-front:

> The image registry allowlist is enforced by the provider at deploy-time,
> not in pre-flight. A permitted-looking string can still be rejected when
> `/manifest-agent:deploy-app` runs.

Do NOT attempt to inspect the image client-side. `build_manifest_preview`
(Step 7) is the validator, and the orchestrated deploy flow re-validates
the image against the provider at broadcast time.

If `SHAPE == stack`: defer image collection to Step 5b.

## Step 4 — Author the spec

Use the `AskUserQuestion` tool throughout. Build a JavaScript object literal
in your working memory; you'll feed it to `build_manifest_preview` in Step 5.

### 4a — Single-service (`SHAPE == single`)

We always emit the **services-map shape** for the spec — even when there's
only one service — because we need per-port `ingress: boolean` control,
which the simpler `{ image, port }` form doesn't expose. Default service
name: `"app"` (the user can override).

**Ports** — ask the user for each port-protocol pair (e.g. `"80/tcp"`).
Multiple ports OK; collect via `AskUserQuestion` looping or as a single
comma-separated input.

**Ingress per port** — for each chosen port:
- If it's the only port AND its number is one of `80, 443, 8080, 8443`
  (common web ports): `AskUserQuestion` "Default ingress=true (port appears
  to be a standard web port — Recommended). Confirm?" with options
  `["Yes (Recommended)", "No (internal only)"]`.
- Otherwise (multiple ports, OR single non-web port): ask explicitly per
  port: "Should `<port>` be publicly reachable via the provider's ingress?
  (Yes / No)" — no default. Be explicit, do not guess.

The chosen `ports` map is `{ "<port>/<proto>": { ingress: <bool> }, ... }`
even when ingress is true (encode it explicitly so the spec is unambiguous
when re-loaded later).

**Cmd / Entrypoint / User / WorkingDir** — DO NOT ask. The image's
defaults are used by Fred unless overridden in the spec. Skip these
fields entirely. If the user later needs to override, they can edit the
saved spec file by hand.

**Health check** — ask: "Add a health check? (Yes / Skip)". On Yes,
collect `test` (string array, e.g. `["CMD", "curl", "-f",
"http://localhost:8080/health"]`), and optional `interval`, `timeout`,
`retries`, `start_period`.

**Storage** — ask: "Add a persistent disk? (Yes / No)". On Yes, present
storage SKU options from `browse_catalog`.

**tmpfs** — ask "Need any tmpfs mounts? (Yes / Skip)". On Yes, collect a
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
spec file in Step 6 — they do not flow through this conversation now.

You may combine **Type in chat** and **From a file** (collect non-sensitive
in chat, then offer the file option for the rest). The file overlays — keys
present in both are taken from the file.

**Sensitive env values — what this protects, what it doesn't:**
- The chat input box stays clean — the user does not paste secrets.
- The values do not enter Claude's conversation context during authoring;
  the script merges them into the spec file directly.
- The values **will** appear in the deploy_app MCP tool call args at
  broadcast time (when `/manifest-agent:deploy-app` later reads the saved
  spec). Eliminating that exposure entirely needs upstream MCP support.

Suggest the user delete the env file after a successful save.

**labels** — same loop as `env`.

**init** — ask "Run an init process inside the container? (Yes / Skip,
default Skip)".

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

### 4b — Multi-service stack (`SHAPE == stack`)

Use `AskUserQuestion` to ask how many services. Then loop: for each service:

Required per service:
- **`name`** — service name. Must be 1–63 chars, lowercase alphanumeric +
  hyphens, no leading/trailing hyphens (RFC 1123 DNS label). The MCP server
  validates this on `build_manifest_preview`; if a user-supplied name is
  rejected, surface the error and re-ask.
- **`image`** — same format hint as Step 3. Just collect the string; the
  provider validates the registry at deploy time and `build_manifest_preview`
  validates the format.
- **`ports`** — ask the user to type each port-protocol pair.

  **Ingress per port**: in stacks the typical pattern is one service is
  ingress-true (the public web tier) and the rest are ingress-false
  (internal — DBs, queues, sidecars). For multi-service stacks, **always
  ask explicitly per port** — do not default. The chosen value goes into
  `{ "<port>/<proto>": { ingress: <bool> } }`.

Optional per service (same rules as single-service):
- `env` — same three-option flow as single-service (file / chat / skip);
  pass `--service-name <name>` to `merge-env.cjs` in Step 6 so the file's
  values land in the right service's env map. Inter-service env wiring
  (e.g. `WORDPRESS_DB_HOST=mysql`, `MYSQL_ROOT_PASSWORD=...`) is the
  user's responsibility — pick whichever input mode fits each value.
- `labels`, `tmpfs`, `health_check`, `stop_grace_period`, `depends_on`,
  `expose`.
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

## Step 5 — Optional custom domain

Ask the user via `AskUserQuestion`: "Attach a custom domain (FQDN) to this
lease? Domains are claimed permanently on-chain until cleared. (Yes / Skip)".

On **Skip**: continue to Step 6 with no `customDomain` in the spec.

On **Yes**:

1. Ask for the FQDN. Do not validate client-side — `build_manifest_preview`
   in Step 6 (and the chain itself at deploy time) validates format,
   lowercase, and reserved-suffix rules. If validation fails there, surface
   the error and re-ask.
2. **For stacks (`SHAPE === 'stack'`)**: ask which service the domain
   should attach to via `AskUserQuestion` populated from the keys of the
   spec's `services` map. Store as `serviceName`.
   **For single-service (`SHAPE === 'single'`)**: skip the picker. The
   single-service shape uses one item; no service name needed.
3. Add to the spec object under construction:
   - top-level `customDomain: <fqdn>`
   - top-level `serviceName: <picked-service>` (stacks only)

The saved spec file (Step 6) carries `customDomain` + `serviceName`
verbatim — `mcp__manifest-fred__build_manifest_preview` and
`mcp__manifest-fred__deploy_app` accept these as top-level input fields,
so the agent can splat the spec into the deploy call without renaming.

## Step 6 — Validate via build_manifest_preview

Call `mcp__manifest-fred__build_manifest_preview` with the spec object from
Step 4 splatted as input arguments. The response shape is:

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
   - FQDN format issues if `customDomain` is set.
3. Loop back to Step 4 to fix. Re-call `build_manifest_preview`. Repeat until
   `validation.valid === true`.

**Note on file-sourced env values**: `build_manifest_preview` here only sees
the env vars the user typed in chat. Vars merged from a file in Step 7 are
NOT validated at this point — they are validated when the saved spec is
loaded by `/manifest-agent:deploy-app` (which routes through the
orchestrated tool, which re-validates internally). If a file-sourced env
key is invalid (e.g. reserved name like `PATH`), the failure surfaces at
deploy time, not here.

Capture `meta_hash_hex` as `META_HASH`. **If Step 7 merges env files into
the saved spec, the hash will change** — Step 7 re-validates and refreshes
`META_HASH` after the merge so Step 8's report is always current.

## Step 7 — Save the spec to disk

Use `AskUserQuestion` to ask where to save the spec:

- **Default** — `$MANIFEST_PLUGIN_DATA/manifests-drafts/<auto-name>.json` (the
  helper picks a name from the first image + timestamp).
- **Custom path** — let the user paste an absolute path.

Write the spec via the helper. The helper handles atomic write + `0600` mode,
and refuses to overwrite an existing file. Note: parent dir auto-creation
applies only to the default `$MANIFEST_PLUGIN_DATA/manifests-drafts/` location;
when the user supplies a custom `--path`, its parent directory must already
exist (the script will fail with `ENOENT` otherwise).

Pipe the spec through stdin via a file (NOT a bash `echo` of the inline JSON
— `echo` would re-render the spec, including any user-supplied env values,
into the chat transcript as a literal command):

1. Use the `Write` tool to materialize the SPEC JSON at a tempfile path,
   e.g. `/tmp/.spec-PROCESS_PID-TIMESTAMP.json` (uppercase placeholders —
   substitute the agent's bash `$$` and `$(date +%s)` respectively, do not
   leave them as literals). The Write tool
   renders the content as a structured tool call (one render, no shell
   echo).
2. Pipe the file to the helper via stdin redirection. For the default
   path, omit `--path`:

   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/save-manifest-draft.cjs" < /tmp/.spec-PROCESS_PID-TIMESTAMP.json
   rm -f /tmp/.spec-PROCESS_PID-TIMESTAMP.json
   ```

   For a user-chosen path:

   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/save-manifest-draft.cjs" --path /absolute/path/to/spec.json < /tmp/.spec-PROCESS_PID-TIMESTAMP.json
   rm -f /tmp/.spec-PROCESS_PID-TIMESTAMP.json
   ```

The script prints the saved file path on stdout. Capture it as `SAVED_PATH`.

**If the user picked "From a file" for env in Step 4** (single-service or
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

After the merge phase (whether or not any env files were actually merged),
refresh `META_HASH` from the on-disk spec — re-loading + re-validating is
idempotent and cheap, and unconditionally re-validating eliminates the
drift surface a "did we merge anything?" branch creates. Re-load the saved
spec via `Read` (returns the spec as a structured tool result; any merged
env values enter your context here) and re-call `build_manifest_preview`
with the splatted spec. Capture the new `meta_hash_hex` and overwrite
`META_HASH` so Step 8's report shows the hash that matches the saved
file's bytes.

## Step 8 — Report

Tell the user:

```
Saved:           <SAVED_PATH>
meta_hash_hex:   <META_HASH>
Format:          single | stack
Custom domain:   <fqdn> -> service <name>      (only when set in Step 5)

To deploy:       /manifest-agent:deploy-app <SAVED_PATH>

The file is plain JSON — feel free to edit it by hand. Re-running this
skill (or `build_manifest_preview` directly) on a hand-edited spec is the
safest way to validate changes before deploying.
```

Omit the `Custom domain:` line if no domain was set in Step 5.

**Version control caveat — only safe when no env files were merged.** If
the user picked "From a file" for env in Step 4 (single-service or
per-service in stacks), the saved spec at `<SAVED_PATH>` now contains
those merged env *values* (DB passwords, API tokens, etc.) verbatim.
Tell the user explicitly: "this spec contains the env values you merged
from `<file paths>` — do NOT commit it to a public repository or share
it without redacting those values first." When no env files were merged
(everything was typed in chat or skipped), the spec is safe to
version-control as-is.

## Step 9 — Record this run in the journal

Append one record to the operation journal at
`$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. The writer auto-fills
`timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` —
omit them. Do NOT include any key matching the writer's secret denylist
— `_journal.SECRET_KEY_DENYLIST` (mnemonic, password, private_key,
secret_key, api_key, auth_token, bearer_token — case-insensitive,
optional `_`/`-` separators; canonical regex in `scripts/_journal.cjs`);
the writer is fail-closed and will exit 1 rather than append such
records. Do NOT embed the spec's env values; `tool_calls[].args_redacted`
for `build_manifest_preview` MUST follow the env-keys-only convention
(see `scripts/_journal.cjs#redactArgs`).

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" <<'JOURNAL_EOF'
{
  "skill": "author-manifest",
  "active_chain": "<activeChain from Step 0>",
  "signer_address": "<address from Step 0>",
  "intent": "<a brief paraphrase of the user's request — what they want to accomplish, not their verbatim message; max ~240 chars; do NOT echo any secrets the user may have typed (passwords, API keys, mnemonics) — the value field is not redacted>",
  "plan_summary": "author <SHAPE> spec, <service_count> services, image=<primary image>",
  "tool_calls": [
    {
      "tool": "mcp__manifest-fred__build_manifest_preview",
      "args_redacted": {
        "summary": { "format": "<single|stack>", "service_count": <N>, "port_count": <N>, "env_count": <N>, "env_keys": ["<KEY1>", "<KEY2>"], "images": ["<image1>"] },
        "customDomain": "<fqdn or null>",
        "serviceName": "<service or null>"
      },
      "outcome": "ok",
      "result_summary": { "meta_hash_hex": "<META_HASH>", "format": "<format>", "valid": true }
    }
  ],
  "outcome": "success",
  "final_state": {
    "saved_path": "<SAVED_PATH>",
    "meta_hash_hex": "<META_HASH>",
    "format": "<single|stack>",
    "custom_domain": "<fqdn or null>",
    "custom_domain_service_name": "<service or null>"
  },
  "errors": [],
  "recovery_actions": []
}
JOURNAL_EOF
```

If the user cancelled mid-flow (e.g. chose Skip on every env mode), set
`outcome` to `"cancelled"` and reduce `final_state` accordingly. If
validation in Step 6 looped multiple times before succeeding, only the
FINAL successful preview goes in `tool_calls[]` (the validation loop is
implementation detail). Do NOT mention the journal write in your reply.
