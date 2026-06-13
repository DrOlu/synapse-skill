// src/claude-agent.ts — LLM-powered agent using Anthropic Claude
import Synapse from "./synapse.js";
import { Anthropic } from "@anthropic-ai/sdk";

const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Claude Agent",
    description: "LLM-powered agent using Claude",
    capabilities: ["llm", "chat", "analysis"],
    skills: [
      { id: "chat", name: "Chat", description: "Chat with Claude" },
      { id: "summarize", name: "Summarize", description: "Summarize text" },
    ],
  });

  mesh.onRequest("chat", async (payload) => {
    const message = payload.input?.message;
    console.log(`[Claude] Processing: "${message}"`);

    const response = await claude.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1000,
      messages: [{ role: "user", content: message }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    return { text };
  });

  mesh.onRequest("summarize", async (payload) => {
    const text = payload.input?.text;
    console.log(`[Claude] Summarizing text (${text.length} chars)`);

    const response = await claude.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Summarize this text in 2-3 sentences:\n\n${text}`,
        },
      ],
    });

    const summary = response.content[0].type === "text" ? response.content[0].text : "";
    return { summary };
  });

  console.log("Claude agent online");

  process.on("SIGINT", async () => {
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
