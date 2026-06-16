---
name: synapse
description: Complete implementation guide for Synapse protocol — build multi-agent systems on NATS using CLI or code (TypeScript, Python, Go). Covers all 6 primitives, real-world patterns, security (cryptographic ACL, NKeys, JWT), cross-org topology, and production deployment.
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
- Require cryptographic identity verification (reject unauthorized callers with signed envelopes)
- Send documents (PDF, DOCX, images, CSV) to agents for analysis over the mesh

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
- **[file-transfer.md](./file-transfer.md)** — Chunked file transfer protocol: send PDFs, images, CSVs to agents via NATS, auto-dispatched to target inbox
- **[security.md](./security.md)** — NKeys, JWT auth, Ed25519, multi-tenant permissions, signed envelopes
- **[acl.md](./acl.md)** — Cryptographic ACL: Ed25519 identity, trust store, key rotation, revocation
- **[cross-org.md](./cross-org.md)** — Leaf node topology, firewall traversal, Acme↔Globex scenario

### Reliability
- **[observability.md](./observability.md)** — OpenTelemetry tracing, metrics, Grafana dashboards, W3C interop
- **[schema.md](./schema.md)** — JSON Schema validation for envelopes, manifests, and task updates (TypeScript/Python/Go)
- **[registry.md](./registry.md)** — JetStream-backed registry service for deterministic discovery
- **[tasks.md](./tasks.md)** — JetStream-backed task store: state machine persistence, conversation linking, querying
- **[http-bridge.md](./http-bridge.md)** — Bidirectional HTTP↔Synapse bridge: wrap any REST/Flask/FastAPI agent as a Synapse participant
- **[reputation.md](./reputation.md)** — Per-agent, per-skill reliability scoring and ranked discovery. Detects lying agents that claim capabilities they don't have.

### Production Deployment
- **[deployment.md](./deployment.md)** — Hard-won production patterns: multi-tenant NATS isolation, boot persistence (launchd/systemd), bridge-level TaskStore integration, control-plane CLI, known gotchas, real-world task case studies. Read this before going live.

### Reference
- **[envelope.md](./envelope.md)** — Complete message envelope format, trace fields, error codes
- **[states.md](./states.md)** — Task state machine and state transition rules
- **[subjects.md](./subjects.md)** — Full subject namespace with wildcards and permissions
- **[comparison.md](./comparison.md)** — How Synapse compares to A2A, MCP, ANP, RepoWire

### Runnable Examples
- **[examples/cli/](./examples/cli/)** — Bash scripts: static agents, monitors, log watchers
- **[examples/acl/](./examples/acl/)** — Cryptographic ACL demo: signed envelopes, trust store, key rotation
- **[examples/reputation/](./examples/reputation/)** — Reputation system demo: good/flaky/lying agents, auto-ranking, lying detection
- **[examples/typescript/](./examples/typescript/)** — Full TypeScript projects (2-agent chat, event pipeline, routing)
- **[examples/python/](./examples/python/)** — Full Python projects (LLM agents, delegation chains)
- **[examples/go/](./examples/go/)** — Full Go projects (high-throughput mesh, JetStream persistence)
- **[examples/docker/](./examples/docker/)** — Multi-container setups (local dev, Synadia, leaf nodes)
- **[examples/docker/e2e-bridge/](./examples/docker/e2e-bridge/)** — End-to-end HTTP bridge demo (Flask ↔ Synapse ↔ Bob)
- **[examples/cross-org/](./examples/cross-org/)** — Complete Acme+Globex multi-company setup with credentials

## Install

```bash
# npm package (TypeScript/JavaScript)
npm install synapse-nats-sdk

# Install as a Claude Code skill
npx skills add https://github.com/drolu/synapse-skill --skill synapse
```

