# Cross-Organization Topology

Complete guide to connecting Synapse agents across companies, firewalls, and networks using NATS leaf nodes.

## The Scenario

**Acme Corp** and **Globex Inc** each run their own NATS servers behind their own firewalls. Their agents need to collaborate without:
- Opening inbound firewall ports
- Exposing internal infrastructure
- Sharing credentials between orgs
- Building custom APIs between agents

## Topology Options

### Option 1: Shared Cloud Hub (Leaf Nodes)

```
[Acme Internal]           [Cloud Hub]           [Globex Internal]
     │                         │                         │
     └──leaf node (outbound)──→│←──leaf node (outbound)──┘
                               │
                   NATS server (neutral ground)
                   Two accounts: ACME + GLOBEX
```

**All connections are outbound only** — no firewall changes needed.

### Option 2: Direct VPN / Private Network

If companies already share a VPN or private network, connect NATS servers directly via routes:

```
[Acme NATS]  ←──cluster route──→  [Globex NATS]
    │                                   │
 (internal VPN / AWS VPC Peering / Azure Peering)
```

### Option 3: Synadia Cloud (Managed)

Synadia Cloud provides a globally-distributed NATS supercluster with built-in multi-tenancy:

```
Acme Agents  ──outbound──→  Synadia Cloud  ←──outbound── Globex Agents
```

Free tier supports this exact scenario (2 accounts, 10 connections, 2 leaf nodes).

---

## Setup: Shared Cloud Hub

### Step 1: Cloud Hub Configuration

```conf
# cloud-hub.conf (runs on cloud VM)

port: 4222
http_port: 8222

# Leaf node listener (where Acme/Globex connect OUTBOUND)
leafnodes {
  port: 7422
  tls {
    cert_file: "/etc/nats/tls/hub.crt"
    key_file: "/etc/nats/tls/hub.key"
    ca_file: "/etc/nats/tls/ca.crt"
    timeout: 3
  }
}

# Account isolation
accounts {
  ACME_CORP: {
    jetstream: enabled
    
    exports: [
      { stream: "mesh.event.shared.acme.>" }
    ]
    
    imports: [
      { stream: { account: GLOBEX_INC, subject: "mesh.event.shared.globex.>" }, to: "mesh.event.shared.globex.>" }
    ]
  }

  GLOBEX_INC: {
    jetstream: enabled
    
    exports: [
      { stream: "mesh.event.shared.globex.>" }
    ]
    
    imports: [
      { stream: { account: ACME_CORP, subject: "mesh.event.shared.acme.>" }, to: "mesh.event.shared.acme.>" }
    ]
  }
}
```

### Step 2: Acme Internal Server

```conf
# acme-internal.conf

port: 4222
http_port: 8222
jetstream { store_dir: "/var/lib/nats/acme-data" }

# Connect OUTBOUND to cloud hub as leaf node
leafnodes {
  remotes: [
    {
      url: "tls://cloud-hub.example.com:7422"
      account: "ACME_CORP"
      credentials: "/etc/nats/leafnode.acme.creds"
      tls {
        ca_file: "/etc/nats/tls/ca.crt"
      }
    }
  ]
}

# Internal accounts (for agents)
accounts {
  ACME_CORP: { ... }
}
```

### Step 3: Globex Internal Server

```conf
# globex-internal.conf

port: 4222
http_port: 8222
jetstream { store_dir: "/var/lib/nats/globex-data" }

leafnodes {
  remotes: [
    {
      url: "tls://cloud-hub.example.com:7422"
      account: "GLOBEX_INC"
      credentials: "/etc/nats/leafnode.globex.creds"
      tls {
        ca_file: "/etc/nats/tls/ca.crt"
      }
    }
  ]
}

accounts {
  GLOBEX_INC: { ... }
}
```

### Step 4: Generate Credentials

```bash
# Cloud hub generates operator + accounts
nats auth createkey -t operator -n HUB_OPERATOR
nats auth createkey -t account -n ACME_CORP_LEAF
nats auth createkey -t account -n GLOBEX_LEAF

# Create leaf node credentials
nats auth mkcreds \
  --account-seed ACME_CORP_LEAF_SEED \
  --user-seed ACME_LEAF_USER_SEED \
  > leafnode.acme.creds

nats auth mkcreds \
  --account-seed GLOBEX_LEAF_SEED \
  --user-seed GLOBEX_LEAF_USER_SEED \
  > leafnode.globex.creds

# Distribute to Acme/Globex via secure channel
```

### Step 5: Start Everything

```bash
# Cloud server
nats-server -c /etc/nats/cloud-hub.conf

# Acme server (behind firewall)
nats-server -c /etc/nats/acme-internal.conf

# Globex server (behind firewall)
nats-server -c /etc/nats/globex-internal.conf
```

### Verify Cross-Org Connection

```bash
# On Acme server
nats server report leafnats
# → Should show: connected leaf to cloud-hub.example.com:7422

# On cloud hub
nats server report leafnats
# → Should show: 2 leaf nodes (Acme + Globex)
```

