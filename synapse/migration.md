# Migration Guide

Protocol-agnostic patterns for adopting Synapse, running alongside other protocols during transition, and porting agents to/from A2A, MCP, or custom systems.

---

## Philosophy

Synapse messages are plain JSON on standard NATS subjects. There is no proprietary envelope format — an agent is just code that:
1. Subscribes to `mesh.agent.{id}.inbox` for incoming requests
2. Parses the `payload` field and calls your business logic
3. Publishes the result to the `reply` subject

Everything in between — registry, discovery, heartbeats, tracing — is optional infrastructure. This architecture means **migration is a matter of rewriting adapters, not rewriting agents.**

---

## Keeping Business Logic Portable

The #1 migration principle: **keep your handler logic completely decoupled from the transport layer.**

### ❌ Bad: Handler directly uses NATS/Synapse APIs

```typescript
mesh.onRequest("translate", async (payload, ctx) => {
  const text = payload.input.text;
  const result = await translateAPI(text);
  // Directly publishes — tightly coupled
  mesh.nc.publish(ctx.reply, JSON.stringify({ output: result }));
});
```

### ✅ Good: Handler is a pure function

```typescript
// Agent logic — pure function, no transport knowledge
async function translateHandler(input: { text: string }): Promise<{ translation: string }> {
  return { translation: await translateAPI(input.text) };
}

// Synapse adapter
mesh.onRequest("translate", async (payload, ctx) => {
  return translateHandler(payload.input);
});

// A2A adapter
a2aServer.handle("translate", async (request) => {
  const result = await translateHandler(request.params);
  return { result };
});

// HTTP adapter (for FastAPI/Flask)
app.post("/translate", async (req) => {
  const result = await translateHandler(req.body);
  return result;
});
```

This way, switching transports is just a matter of writing a new adapter.

---

## Synapse ↔ A2A Adapter

Run both protocols side-by-side during transition. The adapter bridges requests in both directions.

### A2A-to-Synapse Bridge (A2A client → Synapse agent)

```typescript
// Incoming A2A request → route to Synapse mesh
a2aServer.handle("skill-name", async (request) => {
  // 1. Discover the Synapse agent with this capability
  const agents = await mesh.discover({ capabilities: [request.skill] });
  if (agents.length === 0) {
    return { error: { code: 404, message: "No Synapse agent available" } };
  }

  // 2. Forward as a Synapse request
  const synapseResult = await mesh.request(
    agents[0].id,
    request.skill,
    request.params
  );

  // 3. Return as A2A response format
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: synapseResult.payload.output,
  };
});
```

### Synapse-to-A2A Proxy (Synapse request → A2A agent)

```typescript
// Synapse agent forwards to A2A backend
mesh.onRequest("external-skill", async (payload) => {
  // Call A2A agent's task/send endpoint
  const response = await fetch("http://a2a-agent:8080/tasks/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tasks/send",
      id: crypto.randomUUID(),
      params: {
        id: crypto.randomUUID(),
        message: { role: "user", parts: [{ text: JSON.stringify(payload.input) }] },
      },
    }),
  });

  const a2aResponse = await response.json();
  return a2aResponse.result.artifacts?.[0]?.parts?.[0]?.text;
});
```

### Running Both Simultaneously

```dockerfile
# Docker compose: Synapse + A2A agents can coexist
services:
  nats:
    image: nats:2.11-alpine
    ports: ["4222:4222"]
  
  synapse-agent:
    image: my-agent:v1
    depends_on: [nats]
      # Talks Synapse natively
  
  a2a-agent:
    image: my-a2a-agent:v1
    ports: ["8080:8080"]
      # Receives A2A requests
  
  bridge:
    image: synapse-a2a-bridge
    depends_on: [nats, a2a-agent]
      # Bridges both directions
```

---

## Manifest Conversion

### Synapse → A2A Agent Card