Published on [npm (synapse-nats-sdk)](https://www.npmjs.com/package/synapse-nats-sdk) and [skills.sh](https://www.skills.sh/drolu/synapse-skill/synapse).

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

### Option 4: HTTP Bridge (existing REST agent)

```typescript
// Wrap any Flask/FastAPI/Express agent into Synapse — zero NATS code on their side
import Synapse from "synapse-nats-sdk";
import { HTTPBridge } from "./http-bridge.js";

const mesh = await Synapse.connect("nats://localhost:4222");
const bridge = new HTTPBridge(mesh, 4100);
await bridge.registerAgent({
  id: "flask-chat-001", name: "Flask Chat Agent",
  baseUrl: "http://localhost:5000",
  capabilities: ["chat"],
  skills: [{ id: "chat", name: "Chat", description: "Chat" }],
});
await bridge.startWebhook();
// Flask agent is now discoverable and callable from any Synapse agent
```

See **[http-bridge.md](./http-bridge.md)** for full bridge documentation.

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
        │
        │ HTTP Bridge
        ▼
   ┌────────────┐
   │ HTTP Agent │  (Flask/FastAPI/Express — zero NATS code)
   └────────────┘
        │
        │ Browser SDK (WebSocket)
        ▼
   ┌────────────┐
   │ Browser    │  (React/Vue/Svelte — wsconnect to NATS:8443)
   └────────────┘
```

All agents speak Synapse: servers via TCP, browsers via WebSocket, HTTP services via the bridge.

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
| Agent takes >30s to respond (API calls, multi-step reasoning) | [Long-Running Requests](./typescript.md#long-running-requests) — increase `timeoutMs`, use `streamRequest()`, or stable reply subject for CLI |
| Need conversation history / task persistence | [Task Store](./tasks.md) — JetStream-backed task lifecycle + multi-turn linking |
| Want observability/debugging | [Observability Guide](./observability.md) — OTel tracing, metrics, Grafana |
| Need message validation | [Schema Guide](./schema.md) — JSON Schema for all message types |
| Comparing with A2A/MCP | [Comparison Guide](./comparison.md) |
| Need to rank agents by reliability | [Reputation Guide](./reputation.md) — Per-skill scoring, lying detection, discoverRanked |
| Detect agents claiming skills they dont have | [Lying Detection](./reputation.md#lying-detection) — 3001 SKILL_NOT_FOUND tracking |
| Send documents to agents for analysis | [File Transfer](./file-transfer.md) — Chunked transfer over NATS (init→chunks→done→dispatch) |
| Deploy a mesh for production (boot persistence, multi-tenant NATS, known gotchas) | [Deployment Guide](./deployment.md) — launchd/systemd services, 3-account isolation, bridge integration, operational CLI |

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
- [ ] NATS account isolation verified (see [deployment.md § 1](./deployment.md#1-nats-multi-tenant-isolation-the-1-gotcha))
- [ ] JetStream store is on a persistent path (not `/tmp` — see [deployment.md § 2](./deployment.md#2-boot-persistence--platform-services))
- [ ] Services are launchd-managed with `KeepAlive=true` and `ThrottleInterval=5`
- [ ] Bridge TaskStore operations are outside `if msg.reply:` block (see [deployment.md § 3](./deployment.md#3-bridge-level-taskstore-integration-without-rewriting-the-agent))
- [ ] Control-plane CLI supports fire-and-forget + poll (see [deployment.md § 4](./deployment.md#4-control-plane-cli-pattern))
- [ ] Heartbeats use consistent format across all SDKs (`mesh.heartbeat.{id}` with envelope containing `{ v, id, type: "heartbeat", ts, from, payload: { agent_id, timestamp } }`)

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

**JetStream API calls fail when using a leaf node:**
- Almost always caused by missing account isolation (see [deployment.md § 1](./deployment.md#1-nats-multi-tenant-isolation-the-1-gotcha))
- Check `curl http://localhost:8222/jsz` — `api.errors` should be 0
- Verify `accounts {}` block has a dedicated LOCAL account with `jetstream: enabled` and a separate REMOTE account for the leaf
- Ensure `system_account` points to a SYS account with NO JetStream

**Cross-firewall connection fails:**
- Leaf nodes must connect OUTBOUND only
- Check firewall allows NATS port (4222 default)
- Use `nats auth info` to verify JWT is valid

**Request times out on long-running agents (LLM, API calls, multi-step reasoning):**
- Pass explicit `timeoutMs` to `request()`: `mesh.request(id, skill, input, 180_000)`
- For agents taking >3 min, use `streamRequest()` / `onStreamRequest()` instead
- From CLI: subscribe to a stable reply subject BEFORE publishing the request (not after)
- See [Long-Running Requests](./typescript.md#long-running-requests) for full patterns

See [setup.md#troubleshooting](./setup.md#troubleshooting) for basic troubleshooting. For production-level gotchas (NATS isolation, task store bugs, boot persistence issues, bridge integration pitfalls), see [deployment.md § 5](./deployment.md#5-the-known-gotchas-checklist).

## Further Resources

- [Synapse on npm](https://www.npmjs.com/package/synapse-nats-sdk) — `npm install synapse-nats-sdk`
- [Synapse on skills.sh](https://www.skills.sh/drolu/synapse-skill/synapse) — `npx skills add https://github.com/drolu/synapse-skill --skill synapse`
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

# File Transfer
synapse-send-file report.pdf                                  # analyze a PDF
synapse-send-file image.png --action extract                  # extract text from image
synapse-send-file data.csv --target grip-cli-001 --via cloud  # send via Synadia Cloud
```

---

**Note:** This skill contains both reference material and runnable code. All examples in `examples/` are self-contained and tested. Copy freely into your projects.
