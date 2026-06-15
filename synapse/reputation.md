# Reputation System

Per-agent, per-skill reliability scoring and ranked discovery. Detects agents that claim capabilities they don't have, tracks delivery success rates, and automatically ranks agents by observed performance.

---

## Why Reputation?

Synapse's `discover()` returns all agents claiming a capability — equally, with no ranking. This creates two problems:

1. **No quality differentiation.** Agent A might deliver 99% success at 50ms, while Agent B delivers 40% success at 800ms. Both appear identical in `discover()`.

2. **No lying detection.** An agent can register with `capabilities: ["payment"]` without ever implementing a handler. Every request to it returns `3001 SKILL_NOT_FOUND`, but the agent still shows up as "available" in registry responses.

The Reputation System solves both by **observing actual behavior** and scoring agents on:

| Metric | What It Measures |
|--------|-----------------|
| **Success rate** | How often does this agent actually complete the work? |
| **Latency** | How fast is this agent compared to acceptable max? |
| **Freshness** | Has this agent been seen recently? |
| **Skill honesty** | Does the agent actually have handlers for claimed skills? |

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Agent A sends request → Agent B                           │
│      ↓ (task_store records state transitions)              │
│      ↓                                                     │
│  Reputation Service subscribes to:                         │
│      • mesh.task.*.update     (state transitions)         │
│      • mesh.agent.*.inbox     (request/response patterns) │
│      • mesh.registry.register (capability claims)         │
│      • mesh.heartbeat.*       (liveness)                  │
│                                                             │
│  Maintains: JetStream KV bucket "REPUTATION"              │
│      Key: {agent_id}::{skill}                              │
│      Value: ReputationRecord JSON                         │
│                                                             │
│  Exposes: discoverRanked(), smartRequest(), getScores()   │
│  Emits:   mesh.event.reputation.penalty (for liars)       │
└────────────────────────────────────────────────────────────┘
```

### Two Deployment Modes

| Mode | Description | When to Use |
|------|-------------|------------|
| **Embedded (Local)** | Each agent tracks its own reputation store by watching NATS events. No central service. | Small meshes, privacy-sensitive deployments |
| **Service (Shared)** | One dedicated reputation service agent subscribes to everything and answers `discover-ranked` requests from any agent. | Large meshes, shared truth source, cross-agent visibility |

Both modes use the same `ReputationStore` class. The difference is whether it runs inside every agent or in a single long-running service agent.

---

## Data Model

### Reputation Record (per agent, per skill)

```json
{
  "agent_id": "drolu/pi-bmc-agent",
  "skill": "restart-server",
  "total": 347,
  "successes": 312,
  "failures": 28,
  "timeouts": 7,
  "skill_not_found": 0,
  "overloaded": 15,
  "rate_limited": 3,
  "latencies_ms": {
    "count": 312,
    "sum": 390000,
    "p50": 1250,
    "p95": 2800,
    "p99": 4500
  },
  "success_rate": 0.899,
  "speed_score": 0.750,
  "freshness": 0.982,
  "score": 0.823,
  "confidence": 1.0,
  "created_at": "2026-06-14T10:00:00Z",
  "last_seen": "2026-06-15T14:03:45.123Z",
  "flags": {
    "misleading_capabilities": false,
    "consecutive_skill_not_found": 0,
    "last_penalty_at": null,
    "penalty_reason": null
  }
}
```

### Field Definitions

| Field | Type | Meaning |
|-------|------|---------|
| `agent_id` | string | The agent being scored |
| `skill` | string | The specific skill being scored |
| `total` | number | Total requests observed (all outcomes) |
| `successes` | number | Tasks reaching `completed` state |
| `failures` | number | Tasks reaching `failed` with 5xxx errors |
| `timeouts` | number | No response within deadline (4001 transport) |
| `skill_not_found` | number | Count of `3001 SKILL_NOT_FOUND` responses |
| `overloaded` | number | Count of `4001 OVERLOADED` (retryable, not counted against reputation) |
| `rate_limited` | number | Count of `4002 RATE_LIMITED` (retryable) |
| `latencies_ms` | object | Reservoir-sampled latency stats (p50/p95/p99) |
| `success_rate` | float | successes / (successes + failures + timeouts) |
| `speed_score` | float | 1 - clamp(avg_latency / max_acceptable_ms, 0, 1) |
| `freshness` | float | exp(-hours_since_last_seen / 24) |
| `score` | float | Final composite score (0–1) |
| `confidence` | float | 1.0 if total >= minimum_sample_size, else 0.5 |
| `flags.misleading_capabilities` | boolean | True if agent repeatedly returns SKILL_NOT_FOUND for this skill |
| `flags.consecutive_skill_not_found` | number | Rolling count of SKILL_NOT_FOUND in a row |

---

## Scoring Formula

```
success_rate    = successes / max(1, successes + failures + timeouts)
                  // 3001 does NOT count here; it triggers the lying flag separately
                  // 4001/4002 do NOT count; they're retryable signals

