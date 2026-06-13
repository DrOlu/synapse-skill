# Synapse Go Examples

Complete runnable Synapse agents in Go.

## Prerequisites

- Go 1.22+
- NATS server running (`nats-server -js`)

## Setup

```bash
go mod tidy
```

## Agents

| Agent | Description | Run |
|-------|-------------|-----|
| **Bob** | Chat responder (basic request/reply) | `go run bob_agent.go` |
| **Jeff** | Discovers Bob and sends message | `go run jeff_agent.go` |
| **Utilities** | 5 skills: uppercase, reverse, strlen, add, multiply | `go run utilities_agent.go` |
| **Orchestrator** | Delegation chain: research → summarize | `go run orchestrator_agent.go` |

## Quick Start

```bash
# Terminal 1: Start NATS
nats-server -js

# Terminal 2: Start Bob
go run bob_agent.go

# Terminal 3: Send request from Jeff
go run jeff_agent.go
```

## Files

```
synapse.go           — Complete Synapse SDK (copy into your projects)
bob_agent.go         — Basic chat agent
jeff_agent.go        — Discover + request agent
utilities_agent.go   — Multi-skill text/math agent
orchestrator_agent.go — Delegation chain coordinator
go.mod               — Go module definition
```
