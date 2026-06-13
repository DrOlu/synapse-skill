# HTTP Bridge E2E Example

Complete Docker setup showing a **Flask chat agent** (zero NATS knowledge) bridged into the Synapse mesh and called by a native Synapse agent.

## What's Running

| Service | Port | Role |
|---------|------|------|
| NATS server | 4222, 8222 | Synapse messaging backbone |
| Flask agent | 5000 | Pure HTTP REST agent (no NATS) |
| Bridge | 4100 | Proxies HTTP↔Synapse in both directions |
| Bob agent | — | Native Synapse agent that discovers + calls Flask |

## Quick Start

```bash
# Start everything
docker compose up --build

# Bob agent will auto-discover and call the Flask agent
```

## Expected Output

```
nats-server      | Starting JetStream
flask-agent      | Flask Chat Agent listening on http://0.0.0.0:5000
bridge           | HTTP agent "Flask Chat Agent" (flask-chat-001) bridged
bridge           | HTTP bridge webhook on http://0.0.0.0:4100
bob-agent        | ✅ Found Flask agent
bob-agent        | Chat result: {"text":"Flask says: I received 'Hello from Bob!'"}
bob-agent        | Summarize result: {"summary":"Summary of 16 words","word_count":16}
```

## Test From Outside Docker

```bash
# Direct HTTP call to Flask agent
curl -X POST http://localhost:5000/skill/chat \
  -H "Content-Type: application/json" \
  -d '{"skill":"chat","input":{"text":"direct call"}}'

# Call via Synapse webhook (Flask → Synapse → Flask round trip)
curl -X POST http://localhost:4100/mesh/request \
  -H "Content-Type: application/json" \
  -d '{"agentId":"flask-chat-001","skill":"chat","input":{"text":"via webhook"}}'

# Discover all Synapse agents via webhook
curl -X POST http://localhost:4100/mesh/discover \
  -H "Content-Type: application/json" \
  -d '{"capabilities":["chat"]}'
```

## Local (Non-Docker) Setup

```bash
# Terminal 1: NATS
nats-server -js

# Terminal 2: Flask agent
python flask_agent.py

# Terminal 3: Bridge (connects Flask to Synapse)
pip install synapse-nats-sdk aiohttp
# or use the local synapse.py + http_bridge.py
python bridge_runner.py

# Terminal 4: Bob (Synapse agent calling Flask)
node bob_caller.mjs
```

## Files

```
flask_agent.py       — Pure Flask agent (no NATS code)
bridge_runner.py     — Connects Flask agent to Synapse mesh
bob_caller.mjs       — Synapse agent that discovers + calls Flask
Dockerfile.flask     — Flask agent container
Dockerfile.bridge    — Bridge container
Dockerfile.bob       — Bob agent container
docker-compose.yml   — All services
```