lying_penalty   = flags.misleading_capabilities ? 0.0 : 1.0

speed_score     = success_rate > 0
                  ? 1 - clamp(avg(latencies_ms) / config.max_acceptable_latency_ms, 0, 1)
                  : 0

freshness       = exp(-hours_since_last_seen / 24)
                  // 50% decay every 24 hours, ~0 after a week

confidence      = (successes + failures + timeouts >= config.minimum_sample_size)
                  ? 1.0 : 0.5

raw_score       = (0.7 * success_rate + 0.2 * speed_score + 0.1 * freshness)

final_score     = raw_score * lying_penalty * confidence
```

### Why These Weights?

- **70% success rate** — Reliability matters most. An agent that delivers slowly beats one that fails fast.
- **20% speed** — Among equally reliable agents, prefer the faster one.
- **10% freshness** — Penalize agents that haven't been seen recently.

The weights are configurable via `ReputationConfig`:

```typescript
const config: ReputationConfig = {
  weights: { success: 0.7, speed: 0.2, freshness: 0.1 },
  max_acceptable_latency_ms: 5000,
  minimum_sample_size: 5,
  freshness_half_life_hours: 24,
};
```

---

## Lying Detection

An agent "lies" when it claims a capability (via `register()`) but has no handler for it. Every request for that skill returns `3001 SKILL_NOT_FOUND`.

### Detection Logic

```typescript
function updateSkillNotFoundCount(agentId, skill) {
  const record = getOrCreate(agentId, skill);
  record.skill_not_found++;
  record.flags.consecutive_skill_not_found++;

  const attempts = record.skill_not_found + record.successes;

  // Flag if:
  // (a) 3+ consecutive SKILL_NOT_FOUND, OR
  // (b) > 90% skill_not_found rate AND at least 3 attempts
  if (
    record.flags.consecutive_skill_not_found >= 3 ||
    (attempts >= 3 && record.skill_not_found / attempts > 0.9)
  ) {
    record.flags.misleading_capabilities = true;
    record.flags.last_penalty_at = new Date().toISOString();
    record.flags.penalty_reason = "repeated_skill_not_found";
    store.save(record);

    // Broadcast penalty event
    store.emitPenalty(record);
  }
}

function resetConsecutiveOnSuccess(agentId, skill) {
  const record = get(agentId, skill);
  if (record) {
    record.flags.consecutive_skill_not_found = 0;
    store.save(record);
  }
}
```

### What Happens When an Agent Is Flagged

| Stage | Action | Effect |
|-------|--------|--------|
| 1. First few SKILL_NOT_FOUND | Count increments | Score unaffected |
| 2. Threshold breached | `misleading_capabilities = true` + penalty event emitted | Score drops to 0 for that skill |
| 3. `discoverRanked()` calls | Agent excluded from results (unless `includeFlagged: true`) | Other agents stop routing to it |
| 4. Agent fixes the handler | Next successful request resets `consecutive_skill_not_found` to 0 | Score starts recovering (but misleading flag persists until `clearFlag()` or time-based decay) |

### Manual Penalty Clearing

```typescript
// Operator clears the flag after manual verification
await reputation.clearFlag(agentId, skill, "handler_redeployed");
```

---

## Setup

### 1. Create JetStream KV Bucket

```bash
nats kv add REPUTATION \
  --history=5 \
  --ttl=604800s \
  --description="Synapse agent reputation records"

