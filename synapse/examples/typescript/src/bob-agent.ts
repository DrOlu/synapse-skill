// src/bob-agent.ts — Bob registers with a "chat" skill and responds to requests
import Synapse from "./synapse.js";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Bob's Agent",
    description: "Friendly chat agent",
    capabilities: ["chat"],
    skills: [{ id: "chat", name: "Chat", description: "Chat with Bob" }],
  });

  mesh.onRequest("chat", (payload) => {
    const text = payload.input?.text;
    console.log(`[Bob] Received: "${text}"`);
    return { text: `Bob says: Got your message! You said "${text}"` };
  });

  console.log("Bob agent online, waiting for messages...");
  process.on("SIGINT", async () => { await mesh.close(); process.exit(0); });
}

main().catch(console.error);
