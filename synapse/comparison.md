# Protocol Comparison

How Synapse compares to other agent-to-agent protocols in 2026.

## The Big Four

| Protocol | Created By | Purpose | Maturity | Adoption |
|----------|-----------|---------|----------|----------|
| **MCP** (Model Context Protocol) | Anthropic | Agent → Tools | Production (97M+ downloads) | Universal |
| **A2A** (Agent-to-Agent) | Google | Agent → Agent (cross-vendor) | v1.0 (2026) | 150+ partners |
| **ACP** (Agent Communication) | IBM | Agent → Agent (REST-native) | Merging into A2A | BeeAI platform |
| **ANP** (Agent Network) | Community | Decentralized DID-based | Early research | Low |
| **Synapse** | Community | Agent → Agent on NATS | Stable (2K+ stars) | Self-hosted |

## Synapse vs A2A

| Dimension | Synapse | A2A |
|-----------|-----------|-----|
| **Backing** | Community (2K stars) | Linux Foundation (150+ partners) |
| **Transport** | NATS (persistent) | HTTP/gRPC/SSE |
| **Discovery** | Runtime `discover` | Static Agent Cards |
| **Complexity** | 6 primitives, one-page spec | Full SDK, JSON schema |
| **Streaming** | Native pub/sub | SSE (add-on) |
| **Persistence** | JetStream built-in | Push notifications |
| **Firewall** | NATS leaf nodes (outbound only) | HTTP endpoints (inbound) |
| **Auth** | NKeys/JWT at NATS level | OAuth 2.0, signed cards |
| **Real-time events** | `emit`/`subscribe` with wildcards | Not a primary pattern |
| **SDKs** | None (build with NATS clients) | 5 official (Python/JS/Java/Go/.NET) |

### Pick A2A when:
- Enterprise multi-vendor agent coordination
- Need cross-org Agent Card discovery
- Want official SDKs and governance
- Interoperating with existing A2A ecosystem (SAP, Atlassian, Google, etc.)

### Pick Synapse when:
- Building lightweight internal meshes
- Real-time event streaming is critical
- NATS is already in your stack
- Firewalls prevent HTTP inbound
- Simplicity over ceremony

## Synapse vs MCP

**They don't compete** — they operate at different layers.

- **MCP**: Agent accesses tools (database, API, filesystem)
- **Synapse**: Agents talk to other agents

In practice, agents use MCP internally and Synapse/A2A externally.

## Synapse vs RepoWire

| Dimension | Synapse | RepoWire |
|-----------|-----------|---------|
| **Scope** | Any agent type | Coding agents only |
| **Primitives** | 6 | 3 (ask, ack, notify) |
| **Discovery** | Capability-based | Named peers (@frontend) |
| **Network** | NATS mesh (any scale) | Local daemon (+optional relay) |
| **Stars** | 2K | 187 |
| **Best for** | Enterprise agent coordination | Code review between agents on one laptop |

## Layered Architecture (Best Practice)

```
Layer 3: Commerce        → ACP (IBM) or UCP (Google)
Layer 2: Agent-to-Agent  → A2A (external) + Synapse (internal)
Layer 1: Agent-to-Tool   → MCP
Layer 0: Transport       → NATS, HTTP, gRPC
```

## Decision Flowchart

```
Do your agents need to access tools/APIs?
  └─ Yes → Use MCP (Layer 1)

Do you have multiple agents that need to coordinate?
  └─ Yes → Need cross-vendor coordination?
             ├─ Yes → Use A2A
             └─ No  → Need real-time event streaming?
                       ├─ Yes → Use Synapse
                       └─ No  → Either A2A or Synapse
```

## Summary

**MCP** = Universal tool access (you'll always need it)
**A2A** = Enterprise agent coordination (the emerging standard)
**Synapse** = Lightweight NATS-based mesh (great for real-time & firewalls)

Most production systems will use MCP + one of {A2A, Synapse}. Pick based on your deployment topology, existing infrastructure, and real-time requirements.
