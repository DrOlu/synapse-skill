// flaky-agent.ts — Unreliable agent (fails 50% of the time, slow).

import Synapse from "synapse-nats-sdk";
import { SynapseError } from "synapse-nats-sdk";

async function main() {
  const mesh = await Synapse.connect(process.env.NATS_URL || "nats://localhost:4222");

  await mesh.register({
    name: "Flaky Chat Agent",
    description: "Sometimes works, sometimes fails",
    capabilities: ["chat"],
    skills: [
      { id: "respond", name: "Respond to chat", description: "Chat with me (maybe)" },
    ],
  });

  console.log("[Flaky Agent] Registered. I fail 50% of the time on purpose.");

  mesh.onRequest("respond", async (payload) => {
    // Simulate slow responses (500ms — 3s)
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 2500));

    // 50% chance of failure
    if (Math.random() < 0.5) {
      throw new SynapseError(
        "Flaky agent experienced an internal error",
        5001, // INTERNAL_ERROR
        true  // retryable
      );
    }

    return {
      greeting: `Hey. I'm the flaky agent. You got lucky this time.`,
      mood: "unpredictable",
      timestamp: new Date().toISOString(),
    };
  });
}

main().catch((e) => {
  console.error("[Flaky Agent] Fatal:", e);
  process.exit(1);
});