---

## Agent Communication Across Orgs

### Acme Agent Discovers Globex Agents

```typescript
// Acme's agent
const acmeMesh = await Synapse.connect("nats://localhost:4222", {
  // Local agent connects to Acme's internal NATS server
});

await acmeMesh.register({
  name: "Acme Backend Agent",
  capabilities: ["backend.api", "code.review"],
  skills: [
    { id: "code.review", name: "Code Review", description: "Review code changes" },
  ],
});

// Discover Globex's security agent (via shared registry on cloud hub)
const globexeAgents = await acmeMesh.discover({ capabilities: ["security.review"] });
const globexSecurity = globexeAgents.find(a => a.name.includes("Globex"));

// Request security review from Globex
const result = await acmeMesh.request(globexSecurity.id, "security.review", {
  code: "...",
  context: "new auth flow",
});

console.log(result.payload.output);
```

### Globex Agent Responds

```typescript
// Globex's agent
const globexMesh = await Synapse.connect("nats://localhost:4222", {
  // Local agent connects to Globex's internal NATS server
});

await globexMesh.register({
  name: "Globex Security Agent",
  capabilities: ["security.review"],
  skills: [
    { id: "security.review", name: "Security Review", description: "Review code for vulnerabilities" },
  ],
});

globexMesh.onRequest("security.review", async (payload) => {
  const code = payload.input.code;
  const analysis = await analyzeSecurity(code);
  return { analysis, risk_level: analysis.risk };
});
```

---

## Event Sharing

### Shared Events (Both Orgs See)

```typescript
// Acme emits a shared event
acmeMesh.emit("shared.acme.deploy.completed", {
  service: "backend-api",
  version: "1.2.3",
  commit: "abc123",
});

// Globex subscribes to shared events
globexMesh.subscribe("shared.acme.>", (event) => {
  console.log(`[Globex] Acme deployed: ${event.data.service}`);
  // Trigger Globex's compatibility testing
});
```

### Private Events (Internal Only)

```typescript
// Acme emits private event (not visible to Globex)
acmeMesh.emit("acme.internal.metrics", {
  agent: "bob-001",
  cpu: 45.2,
  memory: 78.1,
});

// Globex cannot subscribe to "acme.internal.>" — account permissions prevent it
```

---

## Security Boundaries

| Traffic | Visible To |
|---------|-----------|
| Acme agent-to-agent (internal) | Acme only |
| Globex agent-to-agent (internal) | Globex only |
| `mesh.event.shared.acme.>` | Acme + Globex |
| `mesh.event.shared.globex.>` | Acme + Globex |
| Internal metrics, logs, debugging | Only the owning org |
| Agent discovery (registry) | Both (by design) |

---

## Disaster Recovery

### Leaf Node Disconnection

If Acme's connection to the cloud hub drops:

1. **Internal agents continue working** — they still connect to Acme's internal NATS
2. **Cross-org communication pauses** — no events/requests flow between orgs
3. **Automatic reconnection** — NATS leaf node auto-reconnects when network recovers
4. **No message loss** (if JetStream enabled) — events queue up and deliver on reconnect

### Cloud Hub Failure

If the cloud hub goes down:

1. **Both internal servers keep running** — agents continue intra-org communication
2. **Cross-org traffic stops** — no way to bridge between orgs
3. **Recovery:** Start a new cloud hub instance, reconfigure leaf nodes
4. **Mitigation:** Run cloud hub as 3-node cluster for HA

---

## Cost Comparison

| Option | Monthly Cost | Maintenance |
|--------|--------------|-------------|
| Synadia Cloud (Free Tier) | $0 | None |
| Synadia Cloud (Starter) | $49 | None |
| Self-hosted (1x $5 VPS) | $5 | You operate it |
| Self-hosted HA (3x VPS) | $15 | You operate it |
| AWS Direct Connect + VPC Peering | $300+ | Complex |

**Recommendation for 2-company scenario:** Use Synadia Cloud free tier ($0) or a single $5/mo VPS running NATS with leaf node connections.

---

## Example: Complete Docker Setup

See `examples/cross-org/` for complete Docker Compose setup with:
- Cloud hub container
- Acme internal server + agents
- Globex internal server + agents
- Generated credentials
- Test script demonstrating cross-org communication

```bash
cd examples/cross-org
./setup.sh      # Generate creds
docker compose up
./test.sh       # Send cross-org request
```

---

## Summary

Cross-organization Synapse is possible today with:

✅ **Outbound-only connections** — no firewall changes
✅ **Account isolation** — each org controls their traffic
✅ **Selective sharing** — only agreed subjects cross boundaries
✅ **Production-ready** — TLS, credentials, monitoring
✅ **Low cost** — $0–$15/month for 2-company setup

Synapse protocol + NATS leaf nodes = cross-org agent collaboration without the pain.
