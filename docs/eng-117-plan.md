# ENG-117: image pinning integration

Status: plugin preparation; automatic resolution and canonical digest rendering
depend on [ENG-954](https://linear.app/liftedinit/issue/ENG-954). The implementation
plan in [ENG-117](https://linear.app/liftedinit/issue/ENG-117) was updated before
these changes. Neither ticket's full feature is implemented by this preparation.

## Verified boundary

Audited plugin commit `1bf3c1ff4ceed3b8fedee9e60bafe0297bf73486` and upstream
`v0.22.0` (`000adeefb8044600a2be2ee9da71d7e453543a4c`), the locked runtime.

| Owner | Current behavior | Required upstream change |
| --- | --- | --- |
| Plugin shared workflows | Collect images, preview manifest fields, save/load drafts | Consume released resolution tool; default to resolved pins |
| Fred preview / SDK catalog API | Builds manifest JSON and its `meta_hash_hex` | Keep manifest hashing distinct from OCI digest resolution |
| Agent-core internal inspector | Returns `ImageInfo \| null`; follows an index to a child before returning its digest | Public typed resolution of the top-level index/manifest |
| `AppDeploySpec` / agent MCP schema | Forwards image strings; no image-resolution/opt-out semantics | Shared validated semantics for per-service image choices |
| Agent-core plan and MCP callbacks | Plan renders the primary image; subsequent native intent confirmation lists every full image reference | Automatic resolution and per-service resolution status, consistent with the approved/uploaded spec |

Relevant upstream sources:

- [Preview schema](https://github.com/manifest-network/manifest-mcp-mono/blob/v0.22.0/packages/fred/src/server/register-tools.ts)
- [Internal inspector](https://github.com/manifest-network/manifest-mcp-mono/blob/v0.22.0/packages/agent-core/src/internals/inspect-image.ts)
- [Deployment orchestrator](https://github.com/manifest-network/manifest-mcp-mono/blob/v0.22.0/packages/agent-core/src/deploy-app.ts)
- [Canonical plan renderer](https://github.com/manifest-network/manifest-mcp-mono/blob/v0.22.0/packages/agent-core/src/internals/render-deployment-plan.ts)
- [MCP deploy schema](https://github.com/manifest-network/manifest-mcp-mono/blob/v0.22.0/packages/agent/src/index.ts)

The deleted plugin inspection/intent/plan helpers stay deleted. Unknown fields
passing through a loose MCP schema do not establish supported semantics.

## Current plugin work

- Preserve supplied digest references exactly, including registry ports and
  tag-plus-digest syntax. Offer supplying a digest as the recommended authoring
  choice; retaining a mutable tag requires an explicit choice per service.
- Report each saved reference as user-supplied or mutable/unresolved. A preview
  hash identifies manifest JSON; a supplied digest is not a verified registry
  lookup. Do not emit speculative resolution fields into drafts.
- Classify supplied syntax with `_image-ref.cjs` and its
  `check-image-references.cjs` CLI. Malformed digests cannot be saved or passed
  through the deployment workflow; the helper performs no registry lookup.
- Forward loaded images unchanged and retain upstream native confirmation.
  State the current plan's primary-image limitation.
- Test draft save/env-merge preservation and the published preview/MCP input
  boundary. These checks do not prove registry resolution or provider upload.
- Execute the generated author/deploy shell checks for both hosts, including
  malformed inputs and full digest output. This guards the executable checks;
  prompt choices and final prose presentation still require behavioral host
  testing. Keyword assertions would not establish that behavior.
- Mark all four affected release-evidence rows pending; preserve their recorded
  source hashes and reports until fresh host acceptance is run for release.

## Upstream contract to settle in ENG-954

Final operation names, SDK export/subpath, field names, and release version
remain upstream decisions. The required information is:

- Requested reference, canonical repository, immutable reference, SHA-256
  digest, top-level media type/kind, and a typed unresolved outcome.
- Per-service selected reference and explicit rolling-tag opt-out. Treat
  client-supplied metadata as untrusted; validate it against the actual image.
- One approved immutable reference throughout preview, confirmation, upload,
  and saved deployment. Image edits invalidate stale resolution and require
  a fresh plan; a retained pin is never replaced after its tag moves.

The OCI API retrieves a manifest by tag or digest. An image index references
platform manifests, which in turn reference configuration and layers. Resolve
and validate the top-level bytes for the pin; optional inspection of a child
must not replace that identity. See the [OCI distribution specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md#pulling-manifests)
and [OCI image index specification](https://github.com/opencontainers/image-spec/blob/main/image-index.md).

An opt-out's observed digest is informational: the rolling tag may move before
the provider pulls it. Unresolved images need an explicit user choice; an
unavailable lookup must never silently become a purported immutable pin.

## Integration and release gate

1. ENG-954 settles and implements the SDK/MCP resolution and image-choice
   contract, including index/child distinction, guarded access, digest
   validation, failures, cancellation, and native plan rendering.
2. Upstream tests prove per-service consistency through edits and a moving tag,
   with the approved pin present in the uploaded and persisted manifest.
3. Pin the released MCP version and lockfile here. Update shared workflows to
   call its actual tool/schema and preserve its agreed metadata. Update tool
   inventory/policy checks for the new read-only operation.
4. Regenerate skills and build Codex, then run the unit suite and installed
   runtime contract checks. Exercise native authoring/confirmation on both hosts
   before making a host compatibility claim.

No package version or dependency bump belongs in the preparatory change.
