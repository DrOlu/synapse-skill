# Synapse Patterns

Real-world architectural patterns for multi-agent systems.

## Pattern Types

### 1. Request/Response (Synchronous)

**Use when:** Agent A needs an immediate answer from Agent B.

```
Agent A  ──request──>  Agent B
Agent A  <──respond──  Agent B
```

**TypeScript:**
```typescript
const result = await mesh.request(agentB.id, "analyze", { code: "..." });
```

**Python:**
```python
result = await mesh.request(agent_b_id, "analyze", {"code": "..."})
```

**CLI:**
```bash
nats request mesh.agent.bob-001.inbox '{"skill":"analyze","input":{"code":"..."}}'
```

---

### 2. Pub/Sub (Asynchronous Events)

**Use when:** One or more agents need to react to something happening, without the emitter caring who's listening.

```
Emitter  ──emit──>  mesh.event.*
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
          Subscriber A  Subscriber B  Subscriber C
```

**Wildcard subscriptions:**
- `mesh.event.document.>` — catches all document events
- `mesh.event.*` — catches single-level events
- `mesh.event.document.uploaded` — exact match

---

### 3. Fan-Out / Fan-In (Parallel Workers)

**Use when:** Process N items in parallel across multiple worker agents, then collect results.

```typescript
async function processParallel(items: string[], mesh: Synapse): Promise<any[]> {
  // Discover all workers
  const workers = await mesh.discover({ capabilities: ["worker"] });
  
  // Spawn all requests in parallel
  const promises = items.map((item, i) => {
    const worker = workers[i % workers.length]; // round-robin
    return mesh.request(worker.id, "process", { item });
  });

  // Wait for all
  const results = await Promise.all(promises);
  return results.map(r => r.payload.output);
}
```

**Go with goroutines:**
```go
results := make(chan interface{}, len(items))
var wg sync.WaitGroup

for _, item := range items {
    wg.Add(1)
    go func(it interface{}) {
        defer wg.Done()
        res, _ := mesh.Request(workerID, "process", map[string]interface{}{"item": it}, 30*time.Second)
        results <- res.Payload
    }(item)
}

wg.Wait()
close(results)
```

---

### 4. Delegation Chain

**Use when:** Agent A asks Agent B, who delegates to Agent C, who delegates to Agent D. Each agent adds value.

```
A ──request──> B ──request──> C ──request──> D
A <──respond── B <──respond── C <──respond── D
```

**Trace propagation:** Each hop adds a span to the trace context.

```typescript
const traceContext = {
  trace_id: envelope.trace.trace_id,  // same across chain
  span_id: uuid(),                     // new for each hop
  parent_span_id: envelope.trace.span_id,
};
```

---

### 5. Broadcast / Voting

**Use when:** Ask many agents the same question and collect all responses.

```typescript
async function broadcast(mesh: Synapse, topic: string, question: string): Promise<any[]> {
  const agents = await mesh.discover({ capabilities: [topic] });
  const promises = agents.map(agent => 
    mesh.request(agent.id, topic, { question }).catch(err => null)
  );
  const results = await Promise.all(promises);
  return results.filter(r => r !== null);
}
```

---

### 6. Event-Driven Pipeline

**Use when:** Agents react to events in sequence, each stage emitting for the next.

```
Stage 1               Stage 2                Stage 3
Uploader ──emit──>    Processor ──emit──>    Indexer
  document.uploaded    document.processed    document.indexed
```

```typescript
// Stage 2: Processor
mesh.subscribe("document.uploaded", async (event) => {
  const result = await processDocument(event.data);
  mesh.emit("document.processed", result);
});

// Stage 3: Indexer
mesh.subscribe("document.processed", async (event) => {
  await indexDocument(event.data);
  mesh.emit("document.indexed", { id: event.data.id });
});
```

---

### 7. Request Routing (Capability-Based)

**Use when:** A router agent dynamically finds the right specialist for each request.

```typescript
async function routeQuestion(mesh: Synapse, question: string, topic: string): Promise<string> {
  const { agents } = await mesh.discover({ capabilities: [topic] });
  
  if (agents.length === 0) {
    return `No agent available for "${topic}"`;
  }
  
  // Pick least loaded (by availability)
  const specialist = agents.find(a => a.availability === "online") || agents[0];
  const result = await mesh.request(specialist.id, topic, { text: question });
  return result.payload.output;
}
```

