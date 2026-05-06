# Spec input modes (deploy-app Step 2 detail)

This file is loaded by `skills/deploy-app/SKILL.md` Step 2 after the
`dispatch-deploy-input.cjs` script classifies `$ARGUMENTS`. The dispatcher's
output `mode` selects which section below the orchestrator follows. The
final "Merge any file-sourced env" section applies after the interactive /
fast-path modes (not the spec-file mode).

## Variables in scope

The orchestrator must have these in scope before loading this file:

- `$ARGUMENTS` — the raw argument from the slash-command invocation
  (`/manifest-agent:deploy-app <args>`). Empty when invoked with no
  argument.
- `mode` — from `dispatch-deploy-input.cjs` stdout; one of
  `"spec_file"`, `"single_image"`, `"multi_image"`, `"empty"`. Selects
  which section below applies.
- `tokens`, `services[]`, `collisions[]?`, `spec_path` — additional
  fields from the dispatcher output, populated per `mode`.
- `IMAGE`, `IMAGE_INFO`, `SVC_INFO`, `SIZE`, `SPEC` — collected during
  the authoring loop. `IMAGE_INFO` / `SVC_INFO` are the JSON payload
  from `inspect-image.cjs` (or `{}` on inspection failure).
- `PROCESS_PID` — `$$` from bash, captured into a shell variable; used
  to disambiguate the `/tmp/.spec-env-PROCESS_PID.json` staging path
  during the env-merge phase. Treat this as an agent placeholder, not a
  literal bash interpolation.
- Per-service env-file paths — collected interactively during per-service
  authoring (the `From a file` option of the env-input flow); consumed by
  the `Merge any file-sourced env` section.

## When `mode == "spec_file"`

The dispatcher already verified `spec_path` exists. Validate that it parses
as JSON **without echoing its contents to chat** — spec files can contain
user-supplied env values that may be sensitive:

```bash
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log("ok")' "$ARGUMENTS"
```

If the command does not print `ok` (file unreadable or invalid JSON),
surface the error verbatim to the user and stop.

Then load the spec into your context using the `Read` tool — NOT `cat`.
`cat` would echo the entire spec to chat as a bash result; `Read` returns
the file content as a structured tool result instead. The parsed spec
object is your `SPEC`.

**If the loaded spec has a top-level `customDomain`** (and optionally
`serviceName` for stacks), surface it for confirmation via `AskUserQuestion`
rather than re-asking blindly:

> The spec sets a custom domain: `<fqdn>` → service `<name>` (or
> "single-service lease" when serviceName omitted). What do you want to
> do?
> Options: **Keep** (deploy with this domain) / **Change** (provide a
> different FQDN now) / **Clear** (deploy without a custom domain).

On Change: ask for the new FQDN, validate via `scripts/validate-domain.cjs`,
replace `SPEC.customDomain`. On Clear: delete both `customDomain` and
`serviceName` from `SPEC`.

**If the loaded spec has NO `customDomain`**, ask once via `AskUserQuestion`
"Attach a custom domain to this deploy? (Yes / Skip)"; on Yes, follow the
FQDN-collection + (for stacks) service-picker flow described under the
single_image / multi_image modes below.

## When `mode == "multi_image"` (multi-service stack fast-path)

The user typed something like `/manifest-agent:deploy-app wordpress:6 mysql:9`
or `/manifest-agent:deploy-app wordpress:6 + mysql:9`. The dispatcher has
already tokenized the input, derived a service name per token, and detected
collisions. You consume `services[]` and `collisions?[]` from its output.

**Confirm the parse before doing anything else** so the user can catch
mistakes. Use `AskUserQuestion`. For each entry in `services[]` show
`{derived_name} ({token})`; if any entry has `valid: false`, surface that
the auto-derived name didn't conform to RFC 1123 and you'll need the user
to provide a name.

> Parsed your input as a stack of N services:
>   - `wordpress` (`docker.io/lifted/wordpress:6`)
>   - `mysql` (`docker.io/library/mysql:9`)
> Proceed with these names? Options: yes / customize names / abort.

On "customize names" let the user rename each service. On "abort" stop.

**Service name collisions**: if `collisions[]` is non-empty, the parse
confirmation must show the collision (e.g. `redis:7 redis:8` both derive
to `redis`) and ask the user to disambiguate (suggest `redis-7` /
`redis-8` or let them type names). Do NOT silently auto-suffix — the
dispatcher reports the collision deliberately so the user makes the call.

**SKU size**: after the parse is confirmed, ask for the SKU size once for
the whole stack via `AskUserQuestion`, populated from
`mcp__manifest-fred__browse_catalog`. Store as `SIZE`. (The SKU applies
to the whole lease, not per-service; per-service compute sizing isn't
exposed at the deploy_app surface.)

