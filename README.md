# synapse-skill

[![skills.sh](https://skills.sh/b/DrOlu/synapse-skill)](https://skills.sh/DrOlu/synapse-skill)

**Synapse** is the Internet-of-Agents Communication Protocol — a lightweight open standard that gives every AI agent a common language to form the Internet of Agents, just as TCP/IP gave every computer a common language to form the internet.

This repo packages Synapse as an installable agent skill for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://opencode.ai), [Cursor](https://cursor.sh), [Codex](https://openai.com/codex), and [67+ more agents](https://github.com/vercel-labs/skills/blob/main/README.md#supported-agents).

## Quick Install

### For TypeScript/JavaScript Projects

```bash
npm install synapse-nats-sdk
```

Then use in your code:

```typescript
import { Synapse } from 'synapse-nats-sdk';

const client = new Synapse('nats://localhost:4222');
await client.register({ name: 'my-agent', capabilities: ['chat'] });
```

### For Agent Skills (Claude, Cursor, etc.)

```bash
npx skills add DrOlu/synapse-skill -g -y
```

This installs the **complete Synapse skill** (90 files) into your agent environment, including:
- Full protocol specification
- Implementation guides for TypeScript, Python, Go, and CLI
- Runnable examples with docker-compose
- HTTP bridge for wrapping REST APIs
- ACL system with Ed25519 signed envelopes

Or install to a specific agent:

```bash
npx skills add DrOlu/synapse-skill -a claude-code
```

## What's Inside

This repository is **90 files / 11,000+ lines** of complete Synapse documentation and examples.

### 📚 Core Documentation

| File | Description |
|------|-------------|
| [`SKILL.md`](./synapse/SKILL.md) | Complete implementation guide (architecture, primitives, quick start) |
| [`envelope.md`](./synapse/envelope.md) | Message envelope format, tracing, error codes |
| [`states.md`](./synapse/states.md) | Task state machine (7 states, transitions) |
| [`subjects.md`](./synapse/subjects.md) | NATS subject namespace and wildcards |

### 🔧 Implementation Guides

| Language | File | Lines | Features |
|----------|------|-------|----------|
| **TypeScript** | [`typescript.md`](./synapse/typescript.md) | 2,000+ | Full SDK, JetStream, production patterns, HTTP bridge |
| **Python** | [`python.md`](./synapse/python.md) | 1,200+ | Async handlers, LLM integration, Pydantic models |
| **Go** | [`go.md`](./synapse/go.md) | 1,100+ | Goroutines, high-throughput mesh, persistence |
| **CLI** | [`cli-guide.md`](./synapse/cli-guide.md) | 500+ | Pure bash agents using the `nats` binary |

### 🏗️ Architecture & Security

| File | Description |
|------|-------------|
| [`patterns.md`](./synapse/patterns.md) | Routing, delegation, fan-out, streaming, heartbeat |
| [`security.md`](./synapse/security.md) | NKeys (Ed25519), JWT auth, three-tier trust hierarchy |
| [`http-bridge.md`](./synapse/http-bridge.md) | Wrapping REST APIs as Synapse agents |
| [`acl.md`](./synapse/acl.md) | Cryptographic identity verification and signed envelopes |
| [`cross-org.md`](./synapse/cross-org.md) | Leaf node topology, firewall traversal |
| [`registry.md`](./synapse/registry.md) | JetStream-backed registry service |
| [`observability.md`](./synapse/observability.md) | Metrics, tracing, logging, health checks |
| [`failure-modes.md`](./synapse/failure-modes.md) | Disaster recovery, circuit breakers, degraded modes |
| [`governance.md`](./synapse/governance.md) | Versioning, RFC process, breaking changes |
| [`migration.md`](./synapse/migration.md) | Migrating from HTTP/gRPC/A2A/MCP to Synapse |
| [`framework-integrations.md`](./synapse/framework-integrations.md) | LangChain, CrewAI, AutoGen, Semantic Kernel adapters |
| [`tasks.md`](./synapse/tasks.md) | Advanced task patterns, retries, cancellation |
| [`schema.md`](./synapse/schema.md) | JSON Schema for all message types |

### 🚀 Runnable Examples

| Example | Description |
|---------|-------------|
| [`examples/typescript/`](./synapse/examples/typescript/) | 2-agent chat (bob + jeff), complete with `package.json` |
| [`examples/python/`](./synapse/examples/python/) | LLM agents, delegation chains, HTTP bridge |
| [`examples/go/`](./synapse/examples/go/) | High-throughput mesh (bob, jeff, utilities, orchestrator) |
| [`examples/cli/`](./synapse/examples/cli/) | Pure bash multi-agent meshes, monitors, log watchers |
| [`examples/acl/`](./synapse/examples/acl/) | Cryptographic ACL demo: key generation, signing, verification |
| [`examples/docker/`](./synapse/examples/docker/) | Local dev, Synadia Cloud, leaf node topologies |
| [`examples/cross-org/`](./synapse/examples/cross-org/) | Acme↔Globex multi-company setup with configs |

## The 6 Primitives

| Primitive | Direction | Purpose |
|-----------|-----------|---------|
| `register` | Agent → Registry | Announce agent + capabilities |
| `discover` | Agent → Registry | Find agents by capability |
| `request` | Agent → Agent | Send work (creates tracked task) |
| `respond` | Agent → Agent | Return result or error |
| `emit` | Agent → Listeners | Broadcast event |
| `subscribe` | Listener → Agent | Listen for events with wildcards |

## Quick Start (no code)

```bash
# Terminal 1: NATS server
nats-server &

# Terminal 2: Agent Bob (replies to requests)
nats pub mesh.registry.register '{"id":"bob-001","name":"Bob","capabilities":["chat"]}' -s nats://localhost:4222
nats reply mesh.agent.bob-001.inbox '{"text":"Hi from Bob!"}' -s nats://localhost:4222

# Terminal 3: Agent Jeff (sends request)
nats request mesh.agent.bob-001.inbox '{"text":"Hello Bob"}' -s nats://localhost:4222
# → {"text":"Hi from Bob!"}
```

## Architecture

```
┌──────────────────────────────────────────────┐
│           Synapse Protocol                   │
│  6 primitives, envelope format, state machine│
└──────────────────┬───────────────────────────┘
                   │ speaks
                   ▼
┌──────────────────────────────────────────────┐
│            NATS Messaging                    │
│  • Request/reply  • Pub/sub (wildcards)      │
│  • JetStream      • Leaf nodes               │
│  • Accounts       • WebSockets               │
└──────────────────┬───────────────────────────┘
       ┌───────────┼───────────┐
   Agent A     Agent B     Agent C
  (TypeScript) (Python)      (CLI)
```

## License

Apache 2.0
