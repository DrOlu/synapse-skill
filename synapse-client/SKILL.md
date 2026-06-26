---
name: synapse-client
description: Connect to and operate on any Synapse agent mesh from any agent runtime. A drop-in async Python client (nats-py) plus a bash CLI helper exposing all 6 Synapse primitives (register, discover, request, respond, emit, subscribe) plus heartbeats, durable task polling, chunked file transfer, health probing, and event subscription. Defaults to the local mesh at nats://localhost:4222 (NKey auth, TASK_STORE KV bucket, AGENT_INBOXES JetStream stream, monitoring on :8222, WebSocket on :8443) but accepts arbitrary url/port/auth (NKey/JWT/creds/anonymous) to reach any remote Synapse network. Use whenever an agent needs to discover agents, call agent skills, broadcast or subscribe to events, send files for analysis, or serve requests on the Synapse mesh.
---

# synapse-client

A single, self-contained skill that lets **any agent** connect to and fully operate on **any Synapse mesh**. Provide a URL + port + auth; if none given, it connects to the local mesh running at `nats://localhost:4222`. Works on **macOS, Linux, and Windows** (Python client is fully cross-platform; `cli.sh` runs under Git Bash/WSL and ships a `windows` command that prints native PowerShell equivalents).

Ships:
- `client.py` — drop-in async Python client (`pip install nats-py`)
- `cli.sh` — bash wrappers over the `nats` CLI for agents that can only shell out
- `reference.md` — envelope, subjects, states, error codes, heartbeat format
- `transport.md` — every connection mode (anonymous / NKey / JWT / WebSocket / leaf-node / Synadia Cloud / HTTP bridge) + gotchas
- `config.md` — `nats.conf` template, NKey generation, per-role permissions template

## When to use

- Discover agents by capability and call their skills (`request`/`respond`)
- Broadcast or subscribe to events (`emit`/`subscribe`, with wildcards)
- Send a document (PDF/DOCX/image/CSV) to an agent for analysis (`send_file`)
- Serve requests so other agents can call you (`serve`)
- Need durable, crash-surviving tasks (`request_long` + `TASK_STORE`)
- Operate against a remote mesh (Synadia Cloud, cross-org leaf node) given its URL + creds
- Probe mesh health before issuing requests

## The 6 primitives

| Primitive | Purpose | Subject | Client method |
|-----------|---------|---------|----------------|
| **register** | Announce agent + capabilities | `mesh.registry.register` | `register()` / `deregister()` |
| **discover** | Find agents by capability | `mesh.registry.discover` (+ `.ranked`, `mesh.registry.get.{id}`) | `discover()` |
| **request** | Ask an agent to do work | `mesh.agent.{id}.inbox` | `request()` / `request_long()` |
| **respond** | Return result/error | reply subject | `respond()` / `serve()` |
| **emit** | Broadcast event | `mesh.event.{type}` | `emit()` |
| **subscribe** | Listen with wildcards | `mesh.event.{pattern}` | `subscribe()` |

Plus: `start_heartbeat()`, `send_file()`, `health()`, `get_task()`, `drain()/close()`.

## Default network (local mesh)

These are the defaults baked into the client — matches the local Synapse network:

| Setting | Default | Env override |
|---------|---------|--------------|
| NATS URL | `nats://localhost:4222` | `SYNAPSE_URL` |
| Monitoring | `http://localhost:8222` | `SYNAPSE_HOST`, `SYNAPSE_MON_PORT` |
| WebSocket | `ws://localhost:8443` | — (browser SDK) |
| Auth | NKey seed (`~/.synapse/nkeys/<agent>.seed`) | `nkey_seed_file=` |
| Task persistence KV bucket | `TASK_STORE` | `SYNAPSE_TASK_BUCKET` |
| Inbox JetStream stream | `AGENT_INBOXES` | `SYNAPSE_INBOX_STREAM` |
| Request timeout (sync) | 30 s | `timeout=` |
| Long-task timeout | 600 s | `timeout=` in `request_long` |
| Heartbeat interval | 30 s | `interval=` in `start_heartbeat` |

For any **remote** mesh, pass its URL + port + auth to `connect()`. See `transport.md`.

## Quick start — local default network

```bash
# Ensure the local mesh is up (it is, on this machine):
nats-server -c ~/.config/nats/nats.conf   # already running via launchd

# Install the one dependency:
pip install nats-py
```

### As a caller — discover + request

```python
import asyncio
from client import SynapseClient   # from this skill dir

async def main():
    # Local mesh default; NKey auto-loaded from ~/.synapse/nkeys if present.
    mesh = await SynapseClient.connect()                 # nats://localhost:4222

    agents = await mesh.discover(capabilities=["chat"])
    print("chat agents:", [a["id"] for a in agents])

    r = await mesh.request_long("bob-001", "chat",
                                {"text": "Hello Bob"}, timeout=120)
    print("reply:", r)

    await mesh.close()

asyncio.run(main())
```

