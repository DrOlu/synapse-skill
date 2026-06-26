# Configuration Reference

NATS server config for a Synapse mesh, NKey generation, and a per-role
permissions template. Adapted from the live local mesh
(`~/.config/nats/nats.conf`).

## Minimal `nats.conf` (JetStream + monitoring + WebSocket)

```hcl
port: 4222
http_port: 8222

websocket {
  port: 8443
  no_tls: true        # add tls {} block for production
}

jetstream {
  store_dir: "/var/lib/nats/jetstream"   # PERSISTENT path, never /tmp
  max_mem: 512M
  max_file: 2G
}

# Remove no_auth_user in production — every client must authenticate.
system_account: SYS

accounts {
  SYS: { users: [ { user: sys, password: "" } ] }

  LOCAL: {
    jetstream: enabled
    users: [
      # One NKey user per agent — see per-role template below.
      { nkey: <AGENT_PUBLIC_KEY>, permissions: { … } }
    ]
  }

  REMOTE: {}   # for leaf nodes / cross-org
}

leafnodes {
  remotes [
    { url: "tls://connect.ngs.global:7422"
      creds: "/etc/nats/synadia.creds"
      account: REMOTE
      deny_exports: [ "mesh.registry.>", "mesh.agent.>", "mesh.heartbeat.>", "mesh.task.>" ]
      deny_imports: [ "mesh.registry.>", "mesh.agent.>", "mesh.heartbeat.>", "mesh.task.>" ] }
  ]
}
```

## NKey generation

NKeys are Synadia's ed25519 auth for NATS. One per agent; the **public** key
goes in the server config, the **seed** stays on the agent.

```bash
# Generate a user keypair (prints public + seed)
nats nkeys genuser

# Or, if you have the nk utility:
nk -gen user > ~/.synapse/nkeys/my-agent.seed
nk -keypair ~/.synapse/nkeys/my-agent.seed   # prints the public key

# Restrict to a specific curve for request privacy (optional):
nats nkeys genuser --curve
```

Put seeds in `~/.synapse/nkeys/<agent>.seed` (chmod 600). The
`synapse-client` loads them via `nkey_seed_file=`.

## Per-role permissions template

Permissions are the most common cause of `permissions violation` errors. Give
each agent exactly the subjects it needs.

### Caller agent (discovers + calls others + reads TASK_STORE)

```hcl
{
  nkey: UCALLER_PUBKEY
  permissions: {
    publish: { allow: [
      "mesh.agent.<target>.inbox",      # whom it may call
      "mesh.registry.register", "mesh.registry.discover",
      "mesh.heartbeat.<self>",
      "mesh.task.>", "mesh.event.>",
      "_INBOX.>", "_inbox.>", "_R_.>", "_REPLY.>",
      "$JS.>", "$JS.API.>", "$kv.>", "$KV.>"
    ]}
    subscribe: { allow: [
      "mesh.registry.discover", "mesh.registry.get.>",
      "mesh.event.reputation.>",        # to avoid liar-flagged callers
      "_INBOX.>", "_inbox.>", "$JS.>", "$KV.>"
    ]}
  }
}
```

### Server agent (serves requests on its inbox)

```hcl
{
  nkey: USERVER_PUBKEY
  permissions: {
    publish: { allow: [
      "mesh.agent.<self>.inbox",         # replies go here via _INBOX
      "mesh.registry.register", "mesh.registry.deregister",
      "mesh.registry.discover", "mesh.heartbeat.<self>",
      "mesh.task.>", "mesh.event.>", "mesh.approval.>",
      "_INBOX.>", "_inbox.>", "_R_.>", "_REPLY.>",
      "$JS.>", "$JS.API.>", "$kv.>", "$KV.>"
    ]}
    subscribe: { allow: [
      "mesh.agent.<self>.inbox",
      "mesh.registry.discover", "mesh.registry.reregister",
      "mesh.event.reputation.>", "mesh.approval.>",
      "_INBOX.>", "_inbox.>", "$JS.>", "$KV.>"
    ]}
  }
}
```

### Service users (no NKey, plain user/pass)

