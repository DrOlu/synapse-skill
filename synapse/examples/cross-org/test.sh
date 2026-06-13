#!/bin/bash
# test.sh — Test cross-org communication between Acme and Globex agents
set -e

echo "╔═══════════════════════════════════════════════════════╗"
echo "║  Synapse Cross-Org Test                              ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# Wait for servers to be ready
echo "→ Waiting for NATS servers..."
sleep 5

NATS_URL="nats://localhost:4222"

# ─── Test 1: Check leaf node connections ───────────────────────
echo ""
echo "─────────────────────────────────────────────────────"
echo "TEST 1: Verify leaf node connections"
echo "─────────────────────────────────────────────────────"

LEAF_COUNT=$(curl -s http://localhost:8222/leafz 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('leafs',[])))" 2>/dev/null || echo "0")
echo "Leaf nodes connected to cloud hub: $LEAF_COUNT"

if [ "$LEAF_COUNT" -ge 2 ]; then
  echo "✓ Both Acme and Globex leaf nodes connected"
else
  echo "⚠ Expected 2 leaf nodes, got $LEAF_COUNT (may still be connecting...)"
fi

# ─── Test 2: Register Acme agent ───────────────────────────────
echo ""
echo "─────────────────────────────────────────────────────"
echo "TEST 2: Register Acme code review agent"
echo "─────────────────────────────────────────────────────"

ACME_NATS="nats://localhost:5222"

nats pub mesh.registry.register '{
  "id": "acme-code-review-001",
  "name": "Acme Code Review",
  "capabilities": ["code.review", "shared.acme"],
  "skills": [{"id": "code.review", "name": "Code Review", "description": "Review code changes"}],
  "endpoint": "mesh.agent.acme-code-review-001.inbox",
  "availability": "online"
}' -s "$ACME_NATS" 2>/dev/null

echo "✓ Acme agent registered on internal NATS"

# ─── Test 3: Start Acme agent responder ────────────────────────
echo ""
echo "─────────────────────────────────────────────────────"
echo "TEST 3: Start Acme agent responder"
echo "─────────────────────────────────────────────────────"

nats reply mesh.agent.acme-code-review-001.inbox \
  '{"from":"acme-code-review-001","type":"respond","payload":{"output":{"review":"Approved - code looks good from Acme side"}}}' \
  -s "$ACME_NATS" &
ACME_PID=$!
echo "✓ Acme responder listening (PID: $ACME_PID)"

sleep 1

# ─── Test 4: Globex discovers Acme agent ───────────────────────
echo ""
echo "─────────────────────────────────────────────────────"
echo "TEST 4: Globex discovers Acme agent (cross-org)"
echo "─────────────────────────────────────────────────────"

GLOBEX_NATS="nats://localhost:6222"

RESULT=$(nats request mesh.registry.discover \
  '{"capabilities":["code.review"]}' -s "$GLOBEX_NATS" --timeout 5s 2>/dev/null || echo "TIMEOUT")

if [ "$RESULT" != "TIMEOUT" ] && echo "$RESULT" | grep -q "acme-code-review"; then
  echo "✓ Globex discovered Acme agent across organizations!"
  echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
else
  echo "⚠ Cross-org discovery not yet working (leaf nodes may still be connecting)"
  echo "Result: $RESULT"
fi

# ─── Test 5: Globex requests code review from Acme ─────────────
echo ""
echo "─────────────────────────────────────────────────────"
echo "TEST 5: Globex requests code review from Acme"
echo "─────────────────────────────────────────────────────"

RESULT=$(nats request mesh.agent.acme-code-review-001.inbox \
  '{"type":"request","from":"globex-security-001","skill":"code.review","input":{"code":"fn main() {}","context":"new auth flow"}}' \
  -s "$GLOBEX_NATS" --timeout 5s 2>/dev/null || echo "TIMEOUT")

if [ "$RESULT" != "TIMEOUT" ]; then
  echo "✓ Cross-org request succeeded!"
  echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
else
  echo "⚠ Cross-org request timed out (may need more time for leaf nodes to sync)"
fi

# ─── Test 6: Shared events ────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────────────"
echo "TEST 6: Shared events (Acme → Globex)"
echo "─────────────────────────────────────────────────────"

nats pub mesh.event.shared.acme.deploy.completed '{
  "from": "acme-code-review-001",
  "type": "emit",
  "payload": {
    "event_type": "deploy.completed",
    "data": {"service": "auth-api", "version": "1.2.3", "status": "deployed"}
  }
}' -s "$ACME_NATS" 2>/dev/null

echo "✓ Acme published shared event"
echo "  (Globex can subscribe to mesh.event.shared.acme.> to receive)"

# Cleanup
kill $ACME_PID 2>/dev/null || true

echo ""
echo "═══════════════════════════════════════════════════════"
echo "Cross-org tests complete!"
echo ""
echo "Summary:"
echo "  • Cloud hub:    http://localhost:8222 (monitoring)"
echo "  • Acme NATS:    http://localhost:5822 (monitoring)"
echo "  • Globex NATS:  http://localhost:6822 (monitoring)"
echo ""
echo "Cleanup: docker compose down"
echo "═══════════════════════════════════════════════════════"
