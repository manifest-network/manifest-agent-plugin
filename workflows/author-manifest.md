---
name: author-manifest
description: >
  Build and validate a Fred container deployment spec interactively
  (single-service or multi-service stack), saving a JSON spec file the
  user can hand to {{invoke:deploy-app}}, edit by hand, or
  version-control. Use when the user wants a reusable spec rather than a
  one-shot deploy.
allowed-tools: Bash(*), Read, Write
---

# Author Container Deployment Spec

You are interactively building a Fred container deployment spec. The output is
a validated JSON file the user can hand to `{{invoke:deploy-app}}` or
inspect / edit / version-control as a normal file.

The saved file is an orchestrated deployment spec: required `size`, exactly
one of `image` or `services`, and optional deployment metadata such as
`storage`, `customDomain`, and `serviceName`. This skill always emits
`{ size, skuUuid, providerUuid, services: { <name>: { image, ports?, env?, ... } }, storage? }`.

`build_manifest_preview` accepts only manifest fields. For this skill's
services-map shape, call it with `{ services: SPEC.services }`. Keep `size`,
`storage`, domain fields and SKU/provider selectors in the saved spec; they
are not preview arguments. Direct Fred deployment uses a different input
contract and is not the deployment route for this skill.

**For all user choices, use the `{{ask}}` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, {{environment_recovery}}.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it fails, tell the user to run `{{invoke:init-agent}}` first and stop.
Otherwise parse the JSON; show the user `activeChain` and `address`.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly — legacy copies may contain the key password.

## Step 1 — Choose deployment shape

Use `{{ask}}`:

- **Single-service** — one container image, one port. Simplest case.
- **Multi-service stack** — multiple named services (e.g. `web` + `db`),
  each with its own image and ports.

Store the choice as `SHAPE` (`single` or `stack`).

## Step 2 — Choose SKU size

Call `{{tool:fred/browse_catalog}}`. From its `skus`
array, retain active entries with both `sku_uuid` and `provider_uuid`.
Use this picker for compute and, with the restrictions in 4a, storage:

- Keep one catalog snapshot and sort by `provider_uuid`, then `sku_uuid`.
  Label each SKU option `<name> · <full sku_uuid>`; describe its full
  `provider_uuid`, `provider_url`, and `<price> <unit>`. `price` is a string,
  or "unavailable" when null; do not assume a nested amount/denom price or
  provider display-name field. Never merge entries by name.
- Use a single selection with 2–4 options for each question. With
  no usable compute entries, report the unavailable/incomplete catalog and
  stop without a picker. With no usable storage entries, offer **Refresh
  catalog** / **No disk**; refresh restarts storage selection and **No disk**
  omits storage and its IDs. With one entry, offer its SKU option plus
  **Cancel** for compute or **No disk** for storage. **Cancel** ends authoring.
- With 2–4 entries, offer them directly. With more than four, split the
  sorted entries into pages of two, adding **Previous page** and **Next
  page** only where those pages exist. Thus a first page has three options,
  a middle page four, and the last page two or three. Navigation changes
  only the page; it never selects a SKU or writes an identifier.

Bind the choice to the exact catalog entry: store `sku_uuid` as `SKU_UUID`,
`provider_uuid` as `PROVIDER_UUID`, and `name` as `SIZE`. The catalog field
is `sku_uuid`, not `uuid`. Do not offer an entry missing either identifier;
the picker label must map back to that exact entry in the snapshot. If a
typed answer names several entries, ask the user to choose the exact UUID
using the same picker; never treat a partial UUID or a navigation response
as a selection.

Persist `skuUuid: SKU_UUID` and `providerUuid: PROVIDER_UUID` at the spec's
top level for both deployment shapes. These selectors are honored by the
pinned MCP 0.22.0 orchestrator; `size: SIZE` remains a required descriptive
name. A stack uses the same compute SKU for all services. Do not resolve
the choice again by name or substitute another SKU if this UUID later
becomes unavailable.

## Step 3 — Image reference