### As a server — register + serve

```python
import asyncio
from client import SynapseClient

async def handle(req, ctx):
    # req is the envelope payload; ctx.reply_subject / ctx.task_id / ctx.from_agent
    return {"text": f"Echo: {req.get('text','')}"}

async def main():
    mesh = await SynapseClient.connect(agent_id="echo-001")
    await mesh.register("Echo", capabilities=["chat"],
                        skills=[{"id":"chat","name":"Chat","description":"echo"}])
    await mesh.start_heartbeat()
    await mesh.serve("chat", handle)
    await asyncio.Event().wait()   # run forever

asyncio.run(main())
```

### As an event publisher + subscriber

```python
await mesh.emit("document.created", {"doc_id": "x"})
await mesh.subscribe("mesh.event.document.>", lambda env: print(env["payload"]))
```

### Send a file for analysis

```python
r = await mesh.send_file("grip-cli-001", "report.pdf", action="analyze")
print(r["result"])
```

### From bash (no Python)

```bash
./cli.sh discover '[\"chat\"]'
./cli.sh request bob-001 '{"text":"hi"}'
./cli.sh emit document.created '{"doc":"x"}'
./cli.sh subscribe 'mesh.event.document.>'
./cli.sh file grip-cli-001 report.pdf analyze
./cli.sh health
./cli.sh windows          # print native PowerShell equivalents (no Git Bash needed)
```

> Auth: every primitive accepts `--nkey <seed-path>` / `--creds <jwt-creds>` and `-s nats://host:4222`. `~` paths are expanded (works on Windows `%USERPROFILE%` too).

## Connecting to a remote mesh

Auth precedence: **nkey_seed_file > creds_file > jwt > anonymous**.

```python
# Synadia Cloud (TLS + JWT creds)
mesh = await SynapseClient.connect("tls://connect.ngs.global:4222",
                                   creds_file="~/.nats/synadia.creds")

# Cross-org leaf node with NKey
mesh = await SynapseClient.connect("nats://10.0.0.5:4222",
                                   nkey_seed_file="~/.synapse/nkeys/remote.seed",
                                   agent_id="acme-agent-001")

# Anonymous / open dev mesh
mesh = await SynapseClient.connect("nats://dev.example:4222")

# WebSocket (browser agents)
mesh = await SynapseClient.connect("ws://host:8443")
```

```bash
./cli.sh -s tls://connect.ngs.global:4222 --creds ~/.nats/synadia.creds discover '[]'
./cli.sh -s nats://10.0.0.5:4222 --nkey ~/.synapse/nkeys/remote.seed discover '[]'
```

See `transport.md` for the full matrix (when to use each, TLS gotchas, leaf-node firewall rules, WebSocket notes) and `config.md` for NKey generation + a `nats.conf` permissions template.

## request vs request_long — pick the right one

| Task length | Use | Why |
|-------------|-----|-----|
| < ~30 s, simple | `request()` | Synchronous request/reply, one round trip |
| 30 s – 10 min (LLM, API, multi-step) | `request_long()` | Fire-and-forget publish + poll `TASK_STORE` KV. Durable — survives mesh reconnect and agent restart. |
| > 10 min or streaming | `request_long()` + raise `timeout=`, or streaming primitives (see reference) | Avoids NATS `ack_wait` redelivery storms |

`request_long` publishes the request envelope to `mesh.agent.{id}.inbox` then polls the `TASK_STORE` KV bucket for the task's terminal state (`completed`/`failed`/`canceled`). The target agent's bridge must write task updates to that KV bucket (the local grip-cli bridge does).

## Error handling

Reply envelopes carry an `error` object on failure. Standard codes (full table in `reference.md`):

| Code | Name | Retryable |
|------|------|-----------|
| 1001 | TRANSPORT_TIMEOUT | yes |
| 2001 | INVALID_ENVELOPE | no |
| 3001 | SKILL_NOT_FOUND | no |
| 3002 | AGENT_UNAVAILABLE | yes |
| 3004 | IDENTITY_MISMATCH | no |
| 4001 | OVERLOADED | yes |
| 4003 | GOVERNANCE_DENIED | no |
| 5001 | INTERNAL_ERROR | yes |

```python
r = await mesh.request_long(...)
if r.get("error") and r["error"].get("retryable"):
    # backoff + retry
    ...
```

## Heartbeats

Call `start_heartbeat()` after `register()` so the registry sees the agent as `online`. Heartbeats publish a Synapse envelope to `mesh.heartbeat.{agent_id}` with `type: "heartbeat"` and a `payload` of `{agent_id, timestamp}`. 30 s is the standard interval across all SDKs.

