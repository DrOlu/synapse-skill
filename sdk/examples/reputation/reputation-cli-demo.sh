#!/usr/bin/env bash
# reputation-cli-demo.sh — Pure-cli demonstration of the reputation system.
# Uses only the `nats` binary. No TypeScript build required.
#
# Requires: nats, jq, nats-server
#
# Run in 3 terminals:
#   Terminal 1: Start NATS
#     nats-server -js -p 4222 &
#     nats kv add REPUTATION --history=5 --ttl=604800s
#
#   Terminal 2: Run this script
#     bash reputation-cli-demo.sh
#
#   Terminal 3 (optional): Watch penalty events live
#     nats sub 'mesh.event.reputation.penalty.>'

set -euo pipefail

# ==================== HELPERS ====================

NOW() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
UUID() { cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())'; }

register_agent() {
  local id="$1" name="$2" caps="$3" skills="$4"
  nats pub mesh.registry.register --server nats://localhost:4222 "$(cat <<EOF
{
  "v": "1.0.0",
  "id": "$(UUID)",
  "type": "register",
  "ts": "$(NOW)",
  "from": "$id",
  "payload": {
    "id": "$id",
    "name": "$name",
    "capabilities": $caps,
    "skills": $skills,
    "endpoint": "mesh.agent.$id.inbox",
    "availability": "online",
    "last_heartbeat": "$(NOW)"
  }
}
EOF
)"
  echo "✓ Registered $name ($id)"
}

record_outcome() {
  local agent="$1" skill="$2" state="$3" code="${4:-}" ts="$(NOW)"
  local error_field="null"
  if [[ -n "$code" ]]; then
    error_field="{\"code\": $code, \"message\": \"test\", \"retryable\": false}"
  fi
  local subject="mesh.task.$(UUID).update"
  nats pub "$subject" --server nats://localhost:4222 "$(cat <<EOF
{
  "v": "1.0.0",
  "id": "$(UUID)",
  "type": "task_update",
  "ts": "$ts",
  "task_id": "$(UUID)",
  "payload": {
    "task_id": "$(UUID)",
    "to_agent_id": "$agent",
    "skill": "$skill",
    "state": "$state",
    "error": $error_field,
    "latency_ms": $((100 + RANDOM % 400))
  }
}
EOF
)"
}

# ==================== SETUP ====================

echo "╔══════════════════════════════════════════════════╗"
echo "║  Synapse Reputation — CLI Demo                   ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

echo "📋 Creating KV bucket (if needed)..."
nats kv add REPUTATION --history=5 --ttl=604800s 2>/dev/null || echo "(bucket exists)"
echo ""

echo "🤖 Registering 3 agents with capability 'chat':"
register_agent "good-agent"   "Good Chat Agent"   '["chat"]' '[{"id":"respond","name":"Respond","description":"Reliable"}]'
register_agent "flaky-agent"  "Flaky Chat Agent"  '["chat"]' '[{"id":"respond","name":"Respond","description":"Unreliable"}]'
register_agent "lying-agent"  "Lying Chat Agent"  '["chat"]' '[{"id":"respond","name":"Respond","description":"Lies about this"}]'
echo ""

# ==================== SIMULATE OUTCOMES ====================

echo "📊 Simulating task outcomes for each agent..."
echo ""

echo "   good-agent: 8 successes..."
for i in {1..8}; do record_outcome good-agent respond completed; done

echo "   flaky-agent: 4 successes, 4 failures..."
for i in {1..4}; do record_outcome flaky-agent respond completed; done
for i in {1..4}; do record_outcome flaky-agent respond failed 5001; done

echo "   lying-agent: 4 SKILL_NOT_FOUND (3001)..."
for i in {1..4}; do record_outcome lying-agent respond failed 3001; done

echo ""
echo "⏱️  Waiting 2s for reputation service to score..."
sleep 2

# ==================== DISPLAY RESULTS ====================

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Reputation Records (JetStream KV)"
echo "═══════════════════════════════════════════════════"
echo ""

for agent in good-agent flaky-agent lying-agent; do
  key="${agent}__respond"
  echo "--- $agent ---"
  record=$(nats kv get REPUTATION "$key" 2>/dev/null || echo "")
  if [[ -z "$record" ]]; then
    echo "  (no record — reputation service may not be running)"
  else
    echo "$record" | jq -r '
      "  agent_id:    \(.agent_id)",
      "  skill:       \(.skill)",
      "  total:       \(.total)",
      "  successes:   \(.successes)",
      "  failures:    \(.failures)",
      "  skill_not_found: \(.skill_not_found)",
      "  success_rate: \(.success_rate)",
      "  speed_score:  \(.speed_score)",
      "  freshness:    \(.freshness)",
      "  ⭐ SCORE:     \(.score)",
      "  confidence:   \(.confidence)",
      "  flags.misleading_capabilities: \(.flags.misleading_capabilities)"
    '
  fi
  echo ""
done

# ==================== INTERPRETATION ====================

echo "═══════════════════════════════════════════════════"
echo "  Interpretation"
echo "═══════════════════════════════════════════════════"
echo ""
echo "✅ good-agent should have score ~0.85 (high success rate, acceptable latency)"
echo "⚠️  flaky-agent should have score ~0.42 (50% success penalizes score)"
echo "❌ lying-agent should have score 0.0 with misleading_capabilities=true"
echo ""
echo "When you call discoverRanked(capabilities=['chat'], includeFlagged=false),"
echo "the lying agent is filtered out. Smart requests auto-failover to good/flaky."
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Watch live penalties in another terminal:"
echo "    nats sub 'mesh.event.reputation.penalty.>'"
echo "═══════════════════════════════════════════════════"
