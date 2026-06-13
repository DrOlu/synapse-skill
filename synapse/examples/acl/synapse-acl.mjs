/**
 * synapse-acl.mjs — Synapse SDK with cryptographic identity + ACL
 *
 * Adds to plain Synapse:
 *   - Ed25519 keypair per agent (persistent identity)
 *   - Signed outbound envelopes
 *   - Signature verification on inbound envelopes
 *   - Per-agent allowlists (who can call me / who can I call)
 *   - Revocation via trust store flag
 */

import { connect, StringCodec } from "nats";
import { randomUUID }           from "crypto";
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

const sc = StringCodec();

// ─── Identity & Key Generation ───────────────────────────────────────────

const DEFAULT_KEYS_DIR = "./keys";

/**
 * Convert an identity like "drolu/omp-orchestrator" to a filesystem-safe slug.
 */
export function slugOf(identity) {
  if (!/^[\.\w\-/]+$/.test(identity)) throw new Error(`Invalid identity format: ${identity}`);
  return identity.replace(/\//g, "-");
}

/**
 * Canonical path for an agent's private identity file.
 */
export function keypairPath(identity, keysDir = DEFAULT_KEYS_DIR) {
  return `${keysDir}/${slugOf(identity)}-identity.json`;
}

/**
 * Generate a persistent Ed25519 identity for an agent.
 * Returns { identity, privateKeyPem, publicKeyPem, fingerprint }.
 */
export function generateKeypair(identity) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem  = publicKey.export({ type: "spki",  format: "pem" });
  const fingerprint   = "sha256:" + createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
  return { identity, privateKeyPem, publicKeyPem, fingerprint };
}

/**
 * Save a keypair to disk as JSON (private key + public key + identity).
 */
export function saveKeypair(keypair, path) {
  writeFileSync(path, JSON.stringify(keypair, null, 2));
}

/**
 * Load a keypair from disk.
 * `idOrPath` may be:
 *   - a raw path like "./keys/pi-identity.json"   (legacy / explicit)
 *   - an identity like "drolu/pi-paystack-agent"   (auto-resolves via keypairPath)
 */
