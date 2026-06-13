// bob_caller.mjs — Native Synapse agent that calls the bridged Flask agent
import Synapse from "synapse-nats-sdk";

const natsUrl = process.env.NATS_URL || "nats://nats:4222";

async function main() {
  const mesh = await Synapse.connect(natsUrl);
  await mesh.register({
    name: "Bob Caller Agent",
    capabilities: ["caller"],
    skills: [],
  });

  console.log("Bob agent online. Waiting 3s for bridge to settle...");
  await new Promise(r => setTimeout(r, 3000));

  // Discover the Flask agent through Synapse mesh
  const agents = await mesh.discover({ capabilities: ["chat"] });
  const flask = agents.find(a => a.name === "Flask Chat Agent");

  if (!flask) {
    console.log("❌ Could not find Flask agent in mesh!");
    await mesh.close();
    process.exit(1);
  }

  console.log(`✅ Found Flask agent: ${flask.id}`);

  // Call chat
  const chatResult = await mesh.request(flask.id, "chat", { text: "Hello from Bob!" });
  console.log("Chat result:", JSON.stringify(chatResult.payload?.output));

  // Call summarize
  const sumResult = await mesh.request(flask.id, "summarize", {
    text: "The quick brown fox jumps over the lazy dog and then some more words here"
  });
  console.log("Summarize result:", JSON.stringify(sumResult.payload?.output));

  await mesh.close();
}

main().catch(console.error);