If `SHAPE == single`, collect the image now; for a stack, apply these same
choices to **each service** in Step 4b. Format hint:
- Preferred (immutable): `registry/name@sha256:<64 hex characters>`
- Mutable: `registry/name:tag` or `registry/name` (implicit `latest`)

Classify every input and replacement with the local syntax checker. Create
a private temporary file with `mktemp`, bind its path as `IMAGE_SPEC_PATH`,
and use the **{{write_tool}} tool** to write `{ "image": <the exact input> }`
as JSON. Only shell-quoted paths enter the command; never interpolate an
image into shell source, a heredoc, or `echo`. Set `IMAGE_SPEC_PATH` in the
same {{shell_tool}} call; shell variables do not persist between calls.

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/check-image-references.cjs" --spec-file "$IMAGE_SPEC_PATH"
```

Use the returned `images[0].status`, not the presence of `@`, to choose the
branch below. `malformed-digest` exits 1 with `valid: false`: report
**Malformed digest; repair required**, ask for a corrected reference or
cancel, and rerun the check. Do not label it a pin, strip its digest, or
offer keeping the malformed value. Other checker errors also stop this
choice until corrected. Remove the temporary file after reading the result.
The check accepts the supported lowercase SHA-256 syntax only; it does not
query a registry or validate the full OCI repository grammar.

Keep the original input as the requested reference. Preserve a supplied
reference with status `digest` exactly, including any registry port or tag before `@`.
Describe it as **user-supplied**, not registry-verified. Do not substitute
a tag or another digest during preview, saving, or env merging.

For status `tag`, explain that a tag can point to different
image contents by deployment time and automatic tag resolution is not yet
available. Use `{{ask}}` to offer:

- **Provide a digest reference (Recommended)** — collect the immutable
  reference from the user, then continue with it.
- **Keep mutable tag** — retain the exact input; its digest is unresolved.
- **Cancel** — stop authoring.

Honor an explicit request to keep a rolling tag without asking again.
Otherwise wait for the choice; do not silently keep a tag. If a replacement
is also tag-only, apply the same choice to it. Keep the requested and
selected references for the recap; store the selected reference as `IMAGE`
(or that service's `image`). No resolution metadata fields are supported
by the current deployment contract; do not invent any in the spec.

State up-front:

> The image registry allowlist is enforced by the provider at deploy-time,
> not in pre-flight. A permitted-looking string can still be rejected when
> `{{invoke:deploy-app}}` runs.

MCP 0.22.0 has no public image-resolution tool. Do not inspect registries
client-side or invoke internal SDK helpers. `build_manifest_preview`
validates manifest structure; it does not resolve tags, verify image
availability, or attest to the provider's eventual pull. Its `meta_hash_hex`
hashes the manifest JSON and is never an OCI image digest.

## Step 4 — Author the spec

Use the `{{ask}}` tool throughout. Build a JavaScript object literal
in your working memory; preview only its `services` field in Step 6.

### 4a — Single-service (`SHAPE == single`)

We always emit the **services-map shape** for the spec — even when there's
only one service — because we need per-port `ingress: boolean` control,
which the simpler `{ image, port }` form doesn't expose. Default service
name: `"app"` (the user can override).

**Ports** — ask the user for each port-protocol pair (e.g. `"80/tcp"`).
Multiple ports are allowed, and the map may be omitted for a service with
no listening ports. Collect via `{{ask}}` looping or a single
comma-separated input. At most one TCP port per service may have
`ingress: true`; UDP ingress is invalid. Omit `host_port` (only zero or
omitted is supported).

**Ingress preference** — ask which eligible TCP port should be the preferred
HTTP ingress target, or let the provider choose automatically. Set
`ingress: true` on at most one TCP port per service; all others use false.
With no preferred port Fred chooses automatically (80, then 8080, then the
lowest TCP port). `ingress: false` does not make a port private or disable
HTTP routing. Do not label false as "internal only" or promise isolation.
UDP ports must have `ingress: false`.

The chosen `ports` map is `{ "<port>/<proto>": { ingress: <bool> }, ... }`.

**Cmd / Entrypoint / User / WorkingDir** — DO NOT ask. The image's
defaults are used by Fred unless overridden in the spec. Skip these
fields entirely. If the user later needs to override, they can edit the
saved spec file by hand.

**Health check** — ask: "Add a health check? (Yes / Skip)". On Yes,
collect `test` (string array, e.g. `["CMD", "curl", "-f",
"http://localhost:8080/health"]`), and optional `interval`, `timeout`,
`retries`, `start_period`.

**Storage** — ask: "Add a persistent disk? (Yes / No)". On Yes, show active
catalog entries on `PROVIDER_UUID` only, using the Step 2 picker. The catalog
has no compute/storage type discriminator: ask the user to identify a
storage SKU documented by this provider; a name such as `storage-*` does
not establish suitability. If the user cannot identify one, offer
**Choose another SKU** / **No disk**. Save the selected name in top-level
`storage`, plus `storageSkuUuid` and `storageProviderUuid` from that entry's
`sku_uuid` and `provider_uuid`; do not certify its storage suitability.

These storage IDs are **documentation-only metadata**: MCP 0.22.0 resolves
`storage` by name within the compute provider and has no storage UUID
selector. If that provider has multiple active entries with the storage
name, explain that this storage choice cannot yet be deployed by UUID;
ask for a different storage choice or no disk. Do not switch providers or
drop the disk silently. `{{invoke:deploy-app}}` rechecks the recorded
storage identity before invoking deployment; it cannot pin storage by UUID
during the upstream call. Include this limitation when storage is chosen.
Also explain that storage adds a lease item and its price is omitted from
MCP 0.22.0's deployment plan; the create-lease fee estimate includes only
compute items. Do not present that plan or estimate as covering the full
storage deployment cost.

**tmpfs** — ask "Need any tmpfs mounts? (Yes / Skip)". On Yes, collect a
list of paths.

**env** — `{{ask}}` for the input mode:
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
spec file in Step 7 — they do not flow through this conversation at collection time.

You may combine **Type in chat** and **From a file** (collect non-sensitive
in chat, then offer the file option for the rest). The file overlays — keys
present in both are taken from the file.

**Sensitive env values — what this protects, what it doesn't:**
- The chat input box stays clean — the user does not paste secrets.
- The script merges values directly into the spec file, but Step 7 reads
  that file back and previews it: the values then enter {{host}}'s context
  and preview tool arguments during authoring.
- Values also appear in the orchestrated deployment tool arguments when
  `{{invoke:deploy-app}}` later loads the saved spec. Eliminating
  those exposures needs upstream support; do not promise context secrecy.

Suggest the user delete the env file after a successful save.

**labels** — same loop as `env`.

**init** — ask "Run an init process inside the container? (Yes / Skip,
default Skip)".

**Final spec object** (always services-map shape, even for one service):
```js
{
  size: SIZE,
  skuUuid: SKU_UUID,
  providerUuid: PROVIDER_UUID,
  services: {
    "app": {                     // or a name the user picked
      image: IMAGE,
      ports: { "80/tcp": { ingress: true }, ... },
      env?, labels?, health_check?, tmpfs?, init?, ...
    }
  },
  storage?, storageSkuUuid?, storageProviderUuid?
}
```

### 4b — Multi-service stack (`SHAPE == stack`)

Use `{{ask}}` to ask how many services. Then loop: for each service:

Required per service:
- **`name`** — service name. Must be 1–63 chars, lowercase alphanumeric +
  hyphens, no leading/trailing hyphens (RFC 1123 DNS label). The MCP server
  validates this on `build_manifest_preview`; if a user-supplied name is
  rejected, surface the error and re-ask.
- **`image`** — apply Step 3's reference choices and preservation rules to
  this service, including an explicit choice before retaining a mutable tag.
- **`ports`** — optional map; ask for each port-protocol pair if needed.
  At most one TCP port per service may enable ingress; UDP ingress is
  invalid. Omit `host_port` (only zero or omitted is supported).

  **Ingress preference**: ask explicitly which TCP port, if any, should be
  preferred within each service. At most one may be true; false lets Fred's
  automatic selection apply and does not establish network isolation.

Optional per service (same rules as single-service):
- `env` — same three-option flow as single-service (file / chat / skip);
  pass `--service-name <name>` to `merge-env.cjs` in Step 7 so the file's
  values land in the right service's env map. Inter-service env wiring
  (e.g. `WORDPRESS_DB_HOST=mysql`, `MYSQL_ROOT_PASSWORD=...`) is the
  user's responsibility — pick whichever input mode fits each value.
- `labels`, `tmpfs`, `health_check`, `stop_grace_period`, `depends_on`,
  `expose`.
- Skip asking about `command` / `args` / `user` — image defaults apply.

After all services collected, ask:
- **`storage`** (top-level) — apply to whole stack? If yes, use the storage
  picker and duplicate-name guard from 4a, restricted to `PROVIDER_UUID`.
  Persist `storage`, `storageSkuUuid`, and `storageProviderUuid` at the
  top level; the IDs remain documentation-only metadata.
- **`depends_on`** belongs inside each dependent service; it is not a
  top-level spec field.

Final spec object:
```js
{
  size: SIZE,
  skuUuid: SKU_UUID,
  providerUuid: PROVIDER_UUID,
  services: {
    "<name>": { image, ports, env?, ... },
    ...
  },
  storage?, storageSkuUuid?, storageProviderUuid?
}
```

**Important**: per-service `image` (no top-level `image`); per-service `ports`
(map, not single `port`).

## Step 5 — Optional custom domain

Ask the user via `{{ask}}`: "Attach a custom domain (FQDN) to this
lease? Domains are claimed permanently on-chain until cleared. (Yes / Skip)".

On **Skip**: continue to Step 6 with no `customDomain` in the spec.

On **Yes**:

1. Ask for the FQDN. Domain metadata is validated by the orchestrated
   deployment flow and chain at deploy time, not by `build_manifest_preview`.
   Do not claim a successful manifest preview validates or reserves it.
2. **For stacks (`SHAPE === 'stack'`)**: ask which service the domain
   should attach to via `{{ask}}` populated from the keys of the
   spec's `services` map. Store as `serviceName`.
   **For single-service (`SHAPE === 'single'`)**: skip the picker. The
   generated spec still uses a services map: set `serviceName` to its
   sole service key (normally `app`).
3. Add to the spec object under construction:
   - top-level `customDomain: <fqdn>`
   - top-level `serviceName: <picked-service>` (required for this skill's
     services-map shape, including a one-service map)

The saved spec file (Step 7) carries `customDomain` + `serviceName`
verbatim for `deploy_app_orchestrated`'s `spec` argument. Do not send them
to `build_manifest_preview` or splat them into direct Fred tools.

## Step 6 — Validate via build_manifest_preview

Call `{{tool:fred/build_manifest_preview}}` with
`{ services: SPEC.services }`. Preview validates the container manifest,
not deployment size, storage allocation, domain metadata, or availability. The response shape is:

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
3. Loop back to Step 4 to fix. Re-call `build_manifest_preview`. Repeat until
   `validation.valid === true`.

**Note on file-sourced env values**: `build_manifest_preview` here only sees
the env vars the user typed in chat. Vars merged from a file in Step 7 are
NOT validated at this point — they are validated when the saved spec is
loaded by `{{invoke:deploy-app}}` (which routes through the
orchestrated tool, which re-validates internally). If a file-sourced env
key is invalid (e.g. reserved name like `PATH`), the failure surfaces at
deploy time, not here.

Capture `meta_hash_hex` as `META_HASH`. **If Step 7 merges env files into
the saved spec, the hash will change** — Step 7 re-validates and refreshes
`META_HASH` after the merge so Step 8's report is always current.

## Step 7 — Save the spec to disk

Use `{{ask}}` to ask where to save the spec:

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

1. Use the `{{write_tool}}` tool to materialize the SPEC JSON at a tempfile path,
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

The script rejects malformed digests before writing and prints the saved
file path on stdout on success. Capture it as `SAVED_PATH`. On failure,
repair the reference and repeat its Step 3 choice before trying to save again.

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
spec via `{{read_tool}}` (returns the spec as a structured tool result; any merged
env values enter your context here) and re-call `build_manifest_preview`
with `{ services: SAVED_SPEC.services }`. If validation fails, report the
errors and leave the draft for repair; do not report it as ready to deploy. Capture the new `meta_hash_hex` and overwrite
`META_HASH` so Step 8's report shows the hash that matches the saved
file's bytes.

## Step 8 — Report

Check the saved file again after any repairs or env merges. Set `SAVED_PATH`
to its shell-quoted path in this {{shell_tool}} call:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/check-image-references.cjs" --spec-file "$SAVED_PATH"
```

