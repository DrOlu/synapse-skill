// reputation-service.ts — Central reputation scoring service agent.
// Subscribes to task state transitions and builds reputation scores.
// Exposes: discover-ranked, get-record, clear-flag, leaderboard, stats skills.

import Synapse from "synapse-nats-sdk";
import { ReputationStore, createReputationServiceAgent } from "synapse-nats-sdk/reputation";

async function main() {
  console.log("[Reputation Service] Starting...");

  const mesh = await Synapse.connect(process.env.NATS_URL || "nats://localhost:4222");

  const { store, manifest } = await createReputationServiceAgent(
    mesh,
    {
      kvBucket: "REPUTATION",
      autoSubscribe: true,
      weights: { success: 0.7, speed: 0.2, freshness: 0.1 },
      maxAcceptableLatencyMs: 5000,
      minimumSampleSize: 3,
      lyingThreshold: { consecutive: 3, ratio: 0.9, minAttempts: 3 },
    },
    "Reputation Service"
  );

  console.log(`[Reputation Service] Registered as ${manifest.id}`);
  console.log("[Reputation Service] Watching task updates and scoring agents...");

  // Subscribe to penalty events and log them
  mesh.onEvent("mesh.event.reputation.penalty.>", (data) => {
    const p = data.payload;
    console.log(
      `[Reputation Service] ⚠️  PENALTY EMITTED: ${p.agent_id}/${p.skill} ` +
        `(skill_not_found=${p.skill_not_found_count}, rate=${(p.success_rate * 100).toFixed(1)}%)`
    );
  });

  // Periodic stats log
  setInterval(async () => {
    const s = await store.stats();
    console.log(
      `[Reputation Service] Stats: ${s.total_agents} agents, ` +
        `${s.total_records} records, ${s.flagged_skills} flagged, ` +
        `avg score=${s.avg_score.toFixed(3)}`
    );

    // Dump top agents
    const all = await store.getRecordsForAgent("good-agent");
    // (demo-only: print what we know)
  }, 15_000);

  // Also log every scoring decision for demo visibility
  mesh.onEvent("mesh.task.*.update", (data) => {
    const p = data.payload || {};
    if (p.state === "completed" || p.state === "failed") {
      const outcome = p.state === "completed" ? "✅" : `❌ (${p.error?.code || "?"})`;
      console.log(
        `[Reputation Service] Task update: ${p.to_agent_id || "unknown"}/${p.skill} ` +
          `${outcome} latency=${p.latency_ms || "?"}ms`
      );
    }
  });
}

main().catch((e) => {
  console.error("[Reputation Service] Fatal:", e);
  process.exit(1);
});