export function loadKeypair(idOrPath, keysDir = DEFAULT_KEYS_DIR) {
  const path = idOrPath.startsWith(".") || idOrPath.startsWith("/")
    ? idOrPath
    : keypairPath(idOrPath, keysDir);
  if (!existsSync(path)) throw new Error(`Keypair file not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Load a trust store (agents we trust + their public keys + allowlists).
 */
export function loadTrustStore(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─── Envelope helpers ────────────────────────────────────────────────────

const AUTH_FIELDS = ["signature", "from_identity", "from_key_fingerprint"];

function stripAuthFields(env) {
  const out = {};
  for (const k of Object.keys(env)) {
    if (!AUTH_FIELDS.includes(k)) out[k] = env[k];
  }
  return out;
}

function canonicalize(obj) {
  const keys = Object.keys(obj).sort();
  const stable = {};
  for (const k of keys) stable[k] = obj[k];
  return JSON.stringify(stable);
}

function makeEnvelope(type, payload, from, extra = {}) {
  return {
    v: "0.1.0",
    id: randomUUID(),
    type,
    ts: new Date().toISOString(),
    from,
    trace: { trace_id: randomUUID(), span_id: randomUUID() },
    payload,
    ...extra,
  };
}

// ─── ACL Client ──────────────────────────────────────────────────────────

export class ACLClient {
  constructor({ identity, privateKeyPem, publicKeyPem, fingerprint, trustStore, nc }) {
    this.identity      = identity;
    this.privateKeyPem = privateKeyPem;
    this.publicKeyPem  = publicKeyPem;
    this.fingerprint   = fingerprint;
    this.trustStore    = trustStore;
    this.nc            = nc;
  }

  /** Connect a new ACL client to NATS. */
  static async connect({ url = "nats://localhost:4222", keypair, trustStore }) {
    const nc = await connect({ servers: url });
    return new ACLClient({ ...keypair, trustStore, nc });
  }

  /** Sign an envelope. Returns a new object with signature fields added. */
  signEnvelope(env) {
    const canonical = canonicalize(env);
    const priv      = createPrivateKey(this.privateKeyPem);
    const sig       = cryptoSign(null, Buffer.from(canonical), priv);
    return {
      ...env,
      from_identity:        this.identity,
      from_key_fingerprint: this.fingerprint,
      signature:            sig.toString("base64"),
    };
  }

  /**
   * Verify an inbound envelope.
   * Returns { valid: true, callerIdentity } or { valid: false, error }.
   */
  verifyEnvelope(env, { direction = "inbound" } = {}) {
    if (!env.from_identity || !env.signature) {
      return { valid: false, error: "unsigned envelope" };
    }

    const entry = this.trustStore[env.from_identity];
    if (!entry) {
      return { valid: false, error: `unknown identity: ${env.from_identity}` };
    }

    if (entry.revoked) {
      return { valid: false, error: `identity revoked: ${entry.revocation_reason || "no reason"}` };
    }

    // Build list of candidate keys with their fingerprints.
    // Primary key is always first; trusted_pubkeys cover rotation grace period.
    const trustedOlder = (entry.trusted_pubkeys || [])
      .filter(k => !k.expires || new Date(k.expires) > new Date());

    const candKeys = [
      { pem: entry.public_key_pem, fingerprint: entry.fingerprint },
      ...trustedOlder.map(k => ({ pem: k.pem, fingerprint: k.fingerprint })),
    ];

    // Find which candidate key matches the caller's claimed fingerprint
    const matched = candKeys.find(c => c.fingerprint === env.from_key_fingerprint);
    if (!matched) {
      return { valid: false, error: `fingerprint ${env.from_key_fingerprint} matches neither primary nor rotation grace keys` };
    }

    const stripped  = stripAuthFields(env);
    const canonical = canonicalize(stripped);

    let ok = false;
    let lastErr = null;
    try {
      const pub = createPublicKey(matched.pem);
      const sig = Buffer.from(env.signature, "base64");
      ok = cryptoVerify(null, Buffer.from(canonical), pub, sig);
    } catch (e) {
      lastErr = e;
    }

    if (!ok) {
      return { valid: false, error: lastErr ? `invalid signature: ${lastErr.message}` : "invalid signature" };
    }

    // ACL check — look up SELF in trust store to enforce my own allow_inbound
    const selfEntry = this.trustStore[this.identity];
    const allowed = selfEntry ? (selfEntry.allow_inbound || []) : ["*"]; // if not in own trust store, default to allow-all (open mode)
    const caller = env.from_identity;
    const matches = allowed.some(rule => {
      if (rule === "*") return true;
      if (rule.endsWith("/*")) return caller.startsWith(rule.slice(0, -1));
      return rule === caller;
    });

    if (!matches) {
      return { valid: false, error: `caller ${caller} not in inbound ACL` };
    }

    return { valid: true, callerIdentity: env.from_identity };
  }

  /** Publish a signed envelope to a subject. */
  publishSigned(subject, type, payload, extra = {}) {
    const env    = makeEnvelope(type, payload, this.identity + ":" + randomUUID().slice(0, 8), extra);
    const signed = this.signEnvelope(env);
    this.nc.publish(subject, sc.encode(JSON.stringify(signed)));
    return signed;
  }

  /** Request-reply: publish signed to `subject` and wait for signed reply on `reply`. */
  async requestSigned(subject, type, payload, extra = {}, opts = { timeout: 180_000 }) {
    const env    = makeEnvelope(type, payload, this.identity + ":" + randomUUID().slice(0, 8), extra);
    const signed = this.signEnvelope(env);

    const raw = await this.nc.request(subject, sc.encode(JSON.stringify(signed)), opts);
    const reply = JSON.parse(sc.decode(raw.data));

    if (reply.error) return reply; // ACL error on remote side

    const v = this.verifyEnvelope(reply, { direction: "outbound" });
    if (!v.valid) {
      // We accept replies even from unverified sources if the call was ours.
      // But we log the warning.
      reply._acl_warning = v.error;
    } else {
      reply._acl_verified_caller = v.callerIdentity;
    }
    return reply;
  }

  /**
   * Subscribe to a subject and run `handler` on each incoming message.
   * The handler is only invoked if the inbound envelope is ACL-verified.
   * Otherwise, a 403 error is published back to the reply subject.
   */
  async handleRequests(subject, handler) {
    const sub = this.nc.subscribe(subject);
    for await (const rawMsg of sub) {
      const env = JSON.parse(sc.decode(rawMsg.data));

      // Verify
      const v = this.verifyEnvelope(env, { direction: "inbound" });
      if (!v.valid) {
        console.log(`[ACL] ✗ Rejected request from ${env.from_identity || "<unsigned>"}: ${v.error}`);
        if (rawMsg.reply) {
          const rej = {
            v: "0.1.0", id: randomUUID(), type: "respond",
            ts: new Date().toISOString(), from: this.identity,
            error: { code: 403, message: v.error, retryable: false },
            ...(env.trace ? { trace: { ...env.trace, parent_span_id: env.trace.span_id, span_id: randomUUID() } } : {}),
          };
          const rejSigned = this.signEnvelope(rej);
          rawMsg.respond(sc.encode(JSON.stringify(rejSigned)));
        }
        continue;
      }

      console.log(`[ACL] ✓ Accepted request from ${v.callerIdentity}`);

      try {
        const result = await handler(env, { callerIdentity: v.callerIdentity });
        const ok = makeEnvelope("respond", { output: result }, this.identity);
        if (env.task_id) ok.task_id = env.task_id;
        if (env.trace)   ok.trace   = { ...env.trace, parent_span_id: env.trace.span_id, span_id: randomUUID() };
        const okSigned = this.signEnvelope(ok);
        if (rawMsg.reply) rawMsg.respond(sc.encode(JSON.stringify(okSigned)));
      } catch (e) {
        const err = makeEnvelope("respond", null, this.identity);
        err.error = { code: 5001, message: e.message, retryable: true };
        if (rawMsg.reply) rawMsg.respond(sc.encode(JSON.stringify(this.signEnvelope(err))));
      }
    }
  }

  close() {
    this.nc.close();
  }
}

export default ACLClient;
