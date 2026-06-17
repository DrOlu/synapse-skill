import type { NodeConnectionOptions } from "@nats-io/transport-node";
import { GovernanceGate } from "./governance.js";
import type { GovernanceOptions, PolicyDocument } from "./governance.js";
export interface Skill {
    id: string;
    name: string;
    description: string;
    input_modes?: string[];
    output_modes?: string[];
}
export interface AgentManifest {
    id: string;
    name: string;
    description?: string;
    capabilities: string[];
    skills: Skill[];
    endpoint: string;
    availability: "online" | "busy" | "offline";
    last_heartbeat: string;
    /** Verified agent identity (DID or ACL identity). Serves as the trust root. */
    did?: string;
    /** Pointer to this agent's policy document (KV key, URL, or path). */
    policy_ref?: string;
    /** Public key fingerprint for envelope signature verification. */
    public_key_fingerprint?: string;
}
export interface Envelope {
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
    artifacts?: any[];
    error?: {
        code: number;
        message: string;
        retryable: boolean;
    };
    from_identity?: string;
    from_key_fingerprint?: string;
    signature?: string;
}
export interface DiscoverFilter {
    capabilities?: string[];
    skill_ids?: string[];
    availability?: string;
}
export type { LatencyStats, ReputationFlags, ReputationRecord, ReputationConfig, RankedAgent, RankedDiscoverFilter, ReputationStats, } from "./reputation.js";
export { ReputationStore, createReputationServiceAgent } from "./reputation.js";
export type { Decision, PolicyContext, PolicyResult, PolicyRule, PolicyDocument, GovernanceOptions, ActraAdapter, AgtAdapter, } from "./governance.js";
export { GOV_ERROR, GovernanceGate, PolicyBuilder, createActraAdapter, createAgtAdapter, } from "./governance.js";
export declare class SynapseError extends Error {
    readonly code: number;
    readonly retryable: boolean;
    constructor(message: string, code: number, retryable: boolean);
}
export declare function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries?: number, baseMs?: number): Promise<T>;
export declare class Synapse {
    private nc;
    private _id;
    private manifest;
    private handlers;
    private streamHandlers;
    private heartbeatInterval?;
    /** Governance gate — evaluates every inbound request before dispatch. */
    private governance;
    private constructor();
    static connect(url?: string, opts?: Partial<NodeConnectionOptions>): Promise<Synapse>;
    get agentId(): string;
    get isConnected(): boolean;
    get isRegistered(): boolean;
    register(options: {
        name: string;
        description?: string;
        capabilities?: string[];
        skills?: Skill[];
        /** Verified identity (DID or ACL identity). Enables registry-as-trust-root. */
        did?: string;
        /** Pointer to this agent's policy document. */
        policy_ref?: string;
        /** Public key fingerprint for envelope signature verification. */
        public_key_fingerprint?: string;
        /**
         * Governance gate options. When provided, every inbound request is
         * authorized before the handler runs. Enables fail-closed, allow/deny,
         * and require_approval (human-in-the-loop) decisions.
         */
        governance?: GovernanceOptions;
    }): Promise<AgentManifest>;
    deregister(): Promise<void>;
    discover(filter?: DiscoverFilter, windowMs?: number): Promise<AgentManifest[]>;
    request(agentId: string, skill: string, input: any, timeoutMs?: number): Promise<Envelope>;
    streamRequest(agentId: string, skill: string, input: any, timeoutMs?: number): AsyncGenerator<any>;
    onStreamRequest(skill: string, handler: (payload: any, ctx: {
        task_id: string;
        from: string;
    }) => AsyncGenerator<any>): void;
    onRequest(skill: string, handler: (payload: any, context: {
        task_id: string;
        from: string;
    }) => any): void;
    emit(eventType: string, data: any): void;
    subscribe(pattern: string, handler: (payload: any) => void): {
        unsubscribe: () => void;
    };
    getManifest(): AgentManifest | null;
    getSubscriptions(): string[];
    /** Hot-reload the governance policy (call on mesh.policy.{version}.updated). */
    reloadGovernancePolicy(policy: PolicyDocument): void;
    /** Returns the active governance gate (for testing / inspection). */
    getGovernanceGate(): GovernanceGate | null;
    close(): Promise<void>;
    private _publishError;
    private _setupDiscoverResponder;
    private _setupRequestHandler;
    private _startHeartbeat;
}
export type { Keypair, TrustEntry, TrustStore, VerifyResult, SignedEnvelope, ACLClientOptions, } from "./acl.js";
export { ACLClient, generateKeypair, slugOf, keypairPath, loadKeypair, loadTrustStore, saveKeypair } from "./acl.js";
export default Synapse;
//# sourceMappingURL=index.d.ts.map