# TTL: 7 days — reputation decays naturally without recent activity
# history=5 — keep last 5 updates for audit trail
```

### 2. (Optional) Create Persistent Events Stream

For audit/replay of reputation changes:

```bash
nats stream add REPUTATION_EVENTS \
  --subjects="mesh.event.reputation.>" \
  --storage=file \
  --retention=limits \
  --max-age=30d
```

---

## TypeScript Implementation

```typescript
// src/reputation.ts — Complete reputation system
import { Synapse, Envelope, AgentManifest } from "./synapse.js";
import type { NatsConnection } from "@nats-io/nats-core";

// ==================== TYPES ====================

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
  weights?: { success: number; speed: number; freshness: number };
  maxAcceptableLatencyMs?: number;
  minimumSampleSize?: number;
  freshnessHalfLifeHours?: number;
  lyingThreshold?: { consecutive: number; ratio: number; minAttempts: number };
  latencyReservoirSize?: number;
  autoSubscribe?: boolean;
}

export const DEFAULT_CONFIG: Required<ReputationConfig> = {
  kvBucket: "REPUTATION",
  weights: { success: 0.7, speed: 0.2, freshness: 0.1 },
  maxAcceptableLatencyMs: 5000,
  minimumSampleSize: 5,
  freshnessHalfLifeHours: 24,
  lyingThreshold: { consecutive: 3, ratio: 0.9, minAttempts: 3 },
  latencyReservoirSize: 100,
  autoSubscribe: true,
};

export interface RankedAgent {
  manifest: AgentManifest;
  scores: Record<string, { score: number; success_rate: number; avg_latency_ms: number }>;
  aggregate_score: number;
}

export interface RankedDiscoverFilter {
  capabilities?: string[];
  skill?: string;
  minSuccessRate?: number;
  maxLatencyMs?: number;
  includeFlagged?: boolean;
  limit?: number;
}

// ==================== INTERNAL TRACKING ====================

interface PendingRequest {
  agentId: string;
  skill: string;
  startedAt: number;
  taskId: string;
}

// ==================== REPUTATION STORE ====================

export class ReputationStore {
  private config: Required<ReputationConfig>;
  private nc: NatsConnection;
  private mesh: Synapse;
  private kv: any;
  private localCache: Map<string, ReputationRecord> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private latencySamples: Map<string, number[]> = new Map();

  constructor(mesh: Synapse, config?: ReputationConfig) {
    this.mesh = mesh;
    this.nc = (mesh as any).nc;
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<ReputationConfig>;
  }

  async initialize(): Promise<void> {
    const js = this.nc.jetstream();
    try {
      this.kv = await js.views.kv(this.config.kvBucket);
    } catch {
      this.kv = await js.views.kv(this.config.kvBucket, {
        history: 5,
        ttl: 7 * 24 * 3600 * 1000,
      });
    }

    // Load existing records into local cache
    const keys = await this.kv.keys();
    for await (const key of keys) {
      try {
        const entry = await this.kv.get(key);
        const record = JSON.parse(new TextDecoder().decode(entry.value)) as ReputationRecord;
        this.localCache.set(this.cacheKey(record.agent_id, record.skill), record);
      } catch {}
    }

    if (this.config.autoSubscribe) {
      this.startObserving();
    }
  }

  // ==================== EVENT OBSERVATION ====================

  private startObserving(): void {
    // Watch task state transitions
    const taskSub = this.nc.subscribe("mesh.task.*.update");
    (async () => {
      for await (const msg of taskSub) {
        try {
          const data = JSON.parse(new TextDecoder().decode(msg.data));
          this.onTaskUpdate(data);
        } catch {}
      }
    })();

    // Watch for response patterns directly
    const respSub = this.nc.subscribe("mesh.agent.*.response");
    (async () => {
      for await (const msg of respSub) {
        try {
          const data = JSON.parse(new TextDecoder().decode(msg.data));
          this.onResponse(data);
        } catch {}
      }
    })();
  }

