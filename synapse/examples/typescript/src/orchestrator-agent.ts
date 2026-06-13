// src/orchestrator-agent.ts — Delegation chain: research → summarize
import Synapse from "./synapse.js";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Orchestrator",
    description: "Coordinates research and summarization",
    capabilities: ["orchestration"],
    skills: [
      { id: "research-project", name: "Research Project", description: "Full research + summary" },
    ],
  });

  mesh.onRequest("research-project", async (payload) => {
    const topic = payload.input?.topic;
    console.log(`[Orchestrator] Starting research on: "${topic}"`);

    // Step 1: Discover research agent
    const researchers = await mesh.discover({ capabilities: ["research"] });
    if (researchers.length === 0) {
      throw new Error("No research agents available");
    }
    const researcher = researchers[0];
    console.log(`[Orchestrator] Delegating to researcher: ${researcher.name}`);

    // Step 2: Request research
    const researchResult = await mesh.request(
      researcher.id,
      "research",
      { topic },
      60000
    );
    const findings = researchResult.payload.output.findings;
    console.log(`[Orchestrator] Research complete (${findings.length} findings)`);

    // Step 3: Discover summarizer
    const summarizers = await mesh.discover({ capabilities: ["summarize"] });
    if (summarizers.length === 0) {
      throw new Error("No summarizer agents available");
    }
    const summarizer = summarizers[0];
    console.log(`[Orchestrator] Delegating to summarizer: ${summarizer.name}`);

    // Step 4: Request summary
    const summaryResult = await mesh.request(summarizer.id, "summarize", {
      findings,
      format: "brief",
    });
    const summary = summaryResult.payload.output.summary;
    console.log(`[Orchestrator] Summary generated`);

    return {
      topic,
      findings,
      summary,
      research_agent: researcher.name,
      summarize_agent: summarizer.name,
    };
  });

  console.log("Orchestrator agent online");

  process.on("SIGINT", async () => {
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
