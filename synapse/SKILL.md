---
name: synapse
description: Complete implementation guide for Synapse protocol — build multi-agent systems on NATS using CLI or code (TypeScript, Python, Go). Covers all 6 primitives, real-world patterns, security, cross-org topology, and production deployment.
---

# Synapse: Synapse Implementation Skill

Synapse is a "phone network for AI agents" — a protocol that lets any agent discover, talk to, and collaborate with any other agent through NATS messaging. Built on 6 primitives: **register, discover, request, respond, emit, subscribe**.

This skill provides complete, runnable implementations for all architectures — from one-liner CLI agents to production TypeScript/Python/Go SDK-based systems spanning multiple organizations.

## When to Use This Skill

- Build a multi-agent system where agents need to find and call each other dynamically
- Replace N×M custom integrations with one protocol (all agents speak Synapse)
- Need real-time event streaming between agents (emit/subscribe with wildcards)
- Build cross-org agent coordination without exposing internal infrastructure
- Create lightweight "infrastructure agents" using only the NATS CLI
- Want persistent, reliable messaging (JetStream) with distributed tracing built-in
- Need peer-to-peer agent communication (not manager→worker hierarchies)

## The 6 Primitives (Quick Reference)

| Primitive | Purpose | Direction | NATS Subject |
|-----------|---------|-----------|--------------|
| **register** | Announce agent + capabilities | Agent→Registry | `mesh.registry.register` |
| **discover** | Find agents by capability | Agent→Registry | `mesh.registry.discover` |
| **request** | Ask agent to do work (creates task) | Agent→Agent | `mesh.agent.{id}.inbox` |
| **respond** | Return result or error | Agent→Agent | reply subject (auto) |
| **emit** | Broadcast event to subscribers | Agent→Listeners | `mesh.event.{type}` |
| **subscribe** | Listen for events with wildcards | Listener→Agent | `mesh.event.{pattern}` |

## Skill File Index

### Infrastructure & Setup
- **[setup.md](./setup.md)** — NATS installation, Docker, Synadia Cloud, multi-tenant accounts, leaf nodes

### Protocol Implementation Guides
- **[cli-guide.md](./cli-guide.md)** — Pure CLI agents using only the `nats` binary (no code)
- **[typescript.md](./typescript.md)** — Complete TypeScript/Node.js SDK + full code samples
- **[python.md](./python.md)** — Python SDK with async handlers and full examples
- **[go.md](./go.md)** — Go SDK with goroutines and production patterns

### Architecture & Patterns
- **[patterns.md](./patterns.md)** — Real-world patterns: routing, delegation, fan-out, streaming, heartbeat
- **[security.md](./security.md)** — NKeys, JWT auth, Ed25519, multi-tenant permissions, signed envelopes
- **[cross-org.md](./cross-org.md)** — Leaf node topology, firewall traversal, Acme↔Globex scenario

### Reliability
- **[observability.md](./observability.md)** — OpenTelemetry tracing, metrics, Grafana dashboards, W3C interop
- **[schema.md](./schema.md)** — JSON Schema validation for envelopes, manifests, and task updates (TypeScript/Python/Go)
- **[registry.md](./registry.md)** — JetStream-backed registry service for deterministic discovery
- **[tasks.md](./tasks.md)** — JetStream-backed task store: state machine persistence, conversation linking, querying

### Reference
- **[envelope.md](./envelope.md)** — Complete message envelope format, trace fields, error codes
- **[states.md](./states.md)** — Task state machine and state transition rules
- **[subjects.md](./subjects.md)** — Full subject namespace with wildcards and permissions
- **[comparison.md](./comparison.md)** — How Synapse compares to A2A, MCP, ANP, RepoWire

### Runnable Examples
- **[examples/cli/](./examples/cli/)** — Bash scripts: static agents, monitors, log watchers
- **[examples/typescript/](./examples/typescript/)** — Full TypeScript projects (2-agent chat, event pipeline, routing)
- **[examples/python/](./examples/python/)** — Full Python projects (LLM agents, delegation chains)
- **[examples/go/](./examples/go/)** — Full Go projects (high-throughput mesh, JetStream persistence)
- **[examples/docker/](./examples/docker/)** — Multi-container setups (local dev, Synadia, leaf nodes)
- **[examples/cross-org/](./examples/cross-org/)** — Complete Acme+Globex multi-company setup with credentials

## Install

```bash
# Install as a Claude Code skill
npx skills add https://github.com/drolu/synapse-skill --skill synapse
```

