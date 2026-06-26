# Synapse Protocol Reference

Complete, self-contained reference for the Synapse protocol as used by
`synapse-client`. Keep this beside `client.py`.

## 1. Envelope

Every message on the mesh is a JSON envelope.

### Standard fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `v` | string | yes | Protocol version (`"1.0.0"`) |
| `id` | string | yes | Unique message ID (UUID) |
| `type` | string | yes | `request` \| `respond` \| `emit` \| `register` \| `discover` \| `heartbeat` \| `task_update` |
| `ts` | string | yes | ISO 8601 UTC timestamp |
| `from` | string | yes | Sender agent ID |
| `to` | string | no | Recipient agent ID (events omit it) |
| `task_id` | string | no | Task this message belongs to |
| `in_reply_to` | string | no | ID of message being replied to |
| `context_id` | string | no | Groups related tasks into a session |
| `trace` | object | yes | `{trace_id, span_id, parent_span_id?}` — W3C-compatible |
| `payload` | any | no | Message content (varies by type) |
| `artifacts` | array | no | File attachments / deliverables |
| `error` | object | no | `{code, message, retryable}` |
| `meta` | object | no | Arbitrary metadata |

### Example (request)

```json
{
  "v": "1.0.0",
  "id": "0192…",
  "type": "request",
  "ts": "2026-06-23T00:05:05Z",
  "from": "agentspan-daily",
  "to": "grip-cli-001",
  "task_id": "bmc-daily-2026-06-22",
  "trace": {"trace_id":"bmc-daily-2026-06-22","span_id":"0192…"},
  "payload": {"skill":"complex-task","task_id":"bmc-daily-2026-06-22",
              "text":"Query BMC for incidents on 2026-06-22…"}
}
```

### `payload` shapes by type

| `type` | `payload` |
|--------|-----------|
| `register` | `{"manifest": <AgentManifest>}` |
| `deregister` | `{}` |
| `discover` | `{"capabilities": [...], "id": "?"}` |
| `request` | `{"skill": "...", "task_id": "...", "text": "...", "message": ...}` or file-transfer phases (see §5) |
| `respond` | `{"result": ...}` (or `error` at top level) |
| `emit` | any event data |
| `heartbeat` | `{"agent_id": "...", "timestamp": "..."}` |
| `task_update` | `{"state": "...", ...}` (published to `mesh.task.<id>.update`) |

## 2. Subject namespace

```
mesh.registry.register            publish   announce manifest
mesh.registry.deregister          publish   remove manifest
mesh.registry.discover            req/reply find by capability
mesh.registry.discover.ranked     req/reply reliability-ranked (reputation svc)
mesh.registry.get.{agent_id}      req/reply fetch one manifest

mesh.agent.{agent_id}.inbox       req/reply send a request to an agent
mesh.agent.{agent_id}.status      publish   status updates (optional)

mesh.task.{task_id}.update        publish   task state transition
mesh.task.{task_id}.stream        publish   streaming response tokens

mesh.event.{type}                 publish   broadcast event
mesh.event.heartbeat.{agent_id}   (legacy)  prefer mesh.heartbeat.* below
mesh.heartbeat.{agent_id}         publish   unified heartbeat subject

mesh.approval.>                   pub/sub   approval workflow
mesh.audit.{agent_id}.head        publish   tamper-evident audit
mesh.event.reputation.penalty.>   pub/sub   liar-flagging events
```

### Wildcards

| Token | Matches | Example |
|-------|---------|---------|
| `*` | one token | `mesh.event.*` matches `mesh.event.x` not `mesh.event.a.b` |
| `>` | one+ tokens, must be last | `mesh.event.>` matches all sub-events |

### Monitoring (NATS native)

```
http://<host>:8222/varz      server info
http://<host>:8222/connz      connections (+ ?subs=1 for subscription list)
http://<host>:8222/subsz      subscription stats
http://<host>:8222/healthz    health
http://<host>:8222/jsz        JetStream stats (check api.errors == 0)
http://<host>:8222/leafz      leaf nodes
```

## 3. Task state machine

Every `request` creates a task with this lifecycle.

