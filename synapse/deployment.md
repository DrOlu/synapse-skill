# Production Deployment Patterns

Hard-won patterns, gotchas, and operational knowledge from running Synapse in production. This document covers topics not already in the core reference docs — the things you learn by actually deploying and operating a mesh.

## When to Use This Document

Read this when:
- You're setting up NATS with a **leaf node to a multi-tenant cloud** (Synadia, etc.) and JetStream stops working
- You want to deploy a Synapse mesh as a **persistent system service** that survives reboots
- You need to integrate `TaskStore` into an **existing agent bridge** without rewriting the agent
- You're building a **control-plane CLI** to manage the mesh from the shell
- Something weird is happening and you want to check the "known gotchas" list

For the protocol reference, see [setup.md](./setup.md), [registry.md](./registry.md), [tasks.md](./tasks.md). For SDK code, see [python.md](./python.md), [typescript.md](./typescript.md), [go.md](./go.md).

---

## 1. NATS Multi-Tenant Isolation (The #1 Gotcha)

### The Problem

You have NATS running locally with a leaf node to a cloud provider (Synadia, your own hub, another org's server). Everything works: pub/sub, inbox requests, heartbeats. But as soon as any client tries to use JetStream (KV, streams, consumers), you get errors like:

```
nats: no responders
nats: code=503 no responders
{"status":"unavailable","error":"JetStream stream '$G > KV_FOO' could not be recovered"}
```

And your monitoring endpoint shows:
```
curl http://localhost:8222/jsz
→ {"api":{"total":36,"errors":36}}
```

Every JetStream API call fails. KV buckets can't be created. Streams can't be read.

### Why It Happens

The default NATS config puts everything in account `$G`. When you add a leaf node to cloud NATS:
- The leaf connection subscribes to `$SYS.REQ.*.JSZ`, `$JS.API.>`, and other system subjects
- Those subscriptions are **shared with the cloud** through the leaf
- When your local client publishes to `$JS.API.STREAM.CREATE`, the cloud **intercepts it** and tries to handle it with its own JetStream (which has different permissions, or is disabled)
- The cloud responds with a rejection or nothing

Your local JetStream is healthy, but local clients' `$JS.API.*` requests are being eaten by the cloud.

### The Fix: Three-Account Isolation

You need **three accounts**, each with a distinct purpose:

| Account | Purpose | JetStream? |
|---------|---------|-----------|
| `SYS` | NATS internals (health, `$SYS.REQ.*`) | **No** (NATS forbids it) |
| `LOCAL` | All local clients, all local JetStream | Yes |
| `REMOTE` | Outbound leaf node to cloud | No (cloud handles its own JS) |

```conf
port: 4222
http_port: 8222

# Persistent store — NOT /tmp, which wipes on reboot
jetstream {
  store_dir: "~/.nats/jetstream"   # platform-appropriate persistent path
  max_mem: 512M
  max_file: 2G
}

# Unauthenticated local clients → LOCAL account
no_auth_user: local

accounts {
  SYS: {
    users: [{ user: sys, password: "" }]
  }
  LOCAL: {
    jetstream: enabled
    users: [{ user: local, password: "" }]
  }
  REMOTE: {}
}

system_account: SYS

leafnodes {
  remotes [{
    url: "tls://connect.ngs.global:7422"
    creds: "/path/to/cloud.creds"
    account: REMOTE     # ← critical: isolates leaf from LOCAL
  }]
}
```

### Why Each Part Is Necessary

- **`system_account: SYS`** — NATS forbids JetStream on the system account (hard error: `Not allowed to enable JetStream on the system account`). So you need a dedicated SYS with no JS.
- **`system_account` can't be `$G`** — NATS config parser rejects `$G` as a literal (not a defined account). Use a named account.
- **`no_auth_user: local`** — without this, every existing unauthenticated client fails to connect once you define explicit users. This lets local CLI tools and agents keep working.
- **`account: REMOTE`** on the leaf — this is the critical isolation line. The leaf's subscription graph is now in REMOTE, which doesn't intersect with LOCAL's `$JS.API.*`.

### Iteration History (What Doesn't Work)

It took multiple attempts to get here. Common failed configurations:

| Attempt | What broke |
|--------|-----------|
| `system_account: $G` | Parser error: `variable reference for '$G' not found` |
| Single account with `jetstream: enabled` + system_account | `Not allowed to enable JetStream on the system account` |
| Two accounts (LOCAL/SYS) + leaf in LOCAL | Cloud still intercepts JetStream calls |
| `/tmp/nats/jetstream` store_dir | Data silently wipes on reboot |

### Verification

After restarting with the 3-account config:
```bash
curl -s http://localhost:8222/jsz | jq '.api'
# {"level":4,"total":35,"errors":0}    ← 0 errors

curl -s http://localhost:8222/leafz | jq '.leafs[0]'
# {"ip":"...", "port":7422, "tls_cipher":"..."}    ← leaf still connected

nats kv add TEST_BUCKET -s localhost:4222
# Information for Key-Value Store Bucket TEST_BUCKET ...    ← works locally
```

---

## 2. Boot Persistence — Platform Services

Production services must survive terminal close, session logout, and machine reboot. Here's how on each platform.

### macOS — launchd

Create plists in `~/Library/LaunchAgents/`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.synapse.nats-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/nats-server</string>
    <string>-c</string>
    <string>/path/to/nats.conf</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/path/to/nats/server.log</string>
  <key>StandardErrorPath</key>
  <string>/path/to/nats/server.err</string>
</dict>
</plist>
```

Per-agent plists follow the same structure. Critical settings:
- **`RunAtLoad: true`** — start on boot
- **`KeepAlive: true`** — auto-restart on crash
- **`ThrottleInterval: 5`** — cap restart rate at 5s to prevent tight loops

Load/unload:
```bash
launchctl load ~/Library/LaunchAgents/com.example.synapse.nats-server.plist
launchctl unload ~/Library/LaunchAgents/com.example.synapse.nats-server.plist
launchctl list | grep com.example
```

### Linux — systemd

See existing Docker/systemd examples in [setup.md](./setup.md). The key additions beyond that are:
- `After=nats-server.service` so agents wait for NATS
- Restart=on-failure with RestartSec=5

### Boot Order Resilience

launchd/systemd don't guarantee order, but Synapse agents handle this gracefully:
- NATS starts independently
- Python agents use nats-py's default exponential backoff
- After NATS is up (~1-2s), agents reconnect and re-register
- The `re-register` subject (`mesh.registry.reregister`) triggers manifests to refresh

No explicit boot-order dependency is needed.

---

## 3. Bridge-Level TaskStore Integration (Without Rewriting the Agent)

When you have existing agent bridges (e.g., a REST API bridge, a CLI bridge) that already do request→reply, and you want to add task persistence **without rewriting the core logic**, the integration is surprisingly simple.

### The Pattern

Wrap the existing `_handle_inbox` method (or equivalent) with three additions:

```python
# PSEUDO-CODE showing the integration pattern

async def _handle_inbox(self, msg):
    envelope = parse_envelope(msg)
    text = extract_text(envelope)
    task_id = envelope.get("task_id") or generate_id()

    # ─── ADDITION 1: Create task + transition to working ───
    if self.task_store:
        try:
            await self.task_store.create_task(
                from_agent=envelope.get("from", "unknown"),
                to_agent=self.agent_id,
                skill=self.classify_skill(text),
                payload={"text": text[:500], "model": envelope.get("model")},
                task_id=task_id,
            )
            await self.task_store.set_working(task_id, self.agent_id)
        except Exception as e:
            print(f"[WARN] TaskStore: {e}")
            self.task_store = None  # disable for this request

    # --- Original logic unchanged ---
    try:
        result = await self.call_backend(text)
    except Exception as e:
        # ─── ADDITION 2a: Persist failure ---
        if self.task_store and task_id:
            await self.task_store.fail(task_id, self.agent_id, code=5000, message=str(e), retryable=True)
        raise

    # ─── ADDITION 2b: Persist completion (BEFORE reply) ───
    if self.task_store and task_id:
        try:
            await self.task_store.complete(
                task_id, self.agent_id,
                result={
                    "text": result["response"],        # FULL, no truncation
                    "iterations": result.get("iterations"),
                    "latency_ms": int((time.time() - start) * 1000),
                },
            )
        except Exception as e:
            print(f"[WARN] TaskStore complete: {e}")

    # ─── Original reply (AFTER persist) ───
    if msg.reply:
        await self.nc.publish(msg.reply, build_response(result).encode())
```

### Two Critical Ordering Rules

**Rule 1: Persist BEFORE reply.** If the reply goes out but the persist fails (NATS hiccup mid-transition), the client gets a result but the task store is out of sync. Better to have it backwards: persist first (guaranteed), reply second (optional).

**Rule 2: Persist OUTSIDE the `if msg.reply:` block.** Fire-and-forget clients (using `nats pub` with no reply subject) have no `msg.reply`, but their task should still be recorded. Otherwise the mesh loses audit history for every pub/sub request.

### What "Full Text" Means

Do not truncate the task store payload with arbitrary limits like `[:500]` or `[:200]`. NATS KV handles values up to 8MB by default (`max_msg_size`). The task store is the **definitive source** — truncating it at store time is worse than storing nothing, because it creates false confidence that the result is preserved.

If you need size limits for display purposes, enforce them at **query time** in the client, not at store time in the agent.

### Graceful Degradation

If `TaskStore.connect()` fails at bridge startup:
```python
try:
    self.task_store = await TaskStore.connect(nats_url)
except Exception as e:
    print(f"[WARN] TaskStore unavailable: {e}")
    self.task_store = None
```

If TaskStore operations fail during a request, the bridge continues — NATS reply is sent, but the task remains in `working` state. After 120 seconds, the orphan detector in `task-service.py` will mark it as `failed` with error code 3002 (AGENT_UNAVAILABLE, retryable). This is strictly better than losing the task.

---

## 4. Control-Plane CLI Pattern

Running a Synapse mesh requires frequent inspection. A thin wrapper CLI dramatically improves day-to-day ops. Typical command surface:

```bash
mesh status                      # health + agent list + stats
mesh start                       # load all services
mesh stop                        # unload all
mesh restart                     # stop + start
mesh logs [service]              # tail logs
mesh request <agent|skill> "…"   # fire-and-forget + poll
mesh task-get <task_id>          # re-query a task
```

### The Fire-and-Forget Request Command

The `request` command is the most operationally important. It uses **no blocking NATS request**:

```bash
# Bash pseudocode for the request command

TASK_ID="mesh-$(date +%s)-$(openssl rand -hex 4)"
AGENT_ID="$1"                # direct ID, or resolve by skill name via discovery
PROMPT="$2"

# 1. Fire-and-forget (returns in <1ms, no blocking)
nats pub "mesh.agent.${AGENT_ID}.inbox" \
  "{\"v\":\"1.0\",\"type\":\"request\",\"from\":\"cli\",\"payload\":{\"text\":\"${PROMPT}\",\"task_id\":\"${TASK_ID}\"}}" \
  -s localhost:4222

# 2. Poll the task store (non-blocking, no timeout risk)
PREV=""
while true; do
  RESP=$(nats request mesh.task.get "{\"task_id\":\"${TASK_ID}\"}" -s localhost:4222 --timeout 3s 2>/dev/null)
  STATE=$(echo "$RESP" | jq -r '.payload.task.state // "waiting"')
  if [ "$STATE" != "$PREV" ]; then
    printf "[%s] state: %s\n" "$(date +%H:%M:%S)" "$STATE"
    PREV="$STATE"
  fi
  case "$STATE" in completed|failed|canceled) break ;; esac
  sleep 5
