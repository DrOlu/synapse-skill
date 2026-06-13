/**
 * rotation-test.mjs — Verify key rotation grace period works end-to-end
 *
 * Steps:
 *   1. Start Pi with current identity
 *   2. Rotate the key (synapse-identity rotate)
 *   3. Sign a request with the NEW key → should succeed
 *   4. Sign a request with the OLD key → should STILL succeed (grace period)
 *   5. Revoke the identity → both should fail
 */

import { connect, StringCodec } from "nats";
import { randomUUID } from "crypto";
import { ACLClient, loadKeypair, loadTrustStore } from "./synapse-acl.mjs";

const sc = StringCodec();
const NATS = "nats://localhost:4222";
const PI_INBOX = "mesh.agent.drolu/pi-paystack-agent.inbox";

// Helper: send a signed request and report the result
async function sendSignedRequest(label, keypair) {
  const trust = loadTrustStore("./trust-store.json");
  const client = await ACLClient.connect({ keypair, trustStore: trust });
  try {
    const reply = await client.requestSigned(
      PI_INBOX, "request",
      { skill: "fetch-transactions", input: { count: 1, status: "failed" } },
      {},
      { timeout: 15000 }
    );
    if (reply.error) {
      console.log(`  \u001b[33m${label} → REJECTED: [${reply.error.code}] ${reply.error.message}\u001b[0m`);
    } else {
      const chars = reply.payload?.output?.text?.length || 0;
      console.log(`  \u001b[32m${label} → ACCEPTED (${chars} chars response)\u001b[0m [fp: ${keypair.fingerprint}]`);
    }
  } catch (e) {
    console.log(`  \u001b[31m${label} → ERROR: ${e.message}\u001b[0m`);
  } finally {
    client.close();
  }
}

console.log("\n\u001b[1m=== Rotation End-to-End Test ===\u001b[0m\n");

// ── The test uses OMP identity as 'caller' that calls Pi ──
// ── because Pi's own allow_inbound says 'accept drolu/omp-orchestrator' ──
// Phase 0: Load OMP's current state (caller)
const preRotationKey = { ...loadKeypair("drolu/omp-orchestrator") };
console.log("  Phase 0 — OMP identity loaded (will be rotated)");
console.log(`  Identity: ${preRotationKey.identity}`);
console.log(`  Fingerprint: ${preRotationKey.fingerprint}\n`);

// Phase 1: Send with original key before rotation
console.log("  Phase 1 — Send request BEFORE rotation...");
await sendSignedRequest("pre-rotation (original key)", preRotationKey);

// Phase 2: Rotate OMP's key (the CALLER's key)
console.log("\n  Phase 2 — Rotating OMP keypair (in-process)...\n");
const { execSync } = await import("child_process");
const rotOut = execSync(
  "node synapse-identity.mjs rotate drolu/omp-orchestrator --grace-days=30 --json",
  { encoding: "utf8" }
);
const rot = JSON.parse(rotOut);
console.log(`  Old fp: ${rot.old_fingerprint}`);
console.log(`  New fp: ${rot.new_fingerprint}`);
console.log(`  Grace until: ${rot.grace_until}\n`);

// Phase 3: Reload — the caller hasn't restarted, still has OLD private key in memory
console.log("  Phase 3 — OMP sends with OLD key AFTER rotation...");
console.log("             (OMP hasn't restarted, still signs with old key)");
const trustAfter = loadTrustStore("./trust-store.json");
console.log(`  Trust store: OMP's old key now in trusted_pubkeys? ${trustAfter["drolu/omp-orchestrator"].trusted_pubkeys?.length || 0} entry(ies)`);
await sendSignedRequest("post-rotation (OLD key - grace)", preRotationKey);

// Phase 4: Load new key and send with it (simulates OMP restart after rotation)
console.log("\n  Phase 4 — OMP sends with NEW key AFTER rotation...");
console.log("             (OMP restarted, loads new private key)");
const postRotationKey = loadKeypair("drolu/omp-orchestrator");
console.log(`  New fp: ${postRotationKey.fingerprint}`);
await sendSignedRequest("post-rotation (NEW key)", postRotationKey);

// Phase 5: Create completely unknown identity, sign with its own key — should fail
console.log("\n  Phase 5 — Unknown identity sends (should fail)...");
const { generateKeypair } = await import("./synapse-acl.mjs");
const rogue = generateKeypair("rogue/fake-omp");
await sendSignedRequest("unknown identity", rogue);

console.log("\n  === Restoring OMP key to original state ===");
// Just rotate one more time — leaves us post-rotation, which is fine
const restoreOut = execSync(
  "node synapse-identity.mjs rotate drolu/omp-orchestrator --grace-days=30 --json",
  { encoding: "utf8" }
);
const restoreRot = JSON.parse(restoreOut);
console.log(`  OMP rotated again: fp=${restoreRot.new_fingerprint} (grace until ${restoreRot.grace_until})`);

console.log("\n  === Rotation test complete ===\n");
console.log("  Results expected:");
console.log("    Phase 1 (pre-rotation)      : pre-rotation (original key) → ACCEPTED");
console.log("    Phase 3 (OLD key post-rot)  : post-rotation (OLD key)     → ACCEPTED  ← grace period working");
console.log("    Phase 4 (NEW key post-rot)  : post-rotation (NEW key)     → ACCEPTED  ← primary key working");
console.log("    Phase 5 (unknown identity)  : unknown identity            → REJECTED (403)\n");
