# Synapse Docker Example

Complete Docker Compose setup with NATS server + two TypeScript agents in separate containers.

## Quick Start

```bash
docker compose up --build
```

## What's Running

- **nats** — NATS server with JetStream, monitoring, and WebSocket support
- **bob-agent** — TypeScript agent registered with "chat" skill
- **jeff-agent** — Discovers Bob and sends test message (one-shot, then exits)

## Files

```
docker-compose.yml    # All services
Dockerfile            # Node.js + TypeScript agent build
nats.conf             # NATS server configuration
agents/
  bob-agent.ts        # Bob's agent code
  jeff-agent.ts       # Jeff's agent code
```

## Expected Output

```
bob-agent    | Connected to NATS with ID: abc-...
bob-agent    | Agent "Bob's Agent" registered
bob-agent    | Bob agent online, waiting for messages...
jeff-agent   | Connected to NATS with ID: xyz-...
jeff-agent   | Found Bob: bob-001
jeff-agent   | Bob's response: {"text":"Hi from Bob! 🎉"}
```

## Stopping

```bash
docker compose down
```

## Viewing Logs

```bash
docker compose logs nats        # NATS server logs
docker compose logs bob-agent   # Bob's agent logs
```

## Modifying Agents

Edit `agents/bob-agent.ts` or `agents/jeff-agent.ts`, then:

```bash
docker compose up --build bob-agent
```

No need to rebuild NATS or unrelated containers.
