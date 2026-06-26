#!/usr/bin/env bash
# synapse-cli.sh — thin wrappers over the `nats` CLI for the 6 Synapse primitives.
# Any agent that can shell out can use these against ANY Synapse mesh.
# Defaults to the local mesh (nats://localhost:4222).
#
# Works on macOS/Linux/Git-Bash-on-Windows. For native Windows PowerShell,
# see the `windows` command or use client.py (python) which is fully
# cross-platform via nats-py.
#
# Usage:
#   synapse-cli.sh discover '[capabilities]'            # list agents
#   synapse-cli.sh request bob-001 chat '{"text":"hi"}' # call a skill
#   synapse-cli.sh respond <reply-subject> '{"text":"hi"}'
#   synapse-cli.sh emit document.created '{"doc":"x"}'
#   synapse-cli.sh subscribe 'mesh.event.document.>'    # listen (foreground)
#   synapse-cli.sh register '{"id":"...","name":"..."}'
#   synapse-cli.sh health
#   synapse-cli.sh windows                              # print PowerShell equivalents
#
# Auth for any remote mesh:
#   -s nats://host:4222      choose server:port
#   --nkey ~/.synapse/nkeys/my.seed
#   --creds ~/.nats/synadia.creds

set -euo pipefail

SERVER="${SYNAPSE_URL:-nats://localhost:4222}"
NKEY=""
CREDS=""
FROM="cli"

# Parse global flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--server) SERVER="$2"; shift 2;;
    --nkey) NKEY="$2"; shift 2;;
    --creds) CREDS="$2"; shift 2;;
    --from) FROM="$2"; shift 2;;
    *) break;;
  esac
done

# Expand a leading ~ (variables are not tilde-expanded by bash, so a stored
# "~/.synapse/..." path would be passed literally and fail to open).
expand_tilde() { local p="$1"; printf '%s' "${p/#\~/$HOME}"; }
[[ -n "$NKEY"  ]] && NKEY="$(expand_tilde "$NKEY")"
[[ -n "$CREDS" ]] && CREDS="$(expand_tilde "$CREDS")"

AUTH_ARGS=()
[[ -n "$NKEY"  ]] && AUTH_ARGS+=(--nkey "$NKEY")
[[ -n "$CREDS" ]] && AUTH_ARGS+=(--creds "$CREDS")

NATS=(nats --server "$SERVER" "${AUTH_ARGS[@]}")

# Build a Synapse envelope JSON string. Args: type payload-json
# Passes the payload via an env var and parses it as JSON inside python to
# avoid all shell/python quoting hazards (payloads contain double quotes).
envelope() {
  local type="$1" payload="${2:-null}"
  local ts id
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || python3 -c "import datetime;print(datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'))")
  id="${RANDOM}${RANDOM}${RANDOM}"
  SYN_TYPE="$type" SYN_TS="$ts" SYN_ID="$id" SYN_FROM="$FROM" SYN_PAYLOAD="$payload" python3 -c '
import json, os
env = {"v": "1.0.0", "id": os.environ["SYN_ID"], "type": os.environ["SYN_TYPE"],
       "ts": os.environ["SYN_TS"], "from": os.environ["SYN_FROM"],
       "trace": {"trace_id": os.environ["SYN_ID"], "span_id": os.environ["SYN_ID"]}}
p = os.environ["SYN_PAYLOAD"]
try:
    env["payload"] = json.loads(p)
except Exception:
    env["payload"] = p
print(json.dumps(env))
'
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  discover)
    cap="${1:-[]}"
    payload="{\"capabilities\":$cap}"
    env=$(envelope discover "$payload")
    "${NATS[@]}" request mesh.registry.discover "$env" --raw 2>/dev/null || true
    ;;
  register)
    manifest="${1:?manifest json required}"
    env=$(envelope register "{\"manifest\":$manifest}")
    "${NATS[@]}" pub mesh.registry.register "$env"
    ;;
  request)
    to="${1:?target agent id required}"; skill="${2:?skill id required}"; body="${3:?payload json required}"
    tid="req-${RANDOM}${RANDOM}"
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || python3 -c "import datetime;print(datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'))")"
    env="$(SYN_TYPE=request SYN_TS="$ts" SYN_ID="$tid" SYN_FROM="$FROM" SYN_TO="$to" SYN_TASK="$tid" SYN_SKILL="$skill" SYN_BODY="$body" python3 -c '
import json, os
env = {"v":"1.0.0","id":os.environ["SYN_ID"],"type":"request","ts":os.environ["SYN_TS"],
       "from":os.environ["SYN_FROM"],"to":os.environ["SYN_TO"],"task_id":os.environ["SYN_TASK"],
       "trace":{"trace_id":os.environ["SYN_TASK"],"span_id":os.environ["SYN_TASK"]}}
b = os.environ["SYN_BODY"]
try: msg = json.loads(b)
except Exception: msg = b
env["payload"] = {"skill":os.environ["SYN_SKILL"],"task_id":os.environ["SYN_TASK"],
                 "text": b, "message": msg}
