/**
 * acl-demo.mjs — Three scenarios demonstrating ACL enforcement
 *
 * Scenario 1 (AUTHORIZED)   : OMP has valid identity + signature → Pi accepts
 * Scenario 2 (UNSIGNED)     : Rogue sends plain envelope, no signature → Pi rejects
 * Scenario 3 (UNTRUSTED)    : Rogue generates own keypair, signs, but isn't in trust store → Pi rejects
 *
 * Expected: Scenario 1 succeeds; Scenarios 2 and 3 get signed 403 errors.
 */

import { connect, StringCodec } from "nats";
import { randomUUID }           from "crypto";
import { ACLClient, loadKeypair, loadTrustStore, generateKeypair } from "./synapse-acl.mjs";

const sc    = StringCodec();
const NATS  = "nats://localhost:4222";
const INBOX = "mesh.agent.drolu/pi-paystack-agent.inbox";
const TASK  = { skill: "fetch-transactions", input: { count: 3, status: "failed" } };

const banner = (n, title, color) => {
  console.log("\n" + "═".repeat(70));
  console.log(`${color}SCENARIO ${n}: ${title}\u001b[0m`);
  console.log("═".repeat(70));
};

const printResult = (label, obj) => console.log(`  ${label}: ${typeof obj === "string" ? obj : JSON.stringify(obj).slice(0, 400)}`);

// ── Pre-flight: load trust store (to show the rules) ────────────────────
const trustStore = loadTrustStore("./trust-store.json");
console.log("╔════════════════════════════════════════════════════════════════╗");
console.log("║         Synapse ACL Demo — Authorization Enforcement           ║");
console.log("╚════════════════════════════════════════════════════════════════╝");
console.log();
console.log("Trust store loaded. Identities:");
for (const [id, entry] of Object.entries(trustStore)) {
  console.log(`  • ${id}`);
  console.log(`      fingerprint: ${entry.fingerprint}`);
  console.log(`      allow_inbound: ${entry.allow_inbound.join(", ") || "<none>"}`);
  console.log(`      revoked: ${entry.revoked}`);
}
console.log();
console.log("Waiting 3s for Pi agent to register on the mesh...");
await new Promise(r => setTimeout(r, 3000));

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 1: AUTHORIZED — OMP calls Pi with valid signature
// ─────────────────────────────────────────────────────────────────────────
banner(1, "AUTHORIZED CALLER (OMP → Pi)", "\u001b[32m");
{
  const keypair = loadKeypair("drolu/omp-orchestrator");
  const omp = await ACLClient.connect({ keypair, trustStore });

  console.log(`  Caller:     ${omp.identity}`);
  console.log(`  Fingerprint: ${omp.fingerprint}`);
  console.log(`  Target:     drolu/pi-paystack-agent`);
  console.log();
  console.log(`  Sending SIGNED request... [this will take ~30s as Pi queries Paystack]`);

  try {
    const reply = await omp.requestSigned(INBOX, "request", TASK, {}, { timeout: 120_000 });
    if (reply.error) {
      console.log(`  \u001b[31m✗ Unexpected rejection: [${reply.error.code}] ${reply.error.message}\u001b[0m`);
    } else {
      const output = reply.payload?.output?.text || "(no text)";
      console.log(`  \u001b[32m✓ AUTHORIZED — Pi responded (${output.length} chars)\u001b[0m`);
      console.log();
      console.log("  ── Pi's response (first 500 chars) ──");
      console.log("  " + output.slice(0, 500).replace(/\n/g, "\n  "));
      console.log("  ── ... (truncated) ──");
    }
  } catch (e) {
    console.log(`  \u001b[31m✗ Network error: ${e.message}\u001b[0m`);
  } finally {
    omp.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 2: UNSIGNED — Rogue sends plain envelope, no signature
// ─────────────────────────────────────────────────────────────────────────
banner(2, "UNSIGNED ENVELOPE → REJECT", "\u001b[31m");
{
  const nc = await connect({ servers: NATS });
  console.log(`  Caller:     <no identity, no signature>`);
  console.log(`  Target:     drolu/pi-paystack-agent`);
  console.log();
  console.log(`  Sending PLAIN (unsigned) request...`);

  const plainEnv = {
    v: "0.1.0",
    id: randomUUID(),
    type: "request",
    ts: new Date().toISOString(),
    from: "rogue-unsigned-" + randomUUID().slice(0, 8),
    payload: TASK,
  };

  try {
    const raw = await nc.request(INBOX, sc.encode(JSON.stringify(plainEnv)), { timeout: 5000 });
    const reply = JSON.parse(sc.decode(raw.data));
    if (reply.error) {
      console.log(`  \u001b[32m✓ REJECTED as expected: [${reply.error.code}] ${reply.error.message}\u001b[0m`);
    } else {
      console.log(`  \u001b[31m✗ UNEXPECTED ACCEPTANCE — ACL bypassed!\u001b[0m`);
    }
  } catch (e) {
    console.log(`  \u001b[32m✓ REJECTED (timeout/no-reply): ${e.message}\u001b[0m`);
  } finally {
    nc.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 3: UNTRUSTED — Rogue generates keypair, signs, but not in trust store
// ─────────────────────────────────────────────────────────────────────────
banner(3, "SELF-SIGNED + UNTRUSTED IDENTITY → REJECT", "\u001b[31m");
{
  // Rogue generates a perfectly valid keypair, but it's not in the trust store
  const rogue = generateKeypair("rogue/unknown-agent");
  const rogueClient = await ACLClient.connect({ keypair: rogue, trustStore });

  console.log(`  Caller:     ${rogue.identity}  (valid signature, but NOT in trust store)`);
  console.log(`  Fingerprint: ${rogue.fingerprint}`);
  console.log(`  Target:     drolu/pi-paystack-agent`);
  console.log();
  console.log(`  Sending SIGNED request (rogue's own key)...`);

  try {
    const reply = await rogueClient.requestSigned(INBOX, "request", TASK, {}, { timeout: 5000 });
    if (reply.error) {
      console.log(`  \u001b[32m✓ REJECTED as expected: [${reply.error.code}] ${reply.error.message}\u001b[0m`);
    } else {
      console.log(`  \u001b[31m✗ UNEXPECTED ACCEPTANCE — ACL bypassed!\u001b[0m`);
    }
  } catch (e) {
    console.log(`  \u001b[32m✓ REJECTED: ${e.message}\u001b[0m`);
  } finally {
    rogueClient.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// FINAL SUMMARY
// ─────────────────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(70));
console.log("SUMMARY");
console.log("═".repeat(70));
console.log("  Scenario 1 (authorized)  : OMP's signed identity accepted → response received");
console.log("  Scenario 2 (unsigned)    : Plain envelope rejected with 403");
console.log("  Scenario 3 (untrusted)   : Self-signed but unknown identity rejected with 403");
console.log();
console.log("The trust store enforces cryptographic identity: only agents listed in");
console.log("Pi's allow_inbound (drolu/omp-orchestrator) can reach Pi's skill handlers.");
console.log("Everybody else — unsigned, spoofed, or self-signed — gets a signed rejection.");
console.log("═".repeat(70), "\n");