For **every entry** in the checker's `images` array, show its exact `image`
and the status below. A failed check means the draft needs repair; do not
report it as ready to deploy.

- `digest`: **User-supplied digest** — the digest syntax is valid and the reference is preserved; registry
  contents and availability have not been verified. If the user replaced
  a tag, also show the originally requested reference; do not describe the
  replacement as an automatic resolution.
- `tag`: **Mutable tag retained by choice; digest unresolved** — the provider may
  pull different contents at deployment time.
- `malformed-digest`: **Malformed digest; repair required** — never call
  this a pin. Return to Step 3 for a corrected reference or cancel.

Use full references, without abbreviating the digest. Report from the saved
file so the recap reflects any repairs. An image changed during validation
must go through Step 3's choice again unless the user already made that
choice for the replacement. The manifest hash below does not pin a tag.

Tell the user:

```
Saved:           <SAVED_PATH>
meta_hash_hex:   <META_HASH>
Format:          stack (services-map shape, even for one service)
Size:            <SIZE>
SKU UUID:        <SKU_UUID>
Provider UUID:   <PROVIDER_UUID>
Storage:         <storage> · <storageSkuUuid> · <storageProviderUuid> (when set; IDs are documentation only)
Custom domain:   <fqdn> -> service <name>      (only when set in Step 5)

To deploy:       {{invoke:deploy-app}} <SAVED_PATH>

The file is plain JSON — feel free to edit it by hand. Re-running this
skill (or `build_manifest_preview` directly) on a hand-edited spec is the
safest way to validate changes before deploying.
```

