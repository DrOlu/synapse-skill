# Synapse TypeScript Complete Example

A fully working two-agent chat system using the Synapse protocol.

## Files

- `bob-agent.ts` — Agent that registers with a "chat" skill and responds to requests
- `jeff-agent.ts` — Agent that discovers Bob and sends a test message
- `synapse.ts` — The complete Synapse SDK (from typescript.md)
- `package.json` — Dependencies
- `tsconfig.json` — TypeScript config

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start NATS server (separate terminal)
nats-server

# 3. Run Bob (separate terminal)
npm run bob

# 4. Run Jeff (separate terminal)
npm run jeff
```

## What Happens

1. **Bob starts**: Registers on the mesh with `chat` capability
2. **Jeff starts**: Registers on the mesh, then runs `discover({ capabilities: ["chat"] })`
3. **Discover finds Bob**: Jeff gets Bob's manifest including inbox subject
4. **Jeff sends request**: `nats request mesh.agent.bob-001.inbox {...}`
5. **Bob receives**: Handler function processes the request
6. **Bob responds**: Returns `{ text: "Bob says: Got your message!" }`
7. **Jeff logs**: Prints Bob's response and exits

## Expected Output

**Bob terminal:**
```
Connected to NATS at nats://localhost:4222 with ID: abc-123-...
Agent "Bob's Agent" (abc-123-...) registered
Handler "chat" registered
Bob agent online, waiting for messages...
[Bob] Received: "Hey Bob, how's it going?"
```

**Jeff terminal:**
```
Connected to NATS at nats://localhost:4222 with ID: xyz-456-...
Agent "Jeff's Agent" (xyz-456-...) registered
Jeff agent online, discovering Bob...
Found Bob: Bob's Agent (abc-123-...)
Bob's response: {"text":"Bob says: Got your message! You said \"Hey Bob, how's it going?\""}
Agent xyz-456-... disconnected
```

## Docker Version

```bash
docker compose up --build
```

Starts NATS + Bob + Jeff in three containers, demonstrates full roundtrip.

## Variations

### Multi-Skill Version
See `utilities-agent.ts` for an agent with 5 different skills routed via handler functions.

### LLM Version
See `claude-agent.ts` to replace the canned chat response with a real Claude API call.

### Event Pipeline
See `document-pipeline.ts` for a pub/sub-based processing pipeline.

## Troubleshooting

**Jeff can't find Bob:**
- Both agents must connect to same NATS URL
- Bob must be running before Jeff starts (or increase Jeff's discover timeout)
- Check `nats server report subs` — should show `mesh.registry.discover` subscribers

**Request times out:**
- Verify Bob's reply handler is registered: `nats server report subs | grep inbox`
- Check Bob's logs for handler errors
- Increase request timeout: `mesh.request(..., { timeout: 10000 })`

## Next Steps

Read the full [TypeScript SDK Guide](../../typescript.md) for production patterns, authentication, Docker deployment, and JetStream persistence.
