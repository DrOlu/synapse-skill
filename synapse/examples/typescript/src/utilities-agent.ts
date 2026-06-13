// src/utilities-agent.ts — Multi-skill agent with text and math capabilities
import Synapse from "./synapse.js";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Utilities Agent",
    description: "Common text/math utilities",
    capabilities: ["text", "math"],
    skills: [
      { id: "uppercase", name: "Uppercase", description: "Convert to uppercase" },
      { id: "reverse", name: "Reverse", description: "Reverse a string" },
      { id: "strlen", name: "String Length", description: "Count characters" },
      { id: "add", name: "Add", description: "Add two numbers" },
      { id: "multiply", name: "Multiply", description: "Multiply two numbers" },
    ],
  });

  mesh.onRequest("uppercase", (payload) => {
    const text = payload.input?.text || "";
    return { text: text.toUpperCase() };
  });

  mesh.onRequest("reverse", (payload) => {
    const text = payload.input?.text || "";
    return { text: text.split("").reverse().join("") };
  });

  mesh.onRequest("strlen", (payload) => {
    const text = payload.input?.text || "";
    return { length: text.length };
  });

  mesh.onRequest("add", (payload) => {
    const a = payload.input?.a ?? 0;
    const b = payload.input?.b ?? 0;
    return { result: a + b };
  });

  mesh.onRequest("multiply", (payload) => {
    const a = payload.input?.a ?? 0;
    const b = payload.input?.b ?? 0;
    return { result: a * b };
  });

  console.log("Utilities agent online with 5 skills");

  process.on("SIGINT", async () => {
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
