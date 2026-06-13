# HTTP Bridge

Connect any HTTP/REST agent to the Synapse mesh with zero changes to the agent's code. The bridge acts as a bidirectional proxy between NATS and HTTP.

## Why

Synapse speaks NATS TCP natively. Most real-world agents today are HTTP services (Flask, FastAPI, Express, any REST API). The HTTP bridge:

- **Wraps HTTP agents as Synapse participants** — they register, get discovered, receive requests
- **Lets Synapse agents call HTTP agents** — no NATS required on the HTTP side
- **Lets HTTP agents call Synapse agents** — via a webhook endpoint on the bridge
- **Zero code changes** — HTTP agents don't know NATS exists

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Synapse Mesh (NATS)                           │
│                                                                      │
│  Agent A (TS SDK)          HTTP Bridge               Agent B (Go)   │
│       │                        │                          │         │
│       └──request─────────────>proxy<────────────────────response─────┘
│                                │                                     │
│                           (HTTP POST)                                │
│                                │                                     │
│                    ┌───────────▼──────────┐                          │
│                    │   HTTP Agent         │                          │
│                    │   Flask/FastAPI/...  │  ← zero NATS code       │
│                    │   localhost:5000     │                          │
│                    └──────────┬──────────┘                          │
│                               │                                      │
│                    (can also call Synapse                             │
│                     via bridge webhook)                              │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Mode 1: HTTP Agent joins Synapse (Bridge as proxy)

```
HTTP Agent (Flask)                    Bridge                          Synapse Mesh
     │                                  │                                  │
     │                                  ├── register manifest ───────────>│
     │                                  │   (proxy for HTTP agent)        │
     │                                  │                                  │
     │                                  │<── request from Synapse agent ──│
     │<── POST /skill/chat ─────────────│                                  │
     │                                  │   { skill, input }              │
     │──> 200 OK { output } ───────────>│                                  │
     │                                  ├── respond ─────────────────────>│
     │                                  │                                  │
```

### Mode 2: HTTP Agent calls Synapse (Bridge as webhook)

```
HTTP Agent                          Bridge                          Synapse Mesh
     │                                │                                  │
     │──> POST /mesh/request ────────>│                                  │
     │    { agentId, skill, input }   │── request ──────────────────────>│
     │                                │<─ respond ───────────────────────│
     │<── 200 OK { result } ──────────│                                  │
     │                                │                                  │
```

### Mode 3: Bidirectional (both at once)

The bridge supports both modes simultaneously — an HTTP agent can join the mesh AND call other mesh agents through the same bridge instance.

---

## TypeScript Implementation