## File transfer protocol

`send_file()` implements the chunked file-transfer protocol over the target agent's inbox:
1. **init** — metadata (filename, action, total_bytes, total_chunks, sha256)
2. **chunks** — base64-encoded chunks (~96 KB each)
3. **done** — requests processing; target dispatches the reassembled file to its skill inbox
4. `request_long` polls `TASK_STORE` for the analysis result

Use `action="analyze"` (default), `"extract"`, or any skill the target advertises.

## Production notes

- **ack_wait**: the `serve()` consumer uses `ack_wait=360s, max_deliver=5` so long handlers aren't redelivered prematurely. If you lower it, expect duplicate processing.
- **Idempotency**: redeliveries happen. Make handlers idempotent on `task_id` (check `TASK_STORE` state before starting work; the local grip-cli bridge shows the pattern).
- **One process per agent**: don't run two bridges for the same `agent_id` — duplicate processing. One durable consumer per inbox.
- **Durable tasks**: anything user-facing or >30 s must go through `TASK_STORE` so it survives crashes.
- **Tracing**: envelopes propagate `trace.trace_id`; preserve it end-to-end for OpenTelemetry.

Full gotchas + deployment patterns in `config.md` and the production checklist below.

## Production checklist

- [ ] NATS has JetStream enabled (`store_dir` on a persistent path, not `/tmp`)
- [ ] Each agent has unique NKey/JWT credentials (no shared auth)
- [ ] `serve()` consumer has `ack_wait` > longest handler runtime
- [ ] Handlers are idempotent on `task_id`
- [ ] Heartbeats running (30 s)
- [ ] Tracing propagated via `trace.trace_id` (W3C-compatible)
- [ ] Monitoring endpoint reachable (`health()` returns `healthz.ok`)
- [ ] Leaf-node / cross-org connections are TLS-encrypted
- [ ] Credential rotation plan (JWT expiry, NKey rotation)
- [ ] One bridge process per `agent_id` (no duplicate consumers)

## Troubleshooting

**`discover()` returns empty**
- Verify agents registered: `./cli.sh subscribe mesh.registry.register` in one shell, restart an agent in another, watch.
- Confirm you connected to the right server: `health()` shows the server id.

**`request()` times out (1001)**
- Target agent offline → `discover()` won't list it.
- Task too long → switch to `request_long()` with a larger `timeout=`.
- Target inbox has no subscriber: `curl http://localhost:8222/subsz?subs=1 | grep mesh.agent`.

**Duplicate deliveries / redelivery storms**
- `ack_wait` shorter than handler runtime → raise it (`serve()` defaults to 360 s).
- Two bridges for the same `agent_id` → kill one.
- Make handler idempotent on `task_id`.

**`permissions violation for subscription`**
- The NKey/JWT lacks the subject in its subscribe allow-list. Edit `nats.conf` permissions (see `config.md`) and `kill -HUP <nats-pid>` to reload.

**KV bucket errors / `TASK_STORE` not found**
- JetStream not enabled, or wrong account. `curl http://localhost:8222/jsz` — `api.errors` should be 0.
- Multi-tenant: ensure a LOCAL account with `jetstream: enabled` separate from REMOTE/system accounts.

**Cross-firewall connection fails**
- Leaf nodes connect OUTBOUND only; allow the NATS port (4222 default).
- Use TLS for cross-org (`tls://`).

See `transport.md` and `reference.md` for the full details.

## File index

| File | Contents |
|------|----------|
| `client.py` | Async Python client — all 6 primitives + file transfer + heartbeats + health |
| `cli.sh` | Bash wrappers over the `nats` CLI (same primitives); `windows` subcommand prints PowerShell equivalents |
| `reference.md` | Envelope fields, subject namespace, state machine, error codes, heartbeat format |
| `transport.md` | All connection modes (anonymous/NKey/JWT/WebSocket/leaf-node/Synadia/HTTP bridge) + gotchas |
| `config.md` | `nats.conf` template, NKey generation, per-role permissions template |

## Envelope quick reference

```json
{
  "v": "1.0.0",
  "id": "uuid",
  "type": "request|respond|emit|register|discover|heartbeat",
  "ts": "2026-01-15T12:34:56.789Z",
  "from": "agent-id",
  "to": "target-agent-id",
  "task_id": "uuid",
  "trace": {"trace_id":"uuid","span_id":"uuid"},
  "payload": { ... },
  "error": {"code":5001,"message":"...","retryable":true}
}
```

All subjects follow `mesh.<domain>.<...>`; wildcards `*` (single token) and `>` (one+ tokens, must be last). Full map in `reference.md`.