done

# 3. Print full result (no truncation)
echo "$RESP" | jq -r '.payload.task.result.text'
```

### Why This Matters for Long-Running Tasks

A BMC query that takes 266 seconds would need `--timeout 300s` on `nats request`, blocking the terminal for nearly 5 minutes. If it unexpectedly took 310s, the timeout would fire and the client would fail — even though the agent successfully completed.

With fire-and-forget, the client returns immediately and polls asynchronously. If the client dies mid-poll, the task is still in the KV store and can be retrieved later by the task ID.

### Skill-Based Discovery

The CLI can resolve agent IDs from skill names:

```bash
mesh request wema-bmc "list open incidents"
# internally: discover skill_ids=["wema-bmc"] → pick first agent → dispatch
```

Implementation:
```bash
AGENT_ID=$(nats request mesh.registry.discover \
  "{\"payload\":{\"skill_ids\":[\"${SKILL}\"]}}" \
  -s localhost:4222 | jq -r '.payload.agents[0].id')
```

---

## 5. The Known-Gotchas Checklist

These are problems that are easy to miss, easy to debug if you know them, and hard to diagnose otherwise.

### NATS / JetStream

- [ ] JetStream API returns 100% errors with a leaf node → check account isolation (Section 1)
- [ ] `Not allowed to enable JetStream on the system account` → use separate SYS account
- [ ] Parser error `variable reference for '$G'` → `$G` can't be a literal in the config language
- [ ] JetStream store at `/tmp/nats/...` → data silently deletes on reboot
- [ ] `nats kv add` works but `nats request` to JS API fails → likely same account-isolation issue
- [ ] KV bucket "could not be recovered" after restart → store_dir moved/wiped, or bucket created under wrong account

### Agents

- [ ] Agent registered but `mesh.registry.discover` returns empty → registry TTL expired, trigger `mesh.registry.reregister`
- [ ] Agent replies to inbox but result is truncated in task store → 500-char limit bug; remove the `[:N]` slice from `complete()` call
- [ ] Fire-and-forget request (`nats pub`) doesn't show up in task queries → TaskStore operations are inside `if msg.reply:` block; move them outside
- [ ] Task stuck in `working` forever → orphan detector didn't run, or heartbeat interval > mark-as-orphan threshold
- [ ] Agent crashes and task goes to `failed` with code 3002 → this is correct behavior (orphan detection)
- [ ] Agent processes one request at a time despite backend being parallel → `await backend.call()` blocks event loop; use `asyncio.create_task()` dispatch (Section 8)
- [ ] Multiple requests overwhelm backend → add `asyncio.Semaphore(N)` gate around backend calls (Section 8)
- [ ] Messages lost during agent restart → plain `nc.subscribe()` is ephemeral; use JetStream durable push consumer on `AGENT_INBOXES` stream (Section 9)
- [ ] `nc.publish()` silently discards messages → called without `await`; always `await nc.publish(...)`

### Tasks

- [ ] `submitted → completed` rejected by TaskStore → invalid transition; must go through `working` first
- [ ] Can't transition terminal task → correct; create a new task and link via `context_id`
- [ ] `mesh.task.purge` leaves audit log intact → this is by design; TASK_STATE_LOG stream has its own 7-day retention
- [ ] `history=1` on KV → only current state preserved; use `history=16` for debugging

### Boot / Service Management

- [ ] Service doesn't start after reboot → plist not loaded, or `RunAtLoad: true` missing
- [ ] Tight restart loop after crash → `ThrottleInterval` missing
- [ ] Agents fail to connect on boot → NATS not ready yet; agents retry with exponential backoff, no explicit ordering needed
- [ ] Service log empty → `StandardOutPath` / `StandardErrorPath` missing or path doesn't exist

### Web / Browser

- [ ] Browser WebSocket connects but gets `ERR 'Authentication Timeout'` → `no_auth_user` must be inside the `websocket {}` block, not at top level
- [ ] Browser fails to parse large responses → response spans multiple WebSocket frames; buffer across frames before slicing (Section 10)
- [ ] NATS WS sends unreadable binary → set `ws.binaryType = 'arraybuffer'` and decode with `new TextDecoder()`
- [ ] Gateway `/request` dispatches but returns empty → `await` missing on `nc.publish()` — message silently discarded

---

## 6. Real-World Task Examples

These are actual tasks dispatched through a production Synapse mesh, all using the `secrets` skill to retrieve encrypted credentials:

### BMC Helix Incident Query

```
Prompt:  "List last 5 open BMC incidents (not Closed/Cancelled)"
Agent:   discovered via skill_ids: ["wema-bmc"]
Result:  10-row markdown table with Incident Number, Status, Priority,
         Assigned Group, Submit Date
