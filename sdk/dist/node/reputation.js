// Synapse Reputation System — Per-agent, per-skill reliability scoring
//
// Tracks:
//   - Success rate per (agent_id, skill)
//   - Latency distributions (reservoir-sampled p50/p95/p99)
//   - Freshness (exponential decay from last_seen)
//   - Lying detection (repeated 3001 SKILL_NOT_FOUND)
//
// Provides:
//   - discoverRanked() — sorted agents by score
//   - smartRequest() — automatic failover to best agents
//   - clearFlag() — manual penalty reset
//
// Backed by JetStream KV bucket "REPUTATION" with optional persistent events stream.
import { v4 as uuidv4 } from "uuid";
export const DEFAULT_REPUTATION_CONFIG = {
    kvBucket: "REPUTATION",
    weights: { success: 0.7, speed: 0.2, freshness: 0.1 },
    maxAcceptableLatencyMs: 5000,
    minimumSampleSize: 5,
    freshnessHalfLifeHours: 24,
    lyingThreshold: { consecutive: 3, ratio: 0.9, minAttempts: 3 },
    latencyReservoirSize: 100,
    autoSubscribe: true,
};
// ==================== TEXT ENCODER ====================
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
// ==================== REPUTATION STORE ====================
export class ReputationStore {
    config;
    nc;
    mesh;
    kv;
    localCache = new Map();
    latencySamples = new Map();
    subscriptions = [];
    initialized = false;
    constructor(mesh, config) {
        this.mesh = mesh;
        this.nc = mesh.nc;
        this.config = {
            ...DEFAULT_REPUTATION_CONFIG,
            ...config,
            weights: { ...DEFAULT_REPUTATION_CONFIG.weights, ...config?.weights },
            lyingThreshold: {
                ...DEFAULT_REPUTATION_CONFIG.lyingThreshold,
                ...config?.lyingThreshold,
            },
        };
    }
    // ==================== LIFECYCLE ====================
    async initialize() {
        if (this.initialized)
            return this;
        const js = this.nc.jetstream();
        if (!js) {
            throw new Error("ReputationStore requires JetStream enabled on NATS server");
        }
        // Create or open KV bucket
        try {
            this.kv = await js.views.kv(this.config.kvBucket);
        }
        catch {
            // JetStream KV TTL is in nanoseconds when using bigint, or milliseconds in some SDK versions
            const ttlNs = BigInt(7 * 24 * 3600) * 1000000000n;
            this.kv = await js.views.createKV(this.config.kvBucket, {
                history: 5,
                ttl: ttlNs,
            });
        }
        // Load existing records into local cache
        try {
            const keys = await this.kv.keys();
            for await (const key of keys) {
                try {
                    const entry = await this.kv.get(key);
                    if (entry?.value) {
                        const record = JSON.parse(textDecoder.decode(entry.value));
                        this.localCache.set(this.cacheKey(record.agent_id, record.skill), record);
                    }
                }
                catch { }
            }
        }
        catch { }
        if (this.config.autoSubscribe) {
            this.startObserving();
        }
        this.initialized = true;
        return this;
    }
    async close() {
        for (const sub of this.subscriptions) {
            try {
                sub.unsubscribe();
            }
            catch { }
        }
        this.subscriptions = [];
        this.localCache.clear();
        this.latencySamples.clear();
    }
    // ==================== OBSERVATION ====================
    startObserving() {
        // Task state transitions
        const taskSub = this.nc.subscribe("mesh.task.*.update");
        this.subscriptions.push(taskSub);
        this.consumeTaskUpdates(taskSub);
        // Direct agent responses (for non-task-store flows)
        const respSub = this.nc.subscribe("mesh.registry.register");
        this.subscriptions.push(respSub);
        // Note: we don't consume register events for scoring — only capability claims
    }
    async consumeTaskUpdates(sub) {
        try {
            for await (const msg of sub) {
                try {
                    const envelope = JSON.parse(textDecoder.decode(msg.data));
                    const update = envelope.payload;
                    if (!update?.task_id)
                        continue;
                    // Reconstruct agent/skill from payload
                    const agentId = update.to_agent_id || update.from;
                    const skill = update.skill;
                    const newState = update.state;
                    const errorCode = update.error?.code;
                    if (!agentId || !skill)
                        continue;
                    const record = this.getOrCreate(agentId, skill);
                    switch (newState) {
                        case "completed":
                            this.recordOutcome(record, "success", update.latency_ms);
                            break;
                        case "failed":
                            if (errorCode === 3001) {
                                this.recordOutcome(record, "skill_not_found");
                            }
                            else if (errorCode === 4001) {
                                this.recordOutcome(record, "overloaded");
                            }
                            else if (errorCode === 4002) {
                                this.recordOutcome(record, "rate_limited");
                            }
                            else if (errorCode === 1001) {
                                this.recordOutcome(record, "timeout");
                            }
                            else {
                                this.recordOutcome(record, "failure");
                            }
                            break;
                        case "canceled":
                            // Canceled by requester — don't penalize
                            break;
                    }
                    await this.save(record);
                }
                catch { }
            }
        }
        catch { }
    }
    // ==================== OUTCOME RECORDING ====================
    recordOutcome(record, outcome, latencyMs) {
        const now = new Date().toISOString();
        record.last_seen = now;
        record.total++;
        switch (outcome) {
            case "success":
                record.successes++;
                record.flags.consecutive_skill_not_found = 0;
                if (latencyMs !== undefined)
                    this.addLatency(record, latencyMs);
                break;
            case "failure":
                record.failures++;
                break;
            case "timeout":
                record.timeouts++;
                break;
            case "skill_not_found":
                record.skill_not_found++;
                record.flags.consecutive_skill_not_found++;
                this.checkLyingThreshold(record);
                break;
            case "overloaded":
                record.overloaded++;
                // Don't recompute — transient state
                return;
            case "rate_limited":
                record.rate_limited++;
                // Don't recompute — intentional throttling
                return;
        }
        this.recompute(record);
    }
    checkLyingThreshold(record) {
        const threshold = this.config.lyingThreshold;
        const attempts = record.skill_not_found + record.successes;
        const consecutiveBreached = record.flags.consecutive_skill_not_found >= threshold.consecutive;
        const ratioBreached = attempts >= threshold.minAttempts &&
            record.skill_not_found / attempts > threshold.ratio;
        if (consecutiveBreached || ratioBreached) {
            if (!record.flags.misleading_capabilities) {
                record.flags.misleading_capabilities = true;
                record.flags.last_penalty_at = new Date().toISOString();
                record.flags.penalty_reason = "repeated_skill_not_found";
                this.emitPenalty(record);
            }
        }
    }
    // ==================== SCORING ====================
    recompute(record) {
        const c = this.config;
        // Success rate: successes / decisive outcomes
        const decisive = record.successes + record.failures + record.timeouts;
        record.success_rate = decisive > 0 ? record.successes / decisive : 0;
        // Speed score
        const avgLatency = record.latencies_ms.count > 0
            ? record.latencies_ms.sum / record.latencies_ms.count
            : 0;
        const speedPct = Math.min(avgLatency / c.maxAcceptableLatencyMs, 1);
        record.speed_score = record.success_rate > 0 ? 1 - speedPct : 0;
        // Freshness: exponential decay
        const hoursSinceSeen = (Date.now() - new Date(record.last_seen).getTime()) / (1000 * 3600);
        record.freshness = Math.exp(-hoursSinceSeen / c.freshnessHalfLifeHours);
        // Confidence
        record.confidence = decisive >= c.minimumSampleSize ? 1.0 : 0.5;
        // Composite
        const w = c.weights;
        const raw = w.success * record.success_rate +
            w.speed * record.speed_score +
            w.freshness * record.freshness;
        const lyingPenalty = record.flags.misleading_capabilities ? 0 : 1;
        record.score = raw * lyingPenalty * record.confidence;
    }
    // ==================== LATENCY TRACKING ====================
    addLatency(record, latencyMs) {
        const stats = record.latencies_ms;
        stats.count++;
        stats.sum += latencyMs;
        // Reservoir sampling for percentiles
        const key = this.cacheKey(record.agent_id, record.skill);
        let samples = this.latencySamples.get(key);
        if (!samples) {
            samples = [];
            this.latencySamples.set(key, samples);
        }
        if (samples.length < this.config.latencyReservoirSize) {
            samples.push(latencyMs);
        }
        else {
            // Reservoir algorithm R
            const idx = Math.floor(Math.random() * stats.count);
            if (idx < samples.length)
                samples[idx] = latencyMs;
        }
        // Recompute percentiles from reservoir
        if (samples.length > 0) {
            const sorted = [...samples].sort((a, b) => a - b);
            const pct = (p) => {
                if (sorted.length === 1)
                    return sorted[0];
                const targetIdx = p * (sorted.length - 1);
                const lower = Math.floor(targetIdx);
                const upper = Math.ceil(targetIdx);
                if (lower === upper)
                    return sorted[lower];
                const weight = targetIdx - lower;
                return sorted[lower] * (1 - weight) + sorted[upper] * weight;
            };
            stats.p50 = pct(0.5);
            stats.p95 = pct(0.95);
            stats.p99 = pct(0.99);
        }
    }
    // ==================== RECORD MANAGEMENT ====================
    getOrCreate(agentId, skill) {
        const key = this.cacheKey(agentId, skill);
        const existing = this.localCache.get(key);
        if (existing)
            return existing;
        const now = new Date().toISOString();
        const record = {
            agent_id: agentId,
            skill: skill,
            total: 0,
            successes: 0,
            failures: 0,
            timeouts: 0,
            skill_not_found: 0,
            overloaded: 0,
            rate_limited: 0,
            latencies_ms: { count: 0, sum: 0, p50: 0, p95: 0, p99: 0 },
            success_rate: 0,
            speed_score: 0,
            freshness: 1,
            score: 0,
            confidence: 0,
            created_at: now,
            last_seen: now,
            flags: {
                misleading_capabilities: false,
                consecutive_skill_not_found: 0,
                last_penalty_at: null,
                penalty_reason: null,
            },
        };
        this.localCache.set(key, record);
        return record;
    }
    cacheKey(agentId, skill) {
        return `${agentId}::${skill}`;
    }
    kvKey(agentId, skill) {
        return `${this.safeKey(agentId)}__${this.safeKey(skill)}`;
    }
    safeKey(s) {
        return s.replace(/[^a-zA-Z0-9._-]/g, "_");
    }
    async save(record) {
        this.localCache.set(this.cacheKey(record.agent_id, record.skill), record);
        if (this.kv) {
            try {
                await this.kv.put(this.kvKey(record.agent_id, record.skill), textEncoder.encode(JSON.stringify(record)));
            }
            catch (err) {
                console.warn(`[Reputation] Failed to persist record:`, err);
            }
        }
    }
    // ==================== EVENTS ====================
    emitPenalty(record) {
        try {
            this.nc.publish(`mesh.event.reputation.penalty.${this.safeKey(record.agent_id)}.${this.safeKey(record.skill)}`, textEncoder.encode(JSON.stringify({
                v: "1.0.0",
                id: uuidv4(),
                type: "reputation_penalty",
                ts: new Date().toISOString(),
                from: this.mesh.agentId,
                payload: {
                    agent_id: record.agent_id,
                    skill: record.skill,
                    reason: record.flags.penalty_reason,
                    skill_not_found_count: record.skill_not_found,
                    success_rate: record.success_rate,
                    score: record.score,
                    attempts: record.skill_not_found + record.successes,
                },
            })));
        }
        catch { }
    }
    // ==================== MANUAL OPERATIONS ====================
    async clearFlag(agentId, skill, reason = "manual_clear") {
        const record = this.getOrCreate(agentId, skill);
        record.flags.misleading_capabilities = false;
        record.flags.consecutive_skill_not_found = 0;
        record.flags.penalty_reason = reason;
        record.flags.last_penalty_at = new Date().toISOString();
        this.recompute(record);
        await this.save(record);
        return record;
    }
    async getRecord(agentId, skill) {
        return this.localCache.get(this.cacheKey(agentId, skill)) || null;
    }
    async getRecordsForAgent(agentId) {
        const prefix = `${agentId}::`;
        const results = [];
        for (const [key, record] of this.localCache) {
            if (key.startsWith(prefix))
                results.push(record);
        }
        return results;
    }
    async getAllRecords() {
        return Array.from(this.localCache.values());
    }
    async deleteRecord(agentId, skill) {
        this.localCache.delete(this.cacheKey(agentId, skill));
        this.latencySamples.delete(this.cacheKey(agentId, skill));
        if (this.kv) {
            try {
                await this.kv.delete(this.kvKey(agentId, skill));
            }
            catch { }
        }
    }
    // ==================== RANKED DISCOVERY ====================
    async discoverRanked(filter = {}) {
        const agents = await this.mesh.discover({
            capabilities: filter.capabilities,
        });
        const ranked = [];
        for (const manifest of agents) {
            const skillScores = {};
            let sumScore = 0;
            let count = 0;
            for (const skill of manifest.skills) {
                const record = this.localCache.get(this.cacheKey(manifest.id, skill.id));
                if (record) {
                    // Apply filter exclusions
                    if (!filter.includeFlagged && record.flags.misleading_capabilities) {
                        continue;
                    }
                    if (filter.minSuccessRate !== undefined &&
                        record.confidence >= 1.0 &&
                        record.success_rate < filter.minSuccessRate) {
                        continue;
                    }
                    if (filter.maxLatencyMs !== undefined &&
                        record.latencies_ms.count > 0 &&
                        record.latencies_ms.p50 > filter.maxLatencyMs) {
                        continue;
                    }
                    const avgMs = record.latencies_ms.count > 0
                        ? record.latencies_ms.sum / record.latencies_ms.count
                        : 0;
                    skillScores[skill.id] = {
                        score: record.score,
                        success_rate: record.success_rate,
                        avg_latency_ms: avgMs,
                        flagged: record.flags.misleading_capabilities,
                    };
                    // If filtering by specific skill, only count that skill
                    if (!filter.skill || filter.skill === skill.id) {
                        sumScore += record.score;
                        count++;
                    }
                }
                else {
                    // No data yet — give benefit of the doubt with very low score
                    // (only included if no strict filters apply)
                    const includeUnknown = (filter.includeFlagged ?? false) ||
                        filter.minSuccessRate === undefined ||
                        filter.minSuccessRate <= 0.1;
                    if (includeUnknown && (!filter.skill || filter.skill === skill.id)) {
                        skillScores[skill.id] = {
                            score: 0.1,
                            success_rate: 0,
                            avg_latency_ms: 0,
                            flagged: false,
                        };
                        sumScore += 0.1;
                        count++;
                    }
                }
            }
            if (count > 0) {
                ranked.push({
                    manifest,
                    scores: skillScores,
                    aggregate_score: sumScore / count,
                    skills_considered: count,
                });
            }
        }
        ranked.sort((a, b) => b.aggregate_score - a.aggregate_score);
        if (filter.limit !== undefined && filter.limit > 0) {
            return ranked.slice(0, filter.limit);
        }
        return ranked;
    }
    // ==================== SMART REQUEST ====================
    async smartRequest(capability, skill, input, timeoutMs = 30000, maxRetries = 3) {
        const ranked = await this.discoverRanked({
            capabilities: [capability],
            skill,
            includeFlagged: false,
        });
        if (ranked.length === 0) {
            throw new Error(`No agents available for capability "${capability}" skill "${skill}"`);
        }
        let lastError;
        const attempts = [];
        for (let i = 0; i < Math.min(maxRetries, ranked.length); i++) {
            const candidate = ranked[i];
            const startedAt = Date.now();
            try {
                const result = await this.mesh.request(candidate.manifest.id, skill, input, timeoutMs);
                const latency = Date.now() - startedAt;
                attempts.push({
                    agent: candidate.manifest.id,
                    success: true,
                    latency_ms: latency,
                });
                // Update reputation
                const record = this.getOrCreate(candidate.manifest.id, skill);
                this.recordOutcome(record, "success", latency);
                await this.save(record);
                return result;
            }
            catch (err) {
                const latency = Date.now() - startedAt;
                attempts.push({
                    agent: candidate.manifest.id,
                    success: false,
                    latency_ms: latency,
                });
                const record = this.getOrCreate(candidate.manifest.id, skill);
                const errorCode = err?.code;
                if (errorCode === 1001) {
                    this.recordOutcome(record, "timeout");
                }
                else if (errorCode === 3001) {
                    this.recordOutcome(record, "skill_not_found");
                }
                else if (errorCode === 4001) {
                    this.recordOutcome(record, "overloaded");
                }
                else if (!err?.retryable) {
                    this.recordOutcome(record, "failure");
                }
                await this.save(record);
                if (!err?.retryable) {
                    lastError = err;
                    break;
                }
                lastError = err;
            }
        }
        throw lastError || new Error("All retries exhausted");
    }
    // ==================== STATISTICS ====================
    async stats() {
        const agents = new Set();
        let flagged = 0;
        let scoreSum = 0;
        let scoreCount = 0;
        for (const record of this.localCache.values()) {
            agents.add(record.agent_id);
            if (record.flags.misleading_capabilities)
                flagged++;
            scoreSum += record.score;
            scoreCount++;
        }
        return {
            total_agents: agents.size,
            total_records: this.localCache.size,
            flagged_skills: flagged,
            avg_score: scoreCount > 0 ? scoreSum / scoreCount : 0,
        };
    }
    // ==================== LEADERBOARD ====================
    async leaderboard(capability, skill, limit = 10) {
        return this.discoverRanked({
            capabilities: capability ? [capability] : undefined,
            skill,
            limit,
        });
    }
    // ==================== DEBUG/INSPECTION ====================
    dump() {
        return {
            entries: Array.from(this.localCache.entries()).map(([key, record]) => ({
                key,
                record,
            })),
        };
    }
}
// ==================== STANDALONE USAGE ====================
/**
 * Convenience factory for creating a reputation service agent.
 * Runs as a long-lived agent that answers discover-ranked requests.
 */
