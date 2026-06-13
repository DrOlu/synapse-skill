# Cross-Org Example: Acme ↔ Globex

Complete setup demonstrating Synapse working across two organizations behind firewalls.

## Architecture

```
[Acme NATS Server]  ←→  [Cloud Hub]  ←→  [Globex NATS Server]
   (internal)           (public)           (internal)
      ↑                                        ↑
      │ leaf node (outbound only)             │ leaf node (outbound only)
      └────────────────────────────────────────┘
```

## Files

```
docker-compose.yml              # 4 containers: cloud-hub, acme-nats, globex-nats, agents
configs/
  cloud-hub.conf               # Cloud NATS configuration (accounts, leaf node listener)
  acme-internal.conf            # Acme's internal NATS (leaf to cloud hub)
  globex-internal.conf         # Globex's internal NATS (leaf to cloud hub)
creds/
  acme/leafnode.creds           # Acme leaf node credentials
  globex/leafnode.creds         # Globex leaf node credentials
setup.sh                        # Generate credentials
test.sh                         # Run cross-org tests
```

## Setup (First Time)

```bash
# 1. Generate all credentials
./setup.sh

# 2. Start all containers
docker compose up -d

# 3. Wait for servers to be ready (10s)
sleep 10

# 4. Verify leaf node connections
curl -s http://localhost:8222/leafz | python3 -m json.tool
# Should show: 2 leaf nodes (Acme + Globex)
```

## Test Cross-Org Communication

```bash
./test.sh
```

This script:
1. Registers Acme's code review agent on Acme's internal NATS
2. Starts a responder on Acme's inbox
3. From Globex's network, discovers Acme's agent
4. Sends a code review request across organizations
5. Publishes a shared event from Acme → Globex
6. Prints results for each step

## Manual Testing

```bash
# Register Acme agent (from Acme network)
nats pub mesh.registry.register '{"id":"acme-001","name":"Acme Code Review","capabilities":["code.review"]}' -s nats://localhost:5222

# Discover from Globex network
nats request mesh.registry.discover '{"capabilities":["code.review"]}' -s nats://localhost:6222

# Publish shared event from Acme
nats pub mesh.event.shared.acme.deployed '{"service":"api","version":"1.0"}' -s nats://localhost:5222

# Subscribe to Acme events from Globex
nats sub mesh.event.shared.acme.> -s nats://localhost:6222
```

## Monitoring

```bash
# Cloud hub monitoring
curl http://localhost:8222/varz | python3 -m json.tool    # Server info
curl http://localhost:8222/leafz | python3 -m json.tool   # Leaf nodes
curl http://localhost:8222/connz | python3 -m json.tool   # Connections

# Acme monitoring
curl http://localhost:5822/varz | python3 -m json.tool

# Globex monitoring
curl http://localhost:6822/varz | python3 -m json.tool
```

## What's Happening Under the Hood

1. **Isolation**: Acme agents connect to Acme's internal NATS (port 5222). Globex agents to Globex's internal NATS (port 6222). They never see each other's internal traffic.

2. **Selective Sharing**: Only `mesh.event.shared.>` and `mesh.agent.{org}.>` cross organizations (explicitly imported/exported in each account).

3. **Outbound Only**: Both leaf nodes connect OUTBOUND to cloud hub on port 7422. No inbound ports required. No firewall changes.

4. **Persistent Connections**: If connection drops, NATS auto-reconnects when network recovers. No message loss with JetStream.

## Cleanup

```bash
docker compose down
rm -rf creds/
```

## Cost

- **Cloud Hub**: 1x $5/month VPS (DigitalOcean/Hetzner/Linode) OR Synadia Cloud free tier
- **Acme Internal**: Existing infrastructure
- **Globex Internal**: Existing infrastructure
- **Total incremental cost**: $0–$5/month

## Next Steps

Read the full [Cross-Org Guide](../../cross-org.md) for:
- Synadia Cloud setup (managed, $0 free tier)
- AWS/Azure/GCP deployment templates
- High Availability (3-node cloud hub cluster)
- Disaster Recovery strategies
