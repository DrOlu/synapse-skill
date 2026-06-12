# Subject Namespace Reference

Complete map of Synapse NATS subjects.

## Registry Subjects

| Subject | Direction | Purpose |
|---------|-----------|---------|
| `mesh.registry.register` | publish | Announce agent manifest |
| `mesh.registry.deregister` | publish | Remove agent from registry |
| `mesh.registry.discover` | request/reply | Find agents by capabilities |
| `mesh.registry.get.{agent_id}` | request/reply | Fetch specific agent manifest |

## Agent Inbox Subjects

| Subject | Direction | Purpose |
|---------|-----------|---------|
| `mesh.agent.{agent_id}.inbox` | request/reply | Send request to agent |
| `mesh.agent.{agent_id}.status` | publish | Agent status updates |

## Task / Stream Subjects

| Subject | Purpose |
|---------|---------|
| `mesh.task.{task_id}.update` | Task state transitions |
| `mesh.task.{task_id}.stream` | Streaming response tokens |

## Event Subjects

| Pattern | Examples |
|---------|----------|
| `mesh.event.*` | Any event |
| `mesh.event.system.*` | System-level events |
| `mesh.event.document.*` | Document pipeline events |
| `mesh.event.logs.*` | Log events |
| `mesh.event.heartbeat.*` | Agent heartbeats |

## Wildcard Rules

| Token | Matches | Example |
|-------|---------|---------|
| `*` | Single token | `mesh.event.*` matches `mesh.event.test`, not `mesh.event.a.b` |
| `>` | One or more tokens (must be last) | `mesh.event.>` matches all sub-events |

## Heartbeat Subjects

```
mesh.heartbeat.{agent_id}
mesh.heartbeat.>   // subscribe to all
```

## Monitoring (NATS native)

```bash
# Server info
curl http://localhost:8222/varz

# Connections
curl http://localhost:8222/connz

# Subscriptions
curl http://localhost:8222/subsz?subs=1

# Routes (cluster)
curl http://localhost:8222/routez

# Leaf nodes
curl http://localhost:8222/leafz

# Health
curl http://localhost:8222/healthz
```
