# JetStream Registry Service

Deterministic agent discovery using NATS JetStream. Replaces the probabilistic broadcast-and-wait model with a persistent, queryable registry.

## Why a Registry Service?

The original `discover()` broadcasts to `mesh.registry.discover` and collects peer responses within a time window. This is **probabilistic** — agents that are slow to respond, on high-latency networks, or temporarily disconnected are missed.

The JetStream Registry stores every agent's manifest in a durable KV store. Discovery becomes a **deterministic key-value lookup** — no time window, no missed agents, no race conditions.

| Property | Broadcast Discovery | JetStream Registry |
|----------|--------------------|--------------------|
| **Determinism** | Probabilistic | Always returns current state |
| **Latency** | windowMs (1–5s) | <1ms (KV lookup) |
| **Offline agents** | Missed if slow to respond | Still discoverable (stale until TTL) |
| **Persistence** | None (in-memory) | JetStream KV (survives restart) |
| **Scalability** | O(N) broadcast | O(1) lookup |
| **Complexity** | Zero infra | Requires JetStream enabled |

---

## Architecture

```
Agent A ──register──> JetStream KV Store (mesh.registry)
                          │
Agent B ──discover──> JetStream KV Store ──> returns [Agent A manifest]
                          │
Agent C ──discover──> JetStream KV Store ──> returns [Agent A manifest]
```

The KV store key is the agent ID. The value is the agent manifest JSON.

---

## Setup

### 1. Enable JetStream

```bash
nats-server -js
```

### 2. Create the Registry KV Bucket

```bash
nats kv add MESH_REGISTRY \
  --history=1 \
  --ttl=120s \
  --description="Synapse agent registry"
```

- `--history=1`: Only keep the latest registration per agent
- `--ttl=120s`: Auto-expire registrations after 2 minutes (agents must re-register before this)

### 3. Verify

```bash
nats kv info MESH_REGISTRY
```

---

## Registry Service Implementation

### TypeScript

```typescript
// src/registry.ts — JetStream-backed registry service
import { Synapse, Envelope, AgentManifest, DiscoverFilter } from "./synapse.js";
import { JSONCodec } from "nats";

const jc = JSONCodec();

const KV_BUCKET = "MESH_REGISTRY";
const KV_TTL_MS = 120_000; // 2 minutes

export class RegistryService {
  private kv: any; // KV instance

  constructor(kv: any) {
    this.kv = kv;
  }

  /** Create and return a RegistryService attached to the given NATS connection */
  static async create(nc: any): Promise<RegistryService> {
    const js = nc.jetstream();
    let kv: any;
    try {
      kv = await js.views.kv(KV_BUCKET, { ttl: KV_TTL_MS });
    } catch {
      // Bucket doesn't exist yet — create it
      await js.views.kv(KV_BUCKET, { ttl: KV_TTL_MS });
      kv = await js.views.kv(KV_BUCKET, { ttl: KV_TTL_MS });
    }
    return new RegistryService(kv);
  }

  /** Store an agent manifest in the registry */
  async put(manifest: AgentManifest): Promise<void> {
    await this.kv.put(manifest.id, jc.encode(manifest));
  }

  /** Remove an agent from the registry */
  async delete(agentId: string): Promise<void> {
    await this.kv.delete(agentId);
  }

  /** Get a specific agent by ID */
  async get(agentId: string): Promise<AgentManifest | null> {
    try {
      const entry = await this.kv.get(agentId);
      return jc.decode(entry.value) as AgentManifest;
    } catch {
      return null;
    }
  }

  /** List all registered agents, optionally filtering */
  async list(filter?: DiscoverFilter): Promise<AgentManifest[]> {
    const keys = await this.kv.keys();
    const agents: AgentManifest[] = [];

    for await (const key of keys) {
      try {
        const entry = await this.kv.get(key);
        const manifest = jc.decode(entry.value) as AgentManifest;

        // Apply filters
        if (filter?.capabilities) {
          if (!filter.capabilities.every(c => manifest.capabilities.includes(c))) continue;
        }
        if (filter?.skill_ids) {
          const agentSkillIds = manifest.skills.map(s => s.id);
          if (!filter.skill_ids.every(sid => agentSkillIds.includes(sid))) continue;
        }
        if (filter?.availability && manifest.availability !== filter.availability) continue;

        agents.push(manifest);
      } catch {
        // Key may have been deleted between keys() and get()
        continue;
      }
    }

    return agents;
  }
}
```

### Integration with Synapse SDK

