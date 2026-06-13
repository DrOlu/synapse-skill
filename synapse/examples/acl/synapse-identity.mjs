#!/usr/bin/env node
/**
 * synapse-identity.mjs — Identity lifecycle management for Synapse ACL agents.
 *
 * Commands:
 *   init <identity> [--allows-inbound=<...>] [--allows-outbound=<...>] [--backup=<passphrase>]
 *   list
 *   show <identity>
 *   add <identity> <pubkey.pem> [--allows-inbound=<...>] [--allows-outbound=<...>]
 *   rotate <identity> [--backup=<passphrase>] [--grace-days=<N>]
 *   revoke <identity> --reason=<reason>
 *   backup <identity> [--passphrase=<passphrase>]       (interactive passphrase if omitted)
 *   restore <backup-file> --passphrase=<passphrase>
 *   import <identity-file>                              (import raw identity JSON)
 *
 * Global flags:
 *   --json          JSON output (for scripting)
 *   --force         Overwrite existing files
 *   --keys-dir=<d>  Override ./keys
 *   --trust-file=<f> Override ./trust-store.json
 *
 * Storage layout:
 *   ./keys/<slug>-identity.json       private key + identity (NEVER share)
 *   ./trust-store.json                public keys + ACLs (safe to share)
 *   ./backups/<slug>-<ts>.json.enc    encrypted backup
 */

import {
  generateKeyPairSync, createPrivateKey, createPublicKey, createHash,
  scryptSync, createCipheriv, createDecipheriv, randomBytes,
} from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { basename } from "path";
import { createInterface } from "readline";

// ─── Constants & defaults ──────────────────────────────────────────────────

const DEFAULT_KEYS_DIR   = "./keys";
const DEFAULT_TRUST_FILE = "./trust-store.json";
const DEFAULT_BACKUP_DIR = "./backups";

// ─── CLI parsing ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { positional: [], flags: {}, global: {} };
  const raw = argv.slice(2);
  let i = 0;
  while (i < raw.length) {
    const a = raw[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      args.flags[k] = v ?? true;
    } else {
      args.positional.push(a);
    }
    i++;
  }
  // Promote flags that start with -- globally (so all commands get them)
  for (const k of ["json", "force", "keys-dir", "trust-file", "backup-dir"]) {
    if (k in args.flags) { args.global[k] = args.flags[k]; delete args.flags[k]; }
  }
  return args;
}

function flag(name, def) { return args.flags[name] ?? def; }

const args = parseArgs(process.argv);

// ─── IO helpers ────────────────────────────────────────────────────────────

const KEYS_DIR   = args.global["keys-dir"]   || DEFAULT_KEYS_DIR;
const TRUST_FILE = args.global["trust-file"] || DEFAULT_TRUST_FILE;
const BACKUP_DIR = args.global["backup-dir"] || DEFAULT_BACKUP_DIR;
const JSON_MODE  = args.global.json === true;

function info(...parts)   { if (!JSON_MODE) console.error("\u001b[90m  ⓘ\u001b[0m", ...parts); }
function ok(...parts)     { if (!JSON_MODE) console.log("  \u001b[32m✓\u001b[0m", ...parts); }
function warn(...parts)   { if (!JSON_MODE) console.warn("  \u001b[33m⚠\u001b[0m", ...parts); }
function fail(...parts)   { console.error("  \u001b[31m✗\u001b[0m", ...parts); process.exit(1); }
function heading(h)       { if (!JSON_MODE) console.log(); if (!JSON_MODE) console.log(`\u001b[1m${h}\u001b[0m`); }
function label(k, v, pad = 16) { if (!JSON_MODE) console.log(`  ${k.padEnd(pad)}${v}`); }

function slugOf(identity) {
  if (!/^[\w.\-/]+$/.test(identity)) fail(`Invalid identity format: ${identity}`);
  return identity.replace(/\//g, "-");
}

async function askYesNo(question, def = "N") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def === "Y" ? " [Y/n]" : " [y/N]";
  const ans = await new Promise(resolve => rl.question(`${question}${suffix}: `, resolve));
  rl.close();
  const a = (ans || def).toLowerCase();
  return a === "y" || a === "yes";
}