**Per-service authoring** — for each service in order:

1. Set `IMAGE = <token>` and call:
   ```bash
   NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/inspect-image.cjs" --image "$IMAGE"
   ```
   Capture as `SVC_INFO`. Same fail-soft semantics as the single-service
   fast-path.
2. **Ports**: from `SVC_INFO.ports`.
   - 1 detected: use it.
   - >1 detected: ask which (multi-select).
   - 0 / inspection failed: ask the user to type each port-protocol pair.
3. **Ingress per port**: in stacks the typical pattern is one
   public-facing service (web tier) and the rest internal (DBs, workers).
   **Always ask explicitly per port — do not default.** No port number
   heuristic in this branch (the agent doesn't know which service is the
   public tier).
4. **tmpfs**: use `SVC_INFO.suggestedTmpfs` as the default with
   `["Yes (Recommended)", "No", "Customize"]`.
5. **env** — `AskUserQuestion` for the input mode:
   - **From a file (recommended for secrets)** — user provides an absolute
     path to a dotenv file. Tell them to create it in a separate terminal
     (`cat > /tmp/<svc>.env` … Ctrl+D, then `chmod 600`), not via `echo`
     (shell history). Wait for the path. Store the path with the service
     name; values are merged BEFORE Step 3 — they do not enter chat now.
   - **Type in chat (KEY=VALUE pairs)** — for non-sensitive only (log
     levels, feature flags, etc.). Loop key/value/done.
   - **Skip** — no env for this service.
   You may combine the chat and file modes per service (the file overlays
   the chat values; same-key entries take the file's value).
6. **labels**, **health_check** (only if image has none), **storage**
   (top-level, asked once after all services), **init** — ask normally.
7. **Skip asking about** `command` / `args` / `user` / `workingDir` —
   image defaults apply.

**Inter-service env wiring is NOT auto-populated.** The user must add env
vars like `WORDPRESS_DB_HOST=mysql`, `WORDPRESS_DB_PASSWORD=...`,
`MYSQL_ROOT_PASSWORD=...` themselves via the per-service env prompts —
either typed in chat (for non-sensitive values like the `_HOST=mysql`
pointer) or via a per-service env file (recommended for passwords). The
Intent recap below will heads-up on common gaps.

After all services collected, ask top-level **`storage`** and
**`depends_on`** (e.g. `wordpress depends_on mysql` is a typical pattern —
offer it but let the user say no).

**Custom domain (optional)** — after all services collected and before
the final SPEC is assembled, ask via `AskUserQuestion`:

> Attach a custom domain (FQDN) to this stack? Pick which service it
> routes to. (Yes / Skip)

On Yes:

1. Ask for the FQDN. Validate client-side via
   `node "$MANIFEST_PLUGIN_ROOT/scripts/validate-domain.cjs" --domain "<fqdn>"`.
   Re-ask on `valid: false`.
2. Pick the service via `AskUserQuestion` populated from the confirmed
   service names from the parse step (no chain query — you already have
   them in memory).
3. Add to the spec: top-level `customDomain: <fqdn>` + `serviceName: <picked>`.

**Final SPEC** — services-map shape, one entry per token in the same order
the user typed:

```js
{
  services: {
    "wordpress": { image: "...", ports: { "80/tcp": { ingress: true } }, env: {...}, tmpfs: [...] },
    "mysql":     { image: "...", ports: { "3306/tcp": { ingress: false } }, env: {...}, tmpfs: [...] }
  },
  customDomain?,                    // top-level FQDN (optional)
  serviceName?,                     // top-level — service the domain attaches to (optional, required when customDomain is set on a stack)
  storage?,
  depends_on?
}
```

This branch then continues to Step 3 validation, the Intent recap, the
readiness check, etc., the same as the other input modes.

## When `mode == "single_image"` (single-service fast-path)

Treat `tokens[0]` as the image. Set `IMAGE = tokens[0]`. **Inspect the
image first** to verify it's reachable and to auto-detect ports / cmd /
tmpfs hints:

```bash
NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/inspect-image.cjs" --image "$IMAGE"
```

Capture the JSON result as `IMAGE_INFO`. If empty `{}` (inspection
failed), surface the stderr reason and ask the user to either retry with
a different image or proceed without auto-detection.

Then collect only what's still needed:

1. `AskUserQuestion` for SKU size, populated from
   `mcp__manifest-fred__browse_catalog`.
2. **Ports** — driven by `IMAGE_INFO.ports`:
   - 1 detected: use it (don't ask).
   - >1 detected: multi-select.
   - 0 / no inspection: ask user to type each port-protocol pair.
3. **Ingress per port** — for each chosen port:
   - Single port AND number in `{80, 443, 8080, 8443}`: confirm with
     options `["Yes (Recommended)", "No (internal only)"]`.
   - Otherwise: ask explicitly per port, no default.
4. **Skip asking about** `command` / `args` / `user` / `workingDir` —
   Fred uses image defaults (visible in `IMAGE_INFO.cmd` etc.) unless
   overridden.
5. **`tmpfs`** — if `IMAGE_INFO.suggestedTmpfs` is non-empty, offer it as
   the default (`["Yes (Recommended)", "No", "Customize"]`); else ask
   "Need any tmpfs mounts? (Yes / Skip)".
6. **`env`** — three-option flow (file / chat / skip), same as the
   multi_image mode env step above. Sensitive values via file is the
   recommended path for secrets. The single-service shape uses the
   service name `app` — pass `--service-name app` to `merge-env.cjs`.
7. **`labels`**, **`health_check`** (only if image has none),
   **`storage`**, **`init`** — ask normally.

**Custom domain (optional)** — after collection above and before the
final SPEC is built, ask via `AskUserQuestion`:

> Attach a custom domain (FQDN) to this lease? (Yes / Skip)

On Yes:

1. Ask for the FQDN. Validate via
   `node "$MANIFEST_PLUGIN_ROOT/scripts/validate-domain.cjs" --domain "<fqdn>"`.
   Re-ask on `valid: false`.
2. No service picker — the single-service shape uses one service named
   `app`, which is the implicit target.
3. Add to the spec: top-level `customDomain: <fqdn>`. (Do NOT set
   `serviceName`; the chain treats single-item leases as not needing it.)

Build the `SPEC` object using the **services-map shape** so per-port
ingress is encoded explicitly:

```js
{
  services: {
    "app": {                                           // default service name
      image: IMAGE,
      ports: { "80/tcp": { ingress: true }, ... },
      env?, labels?, health_check?, tmpfs?, init?
    }
  },
  customDomain?,                                       // top-level FQDN (optional)
  storage?
}
```

This branch is single-service only. If the user supplied an image but
actually wants a multi-service stack, tell them: "image-arg fast-path is
single-service only; re-run as `/manifest-agent:deploy-app` (no argument)
for interactive multi-service authoring, or as
`/manifest-agent:deploy-app /path/to/spec.json` if you have a stack spec
file." Then stop.

## When `mode == "empty"` (interactive authoring)

Drive a thin authoring sequence inline (do NOT `Read` the
`author-manifest/SKILL.md` file — the prose below is sufficient). The
standalone `/manifest-agent:author-manifest` is the right entry point if
the user wants a reusable saved spec; here we just author + deploy in one
shot.

1. Use `AskUserQuestion` for shape: **Single-service** or **Multi-service stack**.
   Store as `SHAPE`.
2. Use `AskUserQuestion` for SKU size, populated from
   `mcp__manifest-fred__browse_catalog`. Store as `SIZE`.

### 3a. Single-service authoring (`SHAPE === "single"`)

Skip to section 3b for stacks.

1. Ask for the image reference. Then immediately inspect it to verify
   reachability and to auto-detect ports / cmd / suggested tmpfs:
   ```bash
   NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/inspect-image.cjs" --image "<image>"
   ```
   Capture as `IMAGE_INFO`. Same fail-soft handling as the
   `single_image` fast-path above (empty `{}` → ask user about
   everything; non-empty → drive prompts from the inspection output).
2. **Ports + ingress** — driven by `IMAGE_INFO.ports`:
   - 1 port detected: use it (don't ask).
   - >1 detected: multi-select.
   - 0 / no inspection: ask user to type each port-protocol pair.
   For each chosen port: if it's the only port AND number is one of
   `{80, 443, 8080, 8443}`, confirm with `["Yes (Recommended)",
   "No (internal only)"]`. Otherwise ask explicitly per port; no
   default.
3. **Skip cmd / args / user / workingDir** — image defaults apply.
4. **tmpfs**: `IMAGE_INFO.suggestedTmpfs` non-empty → `AskUserQuestion`
   `["Yes (Recommended)", "No", "Customize"]`; otherwise ask "Need any
   tmpfs mounts? (Yes / Skip)".
5. **env**: three-option flow (file / chat / skip), same as the
   single_image fast-path env step above. Sensitive values via file is
   recommended. The single-service shape uses service name `app` —
   pass `--service-name app` to `merge-env.cjs` later.
6. **labels**, **health_check** (only if image declares none),
   **storage** (top-level), **init** — ask normally.

Build the in-memory `SPEC` using the services-map shape with
`services: { "app": { image, ports, env?, ... } }`.

### 3b. Multi-service stack authoring (`SHAPE === "stack"`)

Skip this section if `SHAPE === "single"` (you ran 3a above).

1. Ask via `AskUserQuestion` for **service count** (typical: 2-5).
   Loop the per-service collection below `count` times.
2. **Per service** (do not auto-suffix; ask the user for everything):
   - **Service name** — must be RFC 1123 DNS label (1-63 chars, lowercase
     alphanumeric + hyphens, no leading/trailing hyphens). The MCP server
     validates on `build_manifest_preview`; if rejected, surface and re-ask.
   - **Image reference** — ask, then immediately inspect:
     ```bash
     NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/inspect-image.cjs" --image "<image>"
     ```
     Capture as `SVC_INFO`. Empty `{}` → ask user about everything;
     non-empty → drive prompts from `SVC_INFO`.
   - **Ports**: from `SVC_INFO.ports` with the same 1 / >1 / 0 rules as
     3a step 2. **Ingress per port**: in stacks, always ask explicitly
     per port — no port-number heuristic (the agent doesn't know which
     service is the public tier).
   - **env**: three-option flow (file / chat / skip). For files, store
     the path with the service name; merging happens in the "Merge any
     file-sourced env" section below.
   - **labels**, **tmpfs** (from `SVC_INFO.suggestedTmpfs`),
     **health_check** (only if image declares none), **stop_grace_period**,
     **expose**, **depends_on** (per-service) — ask as needed.
   - **Skip cmd / args / user** — image defaults apply.
3. After all services collected, ask top-level **storage** and
   **depends_on** (cross-service order, e.g. `web depends_on db`).

Build the in-memory `SPEC` using the services-map shape with one entry
per service in the same order the user collected them.

### 4. Custom domain (optional, both shapes)

After services have been collected and their names are in memory (single:
`["app"]`; stack: the names you asked for in 3b), ask via
`AskUserQuestion`:
> Attach a custom domain (FQDN) to this lease? (Yes / Skip)

On **Yes**:
1. Ask for the FQDN. Validate client-side:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/validate-domain.cjs" --domain "<fqdn>"
   ```
   Re-ask on `valid: false`.
2. **For stacks**: pick the service via `AskUserQuestion` populated from
   the service names you collected in 3b (NOT from `SPEC.services` — the
   final SPEC may not be assembled yet at this point).
   **For single-service**: no picker; the implicit target is `app`.
3. Add `customDomain: <fqdn>` (and `serviceName: <picked>` for stacks) at
   the top level of the SPEC.

### 5. Final SPEC assembly

Build the SPEC object using the services-map shape with explicit
`ports: { "<p>/<proto>": { ingress: <bool> } }` entries, plus any
top-level `customDomain` / `serviceName` / `storage` / `depends_on`
collected above.

Do NOT call `save-manifest-draft.cjs` in the image fast-path or
interactive modes — the spec lives only in memory; the post-deploy
wrapper at `$MANIFEST_PLUGIN_DATA/manifests/<lease_uuid>.json` (Step 10) is
the durable record. (When the user provided an existing spec file path,
the spec already lives on disk by definition.)

## Merge any file-sourced env (interactive paths only)

Skip this section if the user provided a spec file path (the file already
holds whatever env it has) OR if no service was given an env-file path.

Otherwise, materialize the in-memory SPEC, merge each env file via the
script (no values in chat), then re-load the merged spec:

1. Use the `Write` tool to materialize SPEC at
   `/tmp/.spec-env-PROCESS_PID.json`. The Write tool input shows the
   spec content (image, ports, chat-typed env if any, etc.); file-sourced
   values are NOT in this Write yet.
2. For each `(service-name, env-file-path)` pair the user provided
   during per-service authoring above (the multi_image / single_image /
   empty modes each ask for env via the file / chat / skip flow), run:
   ```bash
   cat "<env-file-path>" | node "$MANIFEST_PLUGIN_ROOT/scripts/merge-env.cjs" \
     --spec-file "/tmp/.spec-env-PROCESS_PID.json" \
     --service-name "<service-name>"
   ```
   Report the script's `keys_merged` to the user (keys only — no values
   appear). On any error: surface verbatim, `rm -f` the tempfile, stop.
3. Use the `Read` tool to load `/tmp/.spec-env-PROCESS_PID.json` back
   into your context as the new SPEC. The Read result will contain the
   merged env values — they enter your context here, but they have not
   transited the chat input or any agent prose.
4. `rm -f /tmp/.spec-env-PROCESS_PID.json` once the spec is loaded.
5. Suggest the user delete each env file after a successful deploy (e.g.
   `rm /tmp/wordpress.env`); they have served their purpose.

(Architectural note: env values still appear in the
`build_manifest_preview` and `deploy_app` MCP tool call args at Steps 3
and 7. Eliminating that exposure entirely needs upstream MCP support for
"load spec from this path" and is out of scope here. What this flow does
eliminate is the user typing secrets into the chat input.)
