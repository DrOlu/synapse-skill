# Infrastructure Setup

Complete guide to installing and configuring NATS for Synapse — from local development to production multi-tenant cloud deployments.

## Table of Contents
- [Local Installation](#local-installation)
- [Docker Setup](#docker-setup)
- [Cloud Deployment](#cloud-deployment)
- [Multi-Tenant Accounts](#multi-tenant-accounts)
- [Leaf Node Topology](#leaf-node-topology)
- [JetStream Persistence](#jetstream-persistence)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

---

## Local Installation

### macOS (Homebrew)

```bash
# Install NATS server (daemon)
brew install nats-server

# Install NATS CLI (client tool)
brew install nats

# Verify
nats-server --version  # v2.11.x
nats --version         # 0.3.x
```

### Linux

```bash
# Install NATS server
curl -sf https://binaries.nats.dev/nats-io/nats-server/v2@latest | sh
sudo mv nats-server /usr/local/bin/

# Install NATS CLI
curl -sf https://binaries.nats.dev/nats-io/natscli/v0@latest | sh
sudo mv nats /usr/local/bin/

# Verify
nats-server --version
nats --version
```

### Windows

Download from GitHub releases:

**NATS Server:**
- https://github.com/nats-io/nats-server/releases
- Download `nats-server-v2.x.x-windows-amd64.zip`
- Extract to `C:\NATS\`
- Add to PATH

**NATS CLI:**
- https://github.com/nats-io/natscli/releases
- Download `nats-v0.x.x-windows-amd64.zip`
- Extract to `C:\NATS\`

Verify:
```powershell
nats-server --version
nats --version
```

### Start Local Server (Basic)

```bash
# Quick start (no config)
nats-server

# With JetStream (persistent messaging)
nats-server -js

# With monitoring port
nats-server -m 8222
```

### Configuration File (Recommended)

Create `nats.conf`:

```conf
# Basic NATS server configuration
port: 4222
http_port: 8222  # monitoring

# WebSocket support (for browser agents)
websocket {
  port: 8443
  no_tls: true  # dev only; use TLS in prod
}

# JetStream persistence
jetstream {
  store_dir: "/var/lib/nats/jetstream"
  max_mem: 1G
  max_file: 10G
}
```

Start with config:
```bash
nats-server -c nats.conf
```

---

## Docker Setup

### Single Container (Development)

```bash
# Simple one-liner
docker run -d \
  --name nats-server \
  -p 4222:4222 \
  -p 8222:8222 \
  nats:latest \
  -js -m 8222

# Verify
docker logs nats-server
nats server check -s nats://localhost:4222
```

### Docker Compose (Production)

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  nats:
    image: nats:2.11-alpine
    container_name: nats-server
    ports:
      - "4222:4222"    # Client connections
      - "8222:8222"    # Monitoring API
      - "6222:6222"    # Cluster routes
      - "8443:8443"    # WebSocket
    volumes:
      - ./nats.conf:/etc/nats/nats.conf
      - nats-data:/data
    command: ["-c", "/etc/nats/nats.conf"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8222/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3

  nats-cli:
    image: natscli:latest
    depends_on:
      - nats
    profiles: ["cli"]
    entrypoint: ["nats"]
    command: ["server", "check", "-s", "nats://nats:4222"]

volumes:
  nats-data:
```

Create `nats.conf` (same as above, but with Docker paths):

```conf
port: 4222
http_port: 8222

websocket {
  port: 8443
  no_tls: true
}

jetstream {
  store_dir: "/data/jetstream"
  max_mem: 2G
  max_file: 50G
}

# Monitoring endpoints
http_port: 8222
```

Start:
```bash
# Start NATS server
docker compose up -d nats

# Run one-time CLI commands
docker compose run --rm nats-cli server info -s nats:4222

# Tail logs
docker compose logs -f nats
```

### 3-Node Cluster (High Availability)

Create `cluster-compose.yml`:

```yaml
version: '3.8'

services:
  nats-1:
    image: nats:2.11-alpine
    container_name: nats-1
    ports:
      - "4222:4222"
      - "8222:8222"
      - "6222:6222"
    command: >
      --cluster_name mesh_cluster
      --cluster nats://0.0.0.0:6222
      --routes nats://nats-2:6222,nats://nats-3:6222
      -js
      -m 8222
    restart: unless-stopped

  nats-2:
    image: nats:2.11-alpine
    container_name: nats-2
    command: >
      --cluster_name mesh_cluster
      --cluster nats://0.0.0.0:6222
      --routes nats://nats-1:6222,nats://nats-3:6222
      -js
      -m 8222
    restart: unless-stopped

  nats-3:
    image: nats:2.11-alpine
    container_name: nats-3
    command: >
      --cluster_name mesh_cluster
      --cluster nats://0.0.0.0:6222
      --routes nats://nats-1:6222,nats://nats-2:6222
      -js
      -m 8222
    restart: unless-stopped
```

Start cluster:
```bash
docker compose -f cluster-compose.yml up -d

# Verify cluster formation
nats server report cluster -s nats://localhost:4222
```

---

## Cloud Deployment

### Synadia Cloud (Hosted NATS - Free Tier)

Synadia Cloud provides managed NATS infrastructure. Free tier supports:
- 3 accounts (e.g., dev/staging/prod)
- 100 connections per account
- 1000 subscriptions per connection
- 10 leaf nodes
- 10GB storage
- 100GB/month bandwidth

**Signup Steps:**

1. Go to https://cloud.synadia.com
2. Create account (Free tier, no credit card required)
3. Create 3 accounts: `dev`, `staging`, `prod`
4. Download credentials (`.creds` file for each account)
5. Get your connection URL (format: `connect.ngs.global:4222`)

**Connect with credentials:**

```bash
# CLI with credentials file
nats server info -s tls://connect.ngs.global:4222 --creds ~/.nats/dev.creds

# Set context for convenience
nats context add synadia-dev \
  --server=tls://connect.ngs.global:4222 \
  --creds=~/.nats/dev.creds \
  --description="Synadia dev account"

nats context select synadia-dev

# Now use context
nats server info
```

**In code (TypeScript):**

```typescript
import { connect, StringCodec } from 'nats';

const nc = await connect({
  servers: 'tls://connect.ngs.global:4222',
  authenticator: credsAuthenticator(creds('{creds-file-content}')),
});
```

### AWS (EC2)

```bash
# Launch EC2 instance (t3.medium minimum)
# Security group: open 4222, 8222, 6222 (internal only)

# Install NATS
curl -sf https://binaries.nats.dev/nats-io/nats-server/v2@latest | sh
sudo mv nats-server /usr/local/bin/

# Create systemd service
sudo tee /etc/systemd/system/nats.service > /dev/null <<EOF
[Unit]
Description=NATS Server
After=network.target

[Service]
ExecStart=/usr/local/bin/nats-server -c /etc/nats/nats.conf
Restart=always
User=nats
Group=nats

[Install]
WantedBy=multi-user.target
EOF

# Create config directory
sudo mkdir /etc/nats
sudo chown nats:nats /etc/nats

# Add your nats.conf
sudo nano /etc/nats/nats.conf

# Start service
sudo systemctl daemon-reload
sudo systemctl enable nats
sudo systemctl start nats

# Check status
sudo systemctl status nats
```

### Google Cloud Run / Kubernetes

See [examples/docker/k8s/](./examples/docker/k8s/) for complete Kubernetes deployment.

---

## Multi-Tenant Accounts

Create isolated accounts for different organizations (e.g., Acme Corp and Globex Inc).

### Generate Account Keys

```bash
# Generate NKeys (Ed25519 keypairs)
nats auth createkey -t account -n ACME_CORP
nats auth createkey -t account -n GLOBEX_INC
nats auth createkey -t operator -n MESH_OPERATOR

# Generate user keys for agents
nats auth createkey -t user -n acme_agent_1
nats auth createkey -t user -n globex_agent_1
```

### Create Accounts Configuration

Add to `nats.conf`:

```conf
# Operator configuration
operator: ./operator.jwt

# Define accounts
accounts {
  ACME_CORP: {
    jetstream: enabled
    
    # Permissions for Acme agents
    exports: [
      { service: "mesh.agent.acme.>" }  # Acme agents publish to their inboxes
      { stream: "mesh.event.acme.>" }   # Acme internal events
      { stream: "mesh.event.shared.>" } # Shared events (Globex can subscribe)
    ]
    
    imports: [
      { stream: { account: GLOBEX_INC, subject: "mesh.event.globex.>" }, to: "mesh.event.globex.>" }
      { stream: { account: GLOBEX_INC, subject: "mesh.event.shared.>" }, to: "mesh.event.shared.>" }
    ]
  }

  GLOBEX_INC: {
    jetstream: enabled
    
    exports: [
      { service: "mesh.agent.globex.>" }
      { stream: "mesh.event.globex.>" }
      { stream: "mesh.event.shared.>" }
    ]
    
    imports: [
      { stream: { account: ACME_CORP, subject: "mesh.event.acme.>" }, to: "mesh.event.acme.>" }
      { stream: { account: ACME_CORP, subject: "mesh.event.shared.>" }, to: "mesh.event.shared.>" }
    ]
  }
}

# System account for NATS tools
system_account: $G
```

### Generate User JWTs

```bash
# Create user JWTs for each agent
nats auth createuser -a ACME_CORP -n acme_agent_1 > ./acme-agent-1.jwt
nats auth createuser -a GLOBEX_INC -n globex_agent_1 > ./globex-agent-1.jwt
```

### Test Permissions

```bash
# Acme agent can publish to own inbox
nats pub mesh.agent.acme.agent1.inbox '{}' --creds ./acme-agent-1.jwt

# Acme agent cannot publish to Globex inbox (denied)
nats pub mesh.agent.globex.agent1.inbox '{}' --creds ./acme-agent-1.jwt
# → Permission denied

# Both can see shared events
nats sub 'mesh.event.shared.>' --creds ./acme-agent-1.jwt
nats pub 'mesh.event.shared.broadcast' '{}' --creds ./globex-agent-1.jwt
```

---

## Leaf Node Topology

Leaf nodes enable cross-firewall connections without opening inbound ports.

### Scenario: Acme ↔ Globex via Shared Hub

```
[Acme NATS Server]  ←→  [Cloud Hub]  ←→  [Globex NATS Server]
   (internal)           (public)           (internal)
      ↑                                        ↑
      │ leaf node                             │ leaf node
      │ (outbound only)                       │ (outbound only)
      └────────────────────────────────────────┘
```

**Cloud Hub Configuration:**

```conf
# cloud-hub.conf
port: 4222
http_port: 8222

# Accept leaf node connections (outbound from Acme/Globex)
leafnodes {
  port: 7422
  tls {
    cert_file: "/etc/nats/certs/hub.crt"
    key_file: "/etc/nats/certs/hub.key"
    ca_file: "/etc/nats/certs/ca.crt"
    timeout: 3
  }
  
  authorization {
    accounts: [
      { account: ACME_CORP, key: "ACME_LEAF_KEY", permissions: { sub: "mesh.event.shared.>" } }
      { account: GLOBEX_INC, key: "GLOBEX_LEAF_KEY", permissions: { sub: "mesh.event.shared.>" } }
    ]
  }
}

# Account configuration (same as above)
accounts {
  ACME_CORP: { ... }
  GLOBEX_INC: { ... }
}
```

**Acme Internal Server (Leaf Connecting OUTWARD):**

```conf
# acme-internal.conf
port: 4222
http_port: 8222

# Connect to cloud hub as leaf node
leafnodes {
  remotes: [
    {
      url: "tls://cloud-hub.example.com:7422"
      account: "ACME_CORP"
      credentials: "/etc/nats/leafnode.creds"
      tls {
        ca_file: "/etc/nats/certs/ca.crt"
      }
    }
  ]
}

# Internal accounts (same as before)
accounts {
  ACME_CORP: { ... }
}
```

**Firewall Requirements:**
- ✅ Acme NATS server → OUTBOUND TCP 7422 to cloud hub
- ✅ Globex NATS server → OUTBOUND TCP 7422 to cloud hub
- ❌ NO inbound ports needed
- ❌ NO firewall rule changes

**Verify Leaf Connection:**

```bash
# On Acme server
nats server report leaf -s nats://localhost:4222

# Should show:
leaf node connected: ACME_CORP@cloud-hub.example.com (Connected: 5m23s)
```

---

## JetStream Persistence

Enable persistent delivery for critical messages (agent registrations, task state changes).

### Basic JetStream Setup

```conf
# nats.conf
jetstream {
  store_dir: "/var/lib/nats/jetstream"
  max_mem: 2G
  max_file: 100G
}
```

### Create Streams for Synapse

```bash
# Stream for agent registry (keeps last registration per agent)
nats stream add AGENT_REGISTRY \
  --subjects="mesh.registry.register,mesh.registry.deregister" \
  --storage=file \
  --max-msgs=-1 \
  --retention=limits \
  --discard=old \
  --max-msgs-per-subject=1 \
  --description="Agent registration state"

# Stream for task lifecycle (keeps full history)
nats stream add TASKS_STATE \
  --subjects="mesh.task.*" \
  --storage=file \
  --max-age=168h \
  --description="Task state machine events"

# Stream for persistent events
nats stream add PERSISTENT_EVENTS \
  --subjects="mesh.event.persistent.*" \
  --storage=file \
  --max-msgs=-1 \
  --description="Events that need guaranteed delivery"
```

### Create Consumers (Pull-Based)

```bash
# Worker consumer for task processing
nats consumer add TASKS_STATE task_worker \
  --deliver=all \
  --ack=explicit \
  --wait=30s \
  --max-deliver=3 \
  --description="Worker pulls pending tasks"

# Worker script
while true; do
  MSG=$(nats next TASKS_STATE task_worker --wait 5s)
  if [ -n "$MSG" ]; then
    echo "Processing: $MSG"
    # ... process message ...
    nats ack last  # acknowledge
  fi
done
```

### Create Consumers (Push-Based)

```bash
# Push consumer for event processing
nats consumer add PERSISTENT_EVENTS event_push \
  --deliver=all \
  --ack=explicit \
  --max-deliver=5 \
  --filter="mesh.event.persistent.document.>"

# Agent receives events immediately
nats sub --queue=event-queue --deliver-subject="mesh.event.persistent.document.>" \
  --consumer=event_push
```

---

## Monitoring

### NATS Monitoring API

NATS server exposes monitoring endpoints on HTTP port (8222 by default):

```bash
# Server info
curl http://localhost:8222/varz

# All connections
curl http://localhost:8222/connz

# Subject subscriptions
curl http://localhost:8222/subsz?subs=1

# Route connections (cluster)
curl http://localhost:8222/routez

# Gateway connections (leaf nodes)
curl http://localhost:8222/gatewayz

# Leaf node connections
curl http://localhost:8222/leafz

# Account stats
curl http://localhost:8222/accounts

# JetStream info
curl http://localhost:8222/jsz

# Health check
curl http://localhost:8222/healthz
```

### NATS CLI Monitoring Tools

```bash
# Live connections dashboard
nats top -n 10

# Connection report
nats server report conns -s nats://localhost:4222

# Subject subscriptions
nats server report subs -s nats://localhost:4222

# JetStream health
nats stream report -s nats://localhost:4222

# Consumer lag
nats consumer report TASKS_STATE task_worker -s nats://localhost:4222
```

### External Monitoring

**Prometheus Integration:**

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'nats'
    static_configs:
      - targets: ['nats-server:8222']
    metrics_path: /metrics
```

Install NATS Prometheus exporter:
```bash
docker run -d \
  --name nats-prom-exporter \
  -p 7777:7777 \
  natsio/prometheus-nats-exporter:latest \
  -varz -connz -subsz -jsz all \
  http://nats-server:8222
```

**Grafana Dashboard:**

Import dashboard ID `2279` from Grafana Labs for NATS monitoring.

---

## Troubleshooting

### Agent Not Receiving Requests

**Symptom:** Agent registers but doesn't receive incoming requests.

```bash
# Check if agent is subscribed
nats server report subs -s nats://localhost:4222 | grep "mesh.agent.bob-001.inbox"

# If not subscribed: agent's reply handler isn't running
# Check agent logs for errors

# Test manual request
nats request mesh.agent.bob-001.inbox '{"test":"ping"}' -s nats://localhost:4222
```

**Fix:** Ensure agent is running `nats reply` or SDK equivalent.

---

### Discovery Returns Empty

**Symptom:** `nats request mesh.registry.discover ...` returns no results.

```bash
# Check if any agents registered
nats sub mesh.registry.register -s nats://localhost:4222 --count 3

# In another terminal, re-register an agent
nats pub mesh.registry.register '{"id":"test","capabilities":["test"]}'

# If no messages: no reply service running for discovery
# Agents must implement discovery responder:
nats reply mesh.registry.discover '{"id":"test","capabilities":["test"]}'
```

**Fix:** Agents must implement `discover` responder that returns their manifest.

---

### Request Times Out

**Symptom:** Request hangs or times out after 5 seconds.

```bash
# Check agent health
nats rtt -n 5 -s nats://localhost:4222

# Check JetStream consumer lag
nats consumer report TASKS_STATE task_worker

# Check if agent inbox is reachable
nats request mesh.agent.bob-001.inbox '{}' --timeout 2s
# If timeout: agent is down or firewall blocking
```

**Fix:** Increase timeout, check agent logs, verify network connectivity.

---

### Cross-Firewall Connection Fails

**Symptom:** Leaf node can't connect to cloud hub.

```bash
# On leaf node server
nats server report leafnats

# Check TLS certificate validity
openssl s_client -connect cloud-hub.example.com:7422 -CAfile /etc/nats/certs/ca.crt

# Verify credentials
nats auth info --creds ./leafnode.creds
```

**Fix:** 
- Ensure firewall allows outbound TCP 7422
- Verify leafnode.creds contains valid JWT
- Check cloud hub logs for connection attempts

---

### JetStream Consumer Lag

**Symptom:** Messages pile up, agents can't keep up.

```bash
# Check consumer lag
nats consumer info TASKS_STATE task_worker

# If lag > 0: consumer is slow
# Increase consumer concurrency or optimize message processing

# Check for failed deliveries
nats consumer report TASKS_STATE task_worker
# Look for "redelivered" count
```

**Fix:** 
- Scale workers (multiple consumers on same stream)
- Increase `--max-deliver` for retries
- Optimize message processing latency

---

### Permission Denied

**Symptom:** Agent can't publish or subscribe to subjects.

```bash
# Check account permissions
nats auth info --creds ./agent.creds

# Verify subject matches account permissions in nats.conf
# Example: if account only allows "mesh.agent.acme.>", 
# agent cannot publish to "mesh.agent.globex.>"
```

**Fix:** Update account configuration in nats.conf with correct subject permissions.

---

## Next Steps

Continue to:
- [CLI Guide](./cli-guide.md) for building agents with only the `nats` binary
- [TypeScript SDK](./typescript.md) for production agent implementations
- [Security](./security.md) for authentication and authorization patterns
