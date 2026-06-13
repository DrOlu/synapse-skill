# Failure Modes & Disaster Recovery

Operational guide for handling NATS partitions, JetStream failures, agent crashes mid-task/stream, cascading failures, and registry unavailability.

---

## Failure Mode Matrix

| Failure | Impact | Detection | Recovery |
|---------|--------|-----------|----------|
| NATS server crash | All agents disconnect | Heartbeat timeout (30s) | Auto-reconnect, restart server |
| NATS partition (split-brain) | Agents lose peers | Subscription drops, failed requests | Heal network, reconcile state |
| JetStream disk full | Persistent delivery stops | Monitoring alert, publish errors | Expand storage, purge old streams |
| Agent crash mid-task | Task stuck at `working` | Heartbeat timeout + task TTL | Task store flags stale tasks, retry |
| Agent crash mid-stream | Partial response delivered | Stream subject goes quiet | Caller detects timeout, retries |
| Network timeout (cascading) | All requests fail | Error rate spikes (4001/4002) | Circuit breakers engage, back off |
| Registry unavailable | Discovery returns empty | Empty discover responses | Fall back to cached manifests |
| Leaf node drop (cross-org) | Cross-org communication halts | Leaf node status change | Auto-reconnect when network recovers |
| Message corruption | Envelope parse failure | `INVALID_ENVELOPE` (2001) | Re-request, log for investigation |
| JetStream consumer lag | Messages pile up, slow processing | Consumer lag metric > 0 | Scale workers, increase max-deliver |

---

## 1. NATS Server Failures

### Server Crash

**What happens:** All TCP connections drop. Agents receive `disconnect` events. If `reconnect: true` (default), agents attempt reconnection every 2 seconds indefinitely.

**Detection:**
```bash
# Check if NATS is reachable
nats rtt -s nats://localhost:4222
# If unreachable: server is down

# Check OS-level
systemctl status nats  # Linux
lsof -i :4222          # any OS
```

**Recovery:**
```bash
# Restart NATS with JetStream data intact
systemctl restart nats
# Agents auto-reconnect within 2s

# Verify reconnection
nats server report conns -s nats://localhost:4222
# Should show all expected agent connections
```

### Network Partition (Split-Brain)

**What happens:** NATS cluster nodes lose connectivity between them. Agents connected to one side can't reach agents on the other. Leaf node connections may drop.

```
┌─────────────────────────────────────────────────┐
│  [NATS-1] ←── X ──→ [NATS-2] ←── X ──→ [NATS-3] │
│     │                    │                    │   │
│  Agents A-C         Agents D-F           Agents G-I│
│  (can't reach D-I)  (can't reach A-C,G-I)         │
└─────────────────────────────────────────────────┘
```

**Symptoms:**
- `nats request` to agents on the other partition times out
- Discovery returns partial results (only agents on your side)
- Agents on the "wrong" side appear offline

**Detection:**
```bash
# Check cluster routes
nats server report cluster -s nats://localhost:4222
# Missing routes indicate partition

# Check subscription propagation
curl http://localhost:8222/routez | jq '.routes[].num_subscriptions'
# Mismatched counts = subscriptions haven't propagated
```

**Recovery:**
1. Identify which side the majority of agents are on
2. Fix the underlying network issue
3. NATS auto-routes when connectivity returns
4. Verify with:
```bash
nats server report cluster
# All routes should reappear

# Verify cross-partition communication
nats request mesh.registry.discover '{}' -s nats://localhost:4222
# Should now see agents from both sides
```

### Prevention

```yaml
# Docker Compose: 3-node cluster for HA
nats-1, nats-2, nats-3:
  # Each node holds a copy of subscriptions
  # Partition tolerance: majority (2/3) must be reachable
```

---

## 2. JetStream Failures

### Disk Full

**What happens:** JetStream stops accepting new messages. Publishes to JetStream subjects return `no space left` errors. Existing stored data remains accessible.

**Detection:**
```bash
# Check JetStream storage from CLI
nats stream list
# Look for: "Storage: file — 9.8 GB / 10 GB"

# HTTP monitoring
curl http://localhost:8222/jsz | jq '.storage.total_bytes, .storage.reserved_bytes'

# Prometheus alert
# nats_jetstream_storage_reserved_bytes / nats_jetstream_storage_total_bytes > 0.90
```

**Recovery:**
```bash
# 1. Expand storage (preferred long-term fix)
# In nats.conf: max_file: 50G → max_file: 200G
systemctl restart nats

# 2. Purge old messages (immediate relief)
nats stream purge TASK_STATE_LOG \
  --older=168h  # remove entries older than 7 days

# 3. Delete completed tasks from KV
nats kv keys TASK_STORE | head -100 | while read key; do
  TASK=$(nats kv get TASK_STORE "$key" 2>/dev/null)
  if echo "$TASK" | grep -q '"state":"completed"\|"state":"failed"\|"state":"canceled"'; then
    nats kv delete TASK_STORE "$key"
  fi
done

# 4. Compact old registration history
nats stream delete AGENT_REGISTRY
nats stream add AGENT_REGISTRY --subjects="mesh.registry.*" \
  --storage=file --max-msgs-per-subject=1 --discard=old
```