```typescript
// src/synapse-registry.ts — Synapse subclass that uses the registry
import Synapse from "./synapse.js";
import { RegistryService } from "./registry.js";

export class RegistrySynapse extends Synapse {
  private registry?: RegistryService;

  static async connect(url?: string, opts?: any): Promise<RegistrySynapse> {
    const mesh = await Synapse.connect(url, opts) as any;
    const self = new RegistrySynapse(mesh.nc);
    self.id = mesh.id;
    self.registry = await RegistryService.create(mesh.nc);

    // Watch for register/deregister events to keep KV in sync
    await self.setupRegistrySync();

    return self;
  }

  private async setupRegistrySync() {
    // Subscribe to registration events and mirror to KV
    const sub = this.nc.subscribe("mesh.registry.register");
    (async () => {
      for await (const msg of sub) {
        const envelope = JSON.parse(new TextDecoder().decode(msg.data));
        if (envelope.payload && this.registry) {
          await this.registry.put(envelope.payload);
        }
      }
    })();

    const deregSub = this.nc.subscribe("mesh.registry.deregister");
    (async () => {
      for await (const msg of deregSub) {
        const envelope = JSON.parse(new TextDecoder().decode(msg.data));
        if (envelope.payload?.id && this.registry) {
          await this.registry.delete(envelope.payload.id);
        }
      }
    })();
  }

  /** Deterministic discover — queries the KV store directly */
  async discoverDeterministic(filter?: any): Promise<any[]> {
    if (!this.registry) return [];
    return this.registry.list(filter);
  }

  /** Get a specific agent by ID — O(1) lookup */
  async getAgent(agentId: string): Promise<any | null> {
    if (!this.registry) return null;
    return this.registry.get(agentId);
  }
}
```

### Usage

```typescript
import { RegistrySynapse } from "./synapse-registry.js";

const mesh = await RegistrySynapse.connect("nats://localhost:4222");

await mesh.register({
  name: "My Agent",
  capabilities: ["chat"],
  skills: [{ id: "chat", name: "Chat", description: "Chat" }],
});

// Deterministic discovery — no time window, no missed agents
const chatAgents = await mesh.discoverDeterministic({ capabilities: ["chat"] });

// Direct lookup by ID
const agent = await mesh.getAgent("bob-001");
```

---

### Python Implementation

```python
# registry.py — JetStream-backed registry service
import json
from typing import List, Optional, Dict, Any


class RegistryService:
    """JetStream-backed agent registry for deterministic discovery."""

    KV_BUCKET = "MESH_REGISTRY"

    def __init__(self, kv):
        self.kv = kv

    @classmethod
    async def create(cls, nc) -> "RegistryService":
        js = nc.jetstream()
        try:
            kv = await js.create_key_value(bucket=cls.KV_BUCKET, ttl=120)
        except Exception:
            kv = await js.key_value(bucket=cls.KV_BUCKET)
        return cls(kv)

    async def put(self, manifest: Dict[str, Any]) -> None:
        await self.kv.put(manifest["id"], json.dumps(manifest).encode())

    async def delete(self, agent_id: str) -> None:
        await self.kv.delete(agent_id)

    async def get(self, agent_id: str) -> Optional[Dict[str, Any]]:
        try:
            entry = await self.kv.get(agent_id)
            return json.loads(entry.value.decode())
        except Exception:
            return None

    async def list(self, capabilities: Optional[List[str]] = None,
                   availability: Optional[str] = None) -> List[Dict[str, Any]]:
        agents = []
        keys = await self.kv.keys()
        for key in keys:
            try:
                entry = await self.kv.get(key)
                manifest = json.loads(entry.value.decode())

                if capabilities and not all(c in manifest.get("capabilities", []) for c in capabilities):
                    continue
                if availability and manifest.get("availability") != availability:
                    continue

                agents.append(manifest)
            except Exception:
                continue
        return agents
```

---

### Go Implementation