Latency: 266 seconds (account rate-limited mid-query by BMC security)
Stored:  1,719 chars in KV, 7 audit events in TASK_STATE_LOG
```

### Paystack Transaction Lookup

```
Prompt:  "List last 2 Paystack Live transactions"
Agent:   discovered via skill_ids: ["secrets"]
Result:  2 successful bank transfers (₦160K + ₦320K) with IDs and dates
Latency: 73 seconds
Stored:  1,719 chars full result in KV
```

### MySQL Database Enumeration

```
Prompt:  "SHOW DATABASES and return full list"
Agent:   discovered via skill_ids: ["secrets"]
Result:  22 databases including production schemas
Latency: 169 seconds (one timeout mid-query, retried successfully)
Stored:  1,168 chars full result
```

### Fire-and-Forget Pattern Verification

```
Prompt:  "List planets with moons and distance from sun"
Agent:   grip-cli-001 (direct, no discovery)
Result:  8-planet markdown table
Latency: 11 seconds
Dispatch: nats pub (0ms) + poll loop (11s total)
```

These validate that the persistence layer handles **real-world latencies** (up to 3+ minutes), **full-size results**, and **retry scenarios** correctly.

---

## 7. Operational Monitoring

### JetStream Metrics

```bash
curl -s http://localhost:8222/jsz | jq '{
  streams: .streams,
  messages: .messages,
  bytes: (.bytes / 1024 | floor),
  api_errors: .api.errors,
  api_total: .api.total,
  store: .config.store_dir
}'
```

Watch `api_errors` — it should stay at 0. Any spike means JetStream is being intercepted again (likely account isolation regression).

### Leaf Node Health

```bash
curl -s http://localhost:8222/leafz | jq '.leafs[0] | {name, rtt, tls_cipher}'
```

RTT > 500ms may indicate network instability. TLS should be `TLS_*` with a strong cipher suite.

### KV Bucket Health

```bash
for bucket in MESH_REGISTRY TASK_STORE; do
  echo "=== $bucket ==="
  nats kv info "$bucket" -s localhost:4222 2>&1 | grep -E "Stored|Maximum Age|History"
