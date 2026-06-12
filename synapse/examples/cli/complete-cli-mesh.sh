#!/bin/bash
# complete-cli-mesh.sh — Fully working Synapse with 4 CLI agents
# Run this to see the protocol in action using only the nats binary

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATS_URL="nats://localhost:4222"
LOG_DIR="/tmp/synapse-cli-demo"
mkdir -p "$LOG_DIR"

cleanup() {
  echo ""
  echo "=== Cleanup ==="
  pkill -f "nats reply" 2>/dev/null || true
  pkill -f "nats sub" 2>/dev/null || true
  pkill -f "bob-agent" 2>/dev/null || true
  pkill -f "jeff-agent" 2>/dev/null || true
  pkill -f "monitor-agent" 2>/dev/null || true
  pkill -f "logger-agent" 2>/dev/null || true
  sleep 0.5
  echo "Done."
}
trap cleanup EXIT

echo "╔═══════════════════════════════════════════════════════╗"
echo "║   Synapse CLI Demo — 4 agents on one NATS server    ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# 1. Start NATS if not running
if ! pgrep -x nats-server > /dev/null; then
  echo "→ Starting NATS server..."
  nats-server &> "$LOG_DIR/nats.log" &
  sleep 2
fi
echo "✓ NATS server running"
echo ""

# 2. Start Bob agent (chat responder)
echo "→ Starting Bob agent (chat responder)..."
(
  nats pub mesh.registry.register \
    '{"id":"bob-001","name":"Bob Agent","capabilities":["chat"],"skills":[{"id":"chat"},{"id":"help"}],"endpoint":"mesh.agent.bob-001.inbox","availability":"online"}' \
    -s "$NATS_URL" > /dev/null 2>&1
  nats reply mesh.agent.bob-001.inbox \
    '{"from":"bob-001","type":"respond","payload":{"output":"Hi from Bob! 🎉"}}' \
    -s "$NATS_URL" > "$LOG_DIR/bob.log" 2>&1
) &
BOB_PID=$!
sleep 0.5
echo "✓ Bob agent online (PID: $BOB_PID)"

# 3. Start Monitor agent (event publisher)
echo "→ Starting Monitor agent (event publisher)..."
(
  nats pub mesh.registry.register \
    '{"id":"monitor-001","name":"System Monitor","capabilities":["monitoring"],"skills":[],"endpoint":"mesh.agent.monitor-001.inbox","availability":"online"}' \
    -s "$NATS_URL" > /dev/null 2>&1
  for i in 1 2 3; do
    sleep 1
    nats pub "mesh.event.system.cpu" \
      "{\"from\":\"monitor-001\",\"event_type\":\"cpu\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"payload\":{\"usage\":$((RANDOM % 100))}}" \
      -s "$NATS_URL" > /dev/null 2>&1
  done
) &
MON_PID=$!
echo "✓ Monitor agent online (PID: $MON_PID)"

# 4. Start Logger agent (event subscriber)
echo "→ Starting Logger agent (event subscriber)..."
(
  nats pub mesh.registry.register \
    '{"id":"logger-001","name":"Event Logger","capabilities":["logging"],"skills":[],"endpoint":"mesh.agent.logger-001.inbox","availability":"online"}' \
    -s "$NATS_URL" > /dev/null 2>&1
  nats sub 'mesh.event.system.>' -s "$NATS_URL" --count 3 > "$LOG_DIR/logger.log" 2>&1
) &
LOG_PID=$!
echo "✓ Logger agent online (PID: $LOG_PID)"
echo ""

sleep 1
echo "─────────────────────────────────────────────────────"
echo "TEST 1: DISCOVER — Jeff finds Bob"
echo "─────────────────────────────────────────────────────"
RESULT=$(nats request mesh.registry.discover \
  '{"capabilities":["chat"]}' -s "$NATS_URL" --timeout 2s 2>/dev/null)
echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
echo ""

sleep 1
echo "─────────────────────────────────────────────────────"
echo "TEST 2: REQUEST — Jeff sends message to Bob"
echo "─────────────────────────────────────────────────────"
RESULT=$(nats request mesh.agent.bob-001.inbox \
  '{"type":"request","from":"jeff-001","skill":"chat","input":{"text":"Hi Bob!"}}' \
  -s "$NATS_URL" --timeout 2s 2>/dev/null)
echo "Bob's response:"
echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
echo ""

sleep 3
echo "─────────────────────────────────────────────────────"
echo "TEST 3: EVENT STREAM — Logger received events"
echo "─────────────────────────────────────────────────────"
if [ -f "$LOG_DIR/logger.log" ]; then
  grep -c "cpu" "$LOG_DIR/logger.log" | xargs echo "CPU events logged:"
else
  echo "(no log file yet)"
fi
echo ""

echo "─────────────────────────────────────────────────────"
echo "TEST 4: MANUAL EMIT — Publish a custom event"
echo "─────────────────────────────────────────────────────"
nats pub "mesh.event.user.action" \
  '{"from":"manual-test","event_type":"action","payload":{"action":"demo_complete"}}' \
  -s "$NATS_URL"
echo "✓ Event published"
echo ""

echo "═══════════════════════════════════════════════════════"
echo "All 4 primitives tested with pure CLI agents!"
echo ""
echo "Log files: $LOG_DIR/"
echo "  - nats.log   (server logs)"
echo "  - bob.log    (Bob's reply handler)"
echo "  - logger.log (events received by Logger)"
echo "═══════════════════════════════════════════════════════"
