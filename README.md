# synapse-skill

[![skills.sh](https://skills.sh/b/DrOlu/synapse-skill)](https://skills.sh/DrOlu/synapse-skill)

**Synapse** is the Internet-of-Agents Communication Protocol — a lightweight open standard that gives every AI agent a common language to form the Internet of Agents, just as TCP/IP gave every computer a common language to form the internet.

This repo packages Synapse as an installable agent skill for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://opencode.ai), [Cursor](https://cursor.sh), [Codex](https://openai.com/codex), and [67+ more agents](https://github.com/vercel-labs/skills/blob/main/README.md#supported-agents).

## Install

```bash
npx skills add DrOlu/synapse-skill
```

Or install to a specific agent:

```bash
npx skills add DrOlu/synapse-skill -a claude-code
```

## What's Inside

The `synapse/` skill directory contains:

### Protocol Reference
- **`SKILL.md`** — Full implementation guide with architecture overview, all 6 primitives, quick start examples
- **`envelope.md`** — Canonical message envelope format, trace fields, error codes
- **`states.md`** — Task state machine (7 states, transitions, terminal state rules)
- **`subjects.md`** — Full NATS subject namespace with wildcards and permissions

### Implementation Guides
- **`typescript.md`** — Complete TypeScript/Node.js SDK (1,000+ lines) — handlers, JetStream, production patterns
- **`python.md`** — Complete Python SDK (1,200+ lines) — async handlers, LLM integration, Pydantic models
- **`go.md`** — Complete Go SDK (700+ lines) — goroutines, high-throughput mesh, JetStream persistence
- **`cli-guide.md`** — Pure bash agents using only the `nats` binary (no code)

### Architecture & Patterns
- **`patterns.md`** — Routing, delegation, fan-out, streaming, heartbeat patterns
- **`security.md`** — NKeys (Ed25519), JWT auth, three-tier trust hierarchy, multi-tenant permissions
- **`cross-org.md`** — Leaf node topology, firewall traversal, Acme↔Globex scenario
- **`comparison.md`** — Synapse vs A2A, MCP, ANP, and RepoWire

### Infrastructure
- **`setup.md`** — NATS installation, Docker, Synadia Cloud, multi-tenant accounts, leaf nodes

### Runnable Examples
- **`examples/typescript/`** — Full 2-agent chat (bob + jeff) with `package.json` and `tsconfig.json`
- **`examples/cli/`** — Pure bash multi-agent mesh scripts
- **`examples/cross-org/`** — Acme↔Globex multi-company setup
- **`examples/docker/`** — Local dev, Synadia Cloud, leaf node Docker configs

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
