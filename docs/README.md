# Jevris documentation

If a page and the product disagree, the product wins and the page is a bug: [report it](../CONTRIBUTING.md). `cli.md` and `platform-support.md` are generated from the product, and `npm run lint` checks that every page names only commands and flags the CLI has.

## Use Jevris

| Page | When you need to |
| --- | --- |
| [jevris-in-simple-terms.md](jevris-in-simple-terms.md) | Decide whether and how to use Jevris: what it does and does not do, costs, privacy, limits, and a 10-minute start |
| [installation.md](installation.md) | Install with npx or globally, see where files go, store the Jev key, install on Windows or from source |
| [upgrade.md](upgrade.md) | Upgrade, downgrade, migrate the store, uninstall, delete your data |
| [harnesses/claude-code.md](harnesses/claude-code.md), [codex.md](harnesses/codex.md), [kilocode.md](harnesses/kilocode.md), [opencode.md](harnesses/opencode.md), [antigravity.md](harnesses/antigravity.md) | See what install writes for one harness, verify it inside the harness, certify it, and remove it |
| [harnesses/parity-matrix.md](harnesses/parity-matrix.md) | Compare which features each harness supports, with the reason for each unsupported one |
| [troubleshooting.md](troubleshooting.md) | Understand refused, reduced, unsupported and degraded; fix Node, keychain, sidecar and Windows problems |
| [cli.md](cli.md) | Look up any command, flag or exit code (generated) |
| [mcp.md](mcp.md) | See every MCP tool, its arguments, results and refusals, and how the hook launcher behaves |
| [routing.md](routing.md) | Get model and effort advice, state each harness's sign-in (subscription or API key), see how owned workers pick a harness, and control route learning |
| [settings.md](settings.md) | Change product settings, and see how repository and organization files narrow them |
| [verification.md](verification.md) | Declare and approve checks, and see what counts as proof that work is done |
| [packs.md](packs.md) | Install, test, approve, canary, promote, enable and roll back policy packs |
| [platform-support.md](platform-support.md) | Check Node, OS, architecture and certified harness combinations (generated) |

## Operate and administer

| Page | When you need to |
| --- | --- |
| [configuration.md](configuration.md) | Find every file Jevris reads or writes, the sidecar, the store, retention, the kill switch, managed policy and environment variables |
| [security.md](security.md) | Understand the security boundary, the Jev key, storage, the kill switch, the audit log and authorizations |
| [multi-host.md](multi-host.md) | Run the control service so owned workers on several hosts share one lease authority, and migrate a workspace to it |
| [privacy.md](privacy.md) | See what can leave the machine, what consent means, retention and deletion |
| [remediation-codex-hooks.md](remediation-codex-hooks.md) | Repair shared harness config left by a pre-1.2 install |

## Develop Jevris

| Page | When you need to |
| --- | --- |
| [architecture.md](architecture.md) | See the processes, packages and authority split |
| [development.md](development.md) | Set up, build and follow the conventions |
| [testing.md](testing.md) | Run and extend the suites, CI and required checks |
| [model-refresh.md](model-refresh.md) | Refresh model ids, prices, limits and lifecycle dates, then check them with `npm run registry:check` |
| [../RELEASING.md](../RELEASING.md) | Cut, verify, promote and roll back a release |