---

## 8. Streaming Responses

**Use when:** Agent is producing output incrementally (LLM tokens, large file processing).

Synapse uses a `mesh.task.{task_id}.stream` subject for chunked responses.
Each chunk is a separate NATS message with a sequence number. A final `done: true` signals completion.

The SDK provides two methods:

```typescript
// Caller side: returns an AsyncGenerator yielding chunks
async for (const chunk of mesh.streamRequest(agentId, "analyze", { text: "large doc" })) {
  console.log("Received chunk:", chunk);
}

// Handler side: registers a streaming handler
mesh.onStreamRequest("analyze", async function* (payload) {
  const text = payload.input?.text;
  const words = text.split(/\s+/);
  for (const word of words) {
    yield { word };
  }
});
```

See full streaming primitive in your SDK:
- [TypeScript streaming](./typescript.md#streaming-primitives)
- [Python streaming](./python.md#streaming-primitives)
- [Go streaming](./go.md#streaming-primitives)

### Wire Protocol (Manual, without SDK helpers)

If you're not using the SDK, the wire protocol is:

```
1. Caller sends request with task_id
2. Handler publishes chunks to mesh.task.{task_id}.stream
3. Each chunk: { seq: N, chunk: {...}, done: false }
4. Final chunk: { seq: N+1, chunk: {...}, done: true }
5. Caller subscribes to stream subject before sending request
6. Caller yields chunks until done: true, then unsubscribes
```

---

### 9. Human-in-the-Loop (auth_required)

**Use when:** Agent reaches a decision point and needs human approval.

```typescript
mesh.onRequest("deploy", async (payload, ctx) => {
  // Emit request for human approval
  mesh.emit("approval.requested", {
    task_id: ctx.task_id,
    action: "deploy",
    details: payload.input,
  });

  // Poll for approval (or use async state)
  const approved = await waitForApproval(ctx.task_id);
  
  if (!approved) {
    throw new Error("Deployment rejected by human");
  }

  // Continue with deployment
  return { status: "deployed" };
});
```

---

### 10. Circuit Breaker (Overload Protection)

**Use when:** Agents return error code 4001 (overloaded) and caller should back off.

```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailure: number = 0;
  private cooldown: number = 10000; // 10s

  async request<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) {
      throw new Error("Circuit breaker open");
    }

    try {
      const result = await fn();
      this.reset();
      return result;
    } catch (err: any) {
      if (err.message.includes("4001") || err.message.includes("OVERLOADED")) {
        this.fail();
      }
      throw err;
    }
  }

  private isOpen(): boolean {
    return this.failures >= 3 && Date.now() - this.lastFailure < this.cooldown;
  }

  private fail(): void {
    this.failures++;
    this.lastFailure = Date.now();
  }

  private reset(): void {
    this.failures = 0;
  }
}
```

---

## Production Patterns

### Health Dashboard

Subscribe to all heartbeats and track agent liveness:

```typescript
const agentStatus = new Map<string, { lastSeen: Date; available: boolean }>();

mesh.subscribe("heartbeat.>", (payload) => {
  // Heartbeat payload is { event_type, data: { agent_id, timestamp } }
  const agentId = payload.data?.agent_id || payload.agent_id;
  if (!agentId) return;
  agentStatus.set(agentId, {
    lastSeen: new Date(),
    available: true,
  });
});

// Mark agents as offline after 90s without heartbeat
setInterval(() => {
  const now = Date.now();
  for (const [id, status] of agentStatus.entries()) {
    if (now - status.lastSeen.getTime() > 90000) {
      status.available = false;
    }
  }
}, 10000);
```

---

### Graceful Shutdown

```typescript
async function shutdown(mesh: Synapse, manifest: AgentManifest) {
  // Announce going offline
  mesh.nc.publish("mesh.registry.deregister", jc.encode({
    v: "1.0.0", id: uuid(), type: "deregister",
    ts: new Date().toISOString(),
    from: mesh.agentId,
    payload: { id: mesh.agentId, reason: "shutdown" },
  }));
  
  // Drain connections
  await mesh.close();
}

process.on("SIGINT", () => shutdown(mesh, manifest));
process.on("SIGTERM", () => shutdown(mesh, manifest));
```

---

See [Security Guide](./security.md) for authentication patterns and [Cross-Org Guide](./cross-org.md) for multi-company topologies.