async function askPassphrase() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const first = await new Promise(resolve => rl.question("  Passphrase (min 8 chars): ", resolve));
  if (first.length < 8) { rl.close(); fail("Passphrase must be at least 8 characters"); }
  const second = await new Promise(resolve => rl.question("  Confirm passphrase:       ", resolve));
  rl.close();
  if (first !== second) fail("Passphrases do not match");
  return first;
}

// ─── File helpers ──────────────────────────────────────────────────────────

function ensureDirs() {
  mkdirSync(KEYS_DIR, { recursive: true });
  mkdirSync(BACKUP_DIR, { recursive: true });
}

function loadTrustStore() {
  if (!existsSync(TRUST_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TRUST_FILE, "utf8"));
  } catch (e) {
    fail(`Failed to parse trust store: ${e.message}`);
  }
}

function saveTrustStore(store) {
  writeFileSync(TRUST_FILE, JSON.stringify(store, null, 2));
}

function keypairPath(identity) {
  return `${KEYS_DIR}/${slugOf(identity)}-identity.json`;
}

function loadKeypair(identity) {
  const p = keypairPath(identity);
  if (!existsSync(p)) fail(`No identity file at ${p}. Run: synapse-identity init ${identity}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeKeypair(identity, keypair) {
  writeFileSync(keypairPath(identity), JSON.stringify(keypair, null, 2));
}

// ─── Crypto helpers ────────────────────────────────────────────────────────

function makeKeypair(identity) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem  = publicKey.export({ type: "spki",  format: "pem" });
  const fingerprint   = "sha256:" + createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
  return { identity, privateKeyPem, publicKeyPem, fingerprint };
}

function encryptBackup(keypair, passphrase) {
  const salt = randomBytes(16);
  const iv   = randomBytes(12);
  const key  = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.from(JSON.stringify(keypair), "utf8");
  const ciphertext = cipher.update(payload);
  cipher.final();
  return {
    v: 1,
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    salt:  salt.toString("hex"),
    iv:    iv.toString("hex"),
    tag:   cipher.getAuthTag().toString("hex"),
    data:  Buffer.concat([ciphertext]).toString("hex"),
  };
}

function decryptBackup(backup, passphrase) {
  if (backup.v !== 1) fail(`Unsupported backup version: ${backup.v}`);
  try {
    const salt = Buffer.from(backup.salt, "hex");
    const iv   = Buffer.from(backup.iv,   "hex");
    const tag  = Buffer.from(backup.tag,  "hex");
    const data = Buffer.from(backup.data, "hex");
    const key  = scryptSync(passphrase, salt, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = decipher.update(data);
    decipher.final();
    return JSON.parse(plaintext.toString("utf8"));
  } catch (e) {
    fail(`Decryption failed — wrong passphrase or corrupted file: ${e.message}`);
  }
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

// ─── Command: init ─────────────────────────────────────────────────────────

async function cmdInit() {
  const identity = args.positional[1];
  if (!identity) fail("Usage: synapse-identity init <identity> [--allows-inbound=X,Y] [--allows-outbound=X,Y] [--backup=<pass>]");

  const kpPath = keypairPath(identity);
  if (existsSync(kpPath) && !args.global.force) {
    const existing = loadKeypair(identity);
    if (JSON_MODE) {
      console.log(JSON.stringify({ status: "exists", identity, fingerprint: existing.fingerprint }, null, 2));
    } else {
      warn(`Identity ${identity} already exists`);
      label("Identity:",    existing.identity);
      label("Fingerprint:", existing.fingerprint);
      label("Path:",        kpPath);
      info("Re-run with --force to regenerate (will destroy the existing key).");
    }
    return;
  }

  ensureDirs();
  const keypair = makeKeypair(identity);
  writeKeypair(identity, keypair);

  // Update trust store
  const trust = loadTrustStore();
  const allowIn  = flag("allows-inbound")  ? String(flag("allows-inbound")).split(",").map(s=>s.trim()).filter(Boolean)  : [];
  const allowOut = flag("allows-outbound") ? String(flag("allows-outbound")).split(",").map(s=>s.trim()).filter(Boolean) : [];

  trust[identity] = {
    public_key_pem: keypair.publicKeyPem,
    fingerprint:    keypair.fingerprint,
    allow_inbound:  allowIn,
    allow_outbound: allowOut,
    revoked:        false,
    since:          new Date().toISOString(),
    trusted_pubkeys: [],
  };
  saveTrustStore(trust);

  // Optional immediate backup
  if (flag("backup")) {
    const passphrase = flag("backup") === true ? await askPassphrase() : flag("backup");
    ensureDirs();
    doBackup(identity, keypair, passphrase);
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({
      status: "created",
      identity,
      fingerprint: keypair.fingerprint,
      path: kpPath,
      allow_inbound: allowIn,
      allow_outbound: allowOut,
    }, null, 2));
  } else {
    ok(`Identity created: ${identity}`);
    label("Identity:",    identity);
    label("Fingerprint:", keypair.fingerprint);
    label("Private key:", kpPath);
    label("Trust entry:", TRUST_FILE);
    if (allowIn.length)  label("Accepts:",    allowIn.join(", "));
    if (allowOut.length) label("Calls:",      allowOut.join(", "));
    heading("Next steps");
    info("1. Share the following public key with agents that need to verify you:");
    console.log("  " + keypair.publicKeyPem.split("\n").slice(1, -2).join("").slice(0, 60) + "...");
    info("2. Or send them this trust entry via synapse-identity add <identity> <pubkey.pem>");
    info("3. Back up the private key file: synapse-identity backup " + identity);
  }
}

// ─── Command: add ──────────────────────────────────────────────────────────

function cmdAdd() {
  const identity = args.positional[1];
  const pubFile  = args.positional[2];
  if (!identity || !pubFile) fail("Usage: synapse-identity add <identity> <pubkey.pem> [--allows-inbound=X,Y] [--allows-outbound=X,Y]");
  if (!existsSync(pubFile))  fail(`Public key file not found: ${pubFile}`);

  const pem = readFileSync(pubFile, "utf8");
  let pubKey;
  try {
    pubKey = createPublicKey(pem);
  } catch (e) {
    fail(`Invalid PEM public key: ${e.message}`);
  }
  const canonical = pubKey.export({ type: "spki", format: "pem" });
  const fingerprint = "sha256:" + createHash("sha256").update(canonical).digest("hex").slice(0, 16);

  ensureDirs();
  const trust = loadTrustStore();
  const allowIn  = flag("allows-inbound")  ? String(flag("allows-inbound")).split(",").map(s=>s.trim()).filter(Boolean)  : [];
  const allowOut = flag("allows-outbound") ? String(flag("allows-outbound")).split(",").map(s=>s.trim()).filter(Boolean) : [];

  if (trust[identity] && !args.global.force) {
    fail(`${identity} already in trust store. Use --force to overwrite.`);
  }

  trust[identity] = {
    public_key_pem: canonical,
    fingerprint,
    allow_inbound:  allowIn,
    allow_outbound: allowOut,
    revoked:        false,
    since:          new Date().toISOString(),
    trusted_pubkeys: [],
  };
  saveTrustStore(trust);

  if (JSON_MODE) {
    console.log(JSON.stringify({ status: "added", identity, fingerprint, allow_inbound: allowIn, allow_outbound: allowOut }, null, 2));
  } else {
    ok(`Added ${identity} to ${TRUST_FILE}`);
    label("Fingerprint:",  fingerprint);
    if (allowIn.length)  label("Accepts:",   allowIn.join(", "));
    if (allowOut.length) label("Calls:",     allowOut.join(", "));
  }
}

// ─── Command: list ─────────────────────────────────────────────────────────

function cmdList() {
  const trust = loadTrustStore();
  const ids   = Object.keys(trust);
  if (JSON_MODE) {
    console.log(JSON.stringify(trust, null, 2));
    return;
  }
  if (ids.length === 0) {
    info(`No identities in ${TRUST_FILE}. Create one with: synapse-identity init <identity>`);
    return;
  }
  heading(`Trusted identities (${ids.length}):`);
  for (const id of ids) {
    const e = trust[id];
    const status = e.revoked ? "\u001b[31mREVOKED\u001b[0m" : "\u001b[32monline\u001b[0m";
    console.log(`  \u001b[1m•\u001b[0m ${id.padEnd(44)} [${e.fingerprint}]  ${status}`);
    console.log(`      inbound : ${e.allow_inbound.length ? e.allow_inbound.join(", ") : "<none>"}`);
    console.log(`      outbound: ${e.allow_outbound.length ? e.allow_outbound.join(", ") : "<none>"}`);
    if (e.trusted_pubkeys && e.trusted_pubkeys.length) {
      console.log(`      rotation grace: ${e.trusted_pubkeys.length} older key(s) still accepted`);
    }
  }
}

// ─── Command: show ─────────────────────────────────────────────────────────

function cmdShow() {
  const identity = args.positional[1];
  if (!identity) fail("Usage: synapse-identity show <identity>");
  const trust = loadTrustStore();
  const entry = trust[identity];
  if (!entry) fail(`Identity not in trust store: ${identity}`);
  if (JSON_MODE) { console.log(JSON.stringify({ [identity]: entry }, null, 2)); return; }
  label("Identity:",    identity);
  label("Fingerprint:", entry.fingerprint);
  label("Revoked:",     entry.revoked ? `YES (${entry.revocation_reason || "?"})` : "no");
  label("Since:",       entry.since || "?");
  label("Public key:",  entry.public_key_pem.split("\n")[1] + "...");
  label("Allow inbound:",  entry.allow_inbound.join(", ") || "<none>");
  label("Allow outbound:", entry.allow_outbound.join(", ") || "<none>");
  if (entry.trusted_pubkeys?.length) {
    heading("Rotation grace (older keys still accepted):");
    for (const k of entry.trusted_pubkeys) {
      console.log(`  • ${k.fingerprint}  rotated: ${k.since}`);
    }
  }
}

// ─── Command: rotate ───────────────────────────────────────────────────────

async function cmdRotate() {
  const identity = args.positional[1];
  if (!identity) fail("Usage: synapse-identity rotate <identity> [--backup=<passphrase>] [--grace-days=N]");
  const trust = loadTrustStore();
  if (!trust[identity]) fail(`Identity not in trust store: ${identity}`);

  const kpPath = keypairPath(identity);
  const hasLocalKey = existsSync(kpPath);
  const graceDays = Number(flag("grace-days", 30));

  if (JSON_MODE) {
    // No prompts in JSON mode
    // In non-JSON mode, ask for confirmation
    if (!JSON_MODE) {
      const yes = await askYesNo(`About to rotate ${identity}`);
      if (!yes) {
        info("Abort.");
        return;
      }
    }
    await doRotate(identity, trust, graceDays, hasLocalKey);
    return;
  }

  warn(`About to rotate the keypair for ${identity}`);
  label("Current fingerprint:", trust[identity].fingerprint);
  info("This will:");
  info("  1. Generate a new Ed25519 keypair for this identity");
  info("  2. Keep the OLD public key trusted for " + graceDays + " days (grace period)");
  info("  3. Overwrite the identity file with the new private key");
  if (!hasLocalKey) warn(`No local key file at ${kpPath} — trusting existing trust store entry`);
  console.log();
  if (!(await askYesNo("Continue?"))) {
    info("Cancelled.");
    process.exit(0);
  }

  await doRotate(identity, trust, graceDays, hasLocalKey);
}

async function doRotate(identity, trust, graceDays, hasLocalKey) {
  const oldEntry = trust[identity];
  const oldFP = oldEntry.fingerprint;
  const oldPEM = oldEntry.public_key_pem;

  // Backup current keypair if we have it
  if (hasLocalKey) {
    const oldKP = loadKeypair(identity);
    ensureDirs();
    const backupPath = `${BACKUP_DIR}/${slugOf(identity)}-${ts()}-pre-rotation.json`;
    writeFileSync(backupPath, JSON.stringify(oldKP, null, 2));
    ok(`Saved current keypair to ${backupPath} (unencrypted — consider encrypting)`);
  }

  // Generate new keypair
  const newKP = makeKeypair(identity);
  if (hasLocalKey) writeKeypair(identity, newKP);

  // Move old key to trusted_pubkeys
  const trustedPubkeys = oldEntry.trusted_pubkeys || [];
  trustedPubkeys.push({
    pem: oldPEM,
    fingerprint: oldFP,
    since: new Date().toISOString(),
    expires: new Date(Date.now() + graceDays * 86400000).toISOString(),
  });

  // Update trust entry
  trust[identity] = {
    ...oldEntry,
    public_key_pem: newKP.publicKeyPem,
    fingerprint:    newKP.fingerprint,
    trusted_pubkeys: trustedPubkeys,
    rotated_at:     new Date().toISOString(),
  };
  saveTrustStore(trust);

  if (JSON_MODE) {
    console.log(JSON.stringify({
      status: "rotated",
      identity,
      old_fingerprint: oldFP,
      new_fingerprint: newKP.fingerprint,
      grace_until: trustedPubkeys[trustedPubkeys.length - 1].expires,
    }, null, 2));
    return;
  }

  ok(`Keypair rotated for ${identity}`);
  label("Old fingerprint:", oldFP);
  label("New fingerprint:", newKP.fingerprint);
  label("Grace period:",   `${graceDays} days (old key still accepted)`);
  label("Grace expires:",  trustedPubkeys[trustedPubkeys.length - 1].expires);

  if (flag("backup")) {
    const passphrase = flag("backup") === true ? await askPassphrase() : flag("backup");
    doBackup(identity, newKP, passphrase);
  }
}

// ─── Command: revoke ───────────────────────────────────────────────────────

function cmdRevoke() {
  const identity = args.positional[1];
  const reason   = flag("reason", "no reason given");
  if (!identity) fail("Usage: synapse-identity revoke <identity> --reason=<reason>");

  const trust = loadTrustStore();
  if (!trust[identity]) fail(`Identity not in trust store: ${identity}`);

  trust[identity].revoked = true;
  trust[identity].revoked_at = new Date().toISOString();
  trust[identity].revocation_reason = reason;
  trust[identity].trusted_pubkeys = []; // wipe rotation grace
  saveTrustStore(trust);

  if (JSON_MODE) {
    console.log(JSON.stringify({ status: "revoked", identity, reason }, null, 2));
  } else {
    ok(`Revoked ${identity}`);
    label("Reason:", reason);
    label("At:",     trust[identity].revoked_at);
  }
}

// ─── Command: backup ───────────────────────────────────────────────────────

async function cmdBackup() {
  const identity = args.positional[1];
  if (!identity) fail("Usage: synapse-identity backup <identity> [--passphrase=<pass>]");
  const keypair = loadKeypair(identity);
  const passphrase = flag("passphrase") || await askPassphrase();
  doBackup(identity, keypair, passphrase);
}

function doBackup(identity, keypair, passphrase) {
  ensureDirs();
  const encrypted = encryptBackup(keypair, passphrase);
  const path = `${BACKUP_DIR}/${slugOf(identity)}-${ts()}.json.enc`;
  writeFileSync(path, JSON.stringify(encrypted, null, 2));
  if (JSON_MODE) {
    console.log(JSON.stringify({ status: "backed_up", identity, path }, null, 2));
  } else {
    ok(`Encrypted backup saved to ${path}`);
    info("To restore:  synapse-identity restore " + path + " --passphrase=...");
  }
}

// ─── Command: restore ──────────────────────────────────────────────────────

function cmdRestore() {
  const file = args.positional[1];
  if (!file) fail("Usage: synapse-identity restore <backup.json.enc> --passphrase=<pass>");
  if (!existsSync(file)) fail(`Backup file not found: ${file}`);

  const passphrase = flag("passphrase");
  if (!passphrase) fail("--passphrase is required for restore");

  const raw = JSON.parse(readFileSync(file, "utf8"));
  const keypair = decryptBackup(raw, passphrase);

  ensureDirs();
  const targetPath = keypairPath(keypair.identity);
  if (existsSync(targetPath) && !args.global.force) {
    fail(`${targetPath} exists. Use --force to overwrite.`);
  }
  writeFileSync(targetPath, JSON.stringify(keypair, null, 2));

  // Also update trust store with the public key (so verification works)
  const trust = loadTrustStore();
  if (!trust[keypair.identity] || args.global.force) {
    trust[keypair.identity] = {
      public_key_pem: keypair.publicKeyPem,
      fingerprint:    keypair.fingerprint,
      allow_inbound:  [],
      allow_outbound: [],
      revoked:        false,
      since:          new Date().toISOString(),
      trusted_pubkeys: [],
      restored_from:  basename(file),
    };
    saveTrustStore(trust);
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({ status: "restored", identity: keypair.identity, fingerprint: keypair.fingerprint, path: targetPath }, null, 2));
  } else {
    ok(`Restored identity for ${keypair.identity}`);
    label("Fingerprint:", keypair.fingerprint);
    label("Key file:",    targetPath);
  }
}

// ─── Command: import ───────────────────────────────────────────────────────

function cmdImport() {
  const file = args.positional[1];
  if (!file) fail("Usage: synapse-identity import <identity-file.json>");
  if (!existsSync(file)) fail(`File not found: ${file}`);

  const keypair = JSON.parse(readFileSync(file, "utf8"));
  if (!keypair.identity || !keypair.privateKeyPem || !keypair.publicKeyPem || !keypair.fingerprint) {
    fail("File is not a valid synapse identity (missing identity/privateKeyPem/publicKeyPem/fingerprint)");
  }
  // Verify the keypair is self-consistent
  try {
    const recomputed = "sha256:" + createHash("sha256").update(keypair.publicKeyPem).digest("hex").slice(0, 16);
    if (recomputed !== keypair.fingerprint) fail(`Fingerprint mismatch (got ${keypair.fingerprint}, expected ${recomputed})`);
  } catch (e) { fail(`Key verification failed: ${e.message}`); }

  ensureDirs();
  const targetPath = keypairPath(keypair.identity);
  if (existsSync(targetPath) && !args.global.force) {
    fail(`${targetPath} exists. Use --force to overwrite.`);
  }
  writeFileSync(targetPath, JSON.stringify(keypair, null, 2));

  // Update trust store
  const trust = loadTrustStore();
  if (!trust[keypair.identity] || args.global.force) {
    trust[keypair.identity] = {
      public_key_pem: keypair.publicKeyPem,
      fingerprint:    keypair.fingerprint,
      allow_inbound:  [],
      allow_outbound: [],
      revoked:        false,
      since:          new Date().toISOString(),
      trusted_pubkeys: [],
      imported:       true,
    };
    saveTrustStore(trust);
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({ status: "imported", identity: keypair.identity, fingerprint: keypair.fingerprint, path: targetPath }, null, 2));
  } else {
    ok(`Imported identity ${keypair.identity}`);
    label("Fingerprint:", keypair.fingerprint);
    label("Key file:",    targetPath);
  }
}

// ─── Command: export-pubkey ────────────────────────────────────────────────
// Useful: export just the PEM to share with others (never leaks private key)

function cmdExportPubkey() {
  const identity = args.positional[1];
  if (!identity) fail("Usage: synapse-identity export-pubkey <identity> [--out=<file>]");
  const kp = loadKeypair(identity);
  const outFile = flag("out") || `./keys/${slugOf(identity)}.pub`;
  ensureDirs();
  writeFileSync(outFile, kp.publicKeyPem);
  if (JSON_MODE) {
    console.log(JSON.stringify({ status: "exported", identity, path: outFile, fingerprint: kp.fingerprint }, null, 2));
  } else {
    ok(`Public key exported to ${outFile}`);
    info(`Share this file with other agents so they can \`synapse-identity add ${identity} ${outFile}\``);
  }
}

// ─── Route ─────────────────────────────────────────────────────────────────

// Check for help flag
if (args.flags.help || args.global.help) {
  console.log(`
\u001b[1msynapse-identity\u001b[0m — Identity lifecycle management for Synapse ACL agents

USAGE:
  synapse-identity <command> [args] [flags]

COMMANDS:
  init <identity>          Create a new agent identity + trust entry
  add <id> <pubkey.pem>    Add external agent's pubkey to trust store
  list                     List all trusted identities (default)
  show <identity>          Details of one trust entry
  rotate <identity>        Generate new keypair, keep old one trusted (grace period)
  revoke <identity>        Mark identity as compromised / disabled
  backup <identity>        Encrypt private key with passphrase
  restore <backup.enc>     Decrypt + restore a backup file
  import <id-file.json>    Import a raw identity JSON (e.g. from a backup)
  export-pubkey <id>       Write only the public PEM (safe to share)

GLOBAL FLAGS:
  --help                  Show this help message
  --json                  JSON output (for scripting)
  --force                 Overwrite existing files
  --keys-dir=<dir>        Private key directory     (default: ./keys)
  --trust-file=<file>     Trust store file          (default: ./trust-store.json)
  --backup-dir=<dir>      Encrypted backup dir      (default: ./backups)

EXAMPLES:
  synapse-identity init drolu/pi-paystack-agent --allows-inbound=drolu/omp-orchestrator
  synapse-identity list
  synapse-identity show drolu/pi-paystack-agent
  synapse-identity rotate drolu/pi-paystack-agent --grace-days=14
  synapse-identity revoke rogue/compromised --reason="leaked key"
  synapse-identity backup drolu/pi-paystack-agent
`);
  process.exit(0);
}

const COMMANDS = {
  init:          cmdInit,
  add:           cmdAdd,
  list:          cmdList,
  show:          cmdShow,
  rotate:        cmdRotate,
  revoke:        cmdRevoke,
  backup:        cmdBackup,
  restore:       cmdRestore,
  import:        cmdImport,
  "export-pubkey": cmdExportPubkey,
};

const cmd = args.positional[0] || "list";  // default: list
if (!COMMANDS[cmd]) {
  console.error(`
\u001b[1msynapse-identity\u001b[0m — Identity lifecycle management for Synapse ACL agents

USAGE:
  synapse-identity <command> [args] [flags]

COMMANDS:
  init <identity>          Create a new agent identity + trust entry
  add <id> <pubkey.pem>    Add external agent's pubkey to trust store
  list                     List all trusted identities (default)
  show <identity>          Details of one trust entry
  rotate <identity>        Generate new keypair, keep old one trusted (grace period)
  revoke <identity>        Mark identity as compromised / disabled
  backup <identity>        Encrypt private key with passphrase
  restore <backup.enc>     Decrypt + restore a backup file
  import <id-file.json>    Import a raw identity JSON (e.g. from a backup)
  export-pubkey <id>       Write only the public PEM (safe to share)

GLOBAL FLAGS:
  --json                  JSON output (for scripting)
  --force                 Overwrite existing files
  --keys-dir=<dir>        Private key directory     (default: ./keys)
  --trust-file=<file>     Trust store file          (default: ./trust-store.json)
  --backup-dir=<dir>      Encrypted backup dir      (default: ./backups)

EXAMPLES:
  synapse-identity init drolu/pi-paystack-agent --allows-inbound=drolu/omp-orchestrator
  synapse-identity list
  synapse-identity show drolu/pi-paystack-agent
  synapse-identity rotate drolu/pi-paystack-agent --grace-days=14
  synapse-identity revoke rogue/compromised --reason="leaked key"
  synapse-identity backup drolu/pi-paystack-agent
`);
  process.exit(1);
}

await COMMANDS[cmd]();