```typescript
function synapseToAgentCard(manifest: AgentManifest): A2AAgentCard {
  return {
    name: manifest.name,
    description: manifest.description || "",
    url: `http://bridge:8080/proxy/${manifest.id}`, // bridge endpoint
    version: "1.0",
    protocolVersion: "0.2.0",
    capabilities: {
      streaming: true, // Synapse streaming supported via bridge
      pushNotifications: false,
    },
    skills: manifest.skills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: [manifest.name, ...manifest.capabilities],
    })),
    defaultInputModes: manifest.skills[0]?.input_modes || ["text/plain"],
    defaultOutputModes: manifest.skills[0]?.output_modes || ["text/plain"],
  };
}
```

### A2A Agent Card → Synapse Manifest

```typescript
function agentCardToManifest(card: A2AAgentCard): AgentManifest {
  return {
    id: card.name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
    name: card.name,
    description: card.description,
    capabilities: card.skills.map(s => s.tags[0]).filter(Boolean),
    skills: card.skills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      input_modes: card.defaultInputModes,
      output_modes: card.defaultOutputModes,
    })),
    endpoint: card.url,
    availability: "online",
    last_heartbeat: new Date().toISOString(),
  };
}
```

---

## Primitive Mapping Reference

| Synapse Primitive | A2A Equivalent | MCP Equivalent | Notes |
|-------------------|---------------|----------------|-------|
| `register` | Agent Card (static JSON) | `tools/list` | Synapse = dynamic, A2A = static |
| `discover` | Well-known agent card URL | `tools/list` (server) | No standard discovery in A2A/MCP |
| `request` | `tasks/send` | `tools/call` | All three are 1:1 mappings |
| `respond` | Task result/artifacts | Tool result | All three |
| `emit` | Push notifications | — | MCP has no equivalent |
| `subscribe` | `tasks/sendSubscribe` | — | MCP has no equivalent |
| `streamRequest` | SSE streaming | SSE streaming | All three via HTTP SSE |
| `context_id` | `message.context_id` | — | MCP has no session concept |
| `task_id` | `task.id` | — | Similar |

---

## Migration Timeline Estimates

| Deployment Size | Current State | Estimated Effort | Risk |
|-----------------|---------------|------------------|------|
| 1-5 agents, simple skills | HTTP REST | 1-2 days | Low |
| 5-20 agents, some streaming | LangChain/CrewAI | 1-2 weeks | Medium |
| 20+ agents, cross-org | Custom protocol | 2-4 weeks | Medium-High |
| Enterprise (100+ agents) | Mixed protocols | 1-3 months | High |

### Typical Phases

**Phase 1: Pilot (Week 1-2)**
- Set up NATS server
- Port 1-2 representative agents to Synapse
- Run the bridge adapter for remaining agents
- Validate against baseline performance

**Phase 2: Parallel Run (Week 3-4)**
- Port 50% of agents to Synapse
- Bridge handles remaining 50%
- Monitor for regressions
- Collect operational metrics

**Phase 3: Cutover (Week 5-6)**
- Port remaining agents
- Disable bridge adapters
- Archive old infrastructure
- Update documentation and runbooks

---

## Migration Script Template

```bash
#!/bin/bash
# migrate-agent.sh — Port an HTTP REST agent to Synapse

set -e

AGENT_NAME="$1"
HTTP_BASE_URL="$2"

echo "Migrating $AGENT_NAME from $HTTP_BASE_URL to Synapse..."

# 1. Create Synapse bridge for this HTTP agent
cat > "bridge-${AGENT_NAME}.ts" << EOF
import Synapse from "synapse-nats-sdk";

const mesh = await Synapse.connect("nats://localhost:4222");

await mesh.register({
  name: "${AGENT_NAME}",
  capabilities: ["TODO: list capabilities"],
  skills: [
    // TODO: define skills
  ],
});

// Forward to HTTP backend
mesh.onRequest("translate", async (payload) => {
  const resp = await fetch("${HTTP_BASE_URL}/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload.input),
  });
  return await resp.json();
});

console.log("Bridge for ${AGENT_NAME} running");
EOF

echo "✓ Created bridge-${AGENT_NAME}.ts"
echo "Next: Run the bridge, verify calls work, then port business logic to native Synapse"
```

---

## Exit Strategy: Synapse → Custom System

If Synapse doesn't work out, your investment is not lost:

1. **Business logic is portable** — handlers are pure functions (you followed the rule above, right?)
2. **Envelopes are just JSON** — no proprietary serialization
3. **NATS is widely supported** — most message brokers have NATS integrations
4. **Subject naming is your convention** — reuse `mesh.agent.x.inbox` in any pub/sub system

### Export Script

```typescript
// export-manifests.ts — dump all agent manifests for import elsewhere
const manifests = await mesh.discover();
for (const m of manifests) {
  console.log(JSON.stringify({
    name: m.name,
    skills: m.skills,
    capabilities: m.capabilities,
    endpoint: m.endpoint,
  }));
}
// Output: JSON lines suitable for importing into any registry
```

---

## Next Steps

- [HTTP Bridge](./http-bridge.md) — Run HTTP and Synapse agents together
- [Framework Integrations](./framework-integrations.md) — LangChain, CrewAI, AutoGen adapters
- [Comparison](./comparison.md) — When to choose Synapse vs. A2A/MCP