  private onTaskUpdate(data: any): void {
    const task = data.payload;
    if (!task?.task_id || !task.to || !task.skill) return;

    const record = this.getOrCreate(task.to, task.skill);

    if (task.state === "completed") {
      this.recordSuccess(record, this.measureLatency(task));
    } else if (task.state === "failed") {
      const errorCode = task.error?.code;
      if (errorCode === 3001) {
        this.recordSkillNotFound(record);
      } else if (errorCode === 4001) {
        this.recordOverloaded(record);
      } else if (errorCode === 4002) {
        this.recordRateLimited(record);
      } else {
        this.recordFailure(record);
      }
    }

    this.save(record);
  }

  private onResponse(data: any): void {
    // Mirror of task update logic for non-task-store flows
    const env = data as Envelope;
    if (!env?.to || env.type !== "respond") return;
    // Handle inline responses without task store
    const skill = env.payload?.skill;
    if (!skill) return;

    const record = this.getOrCreate(env.from, skill);

    if (env.error) {
      if (env.error.code === 3001) this.recordSkillNotFound(record);
      else if (env.error.code === 4001) this.recordOverloaded(record);
      else if (env.error.code === 4002) this.recordRateLimited(record);
      else this.recordFailure(record);
    } else {
      this.recordSuccess(record);
    }

    this.save(record);
  }

  // ==================== RECORDING OUTCOMES ====================

  private recordSuccess(record: ReputationRecord, latencyMs?: number): void {
    record.successes++;
    record.total++;
    record.last_seen = new Date().toISOString();
    record.flags.consecutive_skill_not_found = 0;
    if (latencyMs !== undefined) this.addLatency(record, latencyMs);
    this.recompute(record);
  }

  private recordFailure(record: ReputationRecord): void {
    record.failures++;
    record.total++;
    record.last_seen = new Date().toISOString();
    this.recompute(record);
  }

  private recordTimeout(record: ReputationRecord): void {
    record.timeouts++;
    record.total++;
    record.last_seen = new Date().toISOString();
    this.recompute(record);
  }

  private recordSkillNotFound(record: ReputationRecord): void {
    record.skill_not_found++;
    record.total++;
    record.last_seen = new Date().toISOString();
    record.flags.consecutive_skill_not_found++;

    const attempts = record.skill_not_found + record.successes;
    const threshold = this.config.lyingThreshold;

    if (
      record.flags.consecutive_skill_not_found >= threshold.consecutive ||
      (attempts >= threshold.minAttempts && record.skill_not_found / attempts > threshold.ratio)
    ) {
      record.flags.misleading_capabilities = true;
      record.flags.last_penalty_at = new Date().toISOString();
      record.flags.penalty_reason = "repeated_skill_not_found";
      this.emitPenalty(record);
    }

    this.recompute(record);
  }

  private recordOverloaded(record: ReputationRecord): void {
    record.overloaded++;
    record.total++;
    record.last_seen = new Date().toISOString();
    // Do NOT recompute — overloaded is a transient state, not a reliability signal
  }

  private recordRateLimited(record: ReputationRecord): void {
    record.rate_limited++;
    record.total++;
    record.last_seen = new Date().toISOString();
    // Do NOT recompute — rate limiting is intentional throttling
  }

  // ==================== SCORING ====================

  private recompute(record: ReputationRecord): void {
    const c = this.config;

    // Success rate: successes / (successes + failures + timeouts)
    const decisive = record.successes + record.failures + record.timeouts;
    record.success_rate = decisive > 0 ? record.successes / decisive : 0;

    // Speed score: based on average latency vs max acceptable
    const avgLatency =
      record.latencies_ms.count > 0
        ? record.latencies_ms.sum / record.latencies_ms.count
        : 0;
    const speedPct = Math.min(avgLatency / c.maxAcceptableLatencyMs, 1);
    record.speed_score = record.success_rate > 0 ? 1 - speedPct : 0;

    // Freshness: exponential decay from last_seen
    const hoursSinceSeen =
      (Date.now() - new Date(record.last_seen).getTime()) / (1000 * 3600);
    record.freshness = Math.exp(-hoursSinceSeen / c.freshnessHalfLifeHours);

    // Confidence: low until minimum sample size
    record.confidence = decisive >= c.minimumSampleSize ? 1.0 : 0.5;

    // Composite
    const w = c.weights;
    const raw =
      w.success * record.success_rate +
      w.speed * record.speed_score +
      w.freshness * record.freshness;

    const lyingPenalty = record.flags.misleading_capabilities ? 0 : 1;

    record.score = raw * lyingPenalty * record.confidence;
  }

