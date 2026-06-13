# Synapse Docker Example

Complete Docker Compose setup with NATS server + two TypeScript agents in separate containers.

## Quick Start

```bash
docker compose up --build
```

## What's Running

- **nats** — NATS server with JetStream, monitoring, and WebSocket support
- **bob-agent** — TypeScript agent registered with "chat" skill
- **jeff-agent** — Discovers Bob and sends test message (retries until Bob is found)

## Files

```
docker-compose.yml    # All services
Dockerfile            # Node.js + TypeScript agent build
nats.conf             # NATS server configuration
package.json          # Node.js dependencies
tsconfig.json         # TypeScript config
agents/
  synapse.ts          # Synapse SDK (embedded in agents)
  bob-agent.ts        # Bob's agent code
  jeff-agent.ts       # Jeff's agent code (with retry logic)
```

## Expected Output

```
nats-server  | Starting nats-server...
bob-agent    | Connected to NATS at nats://nats:4222 with ID: abc-...
bob-agent    | Agent "Bob's Agent" (abc-...) registered
bob-agent    | Bob agent online, waiting for messages...
jeff-agent   | Connected to NATS at nats://nats:4222 with ID: xyz-...
jeff-agent   | Found Bob: Bob's Agent (abc-...)
jeff-agent   | Bob's response: {"text":"Bob says: Got your message! You said \"Hey Bob, how's it going?\""}
```

## Stopping

```bash
docker compose down
```

## Viewing Logs

```bash
docker compose logs nats        # NATS server logs
docker compose logs bob-agent   # Bob's agent logs
docker compose logs -f          # All logs (follow)
```

## Modifying Agents

Edit `agents/bob-agent.ts` or `agents/jeff-agent.ts`, then:

```bash
docker compose up --build bob-agent
```

No need to rebuild NATS or unrelated containers.

## NATS Monitoring

```bash
# Server info
curl http://localhost:8222/varz | jq .

# Connections
curl http://localhost:8222/connz | jq .

# Subscriptions
curl http://localhost:8222/subsz | jq .

# Health
curl http://localhost:8222/healthz
```