### JetStream Unavailable (Not Enabled)

**What happens:** Publish to JetStream subjects succeeds but messages are not persisted. Agents can still connect and communicate, but state changes are ephemeral.

**Detection:**
```bash
nats stream list
# Error: "JetStream not enabled"

curl http://localhost:8222/jsz | jq '.config'
# "null" = JetStream disabled
```

**Impact:**
- Task store unavailable (tasks don't persist across restarts)
- Registry unavailable (agents must re-register after restart)
- Events lost on server restart

**Recovery:** Enable in `nats.conf`:
```conf
jetstream {
  store_dir: "/var/lib/nats/jetstream"
  max_mem: 2G
  max_file: 50G
}
```

---

## 3. Agent Crash Mid-Task

**Scenario:** Agent A requests work from Agent B. Agent B crashes before responding.

**What happens:**
1. Request sent to `mesh.agent.bob.inbox`
2. Bob is processing but crashes before publishing response
3. A is waiting for `reply` subject response → timeout

**Detection:**
```bash
# Check if Bob is still registered
nats kv get TASK_STORE <task_id>
# State may be "working" with no further transition

# Check Bob's heartbeat
nats sub mesh.heartbeat.bob-id --count 3  # wait 90s
# No heartbeats received = Bob is down
```

**Recovery (caller side):**
```typescript
try {
  const result = await mesh.request(bob.id, "analyze", { code: "..." }, 30000);
} catch (err: any) {
  if (err.code === 4001) {
    // TRANSPORT_TIMEOUT — Bob likely crashed
    // Mark task as failed in task store
    await taskStore.fail(taskId, myId, 4001, "Agent unreachable", true);
    
    // Retry with backoff
    await retryWithBackoff(async () => {
      return await mesh.request(bob.id, "analyze", { code: "..." });
    }, 3, 1000);
  }
}
```

**Recovery (task store side):**
```typescript
// Periodic stale task cleanup
setInterval(async () => {
  const working = await taskStore.list({ state: "working" });
  for (const task of working) {
    const age = Date.now() - new Date(task.updated_at).getTime();
    if (age > 300_000) { // 5 minutes without update
      await taskStore.fail(
        task.task_id, "system", 5001, "Task timed out (agent likely crashed)", true
      );
    }
  }
}, 60_000);
```

---

## 4. Agent Crash Mid-Stream

**Scenario:** Agent is streaming LLM tokens. Crashes after sending 200 of 2000 tokens.

**What happens:**
1. 200 chunks published to `mesh.task.{id}.stream`
2. Agent crashes
3. Stream subject goes quiet
4. Caller's `streamRequest()` is waiting for `done: true`

**Detection:** Caller hits timeout on stream subscription.

**Recovery (caller side):**
```typescript
async function streamWithRecovery(mesh, agentId, skill, input) {
  const chunks = [];
  
  try {
    for await (const chunk of mesh.streamRequest(agentId, skill, input, 60000)) {
      chunks.push(chunk);
    }
  } catch (err: any) {
    if (err.code === 4001) {
      console.warn(`Stream interrupted after ${chunks.length} chunks — retrying`);
      // Retry from scratch (stateless) or request resume (stateful)
      return streamWithRecovery(mesh, agentId, skill, input);
    }
    throw err;
  }
  
  return chunks;
}
```

**Recovery (handler side: checkpoint-based resume):**
```typescript
mesh.onStreamRequest("llm-generate", async function* (payload, ctx) {
  const resumeFrom = payload.input?.resume_from || 0;
  const tokens = await generateTokens(payload.input.prompt);
  
  for (let i = resumeFrom; i < tokens.length; i++) {
    yield { token: tokens[i], index: i, total: tokens.length };
  }
});
```

---

## 5. Network Timeout Cascades

**Scenario:** Agent A calls B, B calls C, C is slow. A times out, retries. B also retries. Cascading load.

**What happens:**
- Error code 4001 (TRANSPORT_TIMEOUT) propagates up
- Each retry doubles load on the slowest agent
- Snowball effect: system-wide slowdown

**Prevention (circuit breakers + rate limiting):**
```typescript
class ProtectedRequest {
  private failures = 0;
  private lastFailure = 0;
  private cooldown = 10_000; // 10s
  private maxFailures = 3;

  async request<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isTripped()) {
      throw new SynapseError("Circuit breaker open", 4002, true);
    }

    try {
      const result = await fn();
      this.reset();
      return result;
    } catch (err: any) {
      if (err.code === 4001 || err.code === 4002) {
        this.trip();
      }
      throw err;
    }
  }

  private isTripped(): boolean {
    return this.failures >= this.maxFailures && 
           Date.now() - this.lastFailure < this.cooldown;
  }
  private trip(): void { 
    this.failures++; 
    this.lastFailure = Date.now(); 
  }
  private reset(): void { this.failures = 0; this.lastFailure = 0; }
}
```

**Operational response:**
1. Check which agent is bottlenecked: `nats top` shows queue depths
2. Scale that agent: run more instances with `queue group` subscriptions
3. Verify recovery: error rate should drop immediately after circuit breaker engages

---

## 6. Registry Unavailable (KV Store Down)

**What happens:** `discover()` returns empty or stale results. New agents can't register. Existing agents can still communicate if they have cached peer IDs.

**Detection:**
```bash
nats kv info MESH_REGISTRY
# Returns error = registry unavailable

# Check from code
const agents = await mesh.discover({ capabilities: ["chat"] });
if (agents.length === 0) {
  console.warn("Registry unavailable — falling back to cached manifests");
}
```

**Recovery (hybrid mode):**
```typescript
async fallbackDiscover(filter: DiscoverFilter): Promise<AgentManifest[]> {
  // 1. Try registry
  if (this.registry) {
    try {
      const agents = await this.registry.list(filter);
      if (agents.length > 0) return agents;
    } catch { /* fall through */ }
  }

  // 2. Fall back to broadcast discovery
  return await this.broadcastDiscover(filter);
}
```

---

## 7. Operational Monitoring Checklist

### Alerts to Configure

| Alert | Trigger | Threshold |
|-------|---------|-----------|
| Agent heartbeat missing | No heartbeat for agent X | > 90 seconds |
| JetStream storage > 80% | Storage usage | > 80% capacity |
| Request timeout rate spike | 4001 errors in 5 min window | > 5% of requests |
| Task stuck in `working` | Task state unchanged | > 5 minutes |
| NATS connection drops | Connection count drops | > 30% in 1 minute |
| Consumer lag growing | Messages pending | Lag > 1000 messages |

### Grafana Panels for Failure Detection

```json
[
  { "title": "Request Error Rate", "expr": "rate(synapse_errors_total[5m]) / rate(synapse_requests_total[5m])" },
  { "title": "Stale Tasks", "expr": "synapse_active_tasks{state='working'} - ignoring(state) synapse_recent_task_updates" },
  { "title": "JetStream Disk Usage %", "expr": "nats_jetstream_storage_reserved_bytes / nats_jetstream_storage_total_bytes" },
  { "title": "Agent Heartbeats Missing", "expr": "synapse_active_agents - count(rate(synapse_heartbeat_total[2m]))" }
]
```

---

## 8. Runbooks

### Runbook: Recover After Full NATS Outage

1. Start NATS server: `systemctl start nats`
2. Verify JetStream enabled: `curl http://localhost:8222/jsz`
3. Wait for agent auto-reconnect (2s per agent)
4. Verify registrations: `nats sub mesh.registry.register --count 10` (watch for 30s)
5. Verify request/reply: `nats request mesh.agent.test.inbox '{"skill":"health"}' -s nats://localhost:4222`
6. Check task store for stuck tasks: look for `working` > 5 minutes
7. Manually fail stuck tasks or mark for retry

### Runbook: JetStream Disk Full Emergency

1. Alert fires → check usage: `curl http://localhost:8222/jsz`
2. Purge old task logs: `nats stream purge TASK_STATE_LOG --older 168h`
3. Delete completed registrations: `nats kv purge TASK_STORE`
4. Expand storage limit in `nats.conf`: `max_file: 100G`
5. Restart NATS: `systemctl restart nats`
6. Verify write works: `nats publish mesh.event.test '{"test":true}'`
7. Root cause: why did streams grow unbounded? Add alerts on per-stream size.

### Runbook: Leaf Node Reconnection

1. Detect drop: `curl http://localhost:8222/leafz` shows fewer than expected
2. Check outbound connectivity: `nc -zv cloud-hub.example.com 7422`
3. Check TLS cert validity: `openssl s_client -connect cloud-hub:7422`
4. Restart leaf connection: `systemctl restart nats-leaf`
5. Verify re-establishes: `curl http://localhost:8222/leafz` shows expected count
6. Verify cross-org requests work: `nats request mesh.registry.discover '{}' -s nats://localhost:4222`

---

## Next Steps

- [Observability](./observability.md) — Set up Grafana dashboards for early warning
- [Tasks](./tasks.md) — Configure task store TTL and periodic cleanup
- [Patterns](./patterns.md) — Implement circuit breakers and backpressure
- [Cross-Org](./cross-org.md) — Leaf node topology and disaster recovery
