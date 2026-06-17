// tester.ts — Runs the reputation demo scenario.
//
// Scenario:
//   Round 1: discoverRanked to see initial state (everyone new, scores ~0.1)
//   Round 2: Force requests to each individual agent to gather data
//   Round 3: Check reputation scores (good > flaky >> lying)
//   Round 4: discoverRanked now excludes the flagged liar
//   Round 5: smartRequest with automatic failover

import Synapse from "synapse-nats-sdk";
import { ReputationStore } from "synapse-nats-sdk/reputation";

const log = (msg: string) => console.log(`\x1b[36m[Tester]\x1b[0m ${msg}`);
const green = (msg: string) => console.log(`\x1b[32m${msg}\x1b[0m`);
const red = (msg: string) => console.log(`\x1b[31m${msg}\x1b[0m`);
const yellow = (msg: string) => console.log(`\x1b[33m${msg}\x1b[0m`);

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  log("Connecting to NATS...");
  const mesh = await Synapse.connect(process.env.NATS_URL || "nats://localhost:4222");

  await mesh.register({
    name: "Tester",
    capabilities: ["test"],
    skills: [{ id: "test", name: "Test", description: "Runs tests" }],
  });

  const reputation = new ReputationStore(mesh, {
    kvBucket: "REPUTATION",
    autoSubscribe: true,
    minimumSampleSize: 3,
    lyingThreshold: { consecutive: 3, ratio: 0.9, minAttempts: 3 },
  });
  await reputation.initialize();

  log("Letting agents register (5s warmup)...");
  await sleep(5000);

  // ============================================================
  // ROUND 1: Discover all chat agents
  // ============================================================
  log("");
  log("═══ Round 1: Discover all chat agents ═══");
  const all = await mesh.discover({ capabilities: ["chat"] });
  log(`${all.length} agents found with 'chat' capability:`);
  for (const a of all) log(`  • ${a.name} (${a.id})`);

  // ============================================================
  // ROUND 2: Initial ranked discovery (no data yet)
  // ============================================================
  log("");
  log("═══ Round 2: discoverRanked (no reputation data yet) ═══");
  const initial = await reputation.discoverRanked({ capabilities: ["chat"] });
  log("All agents appear with placeholder score ~0.1 (no data):");
  for (const r of initial) {
    log(`  ${r.manifest.name} → score=${r.aggregate_score.toFixed(3)}`);
  }

  // ============================================================
  // ROUND 3: Hammer each agent to build reputation data
  // ============================================================
  log("");
  log("═══ Round 3: Sending requests to build reputation ═══");

  for (const agent of all) {
    log(`\nTesting agent: ${agent.name} (${agent.id})`);
    let successes = 0;
    let failures = 0;
    let notFound = 0;

    for (let i = 0; i < 6; i++) {
      try {
        const result = await mesh.request(agent.id, "respond", { name: `test-${i}` }, 5000);
        successes++;
        process.stdout.write(".");

        // Record success with measured latency for the reputation store
        const record = await reputation.getRecord(agent.id, "respond");
        if (record) {
          // The store auto-observed via task updates; nothing to do
        }
      } catch (err: any) {
        if (err?.code === 3001) {
          notFound++;
          process.stdout.write("X");
        } else {
          failures++;
          process.stdout.write("f");
        }
      }
    }

    console.log("");
    if (notFound > 0) {
      red(`  ${notFound}/6 SKILL_NOT_FOUND (3001) — lying!`);
    } else if (failures > 0) {
      yellow(`  ${successes}/6 success, ${failures}/6 failures`);
    } else {
      green(`  ${successes}/6 success ✓`);
    }
  }

  log("\nWaiting for reputation service to catch up...");
  await sleep(3000);

  // ============================================================
  // ROUND 4: Check reputation scores
  // ============================================================
  log("");
  log("═══ Round 4: Reputation scores after testing ═══");
  const ranked = await reputation.discoverRanked({
    capabilities: ["chat"],
    includeFlagged: true,
  });

  for (const r of ranked) {
    const score = r.scores.respond;
    if (!score) {
      log(`  ${r.manifest.name}: no data`);
      continue;
    }
    const flagged = score.flagged ? " ⚠️  MISLEADING" : "";
    const line = `  ${r.manifest.name.padEnd(25)} score=${score.score.toFixed(3).padEnd(6)} ` +
                 `rate=${(score.success_rate * 100).toFixed(0).padStart(3)}% ` +
                 `avg=${score.avg_latency_ms.toFixed(0)}ms${flagged}`;
    if (score.flagged) red(line);
    else if (score.score > 0.7) green(line);
    else yellow(line);
  }

  // ============================================================
  // ROUND 5: discoverRanked EXCLUDING flagged agents
  // ============================================================
  log("");
  log("═══ Round 5: discoverRanked(includeFlagged=false) ═══");
  const trusted = await reputation.discoverRanked({
    capabilities: ["chat"],
    includeFlagged: false,
  });
  log("Only non-flagged agents returned:");
  for (const r of trusted) {
    const score = r.scores.respond || { score: 0, success_rate: 0, avg_latency_ms: 0 };
    green(`  ✓ ${r.manifest.name} → score=${score.score.toFixed(3)}`);
  }

  // ============================================================
  // ROUND 6: smartRequest with automatic failover
  // ============================================================
  log("");
  log("═══ Round 6: smartRequest (auto-routes to best agent) ═══");

  for (let i = 0; i < 5; i++) {
    try {
      const result = await reputation.smartRequest(
        "chat",
        "respond",
        { name: `round6-${i}` },
        5000,
        3
      );
      green(`  ✓ Request ${i}: ${JSON.stringify(result.payload.output).slice(0, 80)}`);
    } catch (err: any) {
      red(`  ✗ Request ${i}: ${err.message}`);
    }
  }

  // ============================================================
  // ROUND 7: Final stats
  // ============================================================
  log("");
  log("═══ Round 7: Final statistics ═══");
  const stats = await reputation.stats();
  log(`Total agents tracked: ${stats.total_agents}`);
  log(`Total records: ${stats.total_records}`);
  log(`Flagged skills: ${stats.flagged_skills}`);
  log(`Average score: ${stats.avg_score.toFixed(3)}`);

  log("\n✅ Demo complete. Notice how the lying agent got auto-excluded!");
  await mesh.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("[Tester] Fatal:", e);
  process.exit(1);
});
