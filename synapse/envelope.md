# Message Envelope Reference

Complete specification for Synapse message envelopes.

## Standard Fields

```json
{
  "v": "1.0.0",
  "id": "uuid-v7",
  "type": "request|respond|emit|register|discover",
  "ts": "2026-01-15T12:34:56.789Z",
  "from": "agent-id",
  "to": "target-agent-id",
  "task_id": "uuid-v4",
  "trace": {
    "trace_id": "uuid",
    "span_id": "uuid",
    "parent_span_id": "uuid"
  },
  "payload": { ... },
  "artifacts": [ ... ],
  "error": { "code": 5001, "message": "...", "retryable": true }
}
```

## Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `v` | string | yes | Protocol version (e.g., "1.0.0") |
| `id` | string | yes | Unique message ID (UUID v7) |
| `type` | string | yes | Primitive: `register`, `discover`, `request`, `respond`, `emit` |
| `ts` | string | yes | ISO 8601 timestamp |
| `from` | string | yes | Sender agent ID |
| `to` | string | no | Recipient agent ID (events don't need this) |
| `task_id` | string | no | Task this message belongs to |
| `in_reply_to` | string | no | ID of message being replied to |
| `context_id` | string | no | Groups related tasks into session |
| `trace` | object | yes | Distributed trace context |
| `payload` | any | no | Message content (varies by type) |
| `artifacts` | array | no | File attachments or deliverables |
| `error` | object | no | Error information |
| `meta` | object | no | Arbitrary metadata |

## Error Codes

| Code | Name | Retryable | Description |
|------|------|-----------|-------------|
| 1001 | TRANSPORT_TIMEOUT | yes | Request timed out |
| 1002 | TRANSPORT_NO_RESPONDERS | no | Nobody listening on that subject |
| 2001 | INVALID_ENVELOPE | no | Message couldn't be decoded |
| 2002 | INVALID_MANIFEST | no | Manifest missing required fields |
| 3001 | SKILL_NOT_FOUND | no | Agent doesn't have that skill |
| 3002 | AGENT_UNAVAILABLE | yes | Agent offline or unreachable |
| 3003 | TASK_INVALID_TRANSITION | no | Illegal state change |
| 3004 | IDENTITY_MISMATCH | no | Envelope `from` doesn't match manifest |
| 4001 | OVERLOADED | yes | Agent too busy |
| 4002 | RATE_LIMITED | yes | Too many requests |
| 5001 | INTERNAL_ERROR | yes | Agent internal failure |

## Retry Strategy

```typescript
async function retryWithBackoff(fn, maxRetries = 5, baseDelay = 100) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!err.retryable) throw err;
      const delay = baseDelay * Math.pow(2, i);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Max retries exceeded");
}
```
