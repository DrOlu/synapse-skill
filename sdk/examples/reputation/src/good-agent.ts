// good-agent.ts — Reliable agent (always succeeds, fast).

import Synapse from "synapse-nats-sdk";

async function main() {
  const mesh = await Synapse.connect(process.env.NATS_URL || "nats://localhost:4222");

  await mesh.register({
    name: "Good Chat Agent",
    description: "Always responds, always succeeds",
    capabilities: ["chat"],
    skills: [
      { id: "respond", name: "Respond to chat", description: "Reliable chat responses" },
    ],
  });

  console.log("[Good Agent] Registered and ready to chat!");

  mesh.onRequest("respond", async (payload) => {
    // Simulate 100-300ms work
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    const name = payload?.input?.name || "friend";
    return {
      greeting: `Hello ${name}! I'm the good agent.`,
      mood: "cheerful",
      timestamp: new Date().toISOString(),
    };
  });
}

main().catch((e) => {
  console.error("[Good Agent] Fatal:", e);
  process.exit(1);
});
