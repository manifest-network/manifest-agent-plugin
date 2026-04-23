---
name: update-app
description: >
  Update a deployed app's container manifest — change an env var, bump an
  image version, swap the full manifest — without closing the lease.
  Supports partial updates (server-side merged over the current manifest)
  and full replacements. Accepts a raw manifest file, a DeployAppInput
  spec, or interactive prompts.
allowed-tools: Bash(*), Read
---

# Update a Deployed App

You are changing the manifest of a running app. The `update_app` tool in
`manifest-mcp-fred` is a pure provider HTTPS upload — **not** a Cosmos
SDK transaction — but it still mutates a running workload and is subject
to the plugin's pre-action confirmation policy.

Two update modes:

- **Partial** — the user changes a few fields (e.g., one env var, an
  image bump). The skill fetches the current manifest from the provider,
  constructs a partial JSON (always including `image`), and sends both
  the partial and the current manifest to `update_app`. The MCP tool
  calls `mergeManifest(new, old)` server-side. The merge rules are
  **not** "everything carries forward" — see the Notes section at the
  bottom for the exact semantics before building a partial.
- **Full replace** — the user supplies a complete manifest. The skill
  sends it without `existing_manifest`, so the provider replaces the
  manifest wholesale.

Structural changes across modes (renaming a service in a stack, adding a
new service, changing the top-level format between single-container and
stack) do not merge cleanly — always use full replace for those.

**For user choices in this skill, use the `AskUserQuestion` tool to
present options the user can pick from a list.**

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, tell the user to restart Claude Code and stop.

## Step 1 — Verify the agent is configured

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If the command fails, tell the user:
> No agent configuration found. Run `/manifest-agent:init-agent` first.

Stop here.

Parse the JSON output. Note `address`, `activeChain`, and `gasPrice` to
show the user which account and chain they are operating on.

**IMPORTANT:** Do NOT read `~/.manifest-agent/config.json` directly — it
contains the key password.

## Step 2 — Pick the lease

Call `mcp__manifest-lease__leases_by_tenant` with `{state: "active"}`.

If the list is empty, tell the user there are no active leases to
update and suggest `/manifest-agent:deploy-app` to create one. Stop.

Otherwise show a numbered list with, for each lease:
- `uuid`
- `stateLabel`
- `createdAt`
- `items` as `skuUuid × quantity` pairs.

Note the `leases_by_tenant` response does **not** include
`service_name` per item (the MCP maps only `{skuUuid, quantity}` out
of the on-chain `LeaseItem`). To tell whether a lease is a stack or a
single-container app, fetch the current manifest in Step 3 and look
for a top-level `services` key.

Use `AskUserQuestion` to let the user pick a lease, or accept a pasted
UUID for leases outside the first page.

Store the selected `LEASE_UUID`.

## Step 3 — Fetch the current manifest

Call `mcp__manifest-fred__app_releases` with `{lease_uuid: LEASE_UUID}`.

**Find the currently-serving release:** iterate the `releases` array
from the end backward and pick the first entry where
`status === "active"`. Do **not** just take the last entry — the most
recent release may have a non-active status (`superseded`, `failed`,
or an in-flight deploy), in which case the actually-serving manifest
is an earlier entry.

If no release has `status === "active"` — or there are zero releases —
tell the user the lease has no active release, so partial updates are
unsafe, and skip to Step 5 as **Full replace** mode. If the lease is
genuinely broken, full replace is what will recover it.

Look for a `manifest` field on the chosen release. It is optional per
the Fred API, so it may be absent.

- If **present**: the value is a **base64-encoded** JSON string (not
  plain JSON — the provider sends the manifest bytes verbatim).
  Decode it portably via Node (already a plugin dependency, so
  available on every platform that can run this plugin — avoids the
  GNU `base64 -d` vs BSD `base64 -D` split). Use a quoted heredoc so
  the base64 payload is piped to stdin rather than placed in argv —
  manifests can be large (pushing against macOS ARG_MAX) and can
  contain env-var secrets that should not land in shell history:
  ```bash
  cat <<'EOF' | node -e 'let b=""; process.stdin.on("data",c=>b+=c).on("end",()=>process.stdout.write(Buffer.from(b.trim(),"base64").toString("utf8")))'
  <base64-string>
  EOF
  ```
  Then parse the decoded string as JSON. Show the user a summary of
  the current app: top-level format (single-container vs stack),
  image(s), key-count breakdowns for `env` / `ports` / `labels`, and
  any other non-default fields. Store the decoded JSON string (not
  the base64) as `CURRENT_MANIFEST`.