```hcl
# registry-service
{ user: registry-service, password: "",
  permissions: {
    publish: { allow: ["mesh.registry.>", "_INBOX.>", "_inbox.>", "_R_.>", "$JS.>", "$kv.>", "$KV.>"] }
    subscribe: { allow: ["mesh.registry.>", "_INBOX.>", "_inbox.>", "$JS.>"] }
  }}

# reputation-service
{ user: reputation-service, password: "",
  permissions: {
    publish: { allow: ["mesh.task.>", "mesh.registry.>", "mesh.event.reputation.>", "_INBOX.>", "_inbox.>", "_R_.>", "$JS.>", "$kv.>", "$KV.>"] }
    subscribe: { allow: ["mesh.task.>", "mesh.registry.>", "mesh.heartbeat.>", "mesh.event.reputation.>", "_INBOX.>", "_inbox.>", "$JS.>"] }
  }}

# task-service
{ user: task-service, password: "",
  permissions: {
    publish: { allow: ["mesh.task.>", "mesh.heartbeat.>", "_INBOX.>", "_inbox.>", "_R_.>", "$JS.>", "$kv.>", "$KV.>"] }
    subscribe: { allow: ["mesh.task.>", "mesh.heartbeat.>", "_INBOX.>", "_inbox.>", "$JS.>"] }
  }}
```

### Admin (monitoring, KV, stream management)

```hcl
{ user: admin, password: "<strong>",
  permissions: { publish: { allow: [">"] }, subscribe: { allow: [">"] } } }
```

## Reloading config

NATS reloads accounts/permissions on SIGHUP without dropping connections:

```bash
kill -HUP $(pgrep -f nats-server)
```

Validate before reload:
```bash
nats-server -t -c /path/to/nats.conf   # exits 0 if valid
```

## JetStream buckets / streams the client depends on

| Resource | Name (default) | Purpose |
|----------|---------------|---------|
| KV bucket | `TASK_STORE` | durable task records (polled by `request_long`) |
| Stream | `AGENT_INBOXES` | durable inbox subjects for `serve()` consumers |

The client creates `TASK_STORE` lazily if missing. If you use a custom mesh,
set `task_bucket=` / `inbox_stream=` or the `SYNAPSE_TASK_BUCKET` /
`SYNAPSE_INBOX_STREAM` env vars.

## Multi-tenant isolation (production gotcha #1)

The #1 production gotcha: JetStream API calls fail from a leaf node when the
account isn't isolated. Ensure:
- A dedicated **LOCAL** account with `jetstream: enabled`
- A separate **REMOTE** account for the leaf (no JetStream)
- `system_account: SYS` with **no** JetStream

Verify: `curl http://localhost:8222/jsz` → `api.errors == 0`.

## Boot persistence (production)

Run NATS + agents under a process supervisor so they survive reboot:
- **macOS**: launchd plists with `KeepAlive=true`, `ThrottleInterval=5`
- **Linux**: systemd units with `Restart=always`
- **Windows**: run `nats-server.exe` as a Windows Service (via `nssm` or
  `sc.exe create`), or a Scheduled Task at logon with “run whether user is
  logged on or not”. Use a **persistent** `store_dir` like
  `C:\ProgramData\nats\jetstream` (never a temp dir). Agent bridges run
  the same way (nssm-wrapped `python.exe client.py …` or a Scheduled Task).
- Put the JetStream `store_dir` on a **persistent** path (not `/tmp`)

### Windows notes

- Paths use backslashes; NKey seeds live at `%USERPROFILE%\.synapse\nkeys\<agent>.seed`
  (the Python client expands `~` to `%USERPROFILE%` via `os.path.expanduser`,
  so `nkey_seed_file="~/.synapse/nkeys/my.seed"` works on Windows too).
- The `nats` CLI and `nats-server.exe` are available for Windows; `cli.sh`
  runs under Git Bash / WSL. For native PowerShell, run `./cli.sh windows` to
  print ready-to-use PowerShell equivalents, or use `client.py` directly
  (nats-py is fully cross-platform).
- Use `nssm install nats-server` to wrap `nats-server.exe -c C:\ProgramData\nats\nats.conf`
  with `AppStdout`/`AppStderr` log redirection and `AppRestartDelay=5000`.
