// Package reputation implements per-agent, per-skill reliability scoring
// for the Synapse protocol. Tracks success rates, latency distributions,
// freshness, and skill honesty. Provides ranked discovery of agents.
//
// Usage:
//
//	nc, _ := nats.Connect("nats://localhost:4222")
//	mesh := synapse.New(nc)
//	store, _ := reputation.NewStore(mesh, nil)
//	defer store.Close()
//
//	ranked, _ := store.DiscoverRanked(reputation.RankedFilter{
//	    Capabilities:   []string{"chat"},
//	    MinSuccessRate: 0.8,
//	})
//	for _, r := range ranked {
//	    fmt.Printf("%s: score=%.3f\n", r.Manifest.Name, r.AggregateScore)
//	}
package reputation

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	natsjs "github.com/nats-io/nats.go/jetstream"
)

// ==================== TYPES ====================

// LatencyStats tracks latency distribution using reservoir sampling.
type LatencyStats struct {
	Count int     `json:"count"`
	Sum   float64 `json:"sum"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
}

// ReputationFlags track penalty and lying detection state.
type ReputationFlags struct {
	MisleadingCapabilities       bool    `json:"misleading_capabilities"`
	ConsecutiveSkillNotFound     int     `json:"consecutive_skill_not_found"`
	LastPenaltyAt                *string `json:"last_penalty_at"`
	PenaltyReason                *string `json:"penalty_reason"`
}

// ReputationRecord holds scoring data for a (agent_id, skill) pair.
type ReputationRecord struct {
	AgentID     string          `json:"agent_id"`
	Skill       string          `json:"skill"`
	Total       int             `json:"total"`
	Successes   int             `json:"successes"`
	Failures    int             `json:"failures"`
	Timeouts    int             `json:"timeouts"`
	SkillNotFound int           `json:"skill_not_found"`
	Overloaded  int             `json:"overloaded"`
	RateLimited int             `json:"rate_limited"`
	LatenciesMs LatencyStats    `json:"latencies_ms"`
	SuccessRate float64         `json:"success_rate"`
	SpeedScore  float64         `json:"speed_score"`
	Freshness   float64         `json:"freshness"`
	Score       float64         `json:"score"`
	Confidence  float64         `json:"confidence"`
	CreatedAt   time.Time       `json:"created_at"`
	LastSeen    time.Time       `json:"last_seen"`
	Flags       ReputationFlags `json:"flags"`
}

// Config holds scoring parameters.
type Config struct {
	KvBucket                 string
	WeightSuccess            float64
	WeightSpeed              float64
	WeightFreshness          float64
	MaxAcceptableLatencyMs   float64
	MinimumSampleSize        int
	FreshnessHalfLifeHours   float64
	LyingThresholdConsecutive int
	LyingThresholdRatio      float64
	LyingThresholdMinAttempts int
	LatencyReservoirSize     int
	AutoSubscribe            bool
}

// DefaultConfig returns production defaults.
func DefaultConfig() *Config {
	return &Config{
		KvBucket:                 "REPUTATION",
		WeightSuccess:            0.7,
		WeightSpeed:              0.2,
		WeightFreshness:          0.1,
		MaxAcceptableLatencyMs:   5000,
		MinimumSampleSize:        5,
		FreshnessHalfLifeHours:   24,
		LyingThresholdConsecutive: 3,
		LyingThresholdRatio:      0.9,
		LyingThresholdMinAttempts: 3,
		LatencyReservoirSize:     100,
		AutoSubscribe:            true,
	}
}

// RankedFilter controls discover_ranked filtering.
type RankedFilter struct {
	Capabilities   []string
	Skill          string
	MinSuccessRate float64
	MaxLatencyMs   float64
	IncludeFlagged bool
	Limit          int
}

// RankedAgentScore is a per-skill score in discover_ranked results.
type RankedAgentScore struct {
	Score        float64 `json:"score"`
	SuccessRate  float64 `json:"success_rate"`
	AvgLatencyMs float64 `json:"avg_latency_ms"`
	Flagged      bool    `json:"flagged"`
}

// AgentManifest is a minimal type for discovered agents.
type AgentManifest struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Capabilities []string `json:"capabilities"`
	Skills       []Skill  `json:"skills"`
}

type Skill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// RankedAgent combines manifest with reputation scores.
type RankedAgent struct {
	Manifest          AgentManifest                `json:"manifest"`
	Scores            map[string]RankedAgentScore  `json:"scores"`
	AggregateScore    float64                      `json:"aggregate_score"`
	SkillsConsidered  int                          `json:"skills_considered"`
}

// Stats summarizes reputation state.
type Stats struct {
	TotalAgents  int     `json:"total_agents"`
	TotalRecords int     `json:"total_records"`
	FlaggedSkills int    `json:"flagged_skills"`
	AvgScore     float64 `json:"avg_score"`
}

// ==================== STORE ====================

// Store tracks reputation data and responds to mesh events.
type Store struct {
	nc      *nats.Conn
	js      natsjs.JetStream
	kv      natsjs.KeyValue
	cfg     *Config
	mu      sync.RWMutex
	local   map[string]*ReputationRecord
	samples map[string][]float64
	subs    []*nats.Subscription
}

// NewStore creates a reputation store. Call Initialize() before use.
func NewStore(nc *nats.Conn, cfg *Config) (*Store, error) {
	if cfg == nil {
		cfg = DefaultConfig()
	}
	js, err := natsjs.New(nc)
	if err != nil {
		return nil, fmt.Errorf("jetstream: %w", err)
	}
	return &Store{
		nc:      nc,
		js:      js,
		cfg:     cfg,
		local:   make(map[string]*ReputationRecord),
		samples: make(map[string][]float64),
	}, nil
}

// Initialize opens the KV bucket and subscribes to events.
func (s *Store) Initialize() error {
	ctx := natsjs.WithContext(nil, time.Now().Add(10*time.Second))

	var err error
	s.kv, err = s.js.KeyValue(ctx, s.cfg.KvBucket)
	if err != nil {
		s.kv, err = s.js.CreateKeyValue(ctx, natsjs.KeyValueConfig{
			Bucket:  s.cfg.KvBucket,
			History: 5,
			TTL:     time.Duration(s.cfg.FreshnessHalfLifeHours*3600*7) * time.Second,
		})
		if err != nil {
			return fmt.Errorf("kv: %w", err)
		}
	}

	// Load existing records
	keys, err := s.kv.Keys(ctx)
	if err == nil {
		for _, key := range keys {
			entry, err := s.kv.Get(ctx, key)
			if err != nil || entry == nil {
				continue
			}
			var rec ReputationRecord
			if err := json.Unmarshal(entry.Value(), &rec); err == nil {
				s.local[s.cacheKey(rec.AgentID, rec.Skill)] = &rec
			}
		}
	}

	if s.cfg.AutoSubscribe {
		s.startObserving()
	}

	return nil
}

// Close unsubscribes and clears state.
func (s *Store) Close() {
	for _, sub := range s.subs {
		_ = sub.Unsubscribe()
	}
	s.subs = nil
	s.mu.Lock()
	s.local = make(map[string]*ReputationRecord)
	s.samples = make(map[string][]float64)
	s.mu.Unlock()
}

// ==================== OBSERVATION ====================

func (s *Store) startObserving() {
	sub, err := s.nc.Subscribe("mesh.task.*.update", func(msg *nats.Msg) {
		var envelope struct {
			Payload map[string]interface{} `json:"payload"`
		}
		if err := json.Unmarshal(msg.Data, &envelope); err != nil || envelope.Payload == nil {
			return
		}
		s.onTaskUpdate(envelope.Payload)
	})
	if err == nil {
		s.subs = append(s.subs, sub)
	}
}

func (s *Store) onTaskUpdate(update map[string]interface{}) {
	agentID, _ := update["to_agent_id"].(string)
	if agentID == "" {
		agentID, _ = update["from"].(string)
	}
	skill, _ := update["skill"].(string)
	if agentID == "" || skill == "" {
		return
	}

	newState, _ := update["state"].(string)
	var errCode int
	if errMap, ok := update["error"].(map[string]interface{}); ok {
		if c, ok := errMap["code"].(float64); ok {
			errCode = int(c)
		}
	}
	var latency float64
	if v, ok := update["latency_ms"].(float64); ok {
		latency = v
	}

	s.mu.Lock()
	record := s.getOrCreate(agentID, skill)

	switch newState {
	case "completed":
		s.recordOutcome(record, "success", latency)
	case "failed":
		switch errCode {
		case 3001:
			s.recordOutcome(record, "skill_not_found", 0)
		case 4001:
			s.recordOutcome(record, "overloaded", 0)
		case 4002:
			s.recordOutcome(record, "rate_limited", 0)
		case 1001:
			s.recordOutcome(record, "timeout", 0)
		default:
			s.recordOutcome(record, "failure", 0)
		}
	}

	s.mu.Unlock()
	go s.save(record)
}

// ==================== OUTCOME RECORDING ====================

func (s *Store) recordOutcome(rec *ReputationRecord, outcome string, latencyMs float64) {
	now := time.Now()
	rec.LastSeen = now
	rec.Total++

	switch outcome {
	case "success":
		rec.Successes++
		rec.Flags.ConsecutiveSkillNotFound = 0
		if latencyMs > 0 {
			s.addLatency(rec, latencyMs)
		}
	case "failure":
		rec.Failures++
	case "timeout":
		rec.Timeouts++
	case "skill_not_found":
		rec.SkillNotFound++
		rec.Flags.ConsecutiveSkillNotFound++
		s.checkLyingThreshold(rec)
	case "overloaded":
		rec.Overloaded++
		return
	case "rate_limited":
		rec.RateLimited++
		return
	}

	s.recompute(rec)
}

func (s *Store) checkLyingThreshold(rec *ReputationRecord) {
	attempts := rec.SkillNotFound + rec.Successes
	consecBreached := rec.Flags.ConsecutiveSkillNotFound >= s.cfg.LyingThresholdConsecutive
	ratioBreached := attempts >= s.cfg.LyingThresholdMinAttempts &&
		float64(rec.SkillNotFound)/math.Max(1, float64(attempts)) > s.cfg.LyingThresholdRatio

	if consecBreached || ratioBreached {
		if !rec.Flags.MisleadingCapabilities {
			rec.Flags.MisleadingCapabilities = true
			now := time.Now().Format(time.RFC3339Nano)
			reason := "repeated_skill_not_found"
			rec.Flags.LastPenaltyAt = &now
			rec.Flags.PenaltyReason = &reason
			go s.emitPenalty(rec)
		}
	}
}

// ==================== SCORING ====================

func (s *Store) recompute(rec *ReputationRecord) {
	decisive := rec.Successes + rec.Failures + rec.Timeouts
	if decisive > 0 {
		rec.SuccessRate = float64(rec.Successes) / float64(decisive)
	} else {
		rec.SuccessRate = 0
	}

	avgLat := 0.0
	if rec.LatenciesMs.Count > 0 {
		avgLat = rec.LatenciesMs.Sum / float64(rec.LatenciesMs.Count)
	}
	speedPct := math.Min(avgLat/s.cfg.MaxAcceptableLatencyMs, 1.0)
	if rec.SuccessRate > 0 {
		rec.SpeedScore = 1.0 - speedPct
	} else {
		rec.SpeedScore = 0
	}

	hoursSince := time.Since(rec.LastSeen).Hours()
	rec.Freshness = math.Exp(-hoursSince / s.cfg.FreshnessHalfLifeHours)

	if decisive >= s.cfg.MinimumSampleSize {
		rec.Confidence = 1.0
	} else {
		rec.Confidence = 0.5
	}

	raw := s.cfg.WeightSuccess*rec.SuccessRate +
		s.cfg.WeightSpeed*rec.SpeedScore +
		s.cfg.WeightFreshness*rec.Freshness

	lyingPenalty := 1.0
	if rec.Flags.MisleadingCapabilities {
		lyingPenalty = 0
	}
	rec.Score = raw * lyingPenalty * rec.Confidence
}

// ==================== LATENCY TRACKING ====================

func (s *Store) addLatency(rec *ReputationRecord, latencyMs float64) {
	stats := &rec.LatenciesMs
	stats.Count++
	stats.Sum += latencyMs

	key := s.cacheKey(rec.AgentID, rec.Skill)
	samples := s.samples[key]

	if len(samples) < s.cfg.LatencyReservoirSize {
		samples = append(samples, latencyMs)
	} else {
		idx := rand.Intn(stats.Count)
		if idx < len(samples) {
			samples[idx] = latencyMs
		}
	}
	s.samples[key] = samples

	if len(samples) > 0 {
		sorted := append([]float64(nil), samples...)
		sort.Float64s(sorted)
		pct := func(p float64) float64 {
			if len(sorted) == 1 {
				return sorted[0]
			}
			target := p * float64(len(sorted)-1)
			lo := int(target)
			hi := lo + 1
			if hi >= len(sorted) {
				hi = len(sorted) - 1
			}
			weight := target - float64(lo)
			return sorted[lo]*(1-weight) + sorted[hi]*weight
		}
		stats.P50 = pct(0.5)
		stats.P95 = pct(0.95)
		stats.P99 = pct(0.99)
	}
}

// ==================== RECORD MANAGEMENT ====================

func (s *Store) getOrCreate(agentID, skill string) *ReputationRecord {
	key := s.cacheKey(agentID, skill)
	if rec, ok := s.local[key]; ok {
		return rec
	}
	now := time.Now()
	rec := &ReputationRecord{
		AgentID:   agentID,
		Skill:     skill,
		Freshness: 1,
		CreatedAt: now,
		LastSeen:  now,
	}
	s.local[key] = rec
	return rec
}

func (s *Store) cacheKey(agentID, skill string) string {
	return agentID + "::" + skill
}

var safeKeyRe = regexp.MustCompile(`[^a-zA-Z0-9._-]`)

func (s *Store) kvKey(agentID, skill string) string {
	return safeKeyRe.ReplaceAllString(agentID, "_") + "__" +
		safeKeyRe.ReplaceAllString(skill, "_")
}

func (s *Store) save(rec *ReputationRecord) {
	if s.kv == nil {
		return
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return
	}
	ctx := natsjs.WithContext(nil, time.Now().Add(5*time.Second))
	_ = s.kv.Put(ctx, s.kvKey(rec.AgentID, rec.Skill), data)
}

// ==================== EVENTS ====================

func (s *Store) emitPenalty(rec *ReputationRecord) {
	subject := "mesh.event.reputation.penalty." +
		safeKeyRe.ReplaceAllString(rec.AgentID, "_") + "." +
		safeKeyRe.ReplaceAllString(rec.Skill, "_")

	payload := map[string]interface{}{
		"v":       "1.0.0",
		"id":      uuid.New().String(),
		"type":    "reputation_penalty",
		"ts":      time.Now().Format(time.RFC3339Nano),
		"payload": map[string]interface{}{
			"agent_id":              rec.AgentID,
			"skill":                 rec.Skill,
			"reason":                rec.Flags.PenaltyReason,
			"skill_not_found_count": rec.SkillNotFound,
			"success_rate":          rec.SuccessRate,
			"score":                 rec.Score,
		},
	}
	data, _ := json.Marshal(payload)
	_ = s.nc.Publish(subject, data)
}

// ==================== MANUAL OPERATIONS ====================

// ClearFlag removes the misleading_capabilities penalty for a (agent, skill) pair.
func (s *Store) ClearFlag(agentID, skill, reason string) (*ReputationRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.getOrCreate(agentID, skill)
	rec.Flags.MisleadingCapabilities = false
	rec.Flags.ConsecutiveSkillNotFound = 0
	if reason == "" {
		reason = "manual_clear"
	}
	rec.Flags.PenaltyReason = &reason
	now := time.Now().Format(time.RFC3339Nano)
	rec.Flags.LastPenaltyAt = &now
	s.recompute(rec)
	go s.save(rec)
	return rec, nil
}

// GetRecord returns reputation for a specific (agent, skill).
func (s *Store) GetRecord(agentID, skill string) (*ReputationRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	key := s.cacheKey(agentID, skill)
	if rec, ok := s.local[key]; ok {
		return rec, nil
	}
	return nil, fmt.Errorf("no record for %s::%s", agentID, skill)
}

// GetRecordsForAgent returns all skill records for an agent.
func (s *Store) GetRecordsForAgent(agentID string) []*ReputationRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	prefix := agentID + "::"
	var results []*ReputationRecord
	for k, r := range s.local {
		if strings.HasPrefix(k, prefix) {
			results = append(results, r)
		}
	}
	return results
}

// ==================== RANKED DISCOVERY ====================

// DiscoverRanked returns agents sorted by composite reputation score.
// NOTE: Caller must provide already-discovered agents (via Synapse discover()).
// In production, wire this to your Synapse client's Discover() method.
func (s *Store) discoverRankedFrom(agents []AgentManifest, filter RankedFilter) []RankedAgent {
	var ranked []RankedAgent

	for _, m := range agents {
		scores := make(map[string]RankedAgentScore)
		scoreSum := 0.0
		count := 0

		for _, sk := range m.Skills {
			s.mu.RLock()
			rec := s.local[s.cacheKey(m.ID, sk.ID)]
			s.mu.RUnlock()

			if rec != nil {
				if !filter.IncludeFlagged && rec.Flags.MisleadingCapabilities {
					continue
				}
				if filter.MinSuccessRate > 0 && rec.Confidence >= 1.0 &&
					rec.SuccessRate < filter.MinSuccessRate {
					continue
				}
				if filter.MaxLatencyMs > 0 && rec.LatenciesMs.Count > 0 &&
					rec.LatenciesMs.P50 > filter.MaxLatencyMs {
					continue
				}

				avgMs := 0.0
				if rec.LatenciesMs.Count > 0 {
					avgMs = rec.LatenciesMs.Sum / float64(rec.LatenciesMs.Count)
				}

				scores[sk.ID] = RankedAgentScore{
					Score:        rec.Score,
					SuccessRate:  rec.SuccessRate,
					AvgLatencyMs: avgMs,
					Flagged:      rec.Flags.MisleadingCapabilities,
				}
				if filter.Skill == "" || filter.Skill == sk.ID {
					scoreSum += rec.Score
					count++
				}
			} else {
				includeUnknown := filter.IncludeFlagged || filter.MinSuccessRate <= 0.1
				if includeUnknown && (filter.Skill == "" || filter.Skill == sk.ID) {
					scores[sk.ID] = RankedAgentScore{
						Score: 0.1, SuccessRate: 0, AvgLatencyMs: 0, Flagged: false,
					}
					scoreSum += 0.1
					count++
				}
			}
		}

		if count > 0 {
			ranked = append(ranked, RankedAgent{
				Manifest:         m,
				Scores:           scores,
				AggregateScore:   scoreSum / float64(count),
				SkillsConsidered: count,
			})
		}
	}

	sort.Slice(ranked, func(i, j int) bool {
		return ranked[i].AggregateScore > ranked[j].AggregateScore
	})

	if filter.Limit > 0 && len(ranked) > filter.Limit {
		ranked = ranked[:filter.Limit]
	}
	return ranked
}

// RecordSuccess is for external callers who want to manually record an outcome.
func (s *Store) RecordSuccess(agentID, skill string, latencyMs float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.getOrCreate(agentID, skill)
	s.recordOutcome(rec, "success", latencyMs)
	go s.save(rec)
}

// RecordFailure is for external callers who want to manually record an outcome.
func (s *Store) RecordFailure(agentID, skill string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.getOrCreate(agentID, skill)
	s.recordOutcome(rec, "failure", 0)
	go s.save(rec)
}

// RecordSkillNotFound records a "skill not found" outcome.
func (s *Store) RecordSkillNotFound(agentID, skill string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.getOrCreate(agentID, skill)
	s.recordOutcome(rec, "skill_not_found", 0)
	go s.save(rec)
}

// RecordTimeout records a timeout outcome.
func (s *Store) RecordTimeout(agentID, skill string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.getOrCreate(agentID, skill)
	s.recordOutcome(rec, "timeout", 0)
	go s.save(rec)
}

// ==================== STATS ====================

// Stats returns aggregate statistics.
func (s *Store) Stats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()

	agents := map[string]struct{}{}
	flagged := 0
	scoreSum := 0.0
	for _, rec := range s.local {
		agents[rec.AgentID] = struct{}{}
		if rec.Flags.MisleadingCapabilities {
			flagged++
		}
		scoreSum += rec.Score
	}
	avg := 0.0
	if len(s.local) > 0 {
		avg = scoreSum / float64(len(s.local))
	}
	return Stats{
		TotalAgents:  len(agents),
		TotalRecords: len(s.local),
		FlaggedSkills: flagged,
		AvgScore:     avg,
	}
}

// Leaderboard returns top N agents for a capability/skill.
func (s *Store) Leaderboard(agents []AgentManifest, capability, skill string, limit int) []RankedAgent {
	return s.discoverRankedFrom(agents, RankedFilter{
		Capabilities: []string{capability},
		Skill:        skill,
		Limit:        limit,
	})
}
