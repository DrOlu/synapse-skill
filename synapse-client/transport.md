# Transport & Auth Guide

Every way to connect to a Synapse mesh. Pick by environment; the client's
`connect()` handles each via its keyword args.

## Decision matrix

| Environment | URL scheme | Auth | `connect()` args |
|-------------|-----------|------|-------------------|
| Local dev mesh (default) | `nats://localhost:4222` | NKey (optional) | `connect()` |
| Remote LAN mesh | `nats://10.0.0.5:4222` | NKey | `connect(url, nkey_seed_file=…)` |
| TLS mesh | `tls://host:4222` | NKey or JWT | `connect("tls://…", nkey_seed_file=…)` or `creds_file=…` |
| Synadia Cloud | `tls://connect.ngs.global:4222` | JWT creds | `connect("tls://…", creds_file="~/.nats/synadia.creds")` |
| Anonymous / open dev | `nats://host:4222` | none | `connect(url)` |
| Browser agent | `ws://host:8443` or `wss://…` | NKey/JWT | `connect("ws://…")` (browser SDK) |
| Cross-org (firewall) | leaf node (outbound only) | JWT creds | `connect("tls://…", creds_file=…)` from the leaf |
| REST-only agent | HTTP bridge | bridge auth | `POST /mesh/*` (no NATS client) |
| **Windows** | `nats://host:4222` | NKey | `connect(url, nkey_seed_file="…")` or `cli.sh`/`client.py` (cross-platform) |

## 1. Local mesh (default)

```python
mesh = await SynapseClient.connect()
```

The local mesh on this machine:
- `nats://localhost:4222` (NATS)
- `http://localhost:8222` (monitoring) — probe with `mesh.health()`
- `ws://localhost:8443` (WebSocket, `no_tls`)
- JetStream store at `~/.nats/jetstream`
- NKeys in `~/.synapse/nkeys/<agent>.seed` (auto-loaded if `nkey_seed_file` points there)
- `TASK_STORE` KV bucket, `AGENT_INBOXES` stream

