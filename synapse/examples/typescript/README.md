# Synapse TypeScript Examples

Complete runnable Synapse agents in TypeScript.

## Prerequisites

- Node.js 18+
- NATS server running (`nats-server -js`)

## Setup

```bash
npm install
```

## Agents

| Agent | Description | Run |
|-------|-------------|-----|
| **Bob** | Chat responder (basic request/reply) | `npm run bob` |
| **Jeff** | Discovers Bob and sends message | `npm run jeff` |
| **Utilities** | 5 skills: uppercase, reverse, strlen, add, multiply | `npm run utilities` |
| **Claude** | LLM-powered chat + summarize (needs `ANTHROPIC_API_KEY`) | `npm run claude` |
| **Document Pipeline** | Event-driven document processing | `npm run pipeline` |
| **Orchestrator** | Delegation chain: research → summarize | `npm run orchestrator` |

## Quick Start

```bash
# Terminal 1: Start NATS
nats-server -js

# Terminal 2: Start Bob
npm run bob

# Terminal 3: Send request from Jeff
npm run jeff
```

## Multi-Skill Agent Test

```bash
# Start utilities agent
npm run utilities

# In another terminal, use nats CLI to test skills:
nats request mesh.agent.<id>.inbox '{"skill":"reverse","input":{"text":"Hello"}}'
nats request mesh.agent.<id>.inbox '{"skill":"add","input":{"a":7,"b":3}}'
```

## Event Pipeline Test

```bash
# Start document pipeline
npm run pipeline

# Publish a document event manually:
nats pub mesh.event.document.uploaded '{"filename":"test.txt","path":"./sample.txt"}'
```

## LLM Agent Test

```bash
ANTHROPIC_API_KEY=your-key npm run claude

# From another agent:
# mesh.request(claudeId, "chat", { message: "Explain quantum computing" })
# mesh.request(claudeId, "summarize", { text: "long text here..." })
```

## Files

```
src/
  synapse.ts              — Complete Synapse SDK (copy this into your projects)
  bob-agent.ts            — Basic chat agent
  jeff-agent.ts           — Discover + request agent
  utilities-agent.ts      — Multi-skill text/math agent
  claude-agent.ts         — LLM-powered agent (Anthropic Claude)
  document-pipeline.ts    — Event-driven document processor
  orchestrator-agent.ts   — Delegation chain coordinator
```
