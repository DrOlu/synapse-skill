# Reputation System Demo

Demonstrates the Synapse reputation system:

- **3 chat agents** with different reliability levels
- **1 lying agent** that claims `chat` but has no handler (always returns SKILL_NOT_FOUND)
- **1 reputation service** that scores all agents
- **1 tester** that routes requests to best agents and watches how scores evolve

## Run

```bash
# Terminal 1: Start NATS with JetStream
nats-server -js -p 4222 -m 8222 &

# Terminal 2: Create KV bucket
nats kv add REPUTATION --history=5 --ttl=604800s

# Terminal 3: Start agents
cd synapse-sdk/examples/reputation
npm install
npm run build

# In 4 separate terminals:
npm run service   # Reputation service
npm run good      # Good agent (99% success)
npm run flaky     # Flaky agent (50% success)
npm run lying     # Lying agent (no handlers — returns SKILL_NOT_FOUND)

# Terminal 8: Run the tester
npm run test
```

## What You'll See

```
[Reputation Service] Watching task updates...
[Lying Agent] Claiming capability 'chat' without a handler...
[Good Agent] Ready to chat!
[Flaky Agent] Ready to chat! (but I fail 50% of the time)

[Tester] === Round 1: Sending 10 requests via discoverRanked ===
[Tester]   Top agent: good-agent (score: 0.10)
[Tester]   10/10 successful

[Tester] === Round 2: Forcing requests to each agent ===
[Tester]   good-agent   → 10/10 success
[Tester]   flaky-agent  → 5/10 success
[Tester]   lying-agent  → 0/10 success (SKILL_NOT_FOUND!)

[Tester] === Checking reputation scores ===
[Reputation] good-agent/chat:   score=0.85  success_rate=1.00
[Reputation] flaky-agent/chat:  score=0.42  success_rate=0.50
[Reputation] lying-agent/chat:  score=0.00  FLAGGED (misleading_capabilities)

[Tester] === Round 3: discoverRanked now excludes flags ===
[Tester]   Top agent: good-agent (score: 0.85)  ← lying agent filtered out!
[Tester]   Flaky agent ranked second (score: 0.42)
```

## Files

- `src/reputation-service.ts` — Central scoring service
- `src/good-agent.ts` — Reliable agent (always works)
- `src/flaky-agent.ts` — Fails 50% of the time
- `src/lying-agent.ts` — Claims `chat` but has no handler
- `src/tester.ts` — Runs the demo scenario