```
submitted ──▶ working ──▶ completed | failed | canceled
                │  ▲
                ▼  │
          input_required   (needs more info from requester)
          auth_required     (needs authorization)
```

| State | Can transition to |
|-------|-------------------|
| `submitted` | `working`, `failed`, `canceled` |
| `working` | `completed`, `failed`, `canceled`, `input_required`, `auth_required` |
| `input_required` | `working`, `failed`, `canceled` |
| `auth_required` | `working`, `failed`, `canceled` |
| `completed` / `failed` / `canceled` | (terminal — no transitions) |

- Tasks are persisted in the `TASK_STORE` KV bucket (JetStream-backed).
- `request_long()` polls `TASK_STORE` for a terminal state.
- To retry a terminal task, create a new task and link via `context_id`.
- State transitions publish to `mesh.task.<task_id>.update`.

## 4. Error codes

| Code | Name | Retryable | Meaning |
|------|------|-----------|---------|
| 1001 | TRANSPORT_TIMEOUT | yes | request timed out |
| 1002 | TRANSPORT_NO_RESPONDERS | no | nobody listening on that subject |
| 2001 | INVALID_ENVELOPE | no | message couldn't be decoded |
| 2002 | INVALID_MANIFEST | no | manifest missing required fields |
| 3001 | SKILL_NOT_FOUND | no | agent doesn't have that skill |
| 3002 | AGENT_UNAVAILABLE | yes | agent offline / unreachable |
| 3003 | TASK_INVALID_TRANSITION | no | illegal state change |
| 3004 | IDENTITY_MISMATCH | no | envelope `from` ≠ manifest / signature invalid |
| 4001 | OVERLOADED | yes | agent too busy |
| 4002 | RATE_LIMITED | yes | too many requests |
| 4003 | GOVERNANCE_DENIED | no | blocked by policy |
| 4004 | APPROVAL_REQUIRED | yes | task → `input_required` pending approver |
| 4005 | POLICY_EVALUATION_FAILED | no | gate couldn't evaluate (fail-closed → deny) |
| 5001 | INTERNAL_ERROR | yes | agent internal failure |

Retry only when `retryable: true`. Exponential backoff: `delay = base * 2^attempt` (base 100 ms).

## 5. Heartbeat format (unified)

All SDKs publish to `mesh.heartbeat.{agent_id}`:

```json
{
  "v": "1.0.0",
  "id": "uuid",
  "type": "heartbeat",
  "ts": "2026-01-15T12:34:56.789Z",
  "from": "agent-id",
  "payload": {"agent_id": "agent-id", "timestamp": "2026-01-15T12:34:56.789Z"}
}
```

Standard interval: 30 s. Subscribe with `mesh.heartbeat.>` to monitor all agents.

## 6. File transfer protocol (chunked)

`send_file()` publishes these phases to `mesh.agent.<to>.inbox`:

1. **init** — `payload.file_transfer=true, phase="init"`, with `filename`, `action`,
   `total_bytes`, `total_chunks`, `sha256`.
2. **chunk** (per chunk) — `phase="chunk"`, `index`, `data_b64` (base64 chunk, ~96 KB).
3. **done** — `phase="done"`, `transfer_id`, `action`, `filename`, `sha256`.
   The target reassembles, verifies the digest, dispatches to its skill inbox,
   and writes a result task to `TASK_STORE`.

The caller polls `TASK_STORE` for the result (see `request_long`).

## 7. HTTP bridge (for REST-only agents)

If a mesh exposes an HTTP bridge, plain HTTP clients can participate with no
NATS code:

```
POST /mesh/discover      {"capabilities": [...]}            → {"agents":[...]}
POST /mesh/request       {"agentId":"...","skill":"...",
                          "input":{"text":"..."},
                          "timeout":30.0}                   → {"output":{...}} | {"error":...,"code":...,"retryable":...}
GET  /mesh/health                                            → health
```

REST agents themselves expose normal REST endpoints (`POST /skill/chat`); the
bridge proxies between those and the corresponding `mesh.agent.{id}.inbox`
NATS subjects.
