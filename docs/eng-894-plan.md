# ENG-894 implementation plan

Goal: ship the existing complete-spec Manifest workflows in Claude Code and
Codex with one maintained workflow source and one deterministic runtime.
Prerequisites ENG-892 and ENG-893 are merged. The upstream runtime remains
locked to MCP 0.22.0; this work does not expand authoring or orchestration.

1. Verify the documented native Codex package format against the installed
   host. Characterize discovery, form elicitation and progress with harmless
   fixtures before wiring a signer.
2. Add explicit host path adapters around `setup-runtime.cjs` and
   `start-server.cjs`. Preserve Claude's data path. Default Codex to an
   isolated persistent directory; configuration, wallets, drafts, saved
   deployments and journals must survive package upgrades. Do not silently
   import a wallet or select a different chain. Exercise concurrent hosts.
3. Extract shared workflow templates and resolve invocation names, MCP names,
   environment setup and questions during generation. Keep Claude's shipped
   skills available. Build a separate native Codex artifact so default
   component discovery cannot load Claude-only hooks or MCP configuration.
4. Add CI checks for generated skills, distribution contents, runtime
   contracts and a reproducible host matrix. Cover decline before mutation,
   success, cancellation, progress and a paid partial failure. Record fixture
   results separately from actual terminal/UI and live testnet evidence.
5. Document installation, upgrade, configuration, recovery and noninteractive
   limits for both hosts. Prepare release artifacts and release gates.
   Follow the repository's separate version/tag release process after review.

Release evidence must identify exact host/package versions and source hashes,
observed results and cleanup. A local fixture is not a live deployment and
an app-server probe is not a terminal UI test. Missing evidence remains an
explicit prerequisite for the relevant host's publication; no checkbox is
completed by inference. Pending Codex evidence does not block Claude-only tags.

Implementation status (2026-09-14): phases 1–3 are implemented; phase 4 has
automated fixtures, fresh Codex app-server checks in CI, historical committed
evidence and pinned-runtime contracts; phase 5 has installation/recovery docs,
CI artifacts and a Codex archive gate. Local validation passes all 511 tests on Node 24.15.0, native plugin
and skill validators, both-host inventory/callback checks, executable docs
and evidence provenance checks. Codex 0.153.4 passed eight harmless host
cases (14 skills, five servers); the pinned inventory contains 34 tools and
12 reviewed mutations. No live resources were used.

The PR review fixes cover early package validation, draining large MCP
responses on exit, sourceable environment helpers for all skills, one policy
injection per thread, cancellation without a late response, a startup-aligned
setup lock deadline, XDG fallback, checked policy rewrites, shared workflow
enumeration and an independent twelve-tool gate assertion. Historical evidence
keeps routine source/version changes independent of a local Codex install;
CI validates its freshly generated report against the checkout. Tagged Claude
releases proceed while Codex acceptance is pending.

ENG-894 remains open for the interactive UI and funded testnet runs, their
cleanup evidence, and the separate compatibility version/tag release. See
[the acceptance matrix](host-acceptance.md). The feature branch is
`feat/eng-894-codex-packaging`; package versions remain 0.4.0.

Sources checked during implementation (2026-09-11):

- [Codex package formats](https://developers.openai.com/plugins/build/plugins)
- [Codex skill metadata](https://learn.chatgpt.com/docs/build-skills)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- Installed Codex CLI 0.153.4 protocol schemas and harmless plugin probe;
  installed Claude Code 2.1.263 and existing repository host harness.