```typescript
// http-bridge.ts
import { Synapse, SynapseError } from "synapse-nats-sdk";
import express from "express";

interface HTTPAgentConfig {
  /** Unique ID for this HTTP agent in the mesh */
  id: string;
  /** Human-readable name */
  name: string;
  /** Base HTTP URL of the agent (e.g., "http://localhost:5000") */
  baseUrl: string;
  /** Capabilities to advertise */
  capabilities: string[];
  /** Skills this agent supports */
  skills: { id: string; name: string; description: string }[];
  /** Path template for skill calls. {skill} is replaced with skill ID. Default: "/skill/{skill}" */
  skillPath?: string;
  /** HTTP method. Default: "POST" */
  method?: "POST" | "GET";
  /** Request timeout in ms. Default: 30000 */
  timeout?: number;
}

export class HTTPBridge {
  private mesh: Synapse;
  private agents: Map<string, HTTPAgentConfig> = new Map();
  private webhookPort: number;
  private server: any;

  constructor(mesh: Synapse, webhookPort: number = 4100) {
    this.mesh = mesh;
    this.webhookPort = webhookPort;
  }

  /** Register an HTTP agent in the Synapse mesh */
  async registerAgent(config: HTTPAgentConfig): Promise<void> {
    this.agents.set(config.id, config);

    // Register on behalf of the HTTP agent using the configured ID
    // so that other agents can discover and address it by the same ID
    await this.mesh.register({
      id: config.id,
      name: config.name,
      capabilities: config.capabilities,
      skills: config.skills,
    });

    // Register handler for each skill — proxy to HTTP
    for (const skill of config.skills) {
      this.mesh.onRequest(skill.id, async (payload) => {
        return this.proxyRequest(config, skill.id, payload.input);
      });
    }

    console.log(`HTTP agent "${config.name}" (${config.id}) bridged to ${config.baseUrl}`);
  }

  /** Forward a Synapse request to the HTTP agent */
  private async proxyRequest(
    config: HTTPAgentConfig,
    skill: string,
    input: any
  ): Promise<any> {
    const skillPath = (config.skillPath || "/skill/{skill}").replace("{skill}", skill);
    const url = new URL(skillPath, config.baseUrl).toString();
    const method = config.method || "POST";
    const timeout = config.timeout || 30000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const opts: RequestInit = {
        method,
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
      };

      if (method === "POST") {
        opts.body = JSON.stringify({ skill, input });
      }

      const resp = await fetch(url, opts);

      if (!resp.ok) {
        throw new SynapseError(
          `HTTP agent returned ${resp.status}: ${resp.statusText}`,
          5001,
          resp.status >= 500
        );
      }

      const body = await resp.json();
      return body.output ?? body;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Start the webhook server so HTTP agents can call Synapse mesh */
  async startWebhook(): Promise<void> {
    const app = express();
    app.use(express.json());

    // POST /mesh/discover — discover Synapse agents
    app.post("/mesh/discover", async (req, res) => {
      try {
        const agents = await this.mesh.discover(req.body || {});
        res.json({ agents });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // POST /mesh/request — call a Synapse agent from HTTP
    app.post("/mesh/request", async (req, res) => {
      const { agentId, skill, input, timeout } = req.body;
      if (!agentId || !skill) {
        res.status(400).json({ error: "agentId and skill are required" });
        return;
      }
      try {
        const result = await this.mesh.request(agentId, skill, input, timeout);
        res.json(result.payload?.output ?? result.payload);
      } catch (err: any) {
        res.status(err.code === 3001 ? 404 : 500).json({
          error: err.message,
          code: err.code,
          retryable: err.retryable,
        });
      }
    });

    // GET /mesh/health — bridge health check
    app.get("/mesh/health", (_req, res) => {
      res.json({
        status: "ok",
        agents: Array.from(this.agents.keys()),
        connected: this.mesh.isConnected,
      });
    });

    return new Promise((resolve) => {
      this.server = app.listen(this.webhookPort, () => {
        console.log(`HTTP bridge webhook listening on port ${this.webhookPort}`);
        resolve();
      });
    });
  }

  /** Stop the webhook server */
  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    await this.mesh.close();
  }
}
```

### Example: Bridge a Flask chat agent

```typescript
// bridge-demo.ts
import Synapse from "synapse-nats-sdk";
import { HTTPBridge } from "./http-bridge.js";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");
  const bridge = new HTTPBridge(mesh, 4100);

  // Bridge an HTTP chat agent into the Synapse mesh
  await bridge.registerAgent({
    id: "flask-chat-agent",
    name: "Flask Chat Agent",
    baseUrl: "http://localhost:5000",
    capabilities: ["chat"],
    skills: [{ id: "chat", name: "Chat", description: "Chat with Flask agent" }],
  });

  // Start webhook so the Flask agent can call Synapse agents too
  await bridge.startWebhook();

  console.log("Bridge running. Flask agent is now a Synapse participant.");
  process.on("SIGINT", async () => {
    await bridge.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

The Flask agent (zero NATS code, zero knowledge of Synapse):

```python
# flask_agent.py — existing Flask app, unchanged
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route("/skill/chat", methods=["POST"])
def chat():
    data = request.get_json()
    skill = data.get("skill")          # "chat"
    inp = data.get("input", {})        # {"text": "hello"}

    # Business logic — agent doesn't know NATS exists
    response = f"Flask says: {inp.get('text', '')}"
    return jsonify({"output": {"text": response}})

if __name__ == "__main__":
    app.run(port=5000)
```

Now any Synapse agent can discover and call it:

```typescript
// From a pure Synapse agent
const agents = await mesh.discover({ capabilities: ["chat"] });
const flaskAgent = agents.find(a => a.name === "Flask Chat Agent");
const result = await mesh.request(flaskAgent.id, "chat", { text: "Hi Flask!" });
// result.payload.output = { text: "Flask says: Hi Flask!" }
```

---

## Python Implementation

```python
# http_bridge.py
import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import aiohttp
from aiohttp import web

from synapse import Synapse, connect


class HTTPAgentConfig:
    def __init__(
        self,
        id: str,
        name: str,
        base_url: str,
        capabilities: List[str],
        skills: List[Dict[str, str]],
        skill_path: str = "/skill/{skill}",
        method: str = "POST",
        timeout: float = 30.0,
    ):
        self.id = id
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.capabilities = capabilities
        self.skills = skills
        self.skill_path = skill_path
        self.method = method.upper()
        self.timeout = timeout


