# Owned workers on several hosts

By default each host grants leases for owned workers by itself. That is enough when one machine runs the work. When several hosts run owned workers for the same workspace, they need one lease authority, or two hosts could lease the same task. That authority is the **control service**: one process, on one host, that holds every host's leases, budget reservations and fences for its tenants.

Nothing here is needed for a single host. `jevris control status` says `SINGLE_HOST` until you configure a service.

The full command reference is in [cli.md](cli.md#jevris-control).

## 1. Run the service

Pick the host that runs the service and a directory for its data. The service keeps one ledger per tenant there.

Each team or group of hosts that shares leases is a **tenant**. Each tenant has a bearer token, and the service stores only the token's SHA-256 digest. To create a token file and print its digest, without the token ever appearing on a command line:

```sh
node -e "const c=require('node:crypto');const t=c.randomBytes(32).toString('base64url');require('node:fs').writeFileSync('team-a.token',t+'\n',{mode:0o600});console.log(c.createHash('sha256').update(t).digest('hex'))"
```

Put the digest in the tenants file, for example `/srv/jevris-control/tenants.json`:

```json
{ "tenants": [{ "id": "team-a", "tokenSha256": "<the printed hex digest>" }] }
```

Tenant ids and digests must be unique. A tenant sees only its own leases, reservations, fences and budgets.

Start the service:

```sh
jevris control serve --root /srv/jevris-control --tenants /srv/jevris-control/tenants.json --host 0.0.0.0 --port 8443 --tls-key key.pem --tls-cert cert.pem --json
```

It prints one JSON line with `"serving":true` and the service's `url`, and runs until Ctrl-C or SIGTERM. Run it under your usual service manager if it should outlive the terminal.

Plain HTTP is served only on a loopback address (the default host is `127.0.0.1`). Any other address needs `--tls-key` and `--tls-cert`; without them the service refuses to start (`SERVE_REFUSED`, exit 2).

## 2. Point each host at it

Copy the tenant's token file to each host that runs owned workers, readable by you only: mode 0600 on macOS and Linux, an owner-only ACL on Windows. Then write `control.json` in the Jevris config directory (see [settings.md](settings.md) for where that is on each OS):

```json
{
  "schemaVersion": "jevris-control-client-1",
  "url": "https://control.example.internal:8443/",
  "tokenFile": "/home/you/.config/jevris/team-a.token",
  "caFile": "/home/you/.config/jevris/control-ca.pem"
}
```

`tokenFile` and `caFile` must be absolute paths. `caFile` is optional; use it when the service's certificate is signed by your own CA. The token never goes in `control.json`, in a command line or in the environment.

Check the host:

```sh
jevris control status
```

| reasonCode | Meaning | Exit |
| --- | --- | --- |
| `SINGLE_HOST` | No `control.json`; this host leases on its own | 0 |
| `CONTROL_SERVICE` | This host leases through the service | 0 |
| `CONTROL_SERVICE_REQUIRED` | The workspace was migrated, but this host has no `control.json`; it grants no lease here until you add one | 1 |
| `CONTROL_SETTINGS_UNUSABLE` | `control.json` is not usable; `problem` says why | 1 |
| `CONTROL_TOKEN_UNUSABLE` | The token file is not owner-only, or does not hold a token of at least 32 printable characters | 1 |
| `CONTROL_UNAUTHORIZED` | The service refused this host's token | 1 |
| `CONTROL_UNAVAILABLE` | The service did not answer | 1 |

Run `status` and `migrate` inside the workspace's repository, or pass `--workspace <dir>`. `status` needs the sidecar running (`jevris sidecar start`), and never starts anything itself. It also shows the service URL, whether it answered, the active leases for this workspace and whether the workspace was migrated.

## 3. Migrate the workspace, once

When a workspace already has local owned-work state, move it to the service from one host:

```sh
jevris control migrate --yes
```

This copies the workspace's budgets, leases, reservations and fences to the service. **It cannot be undone.** Afterwards this host grants no local lease for that workspace: owned work runs only while the service answers. Configure `control.json` on every other host that runs owned work for the workspace before it starts; a host without one keeps leasing on its own. Without `--yes`, it asks y/N on a terminal and refuses otherwise (exit 2). Only the CLI can migrate; no MCP tool reaches the control commands, and the kill switch stops a migration (clear it first with `jevris kill-switch clear`).

| reasonCode | Meaning | Exit |
| --- | --- | --- |
| `MIGRATED` | Done; `imported` counts what was moved | 0 |
| `ALREADY_MIGRATED` | This workspace was already migrated | 1 |
| `IMPORT_CONFLICT` | The service already holds different state for this workspace | 1 |
| `CONTROL_NOT_CONFIGURED` | Write `control.json` first | 1 |
| `CONTROL_SETTINGS_UNUSABLE`, `CONTROL_UNAVAILABLE`, `CONTROL_UNAUTHORIZED` | As for `status` | 1 |

## When the service is down

A host configured for the service grants no new lease while the service does not answer, and never falls back to leasing on its own; `status` shows `CONTROL_UNAVAILABLE`. The same holds when `control.json` or the token file becomes unusable. Fix the service or the settings, then run `jevris control status` again.