- If **absent**: tell the user the provider did not return the current
  manifest, so partial updates are not possible for this lease. Skip
  to Step 5 as **Full replace** mode.

## Step 4 — Choose update mode

Use `AskUserQuestion`:

- **Partial update** — change a few fields, carry the rest forward
  (only offered if `CURRENT_MANIFEST` is set)
- **Full replace** — supply a complete manifest

### Partial update mode

**Important:** `image` **must always be present** in any single-service
partial (and per-service in stack partials). The server-side merger
does **not** carry `image` forward from the existing manifest:
`user`, `tmpfs`, `command`, `args`, `health_check`,
`stop_grace_period`, `init`, `expose`, and `depends_on` carry forward
automatically; `env`, `ports`, and `labels` shallow-merge; everything
else (including `image`) must be supplied explicitly in the partial
or the merged result will be missing that field and the provider will
reject the upload. Read the current `image` out of `CURRENT_MANIFEST`
and include it in every partial you build, even if the user did not
ask to change it.

Ask what the user wants to change. Offer these first-class interactive
edits; for anything else, ask for a partial-manifest file.

- **Environment variable** — add or change. Ask which key and what
  value. For single-container, build:
  `{"image": "<current-image>", "env": {"KEY": "VALUE"}}`. For a
  stack, ask which service and nest:
  `{"services": {"<name>": {"image": "<current-svc-image>", "env": {"KEY": "VALUE"}}}}`.

  **Removing an env var is not reliably supported via partial update.**
  The map-merge semantics mean `{"env": {"KEY": ""}}` sets the value
  to empty string, not unset the key. If the user wants to unset,
  stop and tell them to use full replace.

- **Image version bump** — ask for the new image. Build
  `{"image": "<new>"}` or for a stack
  `{"services": {"<name>": {"image": "<new>"}}}`. No need to include
  the old image — `image` is the field being changed.

- **Labels** — same map-merge semantics as env. Include `image`.
  Example: `{"image": "<current-image>", "labels": {"role": "prod"}}`.
  Same caveat about removal as env.

- **Other fields** — ask the user for a partial-manifest file. The
  file content must itself be manifest-shaped JSON (not
  `DeployAppInput`-shaped), because the partial is passed straight
  through to the server-side merger. It **must include `image`**
  (per service for stacks). Examples:
  `{"image": "<current-image>", "health_check": {"test": ["CMD","curl","-f","http://localhost/"], "interval": "30s"}}`
  or for stacks
  `{"services": {"web": {"image": "<current-image>", "health_check": {...}}}}`.

Show the user a plain-English summary of the diff. Redact env and
label values by default — these commonly carry secrets:

```
Partial update on lease <uuid>:
  env.LOG_LEVEL: changed (values redacted)
  image: nginx:1.27 → nginx:1.28
  (other fields carried forward from current manifest)
```

For non-secret-carrying fields (image, ports structure, expose,
health_check presence) show the full before/after. For image where
the value is unchanged but we're forwarding it because the merger
requires it, say `image: <value> (unchanged, required by merger)`.

Do **not** try to preview the literal merged JSON — that would
require running `mergeManifest` client-side and risks drift with the
server-side merger. And do **not** echo env / label values into the
chat; they land in the transcript.

Store the partial as `PARTIAL_MANIFEST` (a JSON string).

If the change is structural (a service rename, a new service in a
stack, a top-level format change between single-container and stack),
stop and tell the user to switch to full replace instead.

### Full replace mode

Use `AskUserQuestion`:

- **Raw manifest file** — a complete Fred manifest JSON (what the
  provider sees directly; see
  https://github.com/manifest-network/fred/tree/main/docs for the
  schema)
- **DeployAppInput spec file** — same shape `/manifest-agent:deploy-app`
  ingests; the skill converts it to a manifest via `build-manifest.cjs`
- **Interactive** — single-container only; gather image, port, env,
  labels, and build the manifest

**Raw manifest file:**

1. Ask for the path.
2. Read and `JSON.parse` it. Reject anything that is not a JSON object.
3. Show a summary of the new manifest.

**DeployAppInput spec file:**

1. Ask for the path.
2. Pipe the file through `build-manifest.cjs`:
   ```bash
   cat <spec-path> | node "$MANIFEST_PLUGIN_ROOT/scripts/build-manifest.cjs"
   ```
   Capture stdout as the new manifest JSON string. If the script fails
   (non-zero exit), show its stderr to the user and stop.
3. Show the resolved manifest.

**Interactive:**

