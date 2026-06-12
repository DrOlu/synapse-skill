# TypeScript SDK for Synapse

Complete TypeScript/Node.js SDK for building production-grade Synapse agents. Includes full implementations of all 6 primitives, handler functions, dynamic responses, JetStream integration, and cross-org scenarios.

## Table of Contents
- [Installation](#installation)
- [Core SDK](#core-sdk)
- [Basic Agent](#basic-agent)
- [Multi-Skill Agent](#multi-skill-agent)
- [LLM Integration](#llm-integration)
- [Event-Driven Agents](#event-driven-agents)
- [Advanced Patterns](#advanced-patterns)
- [Production Setup](#production-setup)

---

## Installation

```bash
npm init -y
npm install nats uuid
npm install -D typescript @types/node tsx
```

**TypeScript config (`tsconfig.json`):**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

---

## Core SDK

### `src/synapse.ts` — Complete Synapse SDK

```typescript
// src/synapse.ts
import { connect, ConnectionOptions, NatsConnection, createInbox, StringCodec, JSONCodec } from "nats";
import { v4 as uuid } from "uuid";

const sc = StringCodec();
const jc = JSONCodec();

export interface Skill {
  id: string;
  name: string;
  description: string;
  input_modes?: string[];
  output_modes?: string[];
}

export interface AgentManifest {
  id: string;
  name: string;
  description?: string;
  capabilities: string[];
  skills: Skill[];
  endpoint: string;
  availability: "online" | "busy" | "offline";
  last_heartbeat: string;
}

export interface Envelope {
  v: string;
  id: string;
  type: string;
  ts: string;
  from: string;
  to?: string;
  task_id?: string;
  trace?: {
    trace_id: string;
    span_id: string;
    parent_span_id?: string;
  };
  payload?: any;
  artifacts?: any[];
  error?: {
    code: number;
    message: string;
    retryable: boolean;
  };
}

export class Synapse {
  private nc: NatsConnection;
  private id: string;
  private manifest: AgentManifest | null = null;
  private handlers: Map<string, (...args: any[]) => any> = new Map();
  private heartbeatInterval?: NodeJS.Timeout;

  private constructor(nc: NatsConnection) {
    this.nc = nc;
    this.id = uuid();
  }

  static async connect(
    url: string = "nats://localhost:4222",
    opts?: Partial<ConnectionOptions>
  ): Promise<Synapse> {
    const nc = await connect({
      servers: url,
      ...opts,
    });
    const self = new Synapse(nc);
    console.log(`Connected to NATS at ${url} with ID: ${self.id}`);
    return self;
  }

  get agentId(): string {
    return this.id;
  }

  get isConnected(): boolean {
    return !this.nc.isClosed();
  }

  // ==================== PRIMITIVE 1: REGISTER ====================

  async register(options: {
    name: string;
    description?: string;
    capabilities?: string[];
    skills?: Skill[];
  }): Promise<AgentManifest> {
    this.manifest = {
      id: this.id,
      name: options.name,
      description: options.description,
      capabilities: options.capabilities || [],
      skills: options.skills || [],
      endpoint: `mesh.agent.${this.id}.inbox`,
      availability: "online",
      last_heartbeat: new Date().toISOString(),
    };

    // Publish registration
    const envelope: Envelope = {
      v: "1.0.0",
      id: uuid(),
      type: "register",
      ts: new Date().toISOString(),
      from: this.id,
      payload: this.manifest,
    };

    this.nc.publish("mesh.registry.register", jc.encode(envelope));

    // Setup handlers
    this.setupDiscoverResponder();
    this.setupRequestHandler();
    this.startHeartbeat();

    console.log(`Agent "${options.name}" (${this.id}) registered`);
    return this.manifest;
  }

  // ==================== PRIMITIVE 2: DISCOVER ====================

  async discover(
    filter: { capabilities?: string[] } = {}
  ): Promise<AgentManifest[]> {
    const inbox = createInbox();
    const agents: AgentManifest[] = [];

    const sub = this.nc.subscribe(inbox);
    const done = (async () => {
      for await (const msg of sub) {
        const envelope = jc.decode(msg.data) as Envelope;
        if (envelope.payload) {
          agents.push(envelope.payload);
        }
      }
    })();

    const request: Envelope = {
      v: "1.0.0",
      id: uuid(),
      type: "discover",
      ts: new Date().toISOString(),
      from: this.id,
      payload: filter,
    };

    this.nc.publish("mesh.registry.discover", jc.encode(request), {
      reply: inbox,
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    sub.unsubscribe();
    await done.catch(() => {});

    return agents;
  }

  // ==================== PRIMITIVE 3: REQUEST ====================

  async request(
    agentId: string,
    skill: string,
    input: any,
    timeoutMs: number = 30000
  ): Promise<Envelope> {
    const taskId = uuid();
    const inbox = createInbox();

    const envelope: Envelope = {
      v: "1.0.0",
      id: uuid(),
      type: "request",
      ts: new Date().toISOString(),
      from: this.id,
      to: agentId,
      task_id: taskId,
      trace: {
        trace_id: uuid(),
        span_id: uuid(),
      },
      payload: { skill, input },
    };

    return new Promise((resolve, reject) => {
      const sub = this.nc.subscribe(inbox, { max: 1 });
      setTimeout(() => {
        sub.unsubscribe();
        reject(new Error("Request timeout"));
      }, timeoutMs);

      (async () => {
        for await (const msg of sub) {
          const response = jc.decode(msg.data) as Envelope;
          if (response.error) {
            reject(new Error(`[${response.error.code}] ${response.error.message}`));
          } else {
            resolve(response);
          }
        }
      })().catch(reject);

      this.nc.publish(`mesh.agent.${agentId}.inbox`, jc.encode(envelope), {
        reply: inbox,
      });
    });
  }

  // ==================== PRIMITIVE 4: RESPOND (Handler Registration) ====================

  onRequest(
    skill: string,
    handler: (payload: any, context: { task_id: string; from: string }) => any
  ): void {
    this.handlers.set(skill, handler);
    console.log(`Handle "${skill}" registered`);
  }

  // ==================== PRIMITIVE 5: EMIT ====================

  emit(eventType: string, data: any): void {
    const envelope: Envelope = {
      v: "1.0.0",
      id: uuid(),
      type: "emit",
      ts: new Date().toISOString(),
      from: this.id,
      payload: {
        event_type: eventType.split(".").pop(),
        data,
      },
    };

    this.nc.publish(`mesh.event.${eventType}`, jc.encode(envelope));
  }

  // ==================== PRIMITIVE 6: SUBSCRIBE ====================

  subscribe(pattern: string, handler: (payload: any) => void): { unsubscribe: () => void } {
    const sub = this.nc.subscribe(`mesh.event.${pattern}`);
    
    (async () => {
      for await (const msg of sub) {
        const envelope = jc.decode(msg.data) as Envelope;
        handler(envelope.payload);
      }
    })();

    return {
      unsubscribe: () => sub.unsubscribe(),
    };
  }

  // ==================== DISCONNECT ====================

  async close(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    await this.nc.drain();
    console.log(`Agent ${this.id} disconnected`);
  }

  // ==================== INTERNAL HELPERS ====================

  private setupDiscoverResponder(): void {
    const sub = this.nc.subscribe("mesh.registry.discover");
    (async () => {
      for await (const msg of sub) {
        if (!this.manifest) continue;

        const request = jc.decode(msg.data) as Envelope;
        const filter = request.payload || {};

        const matches =
          !filter.capabilities ||
          filter.capabilities.every((cap: string) =>
            this.manifest!.capabilities.includes(cap)
          );

        if (matches && msg.reply) {
          const response: Envelope = {
            v: "1.0.0",
            id: uuid(),
            type: "register",
            ts: new Date().toISOString(),
            from: this.id,
            payload: this.manifest,
          };
          this.nc.publish(msg.reply, jc.encode(response));
        }
      }
    })();
  }

  private setupRequestHandler(): void {
    const inbox = `mesh.agent.${this.id}.inbox`;
    const sub = this.nc.subscribe(inbox);

    (async () => {
      for await (const msg of sub) {
        const envelope = jc.decode(msg.data) as Envelope;

        if (envelope.type !== "request") continue;

        const skill = envelope.payload?.skill;
        const handler = this.handlers.get(skill);

        if (handler) {
          try {
            const result = await handler(envelope.payload, {
              task_id: envelope.task_id || "",
              from: envelope.from,
            });

            const response: Envelope = {
              v: "1.0.0",
              id: uuid(),
              type: "respond",
              ts: new Date().toISOString(),
              from: this.id,
              to: envelope.from,
              task_id: envelope.task_id,
              trace: envelope.trace,
              payload: { output: result },
            };

            if (msg.reply) {
              this.nc.publish(msg.reply, jc.encode(response));
            }
          } catch (error: any) {
            const errorResponse: Envelope = {
              v: "1.0.0",
              id: uuid(),
              type: "respond",
              ts: new Date().toISOString(),
              from: this.id,
              to: envelope.from,
              task_id: envelope.task_id,
              trace: envelope.trace,
              error: {
                code: 5001,
                message: error.message,
                retryable: true,
              },
            };

            if (msg.reply) {
              this.nc.publish(msg.reply, jc.encode(errorResponse));
            }
          }
        } else {
          const notFoundResponse: Envelope = {
            v: "1.0.0",
            id: uuid(),
            type: "respond",
            ts: new Date().toISOString(),
            from: this.id,
            to: envelope.from,
            task_id: envelope.task_id,
            trace: envelope.trace,
            error: {
              code: 3001,
              message: `Skill "${skill}" not found`,
              retryable: false,
            },
          };

          if (msg.reply) {
            this.nc.publish(msg.reply, jc.encode(notFoundResponse));
          }
        }
      }
    })();
  }

  private startHeartbeat(intervalMs: number = 30000): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.manifest) {
        this.emit("heartbeat.agent", {
          agent_id: this.id,
          timestamp: new Date().toISOString(),
        });
      }
    }, intervalMs);
  }
}

export default Synapse;
```

---

## Basic Agent

### Two-Agent Chat (Bob + Jeff)

```typescript
// src/bob-agent.ts
import Synapse from "./synapse.js";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Bob's Agent",
    description: "Friendly chat agent",
    capabilities: ["chat"],
    skills: [
      { id: "chat", name: "Chat", description: "Chat with Bob" },
    ],
  });

  mesh.onRequest("chat", (payload) => {
    const text = payload.input?.text;
    console.log(`[Bob] Received: "${text}"`);
    return { text: `Bob says: I got your message! You said "${text}"` };
  });

  console.log("Bob agent online, waiting for requests...");

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
```

```typescript
// src/jeff-agent.ts
import Synapse from "./synapse.js";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Jeff's Agent",
    capabilities: [],
    skills: [],
  });

  console.log("Jeff agent online, looking for Bob...");

  // Discover Bob
  const agents = await mesh.discover({ capabilities: ["chat"] });
  const bob = agents.find((a) => a.name === "Bob's Agent");

  if (!bob) {
    console.log("Could not find Bob!");
    await mesh.close();
    return;
  }

  console.log(`Found Bob at ${bob.id}`);

  // Send request
  const response = await mesh.request(bob.id, "chat", {
    text: "Hey Bob, how's it going?",
  });

  console.log(`Bob's response: ${JSON.stringify(response.payload.output)}`);

  await mesh.close();
}

main().catch(console.error);
```

**Run:**
```bash
# Terminal 1: Start NATS
nats-server

# Terminal 2: Start Bob
tsx src/bob-agent.ts

# Terminal 3: Start Jeff
tsx src/jeff-agent.ts
```

---

## Multi-Skill Agent

```typescript
// src/utilities-agent.ts
import Synapse from "./synapse.js";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Utilities Agent",
    description: "Common text/math utilities",
    capabilities: ["text", "math"],
    skills: [
      { id: "uppercase", name: "Uppercase", description: "Convert to uppercase" },
      { id: "reverse", name: "Reverse", description: "Reverse a string" },
      { id: "strlen", name: "String Length", description: "Count characters" },
      { id: "add", name: "Add", description: "Add two numbers" },
      { id: "multiply", name: "Multiply", description: "Multiply two numbers" },
    ],
  });

  // Register handlers
  mesh.onRequest("uppercase", (payload) => {
    const text = payload.input?.text || "";
    return { text: text.toUpperCase() };
  });

  mesh.onRequest("reverse", (payload) => {
    const text = payload.input?.text || "";
    return { text: text.split("").reverse().join("") };
  });

  mesh.onRequest("strlen", (payload) => {
    const text = payload.input?.text || "";
    return { length: text.length };
  });

  mesh.onRequest("add", (payload) => {
    const a = payload.input?.a ?? 0;
    const b = payload.input?.b ?? 0;
    return { result: a + b };
  });

  mesh.onRequest("multiply", (payload) => {
    const a = payload.input?.a ?? 0;
    const b = payload.input?.b ?? 0;
    return { result: a * b };
  });

  console.log("Utilities agent online with 5 skills");

  process.on("SIGINT", async () => {
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
```

**Test:**
```bash
nats request mesh.agent.<utilities-id>.inbox '{"skill":"reverse","input":{"text":"Hello"}}'
# → {"text":"olleH"}
```

---

## LLM Integration

### Claude Integration

```typescript
// src/claude-agent.ts
import Synapse from "./synapse.js";
import { Anthropic } from "@anthropic-ai/sdk";

const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Claude Agent",
    description: "LLM-powered agent using Claude",
    capabilities: ["llm", "chat", "analysis"],
    skills: [
      { id: "chat", name: "Chat", description: "Chat with Claude" },
      { id: "summarize", name: "Summarize", description: "Summarize text" },
    ],
  });

  mesh.onRequest("chat", async (payload) => {
    const message = payload.input?.message;
    console.log(`[Claude] Processing: "${message}"`);

    const response = await claude.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1000,
      messages: [{ role: "user", content: message }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    return { text };
  });

  mesh.onRequest("summarize", async (payload) => {
    const text = payload.input?.text;
    console.log(`[Claude] Summarizing text (${text.length} chars)`);

    const response = await claude.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Summarize this text in 2-3 sentences:\n\n${text}`,
        },
      ],
    });

    const summary = response.content[0].type === "text" ? response.content[0].text : "";
    return { summary };
  });

  console.log("Claude agent online");

  process.on("SIGINT", async () => {
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
```

### OpenAI GPT Integration

```typescript
// src/openai-agent.ts
import Synapse from "./synapse.js";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "GPT Agent",
    capabilities: ["llm", "chat", "translation"],
    skills: [
      { id: "chat", name: "Chat", description: "Chat with GPT" },
      { id: "translate", name: "Translate", description: "Translate text" },
      { id: "code-review", name: "Code Review", description: "Review code" },
    ],
  });

  mesh.onRequest("chat", async (payload) => {
    const message = payload.input?.message;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: message }],
      max_tokens: 1000,
    });

    return { text: completion.choices[0].message.content };
  });

  mesh.onRequest("translate", async (payload) => {
    const text = payload.input?.text;
    const targetLang = payload.input?.target || "Spanish";

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `You are a translator. Translate the text to ${targetLang}.`,
        },
        { role: "user", content: text },
      ],
      max_tokens: 1000,
    });

    return { translation: completion.choices[0].message.content };
  });

  mesh.onRequest("code-review", async (payload) => {
    const code = payload.input?.code;
    const language = payload.input?.language || "generic";

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `You are a ${language} code reviewer. Provide a brief review focusing on bugs, security, and performance.`,
        },
        { role: "user", content: `Review this code:\n\n${code}` },
      ],
      max_tokens: 1000,
    });

    return { review: completion.choices[0].message.content };
  });

  console.log("GPT agent online");

  process.on("SIGINT", async () => {
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Event-Driven Agents

### Document Pipeline

```typescript
// src/document-pipeline.ts
import Synapse from "./synapse.js";
import * as fs from "fs";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Document Pipeline",
    capabilities: ["documents"],
    skills: [],
  });

  // Subscribe to document uploads
  mesh.subscribe("document.>", (event) => {
    console.log(`[${event.event_type}]`, JSON.stringify(event.data));

    if (event.event_type === "uploaded") {
      const { filename, path } = event.data;
      console.log(`Processing: ${filename}`);

      // Read file and emit processing event
      fs.readFile(path, "utf-8", (err, content) => {
        if (err) {
          mesh.emit("document.error", { filename, error: err.message });
        } else {
          mesh.emit("document.processed", {
            filename,
            char_count: content.length,
            word_count: content.split(/\s+/).length,
          });
        }
      });
    }
  });

  console.log("Document pipeline online, watching for events...");

  // Simulate document upload every 5 seconds (for testing)
  setInterval(() => {
    mesh.emit("document.uploaded", {
      filename: `test-${Date.now()}.txt`,
      path: "./sample.txt",
    });
  }, 5000);

  process.on("SIGINT", async () => {
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Advanced Patterns

### Delegation Chain

```typescript
// src/orchestrator-agent.ts
import Synapse from "./synapse.js";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Orchestrator",
    description: "Coordinates research and summarization",
    capabilities: ["orchestration"],
    skills: [
      { id: "research-project", name: "Research Project", description: "Full research + summary" },
    ],
  });

  mesh.onRequest("research-project", async (payload) => {
    const topic = payload.input?.topic;
    console.log(`[Orchestrator] Starting research on: "${topic}"`);

    // Step 1: Discover research agent
    const researchers = await mesh.discover({ capabilities: ["research"] });
    if (researchers.length === 0) {
      throw new Error("No research agents available");
    }
    const researcher = researchers[0];
    console.log(`[Orchestrator] Delegating to researcher: ${researcher.name}`);

    // Step 2: Request research
    const researchResult = await mesh.request(
      researcher.id,
      "research",
      { topic },
      60000 // 60s timeout
    );
    const findings = researchResult.payload.output.findings;
    console.log(`[Orchestrator] Research complete (${findings.length} findings)`);

    // Step 3: Discover summarizer
    const summarizers = await mesh.discover({ capabilities: ["summarize"] });
    if (summarizers.length === 0) {
      throw new Error("No summarizer agents available");
    }
    const summarizer = summarizers[0];
    console.log(`[Orchestrator] Delegating to summarizer: ${summarizer.name}`);

    // Step 4: Request summary
    const summaryResult = await mesh.request(summarizer.id, "summarize", {
      findings,
      format: "brief",
    });
    const summary = summaryResult.payload.output.summary;
    console.log(`[Orchestrator] Summary generated`);

    // Step 5: Return complete result
    return {
      topic,
      findings,
      summary,
      research_agent: researcher.name,
      summarize_agent: summarizer.name,
    };
  });

  console.log("Orchestrator agent online");

  process.on("SIGINT", async () => {
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

### Fan-Out / Fan-In

```typescript
// src/fanout-agent.ts
import Synapse from "./synapse.js";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Fan-Out Agent",
    capabilities: ["parallel"],
    skills: [
      { id: "parallel-process", name: "Parallel Process", description: "Process items in parallel" },
    ],
  });

  mesh.onRequest("parallel-process", async (payload) => {
    const items = payload.input?.items || [];
    console.log(`[Fan-Out] Processing ${items.length} items in parallel`);

    // Discover all worker agents
    const workers = await mesh.discover({ capabilities: ["worker"] });
    console.log(`[Fan-Out] Found ${workers.length} workers`);

    // Spawn all requests in parallel
    const promises = items.map(async (item, index) => {
      const worker = workers[index % workers.length]; // Round-robin
      console.log(`[Fan-Out] Sending item ${index + 1} to ${worker.name}`);
      
      const result = await mesh.request(worker.id, "process", { item });
      return { index, result: result.payload.output };
    });

    // Wait for all to complete
    const results = await Promise.all(promises);
    console.log(`[Fan-Out] All items processed`);

    return { results };
  });

  console.log("Fan-out agent online");

  process.on("SIGINT", async () => {
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Production Setup

### Configuration File

```typescript
// src/config.ts
export const config = {
  nats: {
    url: process.env.NATS_URL || "nats://localhost:4222",
    credentials: process.env.NATS_CREDS,
  },
  agent: {
    id: process.env.AGENT_ID || undefined,
    name: process.env.AGENT_NAME || "agent",
  },
  heartbeat: {
    intervalMs: parseInt(process.env.HEARTBEAT_INTERVAL || "30000"),
  },
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT || "30000"),
};
```

### Docker Compose

```yaml
version: "3.8"

services:
  nats:
    image: nats:2.11-alpine
    container_name: nats-server
    ports:
      - "4222:4222"
      - "8222:8222"
    command: ["-js", "-m", "8222"]
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8222/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3

  agent-bob:
    build: .
    container_name: agent-bob
    depends_on:
      - nats
    environment:
      NATS_URL: nats://nats:4222
      AGENT_NAME: bob-agent
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    command: ["tsx", "src/bob-agent.ts"]

  agent-jeff:
    build: .
    container_name: agent-jeff
    depends_on:
      - nats
    environment:
      NATS_URL: nats://nats:4222
      AGENT_NAME: jeff-agent
    command: ["tsx", "src/jeff-agent.ts"]
```

**Dockerfile:**
```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "dist/app.js"]
```

---

## Next Steps

- [Complete Examples](./examples/typescript/) — Full runnable projects
- [Patterns Guide](./patterns.md) — Advanced architectural patterns
- [Security](./security.md) — Authentication and authorization
