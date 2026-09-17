# Native Write observation source artifacts

These files preserve the original bytes behind the hashes in the
[reviewed native Write report](../claude-native-write-0.5.0-reviewed.json):

| Artifact | Recorded hash field |
| --- | --- |
| [Original driver](claude-native-write-driver.cjs) | `operatorDriverSha256` |
| [Original public report](claude-native-write-original.json) | `sourceReportSha256` |

The driver ran on Linux with Claude Code 2.1.270 and Node 24.15.0 on
2026-09-17. The archived files are byte-for-byte copies of that run's driver
and public output. Adding them does not repeat the observation or change its
timestamp. The reviewed report adds interpretation and the relationship to
the workflow fix; it is a different file from the original output.

To check the stored hashes from the repository root:

```bash
sha256sum docs/host-evidence/source-artifacts/claude-native-write-driver.cjs \
  docs/host-evidence/source-artifacts/claude-native-write-original.json
```

With the recorded host version available, the original driver can be run
from the repository root with a separate output path:

```bash
node docs/host-evidence/source-artifacts/claude-native-write-driver.cjs \
  /var/tmp/claude-native-write-new-observation.json
```

The helper uses isolated temporary profiles, a loopback model and harmless
JSON. It preallows only the actual Write tool in print mode, with Read
unavailable. It tests file creation semantics; it does not run a generated
skill, a terminal confirmation flow, or a live MCP mutation. It reports the
installed host version without enforcing the historical version. Keep any
new result separate from these historical files.