done
```

### Stream Audit

```bash
nats stream info TASK_STATE_LOG -s localhost:4222 | grep -E "Messages|Bytes|Maximum Age"
# Messages should grow monotonically; only decreases at 7-day retention boundary
```

---

## 8. Concurrent Agents — Making Bridges Non-Blocking

### The Problem

The default pattern for a Synapse bridge is:

```python
async def _handle_inbox(self, msg):
    result = await self.llm_client.chat(text)   # takes 10–270 seconds
    await nc.publish(msg.reply, result)
```

This `await` inside the NATS callback **blocks the entire asyncio event loop** for the duration of every request. All other inbox messages queue behind it. The agent processes one task at a time — even if the underlying LLM API is fully parallel.

**Before fixing, always verify the backend is actually parallel:**

```python
# Fire N requests concurrently against the backend
results = await asyncio.gather(*[
    client.chat(f"question {i}") for i in range(5)
])
# If all return in ~same time as 1 request: backend is parallel
# If total time = N × single time: backend is serial
```

If the backend is parallel, the fix is two lines.

### The Fix: Task Dispatch + Semaphore

```python
DEFAULT_MAX_CONCURRENT = 5

class AgentBridge:
    def __init__(self):
        self._semaphore = asyncio.Semaphore(DEFAULT_MAX_CONCURRENT)
        self._active_tasks = 0

    async def _handle_inbox(self, msg) -> None:
        # Returns immediately — event loop stays free for next message
        asyncio.create_task(self._process_request(msg))

    async def _process_request(self, msg) -> None:
        self._active_tasks += 1
        try:
            # Semaphore gates actual backend calls — requests queue if at limit
            async with self._semaphore:
                result = await self.backend.chat(text)
        except Exception as e:
            self._active_tasks = max(0, self._active_tasks - 1)
            # handle error, ack, return
            return

        # persist, reply ...
        self._active_tasks = max(0, self._active_tasks - 1)
        await msg.ack()     # JetStream ack — see section below
