# ENG-85: agent identity hardening

Issue: [ENG-85](https://linear.app/liftedinit/issue/ENG-85).

Status: implemented locally for 0.5.0; ready for maintainer review. Live macOS
and Windows credential-store acceptance remains outstanding.

## Implementation plan

1. Add one shared credential-store adapter for Linux Secret Service
   (`secret-tool` / libsecret), macOS Keychain, and Windows Credential Manager.
   Send passwords through stdin, verify storage by reading it back, and persist
   only a nonsecret reference in `agent.keyPasswordRef`.
2. Provide an explicit `MANIFEST_CREDENTIAL_STORE=file` fallback for headless
   environments. Keep its secrets outside config in a private directory; never
   silently replace an unavailable keychain with file storage.
3. Migrate existing plaintext config under a process lock. Store and verify the
   password before atomically removing `agent.keyPassword`; record a durable,
   one-time breadcrumb. Preserve the original config if storage fails. Coordinate
   migration with config writers and all five launchers, including Codex.
4. Extend Claude SessionStart with a bounded, stderr-only identity report:
   address, chain, gas denom, and the balance returned by the chain MCP server.
   Use exact arithmetic for the low-funds threshold (gas price × 200,000 × 2).
   Offer a faucet hint on testnet only; startup never requests funds itself.
5. Update initialization/import instructions, recovery and backup documentation,
   both host manifests and package metadata to 0.5.0; regenerate shared skills.

## Validation

- Exercise storage round trips and platform command contracts with isolated
  fakes, including hostile passwords, unavailable stores, missing entries,
  permissions, migration retries and concurrent callers.
- Exercise fresh config creation, wallet replacement, legacy migration and
  launcher resolution without ever accessing the developer's real keychain.
- Drive a mock MCP peer to cover funded/zero/boundary balances, mainnet,
  unavailable RPC, malformed replies, timeouts and stdout/secret isolation.
- Run the complete unit suite, package build, syntax and documentation checks,
  plus installed-runtime contract checks when dependencies are available.
- Record platform limitations accurately: command-contract tests do not establish
  live macOS/Windows keychain behavior. Existing host acceptance evidence remains
  historical; it does not certify this version's migration or UI behavior.

## Recorded validation

- Node 24.15.0: all 631 unit/integration tests passed with test concurrency 2.
- A real isolated D-Bus/GNOME Keyring session passed four libsecret flows:
  special/newline password, empty password, legacy migration and fresh
  `write-config.cjs` initialization. Synthetic wallet data and temporary XDG
  directories kept the user's keychain untouched.
- The actual pinned chain MCP initialized and reached the guarded read-only
  balance query in 2.876 seconds, inside the five-second budget. The check denied
  network access, emitted no stdout and exposed no fixture credential.
- Executable documentation: three examples passed; two network examples were
  intentionally skipped. Generated skills, version/JSON consistency, syntax and
  policy completeness passed. The generic skill validator also passed for the
  generated Codex setup/import skills; Claude-specific metadata is validated by
  this repository's package checks.
- Pinned MCP inventory: five servers, 34 tools and 12 gated mutations; all six
  numeric lease states matched the installed runtime. Shared launcher transport
  initialized the five installed servers with outbound networking disabled.
- Both-host contracts passed: five installed servers per host, 25 workflow
  tool references and six callback cases. Heavy system load caused the standard
  combined check to time out; the same assertions passed with the per-server
  discovery deadline extended from 20 to 60 seconds in a temporary harness.
  The production and committed CI deadlines were unchanged.
- Historical evidence checks passed. The Codex release gate correctly reports
  `eligible=false`: existing interactive/testnet evidence does not certify 0.5.0.

This validates implementation and local contracts. No live balance query,
faucet request, deployment, release or real-user wallet operation was performed.