export async function createReputationServiceAgent(mesh, config, agentName = "Reputation Service") {
    const manifest = await mesh.register({
        name: agentName,
        description: "Central reputation scoring service",
        capabilities: ["reputation"],
        skills: [
            {
                id: "discover-ranked",
                name: "Ranked Discovery",
                description: "Returns agents ranked by reputation for given capability/skill",
            },
            {
                id: "get-record",
                name: "Get Reputation Record",
                description: "Returns reputation for specific agent/skill pair",
            },
            {
                id: "clear-flag",
                name: "Clear Penalty Flag",
                description: "Manually clears misleading_capabilities flag",
            },
            {
                id: "leaderboard",
                name: "Leaderboard",
                description: "Top N agents by score for capability",
            },
            {
                id: "stats",
                name: "Statistics",
                description: "Returns aggregate reputation statistics",
            },
        ],
    });
    const store = new ReputationStore(mesh, config);
    await store.initialize();
    mesh.onRequest("discover-ranked", async (payload) => {
        const ranked = await store.discoverRanked(payload?.input || {});
        return { agents: ranked };
    });
    mesh.onRequest("get-record", async (payload) => {
        const { agent_id, skill } = payload?.input || {};
        if (!agent_id || !skill) {
            throw new Error("Required: agent_id and skill in input");
        }
        return await store.getRecord(agent_id, skill);
    });
    mesh.onRequest("clear-flag", async (payload) => {
        const { agent_id, skill, reason } = payload?.input || {};
        if (!agent_id || !skill) {
            throw new Error("Required: agent_id and skill in input");
        }
        return await store.clearFlag(agent_id, skill, reason);
    });
    mesh.onRequest("leaderboard", async (payload) => {
        const { capability, skill, limit } = payload?.input || {};
        return await store.leaderboard(capability, skill, limit);
    });
    mesh.onRequest("stats", async () => {
        return await store.stats();
    });
    return { store, manifest };
}
export default ReputationStore;
//# sourceMappingURL=reputation.js.map