class HTTPBridge:
    def __init__(self, mesh: Synapse, webhook_port: int = 4100):
        self.mesh = mesh
        self.webhook_port = webhook_port
        self.agents: Dict[str, HTTPAgentConfig] = {}
        self._runner: Optional[web.AppRunner] = None

    async def register_agent(self, config: HTTPAgentConfig) -> None:
        """Register an HTTP agent in the Synapse mesh."""
        self.agents[config.id] = config

        # Register the bridge as a proxy for this HTTP agent
        # Use the configured ID so other agents can discover and address it
        await self.mesh.register(
            id=config.id,
            name=config.name,
            capabilities=config.capabilities,
            skills=config.skills,
        )

        # Register handler for each skill - proxy to HTTP
        for skill in config.skills:
            skill_id = skill["id"]
            # Capture config in closure
            def make_handler(cfg, sid):
                async def handler(payload, ctx):
                    return await self._proxy_request(cfg, sid, payload.get("input", {}))
                return handler
            self.mesh.on_request(skill_id, make_handler(config, skill_id))

        print(f'HTTP agent "{config.name}" ({config.id}) bridged to {config.base_url}')

    async def _proxy_request(self, config: HTTPAgentConfig, skill: str, input_data: Any) -> Any:
        """Forward a Synapse request to the HTTP agent."""
        skill_path = config.skill_path.replace("{skill}", skill)
        url = f"{config.base_url}{skill_path}"

        async with aiohttp.ClientSession() as session:
            timeout = aiohttp.ClientTimeout(total=config.timeout)

            if config.method == "POST":
                async with session.post(
                    url,
                    json={"skill": skill, "input": input_data},
                    timeout=timeout,
                ) as resp:
                    if resp.status >= 400:
                        raise Exception(f"HTTP agent returned {resp.status}")
                    body = await resp.json()
                    return body.get("output", body)
            else:
                async with session.get(url, timeout=timeout) as resp:
                    if resp.status >= 400:
                        raise Exception(f"HTTP agent returned {resp.status}")
                    body = await resp.json()
                    return body.get("output", body)

    async def start_webhook(self) -> None:
        """Start webhook server so HTTP agents can call Synapse."""
        app = web.Application()
        app.router.add_post("/mesh/discover", self._handle_discover)
        app.router.add_post("/mesh/request", self._handle_request)
        app.router.add_get("/mesh/health", self._handle_health)

        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "0.0.0.0", self.webhook_port)
        await site.start()
        print(f"HTTP bridge webhook listening on port {self.webhook_port}")

    async def _handle_discover(self, request: web.Request) -> web.Response:
        try:
            body = await request.json() if request.body_exists else {}
            agents = await self.mesh.discover(
                capabilities=body.get("capabilities"),
                timeout=body.get("timeout", 2.0),
            )
            agent_dicts = [
                {"id": a.id, "name": a.name, "capabilities": a.capabilities, "skills": [{"id": s.id} for s in a.skills]}
                for a in agents
            ]
            return web.json_response({"agents": agent_dicts})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_request(self, request: web.Request) -> web.Response:
        body = await request.json()
        agent_id = body.get("agentId")
        skill = body.get("skill")
        input_data = body.get("input", {})
        timeout = body.get("timeout", 30.0)

        if not agent_id or not skill:
            return web.json_response({"error": "agentId and skill are required"}, status=400)

        try:
            result = await self.mesh.request(agent_id, skill, input_data, timeout)
            output = result.payload if result.payload else None
            return web.json_response(output)
        except TimeoutError:
            return web.json_response({"error": "timeout", "code": 4001, "retryable": True}, status=504)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_health(self, request: web.Request) -> web.Response:
        return web.json_response({
            "status": "ok",
            "agents": list(self.agents.keys()),
            "connected": self.mesh.is_connected,
        })

    async def stop(self) -> None:
        if self._runner:
            await self._runner.cleanup()
        await self.mesh.close()
```

### Example: Bridge a FastAPI agent

```python
# bridge_demo.py
import asyncio
from http_bridge import HTTPBridge, HTTPAgentConfig
from synapse import connect


async def main():
    mesh = await connect("nats://localhost:4222")
    bridge = HTTPBridge(mesh, webhook_port=4100)

    await bridge.register_agent(HTTPAgentConfig(
        id="fastapi-agent",
        name="FastAPI Translator",
        base_url="http://localhost:8000",
        capabilities=["translation"],
        skills=[
            {"id": "translate", "name": "Translate", "description": "Translate text"},
        ],
    ))

    await bridge.start_webhook()
    print("Bridge running. FastAPI agent is now a Synapse participant.")

    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await bridge.stop()


if __name__ == "__main__":
    asyncio.run(main())
```

The FastAPI agent (zero NATS knowledge):

```python
# fastapi_agent.py — unchanged
from fastapi import FastAPI

app = FastAPI()