Auth is NKey; if no NKey is supplied the client connects anonymously (the
local `nats.conf` has `no_auth_user` removed, so anonymous connections may be
rejected depending on the server's accounts config — supply an NKey).

## 2. NKey auth (recommended for agents)

```python
mesh = await SynapseClient.connect(
    "nats://10.0.0.5:4222",
    nkey_seed_file="~/.synapse/nkeys/remote.seed",
    agent_id="acme-agent-001")
```

Generate keys (see `config.md`):
```bash
nats nkeys genuser --curve   # or use the nk utility
```
The **public** key goes in the server's `accounts` block with a permissions
list; the **seed** stays on the agent. Never share the seed.

## 3. JWT / creds (Synadia Cloud, managed, cross-org)

```python
mesh = await SynapseClient.connect(
    "tls://connect.ngs.global:4222",
    creds_file="~/.nats/synadia.creds")
```

`.creds` files bundle a signed JWT + the NKey seed. They're issued by an
account/operator (Synadia Cloud does this in its console). Use for:
- Synadia Cloud (free tier available)
- Cross-org leaf nodes
- Managed production meshes with per-user permissions + expiry

## 4. Anonymous / open dev

```python
mesh = await SynapseClient.connect("nats://dev.example:4222")
```

Only works if the server has `no_auth_user` set or an open account. Fine for
throwaway dev meshes; **never** for production.

## 5. WebSocket (browser agents)

Browsers can't open raw TCP, so they connect over WebSocket:
```js
// browser SDK (separate from this Python client)
const mesh = await Synapse.connect("ws://host:8443")
```
Server side, `websocket { port: 8443; no_tls: true }` (add TLS in prod).
Auth still required (NKey/JWT) when `no_auth_user` is removed.

## 6. Cross-org via leaf node

Leaf nodes traverse firewalls — the remote mesh connects **outbound** only:
```
[ Acme LAN ] --leaf-outbound--> [ Globex NATS / Synadia ]
```
- The leaf host opens a TLS connection to the remote NATS (e.g.
  `tls://connect.ngs.global:7422`).
- `deny_exports`/`deny_imports` keep local `mesh.*` subjects local (see
  `config.md`).
- Agents on the leaf use normal local NKeys; the remote account maps them.

Gotchas:
- Leaf nodes connect OUTBOUND only; the firewall must allow the NATS port.
- JetStream API calls from a leaf fail unless the account is isolated (LOCAL
  account with `jetstream: enabled`, separate REMOTE account for the leaf,
  `system_account` = SYS with NO JetStream). Check `curl http://localhost:8222/jsz` → `api.errors == 0`.
- Use `tls://` for cross-org traffic.

## 7. HTTP bridge (REST-only participants)

If you're integrating a Flask/FastAPI/Express agent that can't run a NATS
client, point it at the mesh's HTTP bridge (no NATS code on its side):

```
POST /mesh/discover   {"capabilities": ["chat"]}
POST /mesh/request    {"agentId":"bob-001","skill":"chat",
                       "input":{"text":"hi"},"timeout":30}
GET  /mesh/health
```
The bridge proxies between HTTP and `mesh.agent.{id}.inbox`. The agent itself
exposes plain REST (`POST /skill/chat`); the bridge calls it and relays
replies onto the mesh. Use this for legacy services you can't modify.

## TLS notes

- Prefix `tls://` (or `wss://` for browsers) to encrypt the transport.
- Self-signed servers: pass `nats_kwargs={"tls": {"insecure": True}}` for
  dev only — never in prod.
- Always TLS for cross-org and Synadia Cloud.

## Common connection failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Authorization Violation` | NKey/JWT missing or wrong | supply `nkey_seed_file`/`creds_file` matching the server's accounts |
| `permissions violation for subscription …` | NKey lacks that subject in `subscribe.allow` | add the subject in `nats.conf`, `kill -HUP <nats-pid>` (see `config.md`) |
| `no responders` | target inbox has no subscriber | agent offline; `discover()` to confirm |
| `Connect call failed` | wrong host/port, or firewall | verify `url`/port; for leaf nodes confirm outbound-only |
| `nkeys_seed`/`user_credentials` both set | passed conflicting auth | use one (precedence: nkey > creds > jwt > none) |

## Reconnect & resilience

`nats-py` auto-reconnects by default with exponential backoff. Tune via:
```python
mesh = await SynapseClient.connect(url, max_reconnect_attempts=-1,
                                    reconnect_time_wait=2)
```
`request_long()` survives reconnects because it polls the durable `TASK_STORE`
KV bucket, not an in-flight subscription.

## Windows / cross-platform notes

`client.py` (nats-py) and `cli.sh` both run on Windows.
- **Python client**: `pip install nats-py` works on Windows; `os.path.expanduser`
  maps `~` → `%USERPROFILE%`, so `nkey_seed_file="~/.synapse/nkeys/my.seed"`
  resolves to `C:\Users\<you>\.synapse\nkeys\my.seed`. Forward slashes in the
  path are accepted on Windows too.
- **Bash CLI**: `cli.sh` runs under **Git Bash** or **WSL** with the Windows
  `nats.exe` on `%PATH%`. For native PowerShell (no bash), run `./cli.sh windows`
  to print PowerShell equivalents, or call `nats.exe` directly:
  `nats.exe --server nats://host:4222 --nkey $env:USERPROFILE\.synapse\nkeys\my.seed request mesh.registry.discover '{"capabilities":[]}' --raw`
- **Server**: `nats-server.exe` runs on Windows as a Service (nssm) or
  Scheduled Task. JetStream `store_dir` must be a persistent Windows path.
- **WebSocket** (`ws://host:8443`) is handy for Windows agents behind a firewall
  that blocks raw TCP 4222.
