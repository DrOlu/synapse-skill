// Synapse ACL — Cryptographic identity verification and envelope signing
// Adds Ed25519 signed envelopes, trust store management, key rotation,
// and per-agent allow/deny lists to the Synapse SDK.
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as cryptoSign, verify as cryptoVerify, randomUUID, } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
// ==================== KEY MANAGEMENT ====================
const AUTH_FIELDS = ["signature", "from_identity", "from_key_fingerprint"];
/**
 * Generate a new Ed25519 keypair for an agent identity.
 */
export function generateKeypair(identity) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const fingerprint = "sha256:" + createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
    return { identity, privateKeyPem, publicKeyPem, fingerprint };
}
/**
 * Convert an identity like "org/agent" to a filesystem-safe slug.
 */
export function slugOf(identity) {
    if (!/^[\w.\-/]+$/.test(identity)) {
        throw new Error(`Invalid identity format: ${identity}`);
    }
    return identity.replace(/\//g, "-");
}
/**
 * Canonical path for an agent's private identity file.
 */
export function keypairPath(identity, keysDir = "./keys") {
    return `${keysDir}/${slugOf(identity)}-identity.json`;
}
/**
 * Save a keypair to disk as JSON.
 */
export function saveKeypair(keypair, path) {
    writeFileSync(path, JSON.stringify(keypair, null, 2));
}
/**
 * Load a keypair from disk.
 * Accepts either a raw file path or an identity (auto-resolved via keypairPath).
 */
export function loadKeypair(idOrPath, keysDir = "./keys") {
    const path = idOrPath.startsWith(".") || idOrPath.startsWith("/")
        ? idOrPath
        : keypairPath(idOrPath, keysDir);
    if (!existsSync(path)) {
        throw new Error(`Keypair file not found: ${path}`);
    }
    return JSON.parse(readFileSync(path, "utf8"));
}
/**
 * Load a trust store from a JSON file.
 */
export function loadTrustStore(path) {
    if (!existsSync(path))
        return {};
    return JSON.parse(readFileSync(path, "utf8"));
}
// ==================== ENVELOPE HELPERS ====================
function stripAuthFields(env) {
    const out = {};
    for (const k of Object.keys(env)) {
        if (!AUTH_FIELDS.includes(k))
            out[k] = env[k];
    }
    return out;
}
function canonicalize(obj) {
    const keys = Object.keys(obj).sort();
    const stable = {};
    for (const k of keys)
        stable[k] = obj[k];
    return JSON.stringify(stable);
}
// ==================== ACL CLIENT ====================
/**
 * ACLClient provides cryptographic identity verification for Synapse agents.
 *
 * Usage:
 * ```ts
 * import { ACLClient, generateKeypair, loadTrustStore } from "synapse-nats-sdk/acl";
 *
 * const keypair = generateKeypair("my-org/my-agent");
 * const trust = loadTrustStore("./trust-store.json");
 * const acl = new ACLClient({ ...keypair, trustStore: trust });
 *
 * // Sign an outbound envelope
 * const signed = acl.signEnvelope({ v: "0.1.0", id: "...", type: "request", ... });
 *
 * // Verify an inbound envelope
 * const result = acl.verifyEnvelope(incomingEnvelope);
 * if (result.valid) {
 *   console.log("Caller:", result.callerIdentity);
 * }
 * ```
 */
export class ACLClient {
    identity;
    fingerprint;
    privateKeyPem;
    publicKeyPem;
    trustStore;
    nc;
    constructor(options) {
        this.identity = options.identity;
        this.privateKeyPem = options.privateKeyPem;
        this.publicKeyPem = options.publicKeyPem;
        this.fingerprint = options.fingerprint;
        this.trustStore = options.trustStore;
        this.nc = options.nc;
    }
    /**
     * Update the trust store (e.g., after adding or revoking an identity).
     */
    setTrustStore(trustStore) {
        this.trustStore = trustStore;
    }
    /**
     * Sign an envelope. Returns a new object with signature fields added.
     */
    signEnvelope(env) {
        const canonical = canonicalize(env);
        const priv = createPrivateKey(this.privateKeyPem);
        const sig = cryptoSign(null, Buffer.from(canonical), priv);
        return {
            ...env,
            from_identity: this.identity,
            from_key_fingerprint: this.fingerprint,
            signature: sig.toString("base64"),
        };
    }
    /**
     * Verify an inbound envelope against the trust store.
     *
     * Checks:
     * 1. Envelope has signature fields
     * 2. Caller identity exists in trust store
     * 3. Caller identity is not revoked
     * 4. Fingerprint matches primary key or rotation grace key
     * 5. Ed25519 signature is cryptographically valid
     * 6. Caller passes inbound ACL rules
     */
    verifyEnvelope(env, options = {}) {
        const direction = options.direction ?? "inbound";
        if (!env.from_identity || !env.signature) {
            return { valid: false, error: "unsigned envelope" };
        }
        const entry = this.trustStore[env.from_identity];
        if (!entry) {
            return { valid: false, error: `unknown identity: ${env.from_identity}` };
        }
        if (entry.revoked) {
            return {
                valid: false,
                error: `identity revoked: ${entry.revocation_reason || "no reason"}`,
            };
        }
        // Build candidate keys (primary + rotation grace)
        const trustedOlder = (entry.trusted_pubkeys || []).filter((k) => !k.expires || new Date(k.expires) > new Date());
        const candKeys = [
            { pem: entry.public_key_pem, fingerprint: entry.fingerprint },
            ...trustedOlder.map((k) => ({
                pem: k.pem,
                fingerprint: k.fingerprint,
            })),
        ];
        // Match fingerprint
        const matched = candKeys.find((c) => c.fingerprint === env.from_key_fingerprint);
        if (!matched) {
            return {
                valid: false,
                error: `fingerprint ${env.from_key_fingerprint} matches neither primary nor rotation grace keys`,
            };
        }
        // Verify Ed25519 signature
        const stripped = stripAuthFields(env);
        const canonical = canonicalize(stripped);
        let ok = false;
        let lastErr = null;
        try {
            const pub = createPublicKey(matched.pem);
            const sig = Buffer.from(env.signature, "base64");
            ok = cryptoVerify(null, Buffer.from(canonical), pub, sig);
        }
        catch (e) {
            lastErr = e;
        }
        if (!ok) {
            return {
                valid: false,
                error: lastErr
                    ? `invalid signature: ${lastErr.message}`
                    : "invalid signature",
            };
        }
        // ACL check (inbound only)
        if (direction === "inbound") {
            const selfEntry = this.trustStore[this.identity];
            const allowed = selfEntry ? selfEntry.allow_inbound || [] : ["*"];
            const caller = env.from_identity;
            const matches = allowed.some((rule) => {
                if (rule === "*")
                    return true;
                if (rule.endsWith("/*"))
                    return caller.startsWith(rule.slice(0, -2));
                if (rule.endsWith("*"))
                    return caller.startsWith(rule.slice(0, -1));
                return rule === caller;
            });
            if (!matches) {
                return {
                    valid: false,
                    error: `caller ${caller} not in inbound ACL`,
                };
            }
        }
        return { valid: true, callerIdentity: env.from_identity };
    }
    /**
     * Build a signed envelope for publishing.
     */
    makeSignedEnvelope(type, payload, from, extra = {}) {
        const env = {
            v: "0.1.0",
            id: randomUUID(),
            type,
            ts: new Date().toISOString(),
            from,
            trace: { trace_id: randomUUID(), span_id: randomUUID() },
            payload,
            ...extra,
        };
        return this.signEnvelope(env);
    }
    /** Fingerprint for the current identity. */
    getFingerprint() {
        return this.fingerprint;
    }
    /** Public key PEM for the current identity. */
    getPublicKeyPem() {
        return this.publicKeyPem;
    }
    // ==================== NATS-INTEGRATED METHODS ====================
    /** Set a NATS connection for network operations. */
    setConnection(nc) {
        this.nc = nc;
    }
    requireNc() {
        if (!this.nc) {
            throw new Error("ACLClient has no NATS connection. Call setConnection(nc) or pass nc in options.");
        }
        return this.nc;
    }
    /** Publish a signed envelope to a NATS subject. */
    publishSigned(subject, type, payload, extra = {}) {
        const nc = this.requireNc();
        const env = {
            v: "0.1.0",
            id: randomUUID(),
            type,
            ts: new Date().toISOString(),
            from: this.identity + ":" + randomUUID().slice(0, 8),
            trace: { trace_id: randomUUID(), span_id: randomUUID() },
            payload,
            ...extra,
        };
        const signed = this.signEnvelope(env);
        const sc = new TextEncoder();
        nc.publish(subject, sc.encode(JSON.stringify(signed)));
        return signed;
    }
    /**
     * Request-reply with signed envelopes.
     * Publishes a signed request to `subject` and waits for a signed reply.
     * Returns the verified or warned reply payload.
     */
    async requestSigned(subject, type, payload, extra = {}, opts = {}) {
        const nc = this.requireNc();
        const sc = new TextEncoder();
        const dc = new TextDecoder();
        const timeout = opts.timeout ?? 180_000;
        const env = {
            v: "0.1.0",
            id: randomUUID(),
            type,
            ts: new Date().toISOString(),
            from: this.identity + ":" + randomUUID().slice(0, 8),
            trace: { trace_id: randomUUID(), span_id: randomUUID() },
            payload,
            ...extra,
        };
        const signed = this.signEnvelope(env);
        const raw = await nc.request(subject, sc.encode(JSON.stringify(signed)), { timeout });
        const reply = JSON.parse(dc.decode(raw.data));
        if (reply.error)
            return reply;
        const v = this.verifyEnvelope(reply, { direction: "outbound" });
        if (!v.valid) {
            // Accept replies even if unverified — but tag the warning
            reply._acl_warning = v.error;
        }
        else {
            reply._acl_verified_caller = v.callerIdentity;
        }
        return reply;
    }
    /**
     * Subscribe to a NATS subject and run `handler` on each inbound message.
     * The handler is only invoked if the inbound envelope passes ACL verification.
     * Unverified messages receive a signed 403 rejection envelope.
     *
     * Returns the NATS subscription for manual unsubscribe.
     */
    async handleRequests(subject, handler) {
        const nc = this.requireNc();
        const sc = new TextEncoder();
        const dc = new TextDecoder();
        const sub = nc.subscribe(subject);
        (async () => {
            for await (const rawMsg of sub) {
                const env = JSON.parse(dc.decode(rawMsg.data));
                const v = this.verifyEnvelope(env, { direction: "inbound" });
                if (!v.valid) {
                    console.log(`[ACL] ✗ Rejected ${env.from_identity || "<unsigned>"}: ${v.error}`);
                    if (rawMsg.reply) {
                        const rej = {
                            v: "0.1.0", id: randomUUID(), type: "respond",
                            ts: new Date().toISOString(), from: this.identity,
                            error: { code: 403, message: v.error, retryable: false },
                            ...(env.trace ? { trace: { ...env.trace, parent_span_id: env.trace.span_id, span_id: randomUUID() } } : {}),
                        };
                        rawMsg.respond(sc.encode(JSON.stringify(this.signEnvelope(rej))));
                    }
                    continue;
                }
                console.log(`[ACL] ✓ Accepted from ${v.callerIdentity}`);
                try {
                    const result = await handler(env, { callerIdentity: v.callerIdentity });
                    const ok = {
                        v: "0.1.0", id: randomUUID(), type: "respond",
                        ts: new Date().toISOString(), from: this.identity,
                        payload: { output: result },
                    };
                    if (env.task_id)
                        ok.task_id = env.task_id;
                    if (env.trace)
                        ok.trace = { ...env.trace, parent_span_id: env.trace.span_id, span_id: randomUUID() };
                    if (rawMsg.reply)
                        rawMsg.respond(sc.encode(JSON.stringify(this.signEnvelope(ok))));
                }
                catch (e) {
                    const err = {
                        v: "0.1.0", id: randomUUID(), type: "respond",
                        ts: new Date().toISOString(), from: this.identity,
                        error: { code: 5001, message: e.message, retryable: true },
                    };
                    if (rawMsg.reply)
                        rawMsg.respond(sc.encode(JSON.stringify(this.signEnvelope(err))));
                }
            }
        })();
        return sub;
    }
    /** Close the NATS connection if one is set. */
    close() {
        if (this.nc?.close)
            this.nc.close();
    }
}
export default ACLClient;
//# sourceMappingURL=acl.js.map