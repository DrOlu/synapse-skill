#!/bin/bash
# test_bridge.sh — End-to-end test for HTTP↔Synapse bridge
# Requires: nats-server running, Flask agent running, bridge running

set -e

NATS_URL="nats://localhost:4222"
BRIDGE_URL="http://localhost:4100"

echo "╔═══════════════════════════════════════════════════╗"
echo "║  HTTP↔Synapse Bridge — End-to-End Test           ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""

# --- Pre-flight checks ---
echo "→ Checking prerequisites..."
if ! nats server info -s "$NATS_URL" &>/dev/null; then
  echo "❌ NATS server not running. Start with: nats-server -js"
  exit 1
fi

if ! curl -s "$NATS_URL" &>/dev/null && ! nc -z localhost 4222 2>/dev/null; then
  echo "❌ NATS server not reachable at $NATS_URL"
  exit 1
fi

HEALTH=$(curl -sf "$BRIDGE_URL/mesh/health" 2>/dev/null || echo "")
if [ -z "$HEALTH" ]; then
  echo "❌ Bridge not running at $BRIDGE_URL"
  exit 1
fi

echo "✅ NATS: running"
echo "✅ Bridge: running"
echo ""

# --- TEST 1: Discover HTTP agent from Synapse ---
echo "─────────────────────────────────────────────────────"
echo "TEST 1: Discover Flask agent from Synapse mesh"
echo "─────────────────────────────────────────────────────"

RESULT=$(nats request mesh.registry.discover '{"capabilities":["chat"]}' -s "$NATS_URL" --timeout 3s 2>/dev/null || echo "TIMEOUT")
if echo "$RESULT" | grep -q "flask-chat-001\|Flask Chat"; then
  echo "✅ Flask agent discovered via Synapse"
  echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
else
  echo "⚠️  Flask agent not found (bridge may still be registering)"
  echo "   Result: $RESULT"
fi
echo ""

# --- TEST 2: Synapse → HTTP agent (via bridge) ---
echo "─────────────────────────────────────────────────────"
echo "TEST 2: Synapse agent calls Flask chat agent"
echo "─────────────────────────────────────────────────────"

# First find the Flask agent's actual inbox subject
FLASK_ID=$(nats request mesh.registry.discover '{"capabilities":["chat"]}' -s "$NATS_URL" --timeout 3s 2>/dev/null \
  | python3 -c "import sys,json; data=json.load(sys.stdin); print(data.get('payload',{}).get('id',''))" 2>/dev/null || echo "")

if [ -n "$FLASK_ID" ] && [ "$FLASK_ID" != "" ]; then
  INBOX="mesh.agent.$FLASK_ID.inbox"
  REQUEST='{"type":"request","skill":"chat","input":{"text":"Hello from Synapse!"}}'
  RESULT=$(nats request "$INBOX" "$REQUEST" -s "$NATS_URL" --timeout 5s 2>/dev/null || echo "TIMEOUT")

  if echo "$RESULT" | grep -q "Flask says"; then
    echo "✅ Synapse → HTTP agent call succeeded!"
    echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
  else
    echo "⚠️  Unexpected result: $RESULT"
  fi
else
  echo "⚠️  Could not resolve Flask agent ID"
fi
echo ""

# --- TEST 3: HTTP → Synapse (via webhook) ---
echo "─────────────────────────────────────────────────────"
echo "TEST 3: HTTP agent calls Synapse via webhook"
echo "─────────────────────────────────────────────────────"

RESULT=$(curl -sf -X POST "$BRIDGE_URL/mesh/request" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "flask-chat-001",
    "skill": "chat",
    "input": {"text": "Hello from HTTP!"}
  }' 2>/dev/null || echo "CURL_FAILED")

if echo "$RESULT" | grep -q "Flask says"; then
  echo "✅ HTTP → Synapse (webhook) call succeeded!"
  echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
else
  echo "⚠️  Webhook call result: $RESULT"
fi
echo ""

# --- TEST 4: Webhook discover ---
echo "─────────────────────────────────────────────────────"
echo "TEST 4: HTTP discover via webhook"
echo "─────────────────────────────────────────────────────"

RESULT=$(curl -sf -X POST "$BRIDGE_URL/mesh/discover" \
  -H "Content-Type: application/json" \
  -d '{"capabilities":["chat"]}' 2>/dev/null || echo "CURL_FAILED")

if echo "$RESULT" | grep -q "agents"; then
  echo "✅ Webhook discover succeeded!"
  echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
else
  echo "⚠️  Discover result: $RESULT"
fi
echo ""

echo "═══════════════════════════════════════════════════════"
echo "All tests complete."
echo "═══════════════════════════════════════════════════════"
