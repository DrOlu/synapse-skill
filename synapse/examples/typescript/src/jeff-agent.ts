// src/jeff-agent.ts — Jeff discovers Bob and sends a test message
import Synapse from "./synapse.js";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Jeff's Agent",
    capabilities: [],
    skills: [],
  });

  console.log("Jeff agent online, discovering Bob...");

  const agents = await mesh.discover({ capabilities: ["chat"] });
  const bob = agents.find((a) => a.name === "Bob's Agent");

  if (!bob) {
    console.log("Could not find Bob! Is bob-agent.ts running?");
    await mesh.close();
    return;
  }

  console.log(`Found Bob: ${bob.name} (${bob.id})`);

  const response = await mesh.request(bob.id, "chat", { text: "Hey Bob, how's it going?" });
  console.log(`Bob's response: ${JSON.stringify(response.payload.output)}`);

  await mesh.close();
}

main().catch(console.error);