print(json.dumps(env))
')"
    "${NATS[@]}" request "mesh.agent.$to.inbox" "$env" --raw
    ;;
  respond)
    subj="${1:?reply subject required}"; body="${2:?payload json required}"
    env=$(envelope respond "{\"result\":$body}")
    "${NATS[@]}" pub "$subj" "$env"
    ;;
  emit)
    evt="${1:?event type required}"; body="${2:-"{}"}"
    env=$(envelope emit "$body")
    "${NATS[@]}" pub "mesh.event.$evt" "$env"
    ;;
  subscribe)
    pat="${1:?subject pattern required}"
    "${NATS[@]}" sub "$pat"
    ;;
  file)
    # File transfer (chunked) — delegates to synapse-send-file if present,
    # else falls back to a simple one-shot publish of base64.
    to="${1:?target agent required}"; path="${2:?file path required}"
    action="${3:-analyze}"
    if command -v synapse-send-file >/dev/null 2>&1; then
      synapse-send-file "$path" --target "$to" --action "$action" -s "$SERVER" "${AUTH_ARGS[@]}"
    else
      b64=$(base64 < "$path" | tr -d '\n')
      "${NATS[@]}" pub "mesh.agent.$to.inbox" \
        "{\"file_transfer\":true,\"phase\":\"done\",\"action\":\"$action\",\"filename\":\"$(basename "$path")\",\"data_b64\":\"$b64\"}"
      echo "(sent one-shot; install synapse-send-file for chunked transfer)"
    fi
    ;;
  health)
    host="${SYNAPSE_HOST:-localhost}"; port="${SYNAPSE_MON_PORT:-8222}"
    curl -s "http://$host:$port/healthz"; echo
    curl -s "http://$host:$port/varz" | python3 -c "import sys,json;d=json.load(sys.stdin);print('server:',d.get('id','?'),'uptime:',d.get('uptime','?'),'conns:',d.get('connections','?'))" 2>/dev/null || true
    ;;
  windows)
    cat <<'EOF'
# Native Windows PowerShell equivalents (no Git Bash required).
# Requires the `nats` CLI on %PATH% and python for JSON. NKey path uses %USERPROFILE%.

# --- discover agents (send a proper Synapse envelope) ---
$id = [guid]::NewGuid().ToString(); $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$env = @{ v="1.0.0"; id=$id; type="discover"; ts=$ts; from="cli"; trace=@{trace_id=$id;span_id=$id}; payload=@{capabilities=@()} } | ConvertTo-Json -Compress -Depth 5
nats --server "nats://localhost:4222" --nkey "$env:USERPROFILE\.synapse\nkeys\grip-cli-001.seed" request mesh.registry.discover $env

# --- request a skill ---
$to="bob-001"; $skill="chat"; $tid="req-"+[guid]::NewGuid().ToString()
$body = @{ text="Hello Bob" } | ConvertTo-Json -Compress
$env = @{ v="1.0.0"; id=[guid]::NewGuid().ToString(); type="request"; ts=$ts; from="cli"; to=$to; task_id=$tid; trace=@{trace_id=$tid;span_id=$tid}; payload=@{skill=$skill;task_id=$tid;text=$body;message=$body} } | ConvertTo-Json -Compress -Depth 5
nats --server "nats://localhost:4222" --nkey "$env:USERPROFILE\.synapse\nkeys\grip-cli-001.seed" request "mesh.agent.$to.inbox" $env

# --- health (no auth needed; monitoring endpoint) ---
Invoke-RestMethod "http://localhost:8222/healthz"
Invoke-RestMethod "http://localhost:8222/varz" | Select-Object server_id,uptime,connections

# --- emit an event ---
$env = @{ v="1.0.0"; id=[guid]::NewGuid().ToString(); type="emit"; ts=$ts; from="cli"; trace=@{trace_id=$id;span_id=$id}; payload=@{doc_id="x"} } | ConvertTo-Json -Compress -Depth 5
nats --server "nats://localhost:4222" --nkey "$env:USERPROFILE\.synapse\nkeys\grip-cli-001.seed" pub "mesh.event.document.created" $env

# Or simply use client.py which is fully cross-platform via nats-py:
#   pip install nats-py
#   python client.py --nkey %USERPROFILE%\.synapse\nkeys\grip-cli-001.seed discover --cap chat
EOF
    ;;
  *)
    cat <<'EOF'
Synapse CLI helper. Commands:
  discover '[caps]'                list/discover agents (sends Synapse envelope)
  register '<manifest-json>'        announce an agent
  request <agent> <skill> '<payload>'  call an agent's skill (request/reply)
  respond <reply-subj> '<payload>'  reply on a reply subject
  emit <event-type> '<data>'        broadcast an event
  subscribe <pattern>              listen (wildcards: * >)
  file <agent> <path> [action]     send a file (chunked if available)
  health                           probe NATS monitoring endpoint
  windows                          print native PowerShell equivalents

Flags:  -s|--server nats://host:4222   --nkey <seed>   --creds <jwt-creds>   --from <agent-id>
Env:    SYNAPSE_URL  SYNAPSE_HOST  SYNAPSE_MON_PORT
EOF
    ;;
esac
