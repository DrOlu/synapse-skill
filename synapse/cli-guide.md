# Synapse CLI Guide

Build complete Synapse agents using only the `nats` binary — no SDK, no code, just shell commands. Perfect for infrastructure agents, edge devices, edge cases, and understanding the protocol at the wire level.

## Table of Contents
- [Primitives Mapping](#primitives-mapping)
- [Basic Agents](#basic-agents)
- [Dynamic Responses](#dynamic-responses)
- [Event-Driven Agents](#event-driven-agents)
- [Multi-Skill Agents](#multi-skill-agents)
- [Heartbeat Implementation](#heartbeat-implementation)
- [Real-World Patterns](#real-world-patterns)
- [Limitations](#limitations)

---

## Primitives Mapping

Every Synapse primitive maps directly to a `nats` CLI command:

| Primitive | CLI Command | Example |
|-----------|-------------|---------|
| **register** | `nats pub` | `nats pub mesh.registry.register '{manifest}'` |
| **discover** | `nats request` | `nats request mesh.registry.discover '{query}'` |
| **request** | `nats request` | `nats request mesh.agent.bob-001.inbox '{request}'` |
| **respond** | `nats reply` | `nats reply mesh.agent.bob-001.inbox '{response}'` |
| **emit** | `nats pub` | `nats pub mesh.event.system.uptime '{event}'` |
| **subscribe** | `nats sub` | `nats sub 'mesh.event.system.>' --count 5` |

---

## Basic Agents

### Static Agent (Canned Response)

The simplest possible agent — always returns the same response:

```bash
#!/bin/bash
# bob-agent.sh - Static agent with canned responses

AGENT_ID="bob-001"
AGENT_NAME="Bob Agent"
NATS_URL="nats://localhost:4222"
INBOX="mesh.agent.$AGENT_ID.inbox"

# Step 1: Register manifest
MANIFEST=$(cat <<EOF
{
  "id": "$AGENT_ID",
  "name": "$AGENT_NAME",
  "description": "Static echo agent",
  "capabilities": ["echo", "chat"],
  "skills": [
    {"id": "echo", "description": "Echo back input"},
    {"id": "chat", "description": "Static chat response"}
  ],
  "endpoint": "$INBOX",
  "availability": "online",
  "last_heartbeat": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)

echo "[$AGENT_NAME] Registering..."
nats pub mesh.registry.register "$MANIFEST" -s "$NATS_URL"

# Step 2: Respond to ALL requests with canned message
CANNED_RESPONSE='{"payload":{"output":"Hello from Bob! I received your request."},"type":"respond","from":"bob-001"}'

echo "[$AGENT_NAME] Listening on $INBOX..."
nats reply "$INBOX" "$CANNED_RESPONSE" -s "$NATS_URL"
```

Run it:
```bash
chmod +x bob-agent.sh
./bob-agent.sh &

# Test it
nats request mesh.agent.bob-001.inbox '{"text":"Hi Bob!"}' -s nats://localhost:4222
# → {"payload":{"output":"Hello from Bob! I received your request."},"type":"respond","from":"bob-001"}
```

---

### Discover-Only Agent (Service Catalog)

Agent that only discovers other agents (doesn't respond to requests):

```bash
#!/bin/bash
# discover-agent.sh - Finds all chat-capable agents

NATS_URL="nats://localhost:4222"

echo "Discovering agents with 'chat' capability..."
RESULT=$(nats request mesh.registry.discover '{"capabilities":["chat"]}' -s "$NATS_URL" --timeout 2s)

if [ -z "$RESULT" ]; then
  echo "No agents found"
else
  echo "Found agent:"
  echo "$RESULT" | jq .
fi
```

---

### Event Publisher (Monitor)

Agent that publishes events but doesn't respond to requests:

```bash
#!/bin/bash
# uptime-monitor.sh - Publishes system uptime every 10 seconds

AGENT_ID="uptime-monitor-001"
NATS_URL="nats://localhost:4222"

# Register (no skills, just an event publisher)
MANIFEST='{"id":"uptime-monitor-001","name":"Uptime Monitor","capabilities":["monitoring"],"skills":[],"availability":"online"}'
nats pub mesh.registry.register "$MANIFEST" -s "$NATS_URL"

echo "Publishing uptime every 10 seconds..."
while true; do
  UPTIME=$(uptime | awk '{$1=$1};1')
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  
  EVENT=$(cat <<EOF
{
  "from": "$AGENT_ID",
  "event_type": "uptime",
  "timestamp": "$TIMESTAMP",
  "payload": {
    "uptime": "$UPTIME"
  }
}
EOF
)
  
  nats pub "mesh.event.system.uptime" "$EVENT" -s "$NATS_URL"
  sleep 10
done
```

---

### Event Subscriber (Logger)

Agent that subscribes and logs events:

```bash
#!/bin/bash
# event-logger.sh - Subscribes to all system events and logs them

NATS_URL="nats://localhost:4222"

echo "Subscribing to mesh.event.system.> (wildcard)..."
echo "Will log first 10 events, then exit."
echo ""

nats sub 'mesh.event.system.>' -s "$NATS_URL" --count 10 | while IFS= read -r line; do
  TIMESTAMP=$(date +%H:%M:%S)
  echo "[$TIMESTAMP] $line"
done

echo "Done."
```

---

## Dynamic Responses

Pure CLI agents can't read incoming requests and compute responses (unlike SDK agents with handler functions), but you can simulate this with shell scripting.

### Pipe Through Shell Script

```bash
#!/bin/bash
# echo-agent.sh - Echoes back whatever was sent

AGENT_ID="echo-001"
NATS_URL="nats://localhost:4222"
INBOX="mesh.agent.$AGENT_ID.inbox"

# Register
nats pub mesh.registry.register "{\"id\":\"$AGENT_ID\",\"name\":\"Echo Agent\",\"capabilities\":[\"echo\"]}" -s "$NATS_URL"

# Reply handler: reads request from stdin, echoes back
echo "Listening..."
nats reply "$INBOX" -s "$NATS_URL" << 'HANDLER'
while IFS= read -r request; do
  # Extract 'text' field from request
  TEXT=$(echo "$request" | jq -r '.text // empty')
  
  if [ -n "$TEXT" ]; then
    RESPONSE=$(jq -n \
      --arg text "Echo: $TEXT" \
      --arg from "$AGENT_ID" \
      '{payload: {output: $text}, type: "respond", from: $from}')
    echo "$RESPONSE"
  else
    echo '{"error":"No text field found"}'
  fi
done
HANDLER
```

⚠️ **Limitation:** `nats reply` doesn't support stdin-based dynamic responses directly. You need to wrap it or use JetStream work queues (see below).

---

### JetStream Work Queue (True Dynamic Responses)

Use JetStream pull consumers to process requests one at a time with full dynamic logic:

```bash
#!/bin/bash
# workqueue-agent.sh - Pull-based dynamic request processing

AGENT_ID="workworker-001"
NATS_URL="nats://localhost:4222"
INBOX="mesh.agent.$AGENT_ID.inbox"

# Register
nats pub mesh.registry.register "{\"id\":\"$AGENT_ID\",\"name\":\"Work Queue Agent\",\"capabilities\":[\"worker\"]}" -s "$NATS_URL"

# Create stream for this agent
nats stream add "$AGENT_ID" --subjects="$INBOX" --storage=memory --max-age=1h

# Create pull consumer
nats consumer add "$AGENT_ID" worker --deliver=all --ack=explicit

echo "Processing requests from work queue..."
while true; do
  # Pull next message (blocks 5 seconds)
  MSG=$(nats next "$AGENT_ID" worker --wait 5s --raw)
  
  if [ -n "$MSG" ]; then
    echo "[$(date +%H:%M:%S)] Processing: $MSG"
    
    # Parse request and compute response
    SKILL=$(echo "$MSG" | jq -r '.skill // "unknown"')
    INPUT=$(echo "$MSG" | jq -r '.input.text // empty')
    
    case "$SKILL" in
      "reverse")
        OUTPUT=$(echo "$INPUT" | rev)
        ;;
      "uppercase")
        OUTPUT=$(echo "$INPUT" | tr '[:lower:]' '[:upper:]')
        ;;
      "strlen")
        OUTPUT=$(echo -n "$INPUT" | wc -c | xargs)
        ;;
      *)
        OUTPUT="Unknown skill: $SKILL"
        ;;
    esac
    
    # Publish response to reply subject
    # (extract from request's reply-to field — advanced pattern)
    RESPONSE=$(jq -n \
      --arg output "$OUTPUT" \
      --arg from "$AGENT_ID" \
      '{payload: {output: $output}, type: "respond", from: $from}')
    
    echo "[$(date +%H:%M:%S)] Response: $RESPONSE"
    
    # Acknowledge message (remove from queue)
    nats ack "$AGENT_ID" worker last
  fi
done
```

---

## Event-Driven Agents

### Disk Space Monitor

```bash
#!/bin/bash
# disk-monitor.sh - Publishes disk usage events

AGENT_ID="disk-monitor-001"
NATS_URL="nats://localhost:4222"
THRESHOLD=80  # Alert if disk > 80%

# Register
nats pub mesh.registry.register \
  "{\"id\":\"$AGENT_ID\",\"name\":\"Disk Monitor\",\"capabilities\":[\"monitoring\",\"disk\"]}" \
  -s "$NATS_URL"

echo "Monitoring disk usage every 30 seconds..."
while true; do
  # Get root partition usage
  USAGE=$(df / | tail -1 | awk '{print $5}' | sed 's/%//')
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  
  EVENT_TYPE="normal"
  if [ "$USAGE" -gt "$THRESHOLD" ]; then
    EVENT_TYPE="alert"
  fi
  
  EVENT=$(jq -n \
    --arg agent "$AGENT_ID" \
    --arg type "$EVENT_TYPE" \
    --arg ts "$TIMESTAMP" \
    --arg usage "$USAGE" \
    --arg threshold "$THRESHOLD" \
    '{
      event_type: $type,
      from: $agent,
      timestamp: $ts,
      payload: {
        usage_percent: ($usage|tonumber),
        threshold: ($threshold|tonumber)
      }
    }')
  
  nats pub "mesh.event.system.disk" "$EVENT" -s "$NATS_URL"
  
  sleep 30
done
```

---

### Log Watcher with Pattern Matching

```bash
#!/bin/bash
# log-watcher.sh - Watches /var/log/system.log for errors

AGENT_ID="log-watcher-001"
NATS_URL="nats://localhost:4222"
LOGFILE="/var/log/system.log"

# Register
nats pub mesh.registry.register \
  "{\"id\":\"$AGENT_ID\",\"name\":\"Log Watcher\",\"capabilities\":[\"monitoring\",\"logs\"]}" \
  -s "$NATS_URL"

echo "Watching $LOGFILE for ERROR/WARNING..."
tail -F "$LOGFILE" | grep -E "ERROR|WARNING" --line-buffered | while IFS= read -r line; do
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  
  # Determine severity
  SEVERITY="info"
  if echo "$line" | grep -q "ERROR"; then
    SEVERITY="error"
  elif echo "$line" | grep -q "WARNING"; then
    SEVERITY="warning"
  fi
  
  EVENT=$(jq -n \
    --arg agent "$AGENT_ID" \
    --arg severity "$SEVERITY" \
    --arg line "$line" \
    --arg ts "$TIMESTAMP" \
    '{
      event_type: "log",
      from: $agent,
      severity: $severity,
      timestamp: $ts,
      payload: {
        line: $line
      }
    }')
  
  nats pub "mesh.event.logs.system" "$EVENT" -s "$NATS_URL"
done
```

---

## Multi-Skill Agents

Route requests to different handlers based on `skill` field:

```bash
#!/bin/bash
# multi-skill-agent.sh - Routes to different handlers by skill

AGENT_ID="multi-001"
NATS_URL="nats://localhost:4222"
INBOX="mesh.agent.$AGENT_ID.inbox"

# Register with multiple skills
nats pub mesh.registry.register '{
  "id": "multi-001",
  "name": "Multi-Skill Agent",
  "capabilities": ["text", "math"],
  "skills": [
    {"id": "uppercase", "description": "Convert to uppercase"},
    {"id": "strlen", "description": "Count characters"},
    {"id": "double", "description": "Double a number"}
  ]
}' -s "$NATS_URL"

# JetStream work queue
nats stream add "$AGENT_ID" --subjects="$INBOX" --storage=memory
nats consumer add "$AGENT_ID" worker --deliver=all --ack=explicit

echo "Processing requests..."
while true; do
  MSG=$(nats next "$AGENT_ID" worker --wait 5s --raw)
  
  if [ -z "$MSG" ]; then
    continue
  fi
  
  # Extract skill and input
  SKILL=$(echo "$MSG" | jq -r '.skill // "unknown"')
  INPUT=$(echo "$MSG" | jq -r '.input // ""')
  
  # Route by skill
  case "$SKILL" in
    "uppercase")
      OUTPUT=$(echo "$INPUT" | tr '[:lower:]' '[:upper:]')
      ;;
    "strlen")
      OUTPUT=$(echo -n "$INPUT" | wc -c | xargs)
      ;;
    "double")
      OUTPUT=$(echo "$INPUT * 2" | bc)
      ;;
    *)
      OUTPUT="Unknown skill: $SKILL"
      ;;
  esac
  
  RESPONSE=$(jq -n --arg out "$OUTPUT" '{payload: {output: $out}}')
  echo "[$SKILL] $INPUT → $OUTPUT"
  
  nats ack "$AGENT_ID" worker last
done
```

---

## Heartbeat Implementation

All agents should emit heartbeats every 30 seconds:

```bash
#!/bin/bash
# heartbeat.sh - Generic heartbeat daemon for any agent

AGENT_ID="$1"  # Pass agent ID as argument
NATS_URL="nats://localhost:4222"

if [ -z "$AGENT_ID" ]; then
  echo "Usage: $0 <agent-id>"
  exit 1
fi

echo "Heartbeat for $AGENT_ID (every 30s)..."
while true; do
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  
  HEARTBEAT=$(jq -n \
    --arg id "$AGENT_ID" \
    --arg ts "$TIMESTAMP" \
    '{agent_id: $id, timestamp: $ts}')
  
  nats pub "mesh.heartbeat.$AGENT_ID" "$HEARTBEAT" -s "$NATS_URL"
  
  sleep 30
done
```

Run it in background:
```bash
./heartbeat.sh bob-001 &> heartbeat.log &
```

**Subscribe to heartbeats:**
```bash
nats sub 'mesh.heartbeat.>' -s nats://localhost:4222 --count 5
```

---

## Real-World Patterns

### Pattern: Cron-Based Event Publisher

Run an agent as a cron job:

```bash
# /etc/cron.d/agent-metrics
*/5 * * * * root /opt/agents/metrics-agent.sh
```

```bash
#!/bin/bash
# metrics-agent.sh - Publishes metrics every 5 minutes (via cron)

AGENT_ID="metrics-001"
NATS_URL="nats://localhost:4222"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Collect CPU, memory, load
CPU=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | sed 's/%//')
MEM=$(free | grep Mem | awk '{printf("%.1f", $3/$2 * 100)}')
LOAD=$(uptime | awk -F'average:' '{print $2}' | xargs)

EVENT=$(jq -n \
  --arg agent "$AGENT_ID" \
  --arg ts "$TIMESTAMP" \
  --arg cpu "$CPU" \
  --arg mem "$MEM" \
  --arg load "$LOAD" \
  '{
    event_type: "metrics",
    from: $agent,
    timestamp: $ts,
    payload: {
      cpu_percent: ($cpu|tonumber),
      memory_percent: ($mem|tonumber),
      load: $load
    }
  }')

nats pub "mesh.event.system.metrics" "$EVENT" -s "$NATS_URL"
```

---

### Pattern: File Watcher Agent

```bash
#!/bin/bash
# file-watcher.sh - Publishes events when files change

AGENT_ID="filewatcher-001"
NATS_URL="nats://localhost:4222"
WATCH_DIR="/data/incoming"

nats pub mesh.registry.register \
  "{\"id\":\"$AGENT_ID\",\"name\":\"File Watcher\",\"capabilities\":[\"file\",\"monitoring\"]}" \
  -s "$NATS_URL"

# Use inotifywait (install: brew install inotify-tools on macOS, apt install inotify-tools on Linux)
inotifywait -m "$WATCH_DIR" -e create -e modify -e delete --format '%w%f %e' | while IFS= read -r event_line; do
  FILE=$(echo "$event_line" | awk '{print $1}')
  OPERATION=$(echo "$event_line" | awk '{print $2}')
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  
  EVENT=$(jq -n \
    --arg agent "$AGENT_ID" \
    --arg file "$FILE" \
    --arg op "$OPERATION" \
    --arg ts "$TIMESTAMP" \
    '{
      event_type: "file_change",
      from: $agent,
      timestamp: $ts,
      payload: {
        file: $file,
        operation: $op
      }
    }')
  
  nats pub "mesh.event.files.$(basename $WATCH_DIR)" "$EVENT" -s "$NATS_URL"
done
```

---

### Pattern: Health Check Endpoint

```bash
#!/bin/bash
# health-agent.sh - Provides health check endpoint for monitoring

AGENT_ID="health-001"
NATS_URL="nats://localhost:4222"
INBOX="mesh.agent.$AGENT_ID.inbox"

nats pub mesh.registry.register \
  "{\"id\":\"$AGENT_ID\",\"name\":\"Health Check\",\"capabilities\":[\"monitoring\"]}" \
  -s "$NATS_URL"

# Reply with health status
HEALTH='{"status":"healthy","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","version":"1.0.0"}'
nats reply "$INBOX" "$HEALTH" -s "$NATS_URL" &

echo "Health check endpoint ready at $INBOX"
wait
```

Test:
```bash
nats request mesh.agent.health-001.inbox '{}' -s nats://localhost:4222
```

---

### Pattern: Aggregator Agent

```bash
#!/bin/bash
# aggregator.sh - Collects first N events, publishes summary

AGENT_ID="aggregator-001"
NATS_URL="nats://localhost:4222"
BATCH_SIZE=5

nats pub mesh.registry.register \
  "{\"id\":\"$AGENT_ID\",\"name\":\"Event Aggregator\",\"capabilities\":[\"aggregator\"]}" \
  -s "$NATS_URL"

echo "Aggregating events (batch size: $BATCH_SIZE)..."
EVENTS=()
nats sub 'mesh.event.system.>' -s "$NATS_URL" --count "$BATCH_SIZE" | while IFS= read -r event; do
  EVENTS+=("$event")
  echo "Collected $((${#EVENTS[@]}))/$BATCH_SIZE"
  
  if [ "${#EVENTS[@]}" -eq "$BATCH_SIZE" ]; then
    SUMMARY=$(jq -n \
      --arg agent "$AGENT_ID" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg count "${#EVENTS[@]}" \
      '{
        event_type: "aggregated_summary",
        from: $agent,
        timestamp: $ts,
        payload: {
          event_count: ($count|tonumber),
          events: []
        }
      }')
    
    nats pub "mesh.event.aggregated.summary" "$SUMMARY" -s "$NATS_URL"
  fi
done
```

---

## Limitations

### What Pure CLI Agents Can Do Well

✅ **Static responses** — Fixed canned messages (health checks, config servers)
✅ **Event publishing** — Monitors, log watchers, sensors, cron jobs
✅ **Event subscribing** — Loggers, aggregators, alert forwarders
✅ **Simple transformations** — Pipe through shell tools (jq, awk, sed)
✅ **Infrastructure agents** — Dumb glue that connects systems

### What Pure CLI Agents Can't Do (Easily)

❌ **Dynamic request processing** — Can't read request, call LLM, compute response (see JetStream workaround above)
❌ **Complex skill routing** — Hard to dispatch requests to different handlers
❌ **Long-running tasks** — Can't report task state transitions (working → input_required → completed)
❌ **State management** — No persistence across requests (without JetStream setup)
❌ **Error recovery** — Limited retry/timeout logic

### When to Switch to SDK

Move from CLI to SDK when you need:
- LLM integration (Claude, GPT, Gemini)
- Complex request parsing and response generation
- Stateful agents (remember context across requests)
- Real-time skill routing
- Production-grade error handling

→ See [TypeScript SDK](./typescript.md) or [Python SDK](./python.md) for full implementations.

---

## Complete Example: CLI Agent Mesh

```bash
# Full working mesh with 4 CLI agents

# Terminal 1: Start NATS
nats-server &

# Terminal 2: Static agent
./static-agent.sh &

# Terminal 3: Uptime monitor
./uptime-monitor.sh &

# Terminal 4: Disk monitor
./disk-monitor.sh &

# Terminal 5: Event logger
./event-logger.sh &

# Terminal 6: Test it
sleep 2

# Discover all monitoring agents
nats request mesh.registry.discover '{"capabilities":["monitoring"]}' -s nats://localhost:4222

# Request from static agent
nats request mesh.agent.static-001.inbox '{"text":"Hello"}' -s nats://localhost:4222

# Emit a test event
nats pub mesh.event.system.test '{"message":"Hello world"}' -s nats://localhost:4222
# → Event logger should catch and print it
```

---

## Next Steps

- [Full CLI Examples](./examples/cli/) — Complete runnable scripts
- [TypeScript SDK](./typescript.md) — For agents that need dynamic logic
- [Patterns](./patterns.md) — Advanced architectural patterns
