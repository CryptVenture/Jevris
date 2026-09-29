# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| The latest `1.x` release of `@webventures/jevris` (npm tags `latest` and `next`) | Yes |
| Earlier `1.x` releases | Upgrade first; fixes land in the next patch release |
| The `v1.0` and `v1.1` workspace milestones | No (never published) |

Jevris runs on Node `^22.14.0 || >=23.6.0` on macOS, Linux and Windows. Its security boundary is your operating-system user: a process running as you can read what Jevris can read, and Jevris cannot contain a compromised account. See [docs/security.md](docs/security.md).

## Reporting a vulnerability

Report it privately through GitHub: <https://github.com/CryptVenture/Jevris/security/advisories/new>. Do not open a public issue, pull request or discussion for a vulnerability.

Include:

- the affected version (`jevris --version`) and operating system
- what an attacker can do, and what they already need
- a minimal reproduction that contains **no** source code, tokens, or remote response bodies

You should receive an acknowledgement within 7 days. A fix, if accepted, is developed privately and released as a patch version. There is no bounty.

## What to leave out

- the Jev key and any other API key, keychain contents, the store (`jevris.db`), backups and crash dumps
- Repository source that would have been subject to egress review
- Remote HTTP bodies

Error text in this codebase is not allowed to include remote bodies. A report should follow the same rule.

## Scope

In scope: source egress without administrator consent, a Jevris decision that overrides or widens a native harness permission, a path escape or damage to another tool's files during install, uninstall or data delete, a secret reaching a log, argv or a file, a sidecar or pipe endpoint another local user can reach, hook or MCP input that makes Jevris act outside its certification, and tampered release evidence that `jevris gates` accepts.

Out of scope: a capability that `doctor` reports as unsupported (Jevris only observes there), a harness's own hook or timeout behaviour, the Jev vendor's service, and attacks that already run code as your user.

See [docs/security.md](docs/security.md) and [docs/privacy.md](docs/privacy.md).
