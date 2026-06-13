// agents/jeff-agent.ts — Jeff discovers Bob and sends a test message
import Synapse from "./synapse.js";

async function main() {
  const natsUrl = process.env.NATS_URL || "nats://localhost:4222";
  const mesh = await Synapse.connect(natsUrl);

  await mesh.register({
    name: process.env.AGENT_NAME || "Jeff's Agent",
    capabilities: [],
    skills: [],
  });

  console.log("Jeff agent online, discovering Bob...");

  // Retry discovery a few times (agents may still be starting)
  let bob: any = null;
  for (let i = 0; i < 5; i++) {
    const agents = await mesh.discover({ capabilities: ["chat"] });
    bob = agents.find((a) => a.name === "Bob's Agent");
    if (bob) break;
    console.log(`Attempt ${i + 1}: Bob not found, retrying in 2s...`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!bob) {
    console.log("Could not find Bob!");
    await mesh.close();
    return;
  }

  console.log(`Found Bob: ${bob.name} (${bob.id})`);

  const response = await mesh.request(bob.id, "chat", { text: "Hey Bob, how's it going?" });
  console.log(`Bob's response: ${JSON.stringify(response.payload.output)}`);

  await mesh.close();
}

main().catch(console.error);