```

**Key rules:**
- The semaphore MUST be acquired inside `_process_request`, not in `_handle_inbox`. Acquiring it in the callback defeats the non-blocking dispatch.
- Always decrement `_active_tasks` in EVERY exit path (success, error, timeout). Missing one creates a counter leak.
- The semaphore releases automatically when the `async with` block exits, even on exception.

### Configurable Concurrency

Expose `--max-concurrent` as a CLI argument so it can be tuned per deployment without code changes:

```bash
python3 bridge.py --max-concurrent 10    # high-throughput
python3 bridge.py --max-concurrent 1     # serial mode for debugging
```

### Observed Performance

Using grip CLI bridge (Python subprocess per request):

| Requests | Before (serial) | After (concurrent, cap=5) | Speedup |
|----------|----------------|---------------------------|---------|
| 1 | ~15s | ~15s | 1× |
| 5 | ~84s | ~21s | **4.0×** |
| 10 | ~168s | ~42s | ~4× |

The speedup approaches the concurrency cap. Beyond the cap, additional requests queue without overwhelming the backend.

---

## 9. Durable Inbox — Surviving Agent Restarts

### Why Plain Subscribe Loses Messages

`nc.subscribe("mesh.agent.x.inbox", cb=handler)` is ephemeral. When the agent disconnects (restart, NATS reload, launchd bounce), the subscription disappears. Any message published during that window is silently dropped — no error, no retry, no log entry on either side.

This matters because launchd restarts agents automatically after crashes. The restart window is typically 3–10 seconds. Any request that arrives during that window is gone.

### The Fix: JetStream Work-Queue Stream

Create a stream that covers all agent inbox subjects. Messages published while agents are offline are buffered in memory and delivered when the consumer reconnects.

**Create the stream (one-time setup):**

```bash
nats stream add AGENT_INBOXES \
  --subjects="mesh.agent.*.inbox" \
  --storage=memory \
  --retention=workqueue \
  --max-age=5m \
  --max-msgs-per-subject=100
