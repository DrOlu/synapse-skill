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
setup.sh              # Generate NKeys, accounts, credentials
docker-compose.yml    # 3 containers: acme, globex, cloud-hub
test.sh               # Send cross-org request
configs/
  cloud-hub.conf      # Cloud NATS configuration
  acme-internal.conf  # Acme's internal NATS
  globex-internal.conf
creds/                # Generated credentials (gitignored)
  acme/
  globex/
```

## Setup (First Time)

```bash
# 1. Generate all credentials
./setup.sh

# 2. Start all containers
docker compose up -d

# 3. Verify leaf node connections
docker compose exec cloud-hub nats server report leafnats
# Should show: 2 leaf nodes (Acme + Globex)
```

## Test Cross-Org Communication

```bash
./test.sh
```

This script:
1. Registers Acme's code review agent
2. From inside Globex network, discovers Acme's agent
3. Sends a code review request across organizations
4. Prints Acme's response

## What's Happening Under the Hood

1. **Isolation**: Acme agents connect to Acme's internal NATS. Globex agents to Globex's internal NATS. They never see each other's internal traffic.

2. **Selective Sharing**: Only `mesh.event.shared.>` crosses organizations (explicitly imported in each account).

3. **Outbound Only**: Both leaf nodes connect OUTBOUND to cloud hub. No inbound ports required. No firewall changes.

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

## Troubleshooting

**Leaf node won't connect:**
```bash
# Check cloud hub logs
docker compose logs cloud-hub

# Verify firewall allows outbound TCP 7422
docker compose exec acme-nats nc -zv cloud-hub 7422
```

**Agent can't discover cross-org:**
```bash
# Both agents must use the same registry (connected via leaf nodes)
# Check leaf status
docker compose exec cloud-hub nats server report leafnats
```

**TLS errors:**
- Ensure CA cert is same on all three servers
- Check certificate expiry dates
- Verify hostname matches cert SAN

## Next Steps

Read the full [Cross-Org Guide](../../cross-org.md) for:
- Synadia Cloud setup (managed, $0 free tier)
- AWS/Azure/GCP deployment templates
- High Availability (3-node cloud hub cluster)
- Disaster Recovery strategies