@app.post("/skill/translate")
async def translate(body: dict):
    text = body.get("input", {}).get("text", "")
    target = body.get("input", {}).get("target", "Spanish")
    # Real agent would call LLM here
    return {"output": {"translation": f"[Translated to {target}]: {text}"}}
```

---

## Webhook API Reference

### `POST /mesh/discover`

Discover Synapse agents from an HTTP context.

```bash
curl -X POST http://bridge:4100/mesh/discover \
  -H "Content-Type: application/json" \
  -d '{"capabilities": ["chat"]}'

# Response:
{
  "agents": [
    {
      "id": "bob-001",
      "name": "Bob's Agent",
      "capabilities": ["chat"],
      "skills": [{"id": "chat"}]
    }
  ]
}
```

### `POST /mesh/request`

Call a Synapse agent from HTTP.

```bash
curl -X POST http://bridge:4100/mesh/request \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "bob-001",
    "skill": "chat",
    "input": {"text": "Hello Bob!"},
    "timeout": 30.0
  }'

# Response:
{
  "output": {"text": "Bob says: I got your message! You said \"Hello Bob!\""}
}
```

### `GET /mesh/health`

```bash
curl http://bridge:4100/mesh/health

# Response:
{"status": "ok", "agents": ["flask-chat-agent"], "connected": true}
```

---

## HTTP Agent Contract

To be bridged into Synapse, an HTTP agent must expose a single endpoint that:

1. **Accepts POST** with JSON body: `{"skill": "skill-id", "input": {...}}`
2. **Returns JSON** with either:
   - `{"output": {...}}` — the skill result
   - Or any JSON body (treated as the output directly if no `output` key)
3. **Returns HTTP errors** on failure:
   - `4xx` → Synapse error code 3001+ (non-retryable)
   - `5xx` → Synapse error code 5001+ (retryable)

The path is configurable per skill via `skillPath` (default: `/skill/{skill}`).

### No changes needed if your agent already:

- Has a POST endpoint per skill
- Returns JSON
- Handles request timeouts gracefully

If your agent uses a different contract, configure `skillPath` and `method` to match.

---

## Multi-Agent Bridge

Bridge multiple HTTP agents through a single bridge instance:

```typescript
const bridge = new HTTPBridge(mesh, 4100);

await bridge.registerAgent({
  id: "chat-agent", name: "Chat", baseUrl: "http://localhost:5001",
  capabilities: ["chat"], skills: [{ id: "chat", ... }],
});

await bridge.registerAgent({
  id: "translate-agent", name: "Translator", baseUrl: "http://localhost:5002",
  capabilities: ["translation"], skills: [{ id: "translate", ... }],
});

await bridge.registerAgent({
  id: "code-review-agent", name: "Code Reviewer", baseUrl: "http://localhost:5003",
  capabilities: ["code.review"], skills: [{ id: "code-review", ... }],
});

await bridge.startWebhook();
// All three HTTP agents are now Synapse participants
```

---

## Advanced: Custom Request Transformation

Override `_proxyRequest` (TS) or `_proxy_request` (Python) to transform requests for agents with non-standard contracts:

```typescript
// Example: bridge a GraphQL agent
protected async proxyRequest(config, skill, input) {
  const query = input.query;
  const resp = await fetch(config.baseUrl + "/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: input.variables }),
  });
  const data = await resp.json();
  return data.data; // GraphQL wraps in "data"
}
```

```python
# Example: bridge a gRPC-over-HTTP agent
async def _proxy_request(self, config, skill, input_data):
    url = f"{config.base_url}/{config.service}/{skill}"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json=input_data) as resp:
            return await resp.json()
```

---

## Security

### Token Auth

Add a shared secret to protect the webhook:

```typescript
const AUTH_TOKEN = process.env.BRIDGE_TOKEN || "secret";

app.post("/mesh/request", async (req, res) => {
  if (req.headers["authorization"] !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // ... handle request
});
```

### Network Isolation

Run the bridge on an internal network. Only HTTP agents on the same network can call the webhook:

```
┌────────────────────────────────────────────┐
│           Internal Docker Network           │
│                                            │
│  Synapse Mesh (NATS:4222)                  │
│       │                                    │
│       └──> Bridge (bridge:4100)            │
│              │                             │
│              ├── HTTP Agent A (agent-a:5000)│
│              └── HTTP Agent B (agent-b:5001)│
│                                            │
└────────────────────────────────────────────┘
```

---

## Next Steps

- [CLI Guide](./cli-guide.md) — Pure CLI agents
- [TypeScript SDK](./typescript.md) — Full TypeScript integration
- [Python SDK](./python.md) — Full Python integration
- [Security](./security.md) — NKeys, JWT, TLS
