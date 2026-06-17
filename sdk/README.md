# Synapse SDK

Build multi-agent systems on NATS with 6 primitives: register, discover, request, respond, emit, subscribe.

## Install

```bash
npm install synapse-nats-sdk
```

## Quick Start

```typescript
import Synapse from "synapse-nats-sdk";

// Start Bob (chat agent)
const bob = await Synapse.connect("nats://localhost:4222");
await bob.register({ name: "Bob", capabilities: ["chat"], skills: [{ id: "chat", name: "Chat", description: "Chat with Bob" }] });
bob.onRequest("chat", (payload) => ({ text: `Bob says: ${payload.input.text}` }));

// Start Jeff (discovers Bob and chats)
const jeff = await Synapse.connect("nats://localhost:4222");
const agents = await jeff.discover({ capabilities: ["chat"] });
const result = await jeff.request(agents[0].id, "chat", { text: "Hi Bob!" });
console.log(result.payload.output); // { text: "Bob says: Hi Bob!" }
```

## Streaming (LLM tokens)

```typescript
// Caller: receives tokens incrementally
for await (const chunk of mesh.streamRequest(agentId, "chat", { message: "explain quantum" })) {
  process.stdout.write(chunk.token); // live streaming
}

// Handler: yields tokens from LLM
mesh.onStreamRequest("chat", async function* (payload) {
  const stream = anthropic.messages.stream({ model: "claude-3-5-sonnet-20241022", ... });
  for await (const event of stream) {
    if (event.type === "content_block_delta") yield { token: event.delta.text };
  }
});
```

## Documentation

Full skill documentation: [skills.sh/drolu/synapse-skill/synapse](https://www.skills.sh/drolu/synapse-skill/synapse)

## License

MIT