1. Ask for image, port, env (optional), labels (optional). Build a
   `DeployAppInput` object in-memory, then pipe via the helper using
   a quoted heredoc so the spec does not land in argv or shell
   history (env values can carry secrets):
   ```bash
   cat <<'EOF' | node "$MANIFEST_PLUGIN_ROOT/scripts/build-manifest.cjs"
   <spec-json>
   EOF
   ```
   Do not use `echo '<spec-json>'` or `printf '%s' "<spec-json>"` —
   both put the spec in argv. Do not write the spec to a file on
   disk either.

Store the full manifest as `NEW_MANIFEST` (a JSON string).

## Step 5 — Echo and confirm

Display:

- `lease_uuid` (the selected lease)
- Update mode (`partial` or `replace`)
- Summary of the change. **Do not pretty-print the full manifest or
  the partial JSON** — both can contain env values (API keys, DB
  passwords, JWTs) that would be leaked into the chat transcript.
  Instead:
  - **Partial mode:** for each changed `env` / `labels` key, show
    `env.<KEY>: changed (values redacted)` rather than
    `env.<KEY>: <old> → <new>`. For non-secret-carrying fields (image,
    ports structure, expose, health_check presence) show the full
    value. If the user wants to see an env value they just set,
    they can ask — opt-in rather than opt-out.
  - **Replace mode:** show a structural summary — top-level format
    (single / stack), image(s), port shapes, `env` variable **names
    only**, `labels`, `tmpfs`, `user`, `expose`, `depends_on`
    presence. Call out `command` / `args` if set (another
    secret-carrying vector) and warn before displaying them.
- A note that `update_app` uploads to the provider over HTTPS — it is
  **not** a Cosmos SDK transaction, so no gas is spent. The action is
  still impactful because it mutates a running workload; Claude Code
  will also display a permission prompt.

Wait for explicit textual confirmation before continuing. A permission
prompt will fire on the `update_app` call as a safety net — it is not
a substitute for the textual confirmation.

## Step 6 — Update

Call `mcp__manifest-fred__update_app` with:

- Partial mode:
  ```
  {lease_uuid: LEASE_UUID, manifest: PARTIAL_MANIFEST, existing_manifest: CURRENT_MANIFEST}
  ```
  Both `PARTIAL_MANIFEST` and `CURRENT_MANIFEST` must be **JSON
  strings** (not base64). If you pass the raw `release.manifest`
  value from `app_releases` you will get a
  `INVALID_CONFIG: existing_manifest contains invalid JSON` error —
  decode it first (see Step 3). The server-side merger produces the
  final manifest and uploads it.

- Full replace mode:
  ```
  {lease_uuid: LEASE_UUID, manifest: NEW_MANIFEST}
  ```
  No `existing_manifest`; the provider replaces the manifest outright.

## Step 7 — Report results

Display the returned `{lease_uuid, status}`. Offer to:
- Call `mcp__manifest-fred__app_status` to observe the new state.
- Call `mcp__manifest-fred__get_logs` to watch the container after the
  restart.
- Call `mcp__manifest-fred__app_releases` to confirm a new release
  entry landed.

## Notes

- `update_app` does **not** change the lease SKU or resource limits.
  Raising memory/CPU requires creating a new lease with a bigger SKU
  (via `/manifest-agent:deploy-app`) and closing the old one.
- The server-side partial-update merger shallow-merges `env`, `ports`,
  and `labels` (new wins per key); automatically carries forward
  `user`, `tmpfs`, `command`, `args`, `health_check`,
  `stop_grace_period`, `init`, `expose`, `depends_on` when absent in
  the partial; and passes every other field through from the partial
  only. That last bucket includes `image`, so every partial **must**
  include `image` (per service for stacks) even when it is not the
  field being changed — otherwise the merged manifest is missing
  `image` and the provider will reject it.
- `release.manifest` from `app_releases` is **base64-encoded** — the
  MCP passes the raw manifest bytes through without decoding. Decode
  via the portable Node one-liner in Step 3 (do not rely on
  `base64 -d`; the flag differs between GNU and BSD builds).
- Releases in `app_releases` are appended oldest-first; the currently-
  serving one is the most recent entry with `status === "active"`
  (earlier `"active"` entries become `"superseded"` on each activate).
  The last entry may be `"superseded"`, `"failed"`, or an in-flight
  deploy, so do not pick it blindly.
- Partial updates require the provider to return the current manifest
  via `app_releases` with an `"active"` status. If either is missing,
  fall back to full replace.
- `build-manifest.cjs` requires `~/.manifest-agent/node_modules`. Run
  `/manifest-agent:init-agent` first if it is missing.
