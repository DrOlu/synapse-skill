"""
Synapse Reputation System — Per-agent, per-skill reliability scoring

Tracks success rates, latency distributions, freshness, and skill honesty.
Provides discover_ranked() for ranking agents by reliability.

Usage:

    mesh = await Synapse.connect("nats://localhost:4222")
    await mesh.register(...)

    store = ReputationStore(mesh)
    await store.initialize()

    # Ranked discovery
    ranked = await store.discover_ranked(capabilities=["chat"], min_success_rate=0.8)

    # Smart request with automatic failover
    result = await store.smart_request("chat", "respond", {"message": "Hi"})

    # Stats
    stats = await store.stats()
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# ==================== TYPES ====================


@dataclass
class LatencyStats:
    count: int = 0
    sum: float = 0.0
    p50: float = 0.0
    p95: float = 0.0
    p99: float = 0.0


@dataclass
class ReputationFlags:
    misleading_capabilities: bool = False
    consecutive_skill_not_found: int = 0
    last_penalty_at: Optional[str] = None
    penalty_reason: Optional[str] = None


@dataclass
class ReputationRecord:
    agent_id: str
    skill: str
    total: int = 0
    successes: int = 0
    failures: int = 0
    timeouts: int = 0
    skill_not_found: int = 0
    overloaded: int = 0
    rate_limited: int = 0
    latencies_ms: LatencyStats = field(default_factory=LatencyStats)
    success_rate: float = 0.0
    speed_score: float = 0.0
    freshness: float = 1.0
    score: float = 0.0
    confidence: float = 0.0
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    last_seen: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    flags: ReputationFlags = field(default_factory=ReputationFlags)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ReputationRecord":
        lat = LatencyStats(**data.get("latencies_ms", {}))
        flags = ReputationFlags(**data.get("flags", {}))
        kwargs = {k: v for k, v in data.items() if k not in ("latencies_ms", "flags")}
        return cls(latencies_ms=lat, flags=flags, **kwargs)


@dataclass
class ReputationConfig:
    kv_bucket: str = "REPUTATION"
    weight_success: float = 0.7
    weight_speed: float = 0.2
    weight_freshness: float = 0.1
    max_acceptable_latency_ms: float = 5000.0
    minimum_sample_size: int = 5
    freshness_half_life_hours: float = 24.0
    lying_threshold_consecutive: int = 3
    lying_threshold_ratio: float = 0.9
    lying_threshold_min_attempts: int = 3
    latency_reservoir_size: int = 100
    auto_subscribe: bool = True


@dataclass
class RankedAgentScore:
    score: float
    success_rate: float
    avg_latency_ms: float
    flagged: bool


@dataclass
class RankedAgent:
    manifest: Dict[str, Any]
    scores: Dict[str, RankedAgentScore]
    aggregate_score: float
    skills_considered: int


@dataclass
class ReputationStats:
    total_agents: int
    total_records: int
    flagged_skills: int
    avg_score: float


# ==================== REPUTATION STORE ====================


class ReputationStore:
    """
    Tracks per-agent, per-skill performance and scores agents on reliability.

    Observes task state transitions and updates reputation records in both
    local memory and (optionally) a JetStream KV bucket.
    """

    def __init__(self, mesh: Any, config: Optional[ReputationConfig] = None):
        self.mesh = mesh
        self.nc = getattr(mesh, "nc", None)
        self.config = config or ReputationConfig()
        self.kv = None
        self._local: Dict[str, ReputationRecord] = {}
        self._samples: Dict[str, List[float]] = {}
        self._initialized = False

    # ==================== LIFECYCLE ====================

    async def initialize(self) -> "ReputationStore":
        if self._initialized:
            return self

        js = self.nc.jetstream() if hasattr(self.nc, "jetstream") else None
        if js is None:
            raise RuntimeError("ReputationStore requires JetStream enabled")

        try:
            self.kv = await js.key_value(self.config.kv_bucket)
        except Exception:
            self.kv = await js.create_key_value(
                bucket=self.config.kv_bucket,
                history=5,
                ttl=int(self.config.freshness_half_life_hours * 3600 * 7),
            )

        # Load existing
        try:
            keys = await self.kv.keys()
            for key in keys:
                try:
                    entry = await self.kv.get(key)
                    record = ReputationRecord.from_dict(json.loads(entry.value.decode()))
                    self._local[self._cache_key(record.agent_id, record.skill)] = record
                except Exception:
                    continue
        except Exception:
            pass

        if self.config.auto_subscribe:
            self._start_observing()

        self._initialized = True
        return self

    async def close(self) -> None:
        self._local.clear()
        self._samples.clear()

    # ==================== OBSERVATION ====================

    def _start_observing(self) -> None:
        # Hook into task update events
        async def _task_updater():
            sub = await self.nc.subscribe("mesh.task.*.update")
            async for msg in sub.messages:
                try:
                    envelope = json.loads(msg.data.decode())
                    await self._on_task_update(envelope)
                except Exception:
                    continue

        asyncio.create_task(_task_updater())

    async def _on_task_update(self, envelope: Dict[str, Any]) -> None:
        update = envelope.get("payload") or {}
        task_id = update.get("task_id")
        if not task_id:
            return
        agent_id = update.get("to_agent_id") or update.get("from")
        skill = update.get("skill")
        new_state = update.get("state")
        error_code = (update.get("error") or {}).get("code")
        latency_ms = update.get("latency_ms")

        if not agent_id or not skill:
            return

        record = self._get_or_create(agent_id, skill)

        if new_state == "completed":
            self._record_outcome(record, "success", latency_ms)
        elif new_state == "failed":
            if error_code == 3001:
                self._record_outcome(record, "skill_not_found")
            elif error_code == 4001:
                self._record_outcome(record, "overloaded")
            elif error_code == 4002:
                self._record_outcome(record, "rate_limited")
            elif error_code == 1001:
                self._record_outcome(record, "timeout")
            else:
                self._record_outcome(record, "failure")

        await self._save(record)

    # ==================== OUTCOME RECORDING ====================

    def _record_outcome(
        self,
        record: ReputationRecord,
        outcome: str,
        latency_ms: Optional[float] = None,
    ) -> None:
        now = datetime.now(timezone.utc).isoformat()
        record.last_seen = now
        record.total += 1

        if outcome == "success":
            record.successes += 1
            record.flags.consecutive_skill_not_found = 0
            if latency_ms is not None:
                self._add_latency(record, latency_ms)
        elif outcome == "failure":
            record.failures += 1
        elif outcome == "timeout":
            record.timeouts += 1
        elif outcome == "skill_not_found":
            record.skill_not_found += 1
            record.flags.consecutive_skill_not_found += 1
            self._check_lying_threshold(record)
        elif outcome == "overloaded":
            record.overloaded += 1
            return  # don't recompute
        elif outcome == "rate_limited":
            record.rate_limited += 1
            return  # don't recompute

        self._recompute(record)

    def _check_lying_threshold(self, record: ReputationRecord) -> None:
        attempts = record.skill_not_found + record.successes
        consec_breached = (
            record.flags.consecutive_skill_not_found
            >= self.config.lying_threshold_consecutive
        )
        ratio_breached = (
            attempts >= self.config.lying_threshold_min_attempts
            and record.skill_not_found / max(1, attempts) > self.config.lying_threshold_ratio
        )
        if consec_breached or ratio_breached:
            if not record.flags.misleading_capabilities:
                record.flags.misleading_capabilities = True
                record.flags.last_penalty_at = datetime.now(timezone.utc).isoformat()
                record.flags.penalty_reason = "repeated_skill_not_found"
                self._emit_penalty(record)

    # ==================== SCORING ====================

    def _recompute(self, record: ReputationRecord) -> None:
        decisive = record.successes + record.failures + record.timeouts
        record.success_rate = record.successes / decisive if decisive > 0 else 0.0

        avg_lat = (
            record.latencies_ms.sum / record.latencies_ms.count
            if record.latencies_ms.count > 0
            else 0.0
        )
        speed_pct = min(avg_lat / self.config.max_acceptable_latency_ms, 1.0)
        record.speed_score = (1.0 - speed_pct) if record.success_rate > 0 else 0.0

        try:
            last_seen_ts = datetime.fromisoformat(record.last_seen).timestamp()
        except Exception:
            last_seen_ts = time.time()
        hours_since = (time.time() - last_seen_ts) / 3600
        record.freshness = math.exp(-hours_since / self.config.freshness_half_life_hours)

        record.confidence = 1.0 if decisive >= self.config.minimum_sample_size else 0.5

        raw = (
            self.config.weight_success * record.success_rate
            + self.config.weight_speed * record.speed_score
            + self.config.weight_freshness * record.freshness
        )
        lying_penalty = 0.0 if record.flags.misleading_capabilities else 1.0
        record.score = raw * lying_penalty * record.confidence

    # ==================== LATENCY TRACKING ====================

    def _add_latency(self, record: ReputationRecord, latency_ms: float) -> None:
        stats = record.latencies_ms
        stats.count += 1
        stats.sum += latency_ms

        key = self._cache_key(record.agent_id, record.skill)
        samples = self._samples.setdefault(key, [])

        if len(samples) < self.config.latency_reservoir_size:
            samples.append(latency_ms)
        else:
            idx = random.randint(0, stats.count - 1)
            if idx < len(samples):
                samples[idx] = latency_ms

        if samples:
            sorted_samples = sorted(samples)

            def pct(p: float) -> float:
                if len(sorted_samples) == 1:
                    return sorted_samples[0]
                target = p * (len(sorted_samples) - 1)
                lo = int(target)
                hi = min(lo + 1, len(sorted_samples) - 1)
                w = target - lo
                return sorted_samples[lo] * (1 - w) + sorted_samples[hi] * w

            stats.p50 = pct(0.5)
            stats.p95 = pct(0.95)
            stats.p99 = pct(0.99)

    # ==================== RECORD MANAGEMENT ====================

    def _get_or_create(self, agent_id: str, skill: str) -> ReputationRecord:
        key = self._cache_key(agent_id, skill)
        if key in self._local:
            return self._local[key]
        record = ReputationRecord(agent_id=agent_id, skill=skill)
        self._local[key] = record
        return record

    def _cache_key(self, agent_id: str, skill: str) -> str:
        return f"{agent_id}::{skill}"

    def _kv_key(self, agent_id: str, skill: str) -> str:
        import re
        safe_agent = re.sub(r"[^a-zA-Z0-9._-]", "_", agent_id)
        safe_skill = re.sub(r"[^a-zA-Z0-9._-]", "_", skill)
        return f"{safe_agent}__{safe_skill}"

    async def _save(self, record: ReputationRecord) -> None:
        self._local[self._cache_key(record.agent_id, record.skill)] = record
        if self.kv is not None:
            try:
                await self.kv.put(
                    self._kv_key(record.agent_id, record.skill),
                    json.dumps(record.to_dict()).encode(),
                )
            except Exception as e:
                print(f"[Reputation] Failed to persist: {e}")

    # ==================== EVENTS ====================

    def _emit_penalty(self, record: ReputationRecord) -> None:
        try:
            import re
            subject = (
                "mesh.event.reputation.penalty."
                f"{re.sub(r'[^a-zA-Z0-9._-]', '_', record.agent_id)}."
                f"{re.sub(r'[^a-zA-Z0-9._-]', '_', record.skill)}"
            )
            self.nc.publish(
                subject,
                json.dumps(
                    {
                        "v": "1.0.0",
                        "id": str(random.getrandbits(128)),
                        "type": "reputation_penalty",
                        "ts": datetime.now(timezone.utc).isoformat(),
                        "from": getattr(self.mesh, "agent_id", "reputation-service"),
                        "payload": {
                            "agent_id": record.agent_id,
                            "skill": record.skill,
                            "reason": record.flags.penalty_reason,
                            "skill_not_found_count": record.skill_not_found,
                            "success_rate": record.success_rate,
                            "score": record.score,
                        },
                    }
                ).encode(),
            )
        except Exception:
            pass

    # ==================== MANUAL OPERATIONS ====================

    async def clear_flag(
        self, agent_id: str, skill: str, reason: str = "manual_clear"
    ) -> ReputationRecord:
        record = self._get_or_create(agent_id, skill)
        record.flags.misleading_capabilities = False
        record.flags.consecutive_skill_not_found = 0
        record.flags.penalty_reason = reason
        record.flags.last_penalty_at = datetime.now(timezone.utc).isoformat()
        self._recompute(record)
        await self._save(record)
        return record

    async def get_record(self, agent_id: str, skill: str) -> Optional[ReputationRecord]:
        return self._local.get(self._cache_key(agent_id, skill))

    async def get_records_for_agent(self, agent_id: str) -> List[ReputationRecord]:
        prefix = f"{agent_id}::"
        return [r for k, r in self._local.items() if k.startswith(prefix)]

    async def get_all_records(self) -> List[ReputationRecord]:
        return list(self._local.values())

    async def delete_record(self, agent_id: str, skill: str) -> None:
        key = self._cache_key(agent_id, skill)
        self._local.pop(key, None)
        self._samples.pop(key, None)
        if self.kv is not None:
            try:
                await self.kv.delete(self._kv_key(agent_id, skill))
            except Exception:
                pass

    # ==================== RANKED DISCOVERY ====================

    async def discover_ranked(
        self,
        capabilities: Optional[List[str]] = None,
        skill: Optional[str] = None,
        min_success_rate: Optional[float] = None,
        max_latency_ms: Optional[float] = None,
        include_flagged: bool = False,
        limit: Optional[int] = None,
    ) -> List[RankedAgent]:
        agents = await self.mesh.discover({"capabilities": capabilities} if capabilities else {})

        ranked: List[RankedAgent] = []

        for manifest in agents:
            skill_scores: Dict[str, RankedAgentScore] = {}
            score_sum = 0.0
            count = 0

            for sk in manifest.get("skills", []):
                sk_id = sk.get("id") if isinstance(sk, dict) else getattr(sk, "id", None)
                if not sk_id:
                    continue

                record = self._local.get(self._cache_key(manifest.get("id", ""), sk_id))

                if record is not None:
                    if not include_flagged and record.flags.misleading_capabilities:
                        continue
                    if (
                        min_success_rate is not None
                        and record.confidence >= 1.0
                        and record.success_rate < min_success_rate
                    ):
                        continue
                    if (
                        max_latency_ms is not None
                        and record.latencies_ms.count > 0
                        and record.latencies_ms.p50 > max_latency_ms
                    ):
                        continue

                    avg_ms = (
                        record.latencies_ms.sum / record.latencies_ms.count
                        if record.latencies_ms.count > 0
                        else 0.0
                    )
                    skill_scores[sk_id] = RankedAgentScore(
                        score=record.score,
                        success_rate=record.success_rate,
                        avg_latency_ms=avg_ms,
                        flagged=record.flags.misleading_capabilities,
                    )
                    if not skill or skill == sk_id:
                        score_sum += record.score
                        count += 1
                else:
                    include_unknown = include_flagged or (
                        min_success_rate is None or min_success_rate <= 0.1
                    )
                    if include_unknown and (not skill or skill == sk_id):
                        skill_scores[sk_id] = RankedAgentScore(
                            score=0.1, success_rate=0.0, avg_latency_ms=0.0, flagged=False
                        )
                        score_sum += 0.1
                        count += 1

            if count > 0:
                ranked.append(
                    RankedAgent(
                        manifest=manifest,
                        scores=skill_scores,
                        aggregate_score=score_sum / count,
                        skills_considered=count,
                    )
                )

        ranked.sort(key=lambda r: r.aggregate_score, reverse=True)
        if limit:
            return ranked[:limit]
        return ranked

    # ==================== SMART REQUEST ====================

    async def smart_request(
        self,
        capability: str,
        skill: str,
        input_: Any,
        timeout_ms: int = 30000,
        max_retries: int = 3,
    ) -> Any:
        ranked = await self.discover_ranked(
            capabilities=[capability], skill=skill, include_flagged=False
        )
        if not ranked:
            raise RuntimeError(
                f"No agents available for capability '{capability}' skill '{skill}'"
            )

        last_err: Optional[Exception] = None
        for i in range(min(max_retries, len(ranked))):
            candidate = ranked[i]
            agent_id = (
                candidate.manifest.get("id")
                if isinstance(candidate.manifest, dict)
                else getattr(candidate.manifest, "id", None)
            )
            try:
                started = time.time()
                result = await self.mesh.request(agent_id, skill, input_, timeout_ms)
                latency = (time.time() - started) * 1000

                record = self._get_or_create(agent_id, skill)
                self._record_outcome(record, "success", latency)
                await self._save(record)
                return result
            except Exception as e:
                err_code = getattr(e, "code", None)
                record = self._get_or_create(agent_id, skill)
                if err_code == 1001:
                    self._record_outcome(record, "timeout")
                elif err_code == 3001:
                    self._record_outcome(record, "skill_not_found")
                elif err_code == 4001:
                    self._record_outcome(record, "overloaded")
                elif not getattr(e, "retryable", False):
                    self._record_outcome(record, "failure")
                await self._save(record)

                last_err = e
                if not getattr(e, "retryable", False):
                    break

        raise last_err or RuntimeError("All retries exhausted")

    # ==================== STATS ====================

    async def stats(self) -> ReputationStats:
        agents: set = set()
        flagged = 0
        score_sum = 0.0
        for record in self._local.values():
            agents.add(record.agent_id)
            if record.flags.misleading_capabilities:
                flagged += 1
            score_sum += record.score
        return ReputationStats(
            total_agents=len(agents),
            total_records=len(self._local),
            flagged_skills=flagged,
            avg_score=score_sum / len(self._local) if self._local else 0.0,
        )

    async def leaderboard(
        self,
        capability: Optional[str] = None,
        skill: Optional[str] = None,
        limit: int = 10,
    ) -> List[RankedAgent]:
        return await self.discover_ranked(
            capabilities=[capability] if capability else None, skill=skill, limit=limit
        )

    # ==================== DEBUG ====================

    def dump(self) -> Dict[str, Any]:
        return {
            "entries": [
                {"key": k, "record": r.to_dict()} for k, r in self._local.items()
            ]
        }


__all__ = [
    "ReputationStore",
    "ReputationRecord",
    "ReputationConfig",
    "ReputationFlags",
    "LatencyStats",
    "RankedAgent",
    "RankedAgentScore",
    "ReputationStats",
]
