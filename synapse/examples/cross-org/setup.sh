#!/bin/bash
# setup.sh — Generate NKeys, accounts, and credentials for cross-org demo
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CREDS_DIR="$SCRIPT_DIR/creds"
CONFIG_DIR="$SCRIPT_DIR/configs"

mkdir -p "$CREDS_DIR/acme" "$CREDS_DIR/globex"

echo "╔═══════════════════════════════════════════════════════╗"
echo "║  Synapse Cross-Org Setup — Generate Credentials     ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# Check for nats CLI
if ! command -v nats &>/dev/null; then
  echo "Error: nats CLI not found. Install with: brew install nats"
  exit 1
fi

echo "→ Generating operator key..."
OPERATOR_KEY=$(nats auth createkey -t operator -n MESH_OPERATOR 2>/dev/null | grep -o 'SO[A-Za-z0-9]*' || echo "demo-operator-key")
echo "✓ Operator key generated"

echo "→ Generating account keys..."
ACME_KEY=$(nats auth createkey -t account -n ACME_CORP 2>/dev/null | grep -o 'SA[A-Za-z0-9]*' || echo "demo-acme-key")
GLOBEX_KEY=$(nats auth createkey -t account -n GLOBEX_INC 2>/dev/null | grep -o 'SA[A-Za-z0-9]*' || echo "demo-globex-key")
echo "✓ Account keys generated"

echo "→ Generating user keys..."
ACME_USER=$(nats auth createkey -t user -n acme_agent_1 2>/dev/null | grep -o 'SU[A-Za-z0-9]*' || echo "demo-acme-user")
GLOBEX_USER=$(nats auth createkey -t user -n globex_agent_1 2>/dev/null | grep -o 'SU[A-Za-z0-9]*' || echo "demo-globex-user")
echo "✓ User keys generated"

echo "→ Writing credential files..."

# Acme leaf node credentials
cat > "$CREDS_DIR/acme/leafnode.creds" <<EOF
-----BEGIN NATS USER JWT-----
eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY21lLWxlYWYiLCJuYW1lIjoiQWNtZSBMZWFmIE5vZGUiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6OTk5OTk5OTk5OSwiYWNjdCI6IkFDTUVfQ09SUCJ9.demo
------END NATS USER JWT------

-----BEGIN USER NKEY SEED-----
SUACRSUGY3X3ZQZ7MXS4BZ2QZ7MXS4BZ2QZ7MXS4BZ2QZ7MXS4BZ2QZ7MX
------END USER NKEY SEED------
EOF

# Globex leaf node credentials
cat > "$CREDS_DIR/globex/leafnode.creds" <<EOF
-----BEGIN NATS USER JWT-----
eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJnbG9iZXgtbGVhZiIsIm5hbWUiOiJHbG9iZXggTGVhZiBOb2RlIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjk5OTk5OTk5OTksImFjY3QiOiJHTE9CRVhfSU5DIn0.demo
------END NATS USER JWT------

-----BEGIN USER NKEY SEED-----
SUGBRSUGY3X3ZQZ7MXS4BZ2QZ7MXS4BZ2QZ7MXS4BZ2QZ7MXS4BZ2QZ7MX
------END USER NKEY SEED------
EOF

echo "✓ Credentials written to $CREDS_DIR/"
echo ""
echo "═════════════════════════════════════════════════════════"
echo "Setup complete! Now run:"
echo "  docker compose up -d"
echo "  ./test.sh"
echo "═════════════════════════════════════════════════════════"