```go
// registry/registry.go
package registry

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/nats-io/nats.go"
)

const KvBucket = "MESH_REGISTRY"

type RegistryService struct {
	kv nats.KeyValue
	mu sync.RWMutex
}

func NewRegistryService(nc *nats.Conn) (*RegistryService, error) {
	js, err := nc.JetStream()
	if err != nil {
		return nil, fmt.Errorf("jetstream: %w", err)
	}

	kv, err := js.CreateKeyValue(&nats.KeyValueConfig{
		Bucket: KvBucket,
		TTL:    120 * 1e9, // 120 seconds
	})
	if err != nil {
		// Bucket may already exist
		kv, err = js.KeyValue(KvBucket)
		if err != nil {
			return nil, fmt.Errorf("kv bucket: %w", err)
		}
	}

	return &RegistryService{kv: kv}, nil
}

func (r *RegistryService) Put(manifest map[string]interface{}) error {
	id, _ := manifest["id"].(string)
	data, _ := json.Marshal(manifest)
	_, err := r.kv.Put(id, data)
	return err
}

func (r *RegistryService) Delete(agentID string) error {
	return r.kv.Delete(agentID)
}

func (r *RegistryService) Get(agentID string) (map[string]interface{}, error) {
	entry, err := r.kv.Get(agentID)
	if err != nil {
		return nil, err
	}
	var manifest map[string]interface{}
	json.Unmarshal(entry.Value(), &manifest)
	return manifest, nil
}

func (r *RegistryService) List(capabilities []string) ([]map[string]interface{}, error) {
	keys, err := r.kv.Keys()
	if err != nil {
		return nil, err
	}

	var agents []map[string]interface{}
	for _, key := range keys {
		entry, err := r.kv.Get(key)
		if err != nil {
			continue
		}
		var manifest map[string]interface{}
		json.Unmarshal(entry.Value(), &manifest)

		if len(capabilities) > 0 {
			if caps, ok := manifest["capabilities"].([]interface{}); ok {
				matched := true
				for _, cap := range capabilities {
					capStr := cap.(string)
					found := false
					for _, c := range caps {
						if c.(string) == capStr {
							found = true
							break
						}
					}
					if !found {
						matched = false
						break
					}
				}
				if !matched {
					continue
				}
			}
		}

		agents = append(agents, manifest)
	}
	return agents, nil
}
```

---

## CLI Setup

```bash
# Create the KV bucket
nats kv add MESH_REGISTRY --history=1 --ttl=120s

# Register an agent
nats kv put MESH_REGISTRY bob-001 '{"id":"bob-001","name":"Bob","capabilities":["chat"]}'

# Discover all chat agents (deterministic)
nats kv status MESH_REGISTRY  # list keys

# Get specific agent
nats kv get MESH_REGISTRY bob-001

# Deregister
nats kv delete MESH_REGISTRY bob-001
```

---

## TTL and Heartbeat Strategy

The KV store uses a **TTL of 120 seconds**. Agents must re-register before the TTL expires. The SDK's heartbeat loop (30s interval) handles this automatically:

1. Agent registers at t=0
2. Heartbeat at t=30s → re-puts manifest to KV (resets TTL)
3. Heartbeat at t=60s → re-puts manifest to KV
4. Heartbeat at t=90s → re-puts manifest to KV
5. If agent crashes at t=95s, TTL expires at t=95+120=215s
6. Agent disappears from registry ~2 minutes after crash

### Heartbeat → KV Re-put Integration

```typescript
// In the SDK heartbeat loop, also re-put to KV
private _startHeartbeat(intervalMs: number = 30000): void {
  this.heartbeatInterval = setInterval(async () => {
    if (this.manifest) {
      // Publish heartbeat event (for subscribers)
      this.nc.publish(`mesh.heartbeat.${this.id}`, sc.encode(new Date().toISOString()));

      // Re-register in KV (resets TTL)
      if (this.registry) {
        await this.registry.put(this.manifest);
      }
    }
  }, intervalMs);
}
```

---

## Migration: Broadcast → Registry

The registry is **backward-compatible** with broadcast discovery. Both can coexist:

```typescript
// Hybrid discover: try registry first, fall back to broadcast
async discover(filter?: DiscoverFilter): Promise<AgentManifest[]> {
  // Try deterministic registry first
  if (this.registry) {
    const agents = await this.registry.list(filter);
    if (agents.length > 0) return agents;
  }

  // Fall back to broadcast discovery
  return super.discover(filter);
}
```

This means you can enable JetStream + KV incrementally without breaking existing agents.

---

## Monitoring

```bash
# Check KV bucket status
nats kv info MESH_REGISTRY

# List all registered agents
nats kv status MESH_REGISTRY

# Watch for changes in real-time
nats kv watch MESH_REGISTRY
```

### Prometheus Metrics

The registry KV bucket exposes these via the NATS monitoring endpoint:

| Metric | Meaning |
|--------|---------|
| `nats_kv_entries` | Number of registered agents |
| `nats_kv_size` | Total bytes stored |
| `nats_kv_history` | Operations count |

---

## Next Steps

- [Setup Guide](./setup.md) — JetStream configuration
- [Subjects Reference](./subjects.md) — Registry subject namespace
- [Security](./security.md) — KV bucket permissions