```

- `workqueue`: each message delivered once, removed after ack
- `memory`: fast; use `file` if you need inbox messages to survive NATS server restarts
- `max-age=5m`: discard undelivered messages after 5 minutes (prevents unbounded backlog)
- `max-msgs-per-subject=100`: per-agent queue depth cap (backpressure if agent falls far behind)

**Subscribe via durable push consumer instead of plain subscribe:**

```python
async def _setup_subscriptions(self):
    js = self.nc.jetstream()
    try:
        await js.subscribe(
            f"mesh.agent.{self.agent_id}.inbox",
            durable=self.agent_id,      # consumer persists across reconnects
            stream="AGENT_INBOXES",
            manual_ack=True,            # we control when message is removed
            cb=self._handle_inbox,
        )
    except Exception as e:
        # Fallback if JetStream unavailable
        await self.nc.subscribe(f"mesh.agent.{self.agent_id}.inbox", cb=self._handle_inbox)

# After processing each message:
try:
    await msg.ack()     # removes from work-queue stream
except Exception:
    pass                # plain NATS msgs have no ack method — ignore
```

**Why `durable=self.agent_id`:** the durable name ties the consumer to a stable identity. When the agent reconnects, it resumes the same consumer and picks up any buffered messages. Without `durable`, each reconnect creates a new consumer and starts fresh, losing buffered messages.

### Verification

```bash
# 1. Stop the agent
launchctl unload ~/Library/LaunchAgents/com.example.synapse.agent.plist

# 2. Publish messages while agent is down
nats pub mesh.agent.my-agent.inbox '{"payload":{"text":"hello"}}' -s localhost:4222
nats pub mesh.agent.my-agent.inbox '{"payload":{"text":"world"}}' -s localhost:4222

# 3. Confirm messages are held in stream
nats stream info AGENT_INBOXES -s localhost:4222
# → Messages: 2