  // ==================== LATENCY TRACKING ====================

  private addLatency(record: ReputationRecord, latencyMs: number): void {
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
    } else {
      const idx = Math.floor(Math.random() * stats.count);
      if (idx < samples.length) samples[idx] = latencyMs;
    }

    // Recompute percentiles
    if (samples.length > 0) {
      const sorted = [...samples].sort((a, b) => a - b);
      const pct = (p: number) => sorted[Math.floor(p * sorted.length)] || 0;
      stats.p50 = pct(0.5);
      stats.p95 = pct(0.95);
      stats.p99 = pct(0.99);
    }
  }

  private measureLatency(task: any): number | undefined {
    if (!task.created_at || !task.updated_at) return undefined;
    return (
      new Date(task.updated_at).getTime() -
      new Date(task.created_at).getTime()
    );
  }

  // ==================== PERSISTENCE ====================

  private getOrCreate(agentId: string, skill: string): ReputationRecord {
    const key = this.cacheKey(agentId, skill);
    let record = this.localCache.get(key);
    if (!record) {
      const now = new Date().toISOString();
      record = {
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
    }
    return record;
  }

  private cacheKey(agentId: string, skill: string): string {
    return `${agentId}::${skill}`;
  }

  private async save(record: ReputationRecord): Promise<void> {
    this.localCache.set(this.cacheKey(record.agent_id, record.skill), record);
    if (this.kv) {
      const key = `${this.safeKey(record.agent_id)}__${this.safeKey(record.skill)}`;
      await this.kv.put(key, new TextEncoder().encode(JSON.stringify(record)));
    }
  }

  private safeKey(s: string): string {
    return s.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  // ==================== EVENTS ====================

  private emitPenalty(record: ReputationRecord): void {
    this.nc.publish(
      `mesh.event.reputation.penalty.${this.safeKey(record.agent_id)}`,
      new TextEncoder().encode(
        JSON.stringify({
          v: "1.0.0",
          id: Math.random().toString(36).slice(2),
          type: "reputation_penalty",
          ts: new Date().toISOString(),
          from: this.mesh.agentId,
          payload: {
            agent_id: record.agent_id,
            skill: record.skill,
            reason: record.flags.penalty_reason,
            skill_not_found_count: record.skill_not_found,
            score: record.score,
          },
        })
      )
    );
  }

  // ==================== MANUAL OPERATIONS ====================

  async clearFlag(
    agentId: string,
    skill: string,
    reason: string = "manual_clear"
  ): Promise<void> {
    const record = this.getOrCreate(agentId, skill);
    record.flags.misleading_capabilities = false;
    record.flags.consecutive_skill_not_found = 0;
    record.flags.penalty_reason = reason;
    record.flags.last_penalty_at = new Date().toISOString();
    this.recompute(record);
    await this.save(record);
  }

  async getRecord(
    agentId: string,
    skill: string
  ): Promise<ReputationRecord | null> {
    return this.localCache.get(this.cacheKey(agentId, skill)) || null;
  }

  async getRecordsForAgent(agentId: string): Promise<ReputationRecord[]> {
    const prefix = `${agentId}::`;
    const results: ReputationRecord[] = [];
    for (const [key, record] of this.localCache) {
      if (key.startsWith(prefix)) results.push(record);
    }
    return results;
  }

  // ==================== RANKED DISCOVERY ====================

  async discoverRanked(
    filter: RankedDiscoverFilter = {}
  ): Promise<RankedAgent[]> {
    const agents = await this.mesh.discover({
      capabilities: filter.capabilities,
    });

    const ranked: RankedAgent[] = [];

    for (const manifest of agents) {
      const skillScores: Record<
        string,
        { score: number; success_rate: number; avg_latency_ms: number }
      > = {};
      let sumScore = 0;
      let count = 0;

      for (const skill of manifest.skills) {
        const record = this.localCache.get(
          this.cacheKey(manifest.id, skill.id)
        );

        if (record) {
          // Apply filters
          if (
            !filter.includeFlagged &&
            record.flags.misleading_capabilities
          ) {
            continue;
          }
          if (
            filter.minSuccessRate &&
            record.success_rate < filter.minSuccessRate
          ) {
            continue;
          }
          if (filter.maxLatencyMs && record.latencies_ms.p50 > filter.maxLatencyMs) {
            continue;
          }

          const avgMs =
            record.latencies_ms.count > 0
              ? record.latencies_ms.sum / record.latencies_ms.count
              : 0;

          skillScores[skill.id] = {
            score: record.score,
            success_rate: record.success_rate,
            avg_latency_ms: avgMs,
          };

          // If filtering by specific skill, only count that skill
          if (!filter.skill || filter.skill === skill.id) {
            sumScore += record.score;
            count++;
          }
        } else if (filter.includeFlagged || !filter.minSuccessRate) {
          // No data yet — give benefit of the doubt with low score
          if (!filter.skill || filter.skill === skill.id) {
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
        });
      }
    }

    // Sort by aggregate score descending
    ranked.sort((a, b) => b.aggregate_score - a.aggregate_score);

    if (filter.limit) {
      return ranked.slice(0, filter.limit);
    }
    return ranked;
  }

  // ==================== SMART REQUEST ====================

  async smartRequest(
    capability: string,
    skill: string,
    input: any,
    timeoutMs: number = 30000,
    maxRetries: number = 3
  ): Promise<Envelope> {
    const ranked = await this.discoverRanked({
      capabilities: [capability],
      skill,
      minSuccessRate: 0.5,
      maxLatencyMs: this.config.maxAcceptableLatencyMs,
    });

    if (ranked.length === 0) {
      throw new Error(`No agents available for capability "${capability}"`);
    }

    let lastError: unknown;
    for (let i = 0; i < Math.min(maxRetries, ranked.length); i++) {
      const agent = ranked[i];
      try {
        const result = await this.mesh.request(
          agent.manifest.id,
          skill,
          input,
          timeoutMs
        );
        return result;
      } catch (err) {
        lastError = err;
        // Record timeout/failure in reputation for retry analysis
        const record = this.getOrCreate(agent.manifest.id, skill);
        if ((err as any)?.code === 4001) {
          this.recordTimeout(record);
        } else if (!(err as any)?.retryable) {
          this.recordFailure(record);
        }
        await this.save(record);
      }
    }

    throw lastError || new Error("All retries exhausted");
  }

  // ==================== STATS ====================

  async stats(): Promise<{
    total_agents: number;
    total_records: number;
    flagged_skills: number;
  }> {
    const agents = new Set<string>();
    let flagged = 0;

    for (const record of this.localCache.values()) {
      agents.add(record.agent_id);
      if (record.flags.misleading_capabilities) flagged++;
    }

    return {
      total_agents: agents.size,
      total_records: this.localCache.size,
      flagged_skills: flagged,
    };
  }

  // ==================== CLEANUP ====================

  async close(): Promise<void> {
    this.localCache.clear();
    this.latencySamples.clear();
    this.pendingRequests.clear();
  }
}
```

### Integration with Synapse SDK

```typescript
// Usage: Reputation-aware agent
import Synapse from "synapse-nats-sdk";
import { ReputationStore } from "./reputation.js";

const mesh = await Synapse.connect("nats://localhost:4222");
await mesh.register({
  name: "Orchestrator",
  capabilities: ["orchestrate"],
  skills: [{ id: "orchestrate", name: "Orchestrate", description: "..." }],
});

// Initialize reputation (auto-subscribes to events)
const reputation = new ReputationStore(mesh);
await reputation.initialize();

// Use ranked discovery for routing
const ranked = await reputation.discoverRanked({
  capabilities: ["chat"],
  skill: "respond",
  minSuccessRate: 0.8,
  limit: 3,
});

console.log("Top 3 chat agents:");
for (const r of ranked) {
  console.log(`  ${r.manifest.name}: score=${r.aggregate_score.toFixed(3)}`);
}

// Use smartRequest for automatic retry on best agents
const result = await reputation.smartRequest("chat", "respond", {
  message: "Hello",
});
console.log(result.payload.output);
```

---

## CLI Usage

```bash
# Create the KV bucket
nats kv add REPUTATION --history=5 --ttl=604800s

# Watch live reputation updates
nats kv watch REPUTATION

# Get reputation for a specific agent/skill
nats kv get REPUTATION drolu__pi-bmc-agent__restart-server

# Watch for penalty events (liars)
nats sub 'mesh.event.reputation.penalty.>'

# List all tracked (agent, skill) pairs
nats kv keys REPUTATION

# Check overall stats
nats kv info REPUTATION
```

---

## Deployment Patterns

### Pattern 1: Embedded in Every Agent

Each agent runs its own `ReputationStore`. They build reputation from their own interactions.

```
Agent A's ReputationStore          Agent B's ReputationStore
──────────────────────             ──────────────────────
Knows: "B is good at chat"         Knows: "A is good at analyze"
Knows: "C is good at chat"         Knows: "C is slow at summarize"

Pros:
  ✓ Zero extra infrastructure
  ✓ Private (your experience stays local)
  ✓ No single point of failure

Cons:
  ✗ No shared view (A might not know B's experience with C)
  ✗ Cold start for new agents
```

### Pattern 2: Dedicated Reputation Service

One long-running service agent subscribes to everything and answers `discover-ranked` requests.

```typescript
// reputation-service.ts — runs as a standalone service agent
import Synapse from "synapse-nats-sdk";
import { ReputationStore } from "./reputation.js";

const mesh = await Synapse.connect("nats://localhost:4222");
await mesh.register({
  name: "Reputation Service",
  capabilities: ["reputation"],
  skills: [
    { id: "discover-ranked", name: "Ranked Discovery", description: "Ranked agent lookup" },
    { id: "get-record", name: "Get Record", description: "Get reputation for agent/skill" },
    { id: "clear-flag", name: "Clear Flag", description: "Manually clear penalty" },
  ],
});

const store = new ReputationStore(mesh, { autoSubscribe: true });
await store.initialize();

mesh.onRequest("discover-ranked", async (payload) => {
  const ranked = await store.discoverRanked(payload.input);
  return { agents: ranked };
});

mesh.onRequest("get-record", async (payload) => {
  const { agent_id, skill } = payload.input;
  return await store.getRecord(agent_id, skill);
});

mesh.onRequest("clear-flag", async (payload) => {
  const { agent_id, skill, reason } = payload.input;
  await store.clearFlag(agent_id, skill, reason);
  return { cleared: true };
});
```

Then any agent can query it:

```typescript
const result = await mesh.request("reputation-service-001", "discover-ranked", {
  capabilities: ["chat"],
  minSuccessRate: 0.8,
});
const ranked = result.payload.output.agents;
```

### Pattern 3: Hybrid (Embedded + Service Sync)

Use hybrid when you want both low-latency local routing AND cross-agent visibility:

```typescript
// Each agent runs local store
const local = new ReputationStore(mesh, { autoSubscribe: true });
await local.initialize();

// Also subscribe to reputation service's penalty events for real-time flag updates
mesh.subscribe("mesh.event.reputation.penalty.>", async (data) => {
  const { agent_id, skill } = data.payload;
  const record = await local.getRecord(agent_id, skill);
  if (record) {
    record.flags.misleading_capabilities = true;
    // Recompute score immediately
  }
});
```

---

## Dashboard Integration

Subscribe to reputation events and push to Grafana:

```typescript
// Grafana metrics bridge
mesh.subscribe("mesh.task.*.update", async (data) => {
  const { task_id, state, from, to } = data.payload;
  
  // Push to Prometheus via pushgateway
  promClient
    .gauge("synapse_agent_score")
    .labels({ agent: to, skill: data.payload.skill })
    .set(await getScore(to, data.payload.skill));
});
```

### Grafana Dashboard JSON (excerpt)

```json
{
  "title": "Agent Reputation Scores",
  "type": "table",
  "targets": [
    {
      "expr": "synapse_agent_score",
      "legendFormat": "{{agent}} / {{skill}}"
    }
  ]
}
```

---

## Threat Model

| Threat | Mitigated? |
|--------|-----------|
| Agent claims capabilities it doesn't have | ✅ Yes — 3001 SKILL_NOT_FOUND detection |
| Agent degrades over time (performance drop) | ✅ Yes — score decays with success rate |
| Agent goes offline | ✅ Yes — freshness decays after 24h, confidence drops |
| Agent occasionally times out under load | ✅ Yes — timeouts counted as failures |
| Agent is temporarily overloaded | ⚠️ Partial — 4001 retries excluded, but repeated overload reduces trust |
| Agent returns wrong results (semantic errors) | ❌ No — reputation tracks delivery, not correctness |
| Coordinated malicious agents downgrading rivals | ⚠️ Partial — penalty events public, but requires trust in penalty emitter |

---

## Configuration Reference

| Parameter | Default | Description |
|-----------|---------|------------|
| `kvBucket` | `"REPUTATION"` | NATS KV bucket name |
| `weights.success` | `0.7` | Weight for success rate in score |
| `weights.speed` | `0.2` | Weight for speed score |
| `weights.freshness` | `0.1` | Weight for recency |
| `maxAcceptableLatencyMs` | `5000` | Above this → speed_score = 0 |
| `minimumSampleSize` | `5` | Confidence halved below this |
| `freshnessHalfLifeHours` | `24` | Freshness halves every N hours |
| `lyingThreshold.consecutive` | `3` | N consecutive 3001 → flag |
| `lyingThreshold.ratio` | `0.9` | 90% SKILL_NOT_FOUND rate → flag |
| `lyingThreshold.minAttempts` | `3` | Minimum attempts before ratio applied |
| `latencyReservoirSize` | `100` | Number of latencies kept for percentiles |
| `autoSubscribe` | `true` | Automatically subscribe to task events |

---

## Python Implementation

See `synapse-sdk/src/python/reputation.py` for the full Python implementation.

```python
from reputation import ReputationStore

mesh = await Synapse.connect("nats://localhost:4222")
await mesh.register(name="My Agent", capabilities=["chat"], skills=[...])

store = ReputationStore(mesh)
await store.initialize()

# Ranked discovery
ranked = await store.discover_ranked(
    capabilities=["chat"],
    min_success_rate=0.8,
)

# Smart request with automatic retries
result = await store.smart_request(
    capability="chat",
    skill="respond",
    input_={"message": "Hello"},
)

# Stats
stats = await store.stats()
print(f"Tracked {stats['total_agents']} agents, {stats['flagged_skills']} flagged skills")
```

---

## Go Implementation

See `synapse-sdk/src/go/reputation/reputation.go` for the full Go implementation.

```go
mesh, _ := synapse.Connect("nats://localhost:4222")
defer mesh.Close()

store, _ := reputation.NewStore(mesh, nil)
defer store.Close()

ranked, _ := store.DiscoverRanked(reputation.RankedFilter{
    Capabilities: []string{"chat"},
    MinSuccessRate: 0.8,
})

for _, r := range ranked {
    fmt.Printf("%s: score=%.3f\n", r.Manifest.Name, r.AggregateScore)
}

result, _ := store.SmartRequest("chat", "respond", map[string]any{"message": "Hello"}, 30*time.Second, 3)
```

---

## Next Steps

- [Task Store](./tasks.md) — Where reputation data comes from
- [Pattern Guide](./patterns.md) — Circuit breakers complement reputation
- [Security Guide](./security.md) — Combine with ACL for authenticated interactions
- [Observability](./observability.md) — Add reputation to OTel spans
