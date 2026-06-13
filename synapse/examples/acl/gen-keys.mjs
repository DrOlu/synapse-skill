#!/usr/bin/env node
/**
 * gen-keys.mjs — Generate ACL keys and trust store for the Synapse demo.
 *
 * Creates (using canonical names that `synapse-identity.mjs` recognises):
 *   keys/drolu-omp-orchestrator-identity.json    <- private key + identity for OMP
 *   keys/drolu-pi-paystack-agent-identity.json   <- private key + identity for Pi
 *   trust-store.json                             <- public keys + allowlists (shared by all agents)
 *
 * Trust rules:
 *   - drolu/omp-orchestrator may CALL   drolu/pi-paystack-agent (outbound ACL)
 *   - drolu/pi-paystack-agent ACCEPTS from drolu/omp-orchestrator (inbound ACL)
 *   - any other caller is rejected
 */

import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { generateKeypair, keypairPath } from "./synapse-acl.mjs";

mkdirSync("./keys",      { recursive: true });
mkdirSync("./backups",   { recursive: true });

// ── 1. Generate keypairs ──────────────────────────────────────────────────
console.log("Generating keypairs...\n");

const omp = generateKeypair("drolu/omp-orchestrator");
const pi  = generateKeypair("drolu/pi-paystack-agent");

console.log(`  OMP identity    : ${omp.identity}`);
console.log(`  OMP fingerprint : ${omp.fingerprint}`);
console.log(`  Pi  identity    : ${pi.identity}`);
console.log(`  Pi  fingerprint : ${pi.fingerprint}`);
console.log();

// ── 2. Save private keys using canonical keypairPath() ────────────────────
writeFileSync(keypairPath(omp.identity), JSON.stringify(omp, null, 2));
writeFileSync(keypairPath(pi.identity),  JSON.stringify(pi,  null, 2));
console.log(`✓ Wrote ${keypairPath(omp.identity)} (private)`);
console.log(`✓ Wrote ${keypairPath(pi.identity)}  (private)`);
console.log();

// Clean up any legacy files from before the slug convention was introduced
for (const legacy of ["./keys/omp-identity.json", "./keys/pi-identity.json"]) {
  if (existsSync(legacy)) {
    unlinkSync(legacy);
    console.log(`  (removed legacy file ${legacy})`);
  }
}

// ── 3. Build the trust store (shared by all agents, contains only pubkeys + ACL) ─
const trustStore = {
  [omp.identity]: {
    public_key_pem:  omp.publicKeyPem,
    fingerprint:     omp.fingerprint,
    allow_outbound:  [pi.identity],          // OMP may call Pi
    allow_inbound:   [],                     // OMP accepts no inbound (orchestrator)
    revoked:         false,
    since:           new Date().toISOString(),
    trusted_pubkeys: [],
  },
  [pi.identity]: {
    public_key_pem:  pi.publicKeyPem,
    fingerprint:     pi.fingerprint,
    allow_outbound:  [],                     // Pi calls nothing proactively
    allow_inbound:   [omp.identity],         // Pi only accepts from OMP
    revoked:         false,
    since:           new Date().toISOString(),
    trusted_pubkeys: [],
  },
};

writeFileSync("./trust-store.json", JSON.stringify(trustStore, null, 2));
console.log("\n✓ Wrote trust-store.json (shared public keys + ACLs)");
console.log("  (Contains no private keys — safe to version-control)\n");

// ── 4. Show what this means ───────────────────────────────────────────────
console.log("=== Trust Rules ===");
console.log(`  ${omp.identity}`);
console.log(`    may call: ${trustStore[omp.identity].allow_outbound.join(", ") || "<nobody>"}`);
console.log(`    accepts:  ${trustStore[omp.identity].allow_inbound.join(", ") || "<nobody>"}`);
console.log();
console.log(`  ${pi.identity}`);
console.log(`    may call: ${trustStore[pi.identity].allow_outbound.join(", ") || "<nobody>"}`);
console.log(`    accepts:  ${trustStore[pi.identity].allow_inbound.join(", ") || "<nobody>"}`);
console.log();
console.log("✓ Ready. Run pi-agent.mjs and acl-demo.mjs to see authorization in action.");
console.log("  Or run:   node synapse-identity.mjs list");
console.log("            node synapse-identity.mjs rotate drolu/omp-orchestrator\n");
