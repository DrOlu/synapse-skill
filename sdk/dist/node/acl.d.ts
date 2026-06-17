export interface Keypair {
    identity: string;
    privateKeyPem: string;
    publicKeyPem: string;
    fingerprint: string;
}
export interface TrustEntry {
    public_key_pem: string;
    fingerprint: string;
    allow_inbound: string[];
    allow_outbound: string[];
    revoked: boolean;
    since: string;
    revocation_reason?: string;
    revoked_at?: string;
    rotated_at?: string;
    trusted_pubkeys: RotationKey[];
}
export interface RotationKey {
    pem: string;
    fingerprint: string;
    since: string;
    expires?: string;
}
export type TrustStore = Record<string, TrustEntry>;
export interface VerifyResult {
    valid: boolean;
    callerIdentity?: string;
    error?: string;
}
export interface SignedEnvelope {
    v: string;
    id: string;
    type: string;
    ts: string;
    from: string;
    to?: string;
    task_id?: string;
    trace?: {
        trace_id: string;
        span_id: string;
        parent_span_id?: string;
    };
    payload?: any;
    error?: {
        code: number;
        message: string;
        retryable: boolean;
    };
    from_identity: string;
    from_key_fingerprint: string;
    signature: string;
}
export interface ACLClientOptions {
    identity: string;
    privateKeyPem: string;
    publicKeyPem: string;
    fingerprint: string;
    trustStore: TrustStore;
    /** Optional NATS connection for publishSigned / requestSigned / handleRequests */
    nc?: any;
}
/**
 * Generate a new Ed25519 keypair for an agent identity.
 */
export declare function generateKeypair(identity: string): Keypair;
/**
 * Convert an identity like "org/agent" to a filesystem-safe slug.
 */
export declare function slugOf(identity: string): string;
/**
 * Canonical path for an agent's private identity file.
 */
export declare function keypairPath(identity: string, keysDir?: string): string;
/**
 * Save a keypair to disk as JSON.
 */
export declare function saveKeypair(keypair: Keypair, path: string): void;
/**
 * Load a keypair from disk.
 * Accepts either a raw file path or an identity (auto-resolved via keypairPath).
 */
export declare function loadKeypair(idOrPath: string, keysDir?: string): Keypair;
/**
 * Load a trust store from a JSON file.
 */
export declare function loadTrustStore(path: string): TrustStore;
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
export declare class ACLClient {
    readonly identity: string;
    readonly fingerprint: string;
    private privateKeyPem;
    private publicKeyPem;
    private trustStore;
    private nc?;
    constructor(options: ACLClientOptions);
    /**
     * Update the trust store (e.g., after adding or revoking an identity).
     */
    setTrustStore(trustStore: TrustStore): void;
    /**
     * Sign an envelope. Returns a new object with signature fields added.
     */
    signEnvelope(env: Record<string, any>): SignedEnvelope;
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
    verifyEnvelope(env: Record<string, any>, options?: {
        direction?: "inbound" | "outbound";
    }): VerifyResult;
    /**
     * Build a signed envelope for publishing.
     */
    makeSignedEnvelope(type: string, payload: any, from: string, extra?: Record<string, any>): SignedEnvelope;
    /** Fingerprint for the current identity. */
    getFingerprint(): string;
    /** Public key PEM for the current identity. */
    getPublicKeyPem(): string;
    /** Set a NATS connection for network operations. */
    setConnection(nc: any): void;
    private requireNc;
    /** Publish a signed envelope to a NATS subject. */
    publishSigned(subject: string, type: string, payload: any, extra?: Record<string, any>): SignedEnvelope;
    /**
     * Request-reply with signed envelopes.
     * Publishes a signed request to `subject` and waits for a signed reply.
     * Returns the verified or warned reply payload.
     */
    requestSigned(subject: string, type: string, payload: any, extra?: Record<string, any>, opts?: {
        timeout?: number;
    }): Promise<Record<string, any>>;
    /**
     * Subscribe to a NATS subject and run `handler` on each inbound message.
     * The handler is only invoked if the inbound envelope passes ACL verification.
     * Unverified messages receive a signed 403 rejection envelope.
     *
     * Returns the NATS subscription for manual unsubscribe.
     */
    handleRequests(subject: string, handler: (env: Record<string, any>, ctx: {
        callerIdentity: string;
    }) => Promise<any>): Promise<any>;
    /** Close the NATS connection if one is set. */
    close(): void;
}
export default ACLClient;
//# sourceMappingURL=acl.d.ts.map