Omit absent storage/domain lines. When storage is set, explain that the
deployment tool resolves storage by name within this provider; its UUID is
recorded for comparison, not enforced as a deployment selector.
Repeat the storage cost limitation from 4a: the upstream plan omits its
price, and the fee estimate omits its extra lease item.

**Version control caveat — check for secrets before committing.** If
the user picked "From a file" for env in Step 4 (single-service or
per-service in stacks), the saved spec at `<SAVED_PATH>` now contains
those merged env *values* (DB passwords, API tokens, etc.) verbatim.
Tell the user explicitly: "this spec contains the env values you merged
from `<file paths>` — do NOT commit it to a public repository or share
it without redacting those values first." Values typed in chat can also be sensitive. Recommend version control
only after confirming the spec contains no secrets, regardless of input mode.

## Step 9 — Record this run in the journal

The `tool_calls[].tool` strings below are historical journal keys used by
`_journal.cjs` redaction reducers. Keep their `mcp__manifest-*` spelling;
invoke tools with the scoped `{{tool_prefix}}`
names shown in the workflow above. Journal keys are not callable host names.

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
        "summary": { "format": "stack", "service_count": <N>, "port_count": <N>, "env_count": <N>, "env_keys": ["<KEY1>", "<KEY2>"], "images": ["<image1>"] }
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
    "sku_uuid": "<SKU_UUID>",
    "provider_uuid": "<PROVIDER_UUID>",
    "storage_sku_uuid": "<storageSkuUuid or null>",
    "storage_provider_uuid": "<storageProviderUuid or null>",
    "custom_domain": "<fqdn or null>",
    "custom_domain_service_name": "<service or null>"
  },
  "errors": [],
  "recovery_actions": []
}
JOURNAL_EOF
```

If the user cancelled mid-flow (skipping optional env fields is not cancellation), set
`outcome` to `"cancelled"` and reduce `final_state` accordingly. If
validation in Step 6 looped multiple times before succeeding, only the
FINAL successful preview goes in `tool_calls[]` (the validation loop is
implementation detail). Do NOT mention the journal write in your reply.