Published on [skills.sh/drolu/synapse-skill/synapse](https://www.skills.sh/drolu/synapse-skill/synapse).

## Quick Start (30 seconds)

### Option 1: Pure CLI Agent (no code)

```bash
# Terminal 1: Start NATS
nats-server &

# Terminal 2: Agent Bob (replies to requests)
nats pub mesh.registry.register '{"id":"bob-001","name":"Bob","capabilities":["chat"]}' -s nats://localhost:4222
nats reply mesh.agent.bob-001.inbox '{"text":"Hi from Bob!"}' -s nats://localhost:4222

# Terminal 3: Agent Jeff (sends request)
nats request mesh.agent.bob-001.inbox '{"text":"Hello Bob"}' -s nats://localhost:4222
# → {"text":"Hi from Bob!"}
```

### Option 2: TypeScript SDK

```bash
cd examples/typescript/agent-sdk
npm install
node src/bob-agent.js   # start Bob
node src/jeff-agent.js # Jeff discovers + requests Bob
```

See **[typescript.md](./typescript.md)** for the full SDK.

### Option 3: Python LLM Agent

```bash
cd examples/python/llm-agent
pip install -r requirements.txt
python research_agent.py
python summarizer_agent.py
```

See **[python.md](./python.md)** for full code.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                Synapse Protocol                    │
│  (6 primitives, envelope format, state machine)     │
└────────────────────────┬────────────────────────────┘
                         │
                         │ speaks
                         ▼
┌─────────────────────────────────────────────────────┐
│                 NATS Messaging                      │
├─────────────────────────────────────────────────────┤
│ • Request/reply (inbox model)                       │
│ • Pub/sub (wildcards)                               │
│ • JetStream persistence                             │
│ • Leaf nodes (cross-firewall)                       │
│ • Accounts (multi-tenant isolation)                 │
│ • WebSockets (browser/home agents)                  │
└────────────────────────┬────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   ┌────▼────┐      ┌───▼────┐      ┌────▼────┐
   │ Agent A │      │Agent B │      │ Agent C │
   │(TypeSC) │      │(Python)│      │ (CLI)   │
   └─────────┘      └────────┘      └─────────┘
```

All three agents speak Synapse. They don't know or care about each other's implementation language.

## Decision Matrix

| Scenario | Recommended Approach |
|----------|---------------------|
| Static data agents (uptime, config) | [CLI Guide](./cli-guide.md) — 5 lines of bash |
| Edge/IoT agents (sensors, cron jobs) | CLI + JetStream |
| LLM-powered agent (needs reasoning) | [TypeScript](./typescript.md) or [Python](./python.md) SDK |
| High-throughput data pipeline | [Go](./go.md) SDK |
| Cross-org coordination (firewalls) | [Cross-Org Guide](./cross-org.md) |
| Need guaranteed delivery | JetStream (Go SDK) |
| Need streaming responses (LLM tokens) | [Streaming Primitives](./typescript.md#streaming-primitives) — `streamRequest()` / `onStreamRequest()` |
| Need conversation history / task persistence | [Task Store](./tasks.md) — JetStream-backed task lifecycle + multi-turn linking |
| Want observability/debugging | [Observability Guide](./observability.md) — OTel tracing, metrics, Grafana |
| Need message validation | [Schema Guide](./schema.md) — JSON Schema for all message types |
| Comparing with A2A/MCP | [Comparison Guide](./comparison.md) |

## Comparison with Other Protocols

See [comparison.md](./comparison.md) for detailed comparison with:
- **A2A** (Google's Agent-to-Agent) — more ceremony, enterprise focus
- **MCP** (Anthropic's Model Context) — agent-to-tool only
- **ANP** (Agent Network Protocol) — decentralized DID-based
- **RepoWire** — local-first for coding agents only

## Production Checklist

Before going to production, verify:

- [ ] NATS has JetStream enabled for persistent delivery
- [ ] All subjects are documented in your permissions model
- [ ] Each agent has unique NKey credentials (no shared auth)
- [ ] Error codes are standardized and documented (see envelope.md)
- [ ] Task timeouts are enforced (default: 30s)
- [ ] Heartbeats are running (30s interval)
- [ ] Tracing is propagated via W3C Trace Context (see [observability.md](./observability.md))
- [ ] Monitoring dashboard is set up (NATS monitoring port + Grafana, see [observability.md](./observability.md))
- [ ] Leaf node connections are TLS-encrypted for cross-org traffic
- [ ] Credential rotation plan is in place (jwt expiry, nkey rotation)
- [ ] Envelope validation is enabled on send and receive (see [schema.md](./schema.md))
- [ ] Manifest validation rejects malformed registrations (error code 2002)
- [ ] OTLP endpoint is configured for trace/metric export
- [ ] Circuit breakers protect overloaded agents (see [patterns.md](./patterns.md))
- [ ] Backpressure / flow control enabled (concurrency limits, adaptive rate limiting)
- [ ] Heartbeats use consistent format across all SDKs (`mesh.heartbeat.{id}` with envelope)

## Troubleshooting

Common issues and fixes:

**Agent not responding to requests:**
```bash
# Check if agent's inbox has subscribers
nats server report subs -s nats://localhost:4222 | grep mesh.agent
```

**Discovery returns empty:**
```bash
# Verify agents registered
nats sub mesh.registry.register -s nats://localhost:4222 --count 1
# (run in background, watch who registers)
```

**Cross-firewall connection fails:**
- Leaf nodes must connect OUTBOUND only
- Check firewall allows NATS port (4222 default)
- Use `nats auth info` to verify JWT is valid

See [setup.md#troubleshooting](./setup.md#troubleshooting) for full troubleshooting guide.

## Further Resources

- [Synapse on skills.sh](https://www.skills.sh/drolu/synapse-skill/synapse) — Install with `npx skills add https://github.com/drolu/synapse-skill --skill synapse`
- [Synapse specification](https://synapse.ai)
- [NATS documentation](https://docs.nats.io)
- [Synadia Cloud](https://cloud.synadia.com) (free tier available)
- [Academic survey on Synapse patterns](https://arxiv.org/html/2505.02279v1)

## Quick Commands Reference

```bash
# Infrastructure
nats-server                           # start local server
nats-server -js                       # with JetStream
docker run -p 4222:4222 nats:latest   # Docker

# CLI Primitives
nats pub <subject> '<payload>'        # register, emit
nats sub <subject>                    # subscribe (with wildcards)
nats request <subject> '<payload>'    # request (blocks for reply)
nats reply <subject> '<payload>'      # respond to requests

# Discovery
nats request mesh.registry.discover '{"capabilities":["chat"]}'

# Monitoring
nats server report subs               # view subject subscriptions
nats top                              # live connection stats
nats rtt                              # latency test
```

---

**Note:** This skill contains both reference material and runnable code. All examples in `examples/` are self-contained and tested. Copy freely into your projects.