# 4. Restart agent
launchctl load ~/Library/LaunchAgents/com.example.synapse.agent.plist

# 5. Verify delivery — both messages should now be processed
```

### The Catch

Work-queue semantics give **at-least-once** delivery, not at-most-once. If the agent crashes after starting to process a message but before acking it, the message will be redelivered after the ack timeout. Your handler must be **idempotent** — or you must deduplicate using the task_id from the envelope.

---

## 10. Web Agent Integration

For agents that cannot hold a raw NATS TCP connection (browsers, serverless functions, cloud-hosted AI), Synapse exposes itself via two additional transports.

### NATS WebSocket (port 8443)

Add to `nats.conf`:

```conf
websocket {
  port: 8443
  no_tls: true        # dev only; add cert/key for production
  no_auth_user: local # must be INSIDE websocket block, not at top level
}
```

**Critical detail:** `no_auth_user` at the top level of the config does not apply to WebSocket connections. It must be set inside the `websocket {}` block. Without it, browsers receive `ERR 'Authentication Timeout'` after the WebSocket upgrade.

For browser SDK use, avoid the `nats.ws` npm package CDN — the file paths change between versions and the package is deprecated. Instead, write a ~150-line native WebSocket shim that speaks the NATS wire protocol directly:

```
INFO (receive) → CONNECT (send) → PING/PONG → PUB/SUB/MSG
```

Two browser-specific gotchas:
1. NATS sends **binary WebSocket frames** — set `ws.binaryType = 'arraybuffer'` and decode with `new TextDecoder()`
2. Large responses (agent manifests, task results) arrive across **multiple WebSocket frames** — buffer with `_buf += text` and wait until `_buf.length >= payload_size + 2` before slicing

### HTTP REST Gateway

Flask gateway that translates HTTP ↔ NATS. Install as a launchd service behind your reverse proxy.

Endpoints:

```
GET  /health             → NATS + agent health
POST /discover           → {"skill": "wema-bmc"}  → agent list
POST /request            → {"skill": "...", "text": "..."}  → full task result
GET  /task/<task_id>     → task state + result
POST /cancel             → {"task_id": "..."}  → cancel
GET  /stats              → per-state task counts
```

The `/request` endpoint blocks until the task completes (fire-and-forget to agent inbox + polling `mesh.task.get`). Returns the full task object including `result.text` (no truncation).

**Critical bug to avoid:** `nc.publish()` in nats-py is an **async coroutine**. Calling it without `await` creates a coroutine that is immediately garbage-collected and never executed. The message is silently discarded. Always `await nc.publish(...)`.

For a public gateway (used by Copilot plugins, Claude API tools, or CI pipelines), expose it behind Cloudflare Tunnel or a VPS reverse proxy with TLS. The gateway itself does not change — only the DNS and certificate layer.

---

## 11. Suggested Extensions

These weren't built but are natural next steps:

- **Task retry logic** — JetStream consumer on `TASK_RETRY_QUEUE` that picks up `failed` tasks marked `retryable: true` and re-dispatches
- **Streaming responses** — for LLM token streams; see TypeScript `streamRequest()` / Python equivalent
- **Assignment routing** — when multiple agents support a skill, pick by reputation (see [reputation.md](./reputation.md))
- **Cross-org coordination** — use leaf nodes between orgs; emit `mesh.event.shared.*` for inter-org events
- **Grafana dashboard** — NATS Prometheus exporter + panels for tasks/sec, agent heartbeats, KV size, JS API errors
- **Event streaming** — `mesh.event.*` subjects for domain events (order-placed, incident-created) that multiple agents can react to

---

## Related Docs

- [setup.md](./setup.md) — NATS installation, Docker, multi-tenant accounts, basics
- [registry.md](./registry.md) — JetStream KV registry design and SDK usage
- [tasks.md](./tasks.md) — `TaskStore` implementation across TypeScript/Python/Go
- [states.md](./states.md) — Task state machine and transition rules
- [observability.md](./observability.md) — OTel tracing and metrics
- [setup.md#troubleshooting](./setup.md#troubleshooting) — Additional troubleshooting

