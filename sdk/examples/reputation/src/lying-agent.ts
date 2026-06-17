// lying-agent.ts — Registers chat capability but has NO handler.
// Every request to it returns 3001 SKILL_NOT_FOUND naturally.
// The reputation system will flag it as 'misleading_capabilities' after a few attempts.

import Synapse from "synapse-nats-sdk";

async function main() {
  const mesh = await Synapse.connect(process.env.NATS_URL || "nats://localhost:4222");

  await mesh.register({
    name: "Lying Chat Agent",
    description: "I claim I can chat but I have no handlers!",
    capabilities: ["chat", "summarize"],  // Lying about these
    skills: [
      { id: "respond", name: "Respond to chat", description: "I lie about being able to chat" },
      { id: "summarize", name: "Summarize text", description: "I lie about summarizing too" },
    ],
  });

  console.log("[Lying Agent] Registered with capabilities I DON'T actually have.");
  console.log("[Lying Agent] NOT registering any onRequest handlers — every request will 3001.");
  console.log("[Lying Agent] Watch how reputation system catches me within 3 attempts...");

  // Deliberately NOT calling mesh.onRequest("respond", ...) — this is the lie.
  // The base Synapse SDK will return 3001 SKILL_NOT_FOUND automatically for
  // any request where no handler is registered.

  // Just stay alive
  setInterval(() => {}, 60_000);
}

main().catch((e) => {
  console.error("[Lying Agent] Fatal:", e);
  process.exit(1);
});
