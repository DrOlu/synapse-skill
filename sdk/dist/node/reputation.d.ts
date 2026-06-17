import type { Synapse, Envelope, AgentManifest } from "./index.js";
export interface LatencyStats {
    count: number;
    sum: number;
    p50: number;
    p95: number;
    p99: number;
}
export interface ReputationFlags {
    misleading_capabilities: boolean;
    consecutive_skill_not_found: number;
    last_penalty_at: string | null;
    penalty_reason: string | null;
}
export interface ReputationRecord {
    agent_id: string;
    skill: string;
    total: number;
    successes: number;
    failures: number;
    timeouts: number;
    skill_not_found: number;
    overloaded: number;
    rate_limited: number;
    latencies_ms: LatencyStats;
    success_rate: number;
    speed_score: number;
    freshness: number;
    score: number;
    confidence: number;
    created_at: string;
    last_seen: string;
    flags: ReputationFlags;
}
export interface ReputationConfig {
    kvBucket?: string;
    weights?: {
        success: number;
        speed: number;
        freshness: number;
    };
    maxAcceptableLatencyMs?: number;
    minimumSampleSize?: number;
    freshnessHalfLifeHours?: number;
    lyingThreshold?: {
        consecutive: number;
        ratio: number;
        minAttempts: number;
    };
    latencyReservoirSize?: number;
    autoSubscribe?: boolean;
}
export declare const DEFAULT_REPUTATION_CONFIG: Required<ReputationConfig>;
export interface RankedAgent {
    manifest: AgentManifest;
    scores: Record<string, {
        score: number;
        success_rate: number;
        avg_latency_ms: number;
        flagged: boolean;
    }>;
    aggregate_score: number;
    skills_considered: number;
}
export interface RankedDiscoverFilter {
    capabilities?: string[];
    skill?: string;
    minSuccessRate?: number;
    maxLatencyMs?: number;
    includeFlagged?: boolean;
    limit?: number;
}
export interface ReputationStats {
    total_agents: number;
    total_records: number;
    flagged_skills: number;
    avg_score: number;
}
export declare class ReputationStore {
    private config;
    private nc;
    private mesh;
    private kv;
    private localCache;
    private latencySamples;
    private subscriptions;
    private initialized;
    constructor(mesh: Synapse, config?: Partial<ReputationConfig>);
    initialize(): Promise<this>;
    close(): Promise<void>;
    private startObserving;
    private consumeTaskUpdates;
    recordOutcome(record: ReputationRecord, outcome: "success" | "failure" | "timeout" | "skill_not_found" | "overloaded" | "rate_limited", latencyMs?: number): void;
    private checkLyingThreshold;
    private recompute;
    private addLatency;
    private getOrCreate;
    private cacheKey;
    private kvKey;
    private safeKey;
    private save;
    private emitPenalty;
    clearFlag(agentId: string, skill: string, reason?: string): Promise<ReputationRecord>;
    getRecord(agentId: string, skill: string): Promise<ReputationRecord | null>;
    getRecordsForAgent(agentId: string): Promise<ReputationRecord[]>;
    getAllRecords(): Promise<ReputationRecord[]>;
    deleteRecord(agentId: string, skill: string): Promise<void>;
    discoverRanked(filter?: RankedDiscoverFilter): Promise<RankedAgent[]>;
    smartRequest(capability: string, skill: string, input: any, timeoutMs?: number, maxRetries?: number): Promise<Envelope>;
    stats(): Promise<ReputationStats>;
    leaderboard(capability?: string, skill?: string, limit?: number): Promise<RankedAgent[]>;
    dump(): {
        entries: Array<{
            key: string;
            record: ReputationRecord;
        }>;
    };
}
/**
 * Convenience factory for creating a reputation service agent.
 * Runs as a long-lived agent that answers discover-ranked requests.
 */
export declare function createReputationServiceAgent(mesh: Synapse, config?: Partial<ReputationConfig>, agentName?: string): Promise<{
    store: ReputationStore;
    manifest: AgentManifest;
}>;
export default ReputationStore;
//# sourceMappingURL=reputation.d.ts.map