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
- [JavaScript ESM (copy-paste ready)](#javascript-esm-copy-paste-ready)
- [Known Limitations](#known-limitations)

---

## Installation

```bash
# Option 1: Install from npm (recommended)
npm install synapse-nats-sdk

# Option 2: Copy synapse.ts from examples/ into your project
# (the full SDK file is self-contained — just import Synapse from "./synapse.js")

# Dev dependencies (if using Option 1 or 2 with TypeScript)
npm install -D typescript @types/node tsx
```

### Usage

```typescript
// Node.js / Bun (TCP transport)
import Synapse from "synapse-nats-sdk";

// Browser (WebSocket transport)
import Synapse from "synapse-nats-sdk/browser";

// HTTP Bridge (server-side only)
import { HttpBridge } from "synapse-nats-sdk/http-bridge";
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

// ==================== TYPES ====================

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

export interface DiscoverFilter {
  capabilities?: string[];
  skill_ids?: string[];
  availability?: string;
}

// ==================== ERROR CLASS ====================

export class SynapseError extends Error {
  readonly code: number;
  readonly retryable: boolean;

  constructor(message: string, code: number, retryable: boolean) {
    super(message);
    this.name = "SynapseError";
    this.code = code;
    this.retryable = retryable;
    // Maintain proper prototype chain in compiled JS
    Object.setPrototypeOf(this, SynapseError.prototype);
  }
}

// ==================== RETRY HELPER ====================

/**
 * Retry an async function with exponential back-off.
 * @param fn        The async function to attempt.
 * @param maxRetries Maximum number of retries (default 3). Pass 0 for no retry.
 * @param baseMs    Base delay in ms before first retry (doubles each attempt, default 100).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseMs: number = 100
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Don't retry non-retryable SynapseErrors
      if (err instanceof SynapseError && !err.retryable) throw err;
      if (attempt < maxRetries) {
        const delay = baseMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ==================== SYNAPSE CLASS ====================

export class Synapse {
  private nc: NatsConnection;
  private id: string;
  private manifest: AgentManifest | null = null;
  private handlers: Map<string, (...args: any[]) => any> = new Map();
  private streamHandlers: Map<string, (payload: any, ctx: { task_id: string; from: string }) => AsyncGenerator<any>> = new Map();
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
      // Auto-reconnect: retry indefinitely with 2 s wait between attempts
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
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

  /** True once register() has been called and deregister() has not. */
  get isRegistered(): boolean {
    return this.manifest !== null;
  }

  // ==================== PRIMITIVE 1: REGISTER ====================

  async register(options: {
    name: string;
    description?: string;
    capabilities?: string[];
    skills?: Skill[];
    id?: string;
  }): Promise<AgentManifest> {
    // Allow caller to specify a stable agent ID (e.g., for HTTP bridge proxying)
    if (options.id) {
      this.id = options.id;
    }
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

    const envelope: Envelope = {
      v: "1.0.0",
      id: uuid(),
      type: "register",
      ts: new Date().toISOString(),
      from: this.id,
      payload: this.manifest,
    };

    this.nc.publish("mesh.registry.register", jc.encode(envelope));

    this._setupDiscoverResponder();
    this._setupRequestHandler();
    this._startHeartbeat();

    console.log(`Agent "${options.name}" (${this.id}) registered`);
    return this.manifest;
  }

  // ==================== DEREGISTER ====================

  /**
   * Gracefully remove this agent from the mesh registry.
   * Called automatically by close(); can also be called independently.
   */
  async deregister(): Promise<void> {
    if (!this.manifest) return;

    const envelope: Envelope = {
      v: "1.0.0",
      id: uuid(),
      type: "deregister",
      ts: new Date().toISOString(),
      from: this.id,
      payload: { id: this.id },
    };

    this.nc.publish("mesh.registry.deregister", jc.encode(envelope));
    this.manifest = null;
    console.log(`Agent ${this.id} deregistered`);
  }

  // ==================== PRIMITIVE 2: DISCOVER ====================

  /**
   * Broadcast a discover request and collect responses within a time window.
   *
   * @param filter   Optional filter: capabilities, skill_ids, availability.
   * @param windowMs How long to wait for responses (default 2000 ms).
   */
  async discover(
    filter: DiscoverFilter = {},
    windowMs: number = 2000
  ): Promise<AgentManifest[]> {
    const inbox = createInbox();
    const seen = new Set<string>();
    const agents: AgentManifest[] = [];

    const sub = this.nc.subscribe(inbox);
    const done = (async () => {
      for await (const msg of sub) {
        const envelope = jc.decode(msg.data) as Envelope;
        const manifest: AgentManifest | undefined = envelope.payload;
        if (!manifest) continue;

        // Client-side deduplication
        if (seen.has(manifest.id)) continue;

        // Client-side capability filter
        if (
          filter.capabilities &&
          !filter.capabilities.every((c) => manifest.capabilities.includes(c))
        ) continue;

        // Client-side skill_ids filter
        if (filter.skill_ids) {
          const agentSkillIds = manifest.skills.map((s) => s.id);
          if (!filter.skill_ids.every((sid) => agentSkillIds.includes(sid))) continue;
        }

        // Client-side availability filter
        if (filter.availability && manifest.availability !== filter.availability) continue;

        seen.add(manifest.id);
        agents.push(manifest);
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

    await new Promise((resolve) => setTimeout(resolve, windowMs));
    sub.unsubscribe();
    await done.catch(() => {});

    return agents;
  }

  // ==================== PRIMITIVE 3: REQUEST ====================

  /**
   * Send a skill request to a specific agent and await its response.
   * Throws SynapseError on application-level errors so callers can inspect
   * `code` and `retryable`.
   */
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

      const timer = setTimeout(() => {
        sub.unsubscribe();
        reject(new SynapseError("Request timeout", 4001, true));
      }, timeoutMs);

      (async () => {
        for await (const msg of sub) {
          clearTimeout(timer);
          const response = jc.decode(msg.data) as Envelope;
          if (response.error) {
            reject(
              new SynapseError(
                response.error.message,
                response.error.code,
                response.error.retryable
              )
            );
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
    console.log(`Handler "${skill}" registered`);
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
    // Publish deregister before draining so peers learn we're gone
    await this.deregister();
    await this.nc.drain();
    console.log(`Agent ${this.id} disconnected`);
  }

  // ==================== INTERNAL HELPERS ====================

  private _setupDiscoverResponder(): void {
    const sub = this.nc.subscribe("mesh.registry.discover");
    (async () => {
      for await (const msg of sub) {
        if (!this.manifest) continue;

        const req = jc.decode(msg.data) as Envelope;
        const filter: DiscoverFilter = req.payload || {};

        // Server-side pre-filter (mirrors client-side logic for efficiency)
        if (
          filter.capabilities &&
          !filter.capabilities.every((c: string) =>
            this.manifest!.capabilities.includes(c)
          )
        ) continue;

        if (filter.skill_ids) {
          const agentSkillIds = this.manifest.skills.map((s) => s.id);
          if (!filter.skill_ids.every((sid: string) => agentSkillIds.includes(sid))) continue;
        }

        if (filter.availability && this.manifest.availability !== filter.availability) continue;

        if (msg.reply) {
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

  private _setupRequestHandler(): void {
    const inbox = `mesh.agent.${this.id}.inbox`;
    const sub = this.nc.subscribe(inbox);

    (async () => {
      for await (const msg of sub) {
        const envelope = jc.decode(msg.data) as Envelope;

        if (envelope.type !== "request") continue;

        const skill = envelope.payload?.skill;
        const handler = this.handlers.get(skill);

        if (handler) {
          // Check if this is a streaming request
          if (envelope.payload?.stream && this.streamHandlers.has(skill)) {
            const streamHandler = this.streamHandlers.get(skill)!;
            const streamSubject = `mesh.task.${envelope.task_id}.stream`;
            let seq = 0;
            try {
              for await (const chunk of streamHandler(envelope.payload, {
                task_id: envelope.task_id || "",
                from: envelope.from,
              })) {
                this.nc.publish(streamSubject, jc.encode({ seq: seq++, chunk, done: false }));
              }
              this.nc.publish(streamSubject, jc.encode({ seq: seq++, chunk: {}, done: true }));
            } catch (error: any) {
              this.nc.publish(streamSubject, jc.encode({
                seq: seq++, chunk: {}, done: true,
                error: { code: 5001, message: error.message, retryable: true }
              }));
            }
            continue; // don't fall through to regular handler
          }

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

  private _startHeartbeat(intervalMs: number = 30000): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.manifest) {
        // Publish heartbeat envelope (consistent with Python/Go SDKs)
        const heartbeat: Envelope = {
          v: "1.0.0",
          id: uuid(),
          type: "heartbeat",
          ts: new Date().toISOString(),
          from: this.id,
          payload: {
            agent_id: this.id,
            timestamp: new Date().toISOString(),
          },
        };
        this.nc.publish(
          `mesh.heartbeat.${this.id}`,
          jc.encode(heartbeat)
        );
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

---

## JavaScript ESM (copy-paste ready)

No TypeScript toolchain required. Save as `synapse.mjs` and import directly with Node 18+.

```javascript
// synapse.mjs
import { connect, createInbox, JSONCodec, StringCodec } from "nats";
import { v4 as uuid } from "uuid";

const jc = JSONCodec();
const sc = StringCodec();

// ==================== SynapseError ====================

export class SynapseError extends Error {
  constructor(message, code, retryable) {
    super(message);
    this.name = "SynapseError";
    this.code = code;
    this.retryable = retryable;
  }
}

// ==================== retryWithBackoff ====================

export async function retryWithBackoff(fn, maxRetries = 3, baseMs = 100) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err instanceof SynapseError && !err.retryable) throw err;
      if (attempt < maxRetries) {
        const delay = baseMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ==================== Synapse ====================

export class Synapse {
  #nc;
  #id;
  #manifest = null;
  #handlers = new Map();
  #streamHandlers = new Map();
  #heartbeatInterval;

  constructor(nc) {
    this.#nc = nc;
    this.#id = uuid();
  }

  static async connect(url = "nats://localhost:4222", opts = {}) {
    const nc = await connect({
      servers: url,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
      ...opts,
    });
    const self = new Synapse(nc);
    console.log(`Connected to NATS at ${url} with ID: ${self.agentId}`);
    return self;
  }

  get agentId() { return this.#id; }
  get isConnected() { return !this.#nc.isClosed(); }
  get isRegistered() { return this.#manifest !== null; }

  // ---- register ----

  async register({ name, description, capabilities = [], skills = [], id }) {
    // Allow caller to specify a stable agent ID (e.g., for HTTP bridge proxying)
    if (id) {
      this.#id = id;
    }
    this.#manifest = {
      id: this.#id,
      name,
      description,
      capabilities,
      skills,
      endpoint: `mesh.agent.${this.#id}.inbox`,
      availability: "online",
      last_heartbeat: new Date().toISOString(),
    };

    this.#nc.publish("mesh.registry.register", jc.encode({
      v: "1.0.0", id: uuid(), type: "register",
      ts: new Date().toISOString(), from: this.#id,
      payload: this.#manifest,
    }));

    this.#setupDiscoverResponder();
    this.#setupRequestHandler();
    this.#startHeartbeat();

    console.log(`Agent "${name}" (${this.#id}) registered`);
    return this.#manifest;
  }

  // ---- deregister ----

  async deregister() {
    if (!this.#manifest) return;
    this.#nc.publish("mesh.registry.deregister", jc.encode({
      v: "1.0.0", id: uuid(), type: "deregister",
      ts: new Date().toISOString(), from: this.#id,
      payload: { id: this.#id },
    }));
    this.#manifest = null;
    console.log(`Agent ${this.#id} deregistered`);
  }

  // ---- discover ----

  async discover(filter = {}, windowMs = 2000) {
    const inbox = createInbox();
    const seen = new Set();
    const agents = [];

    const sub = this.#nc.subscribe(inbox);
    const done = (async () => {
      for await (const msg of sub) {
        const envelope = jc.decode(msg.data);
        const manifest = envelope.payload;
        if (!manifest) continue;
        if (seen.has(manifest.id)) continue;

        if (filter.capabilities &&
          !filter.capabilities.every((c) => manifest.capabilities.includes(c)))
          continue;

        if (filter.skill_ids) {
          const agentSkillIds = manifest.skills.map((s) => s.id);
          if (!filter.skill_ids.every((sid) => agentSkillIds.includes(sid))) continue;
        }

        if (filter.availability && manifest.availability !== filter.availability) continue;

        seen.add(manifest.id);
        agents.push(manifest);
      }
    })();

    this.#nc.publish("mesh.registry.discover", jc.encode({
      v: "1.0.0", id: uuid(), type: "discover",
      ts: new Date().toISOString(), from: this.#id,
      payload: filter,
    }), { reply: inbox });

    await new Promise((r) => setTimeout(r, windowMs));
    sub.unsubscribe();
    await done.catch(() => {});
    return agents;
  }

  // ---- request ----

  async request(agentId, skill, input, timeoutMs = 30000) {
    const taskId = uuid();
    const inbox = createInbox();

    const envelope = {
      v: "1.0.0", id: uuid(), type: "request",
      ts: new Date().toISOString(), from: this.#id, to: agentId,
      task_id: taskId,
      trace: { trace_id: uuid(), span_id: uuid() },
      payload: { skill, input },
    };

    return new Promise((resolve, reject) => {
      const sub = this.#nc.subscribe(inbox, { max: 1 });
      const timer = setTimeout(() => {
        sub.unsubscribe();
        reject(new SynapseError("Request timeout", 4001, true));
      }, timeoutMs);

      (async () => {
        for await (const msg of sub) {
          clearTimeout(timer);
          const response = jc.decode(msg.data);
          if (response.error) {
            reject(new SynapseError(
              response.error.message,
              response.error.code,
              response.error.retryable
            ));
          } else {
            resolve(response);
          }
        }
      })().catch(reject);

      this.#nc.publish(`mesh.agent.${agentId}.inbox`, jc.encode(envelope), { reply: inbox });
    });
  }

  // ---- onRequest ----

  onRequest(skill, handler) {
    this.#handlers.set(skill, handler);
    console.log(`Handler "${skill}" registered`);
  }

  // ---- emit ----

  emit(eventType, data) {
    this.#nc.publish(`mesh.event.${eventType}`, jc.encode({
      v: "1.0.0", id: uuid(), type: "emit",
      ts: new Date().toISOString(), from: this.#id,
      payload: { event_type: eventType.split(".").pop(), data },
    }));
  }

  // ---- subscribe ----

  subscribe(pattern, handler) {
    const sub = this.#nc.subscribe(`mesh.event.${pattern}`);
    (async () => {
      for await (const msg of sub) {
        const envelope = jc.decode(msg.data);
        handler(envelope.payload);
      }
    })();
    return { unsubscribe: () => sub.unsubscribe() };
  }

  // ---- close ----

  async close() {
    if (this.#heartbeatInterval) clearInterval(this.#heartbeatInterval);
    await this.deregister();
    await this.#nc.drain();
    console.log(`Agent ${this.#id} disconnected`);
  }

  // ---- private helpers ----

  #setupDiscoverResponder() {
    const sub = this.#nc.subscribe("mesh.registry.discover");
    (async () => {
      for await (const msg of sub) {
        if (!this.#manifest) continue;
        const req = jc.decode(msg.data);
        const filter = req.payload || {};

        if (filter.capabilities &&
          !filter.capabilities.every((c) => this.#manifest.capabilities.includes(c)))
          continue;

        if (filter.skill_ids) {
          const agentSkillIds = this.#manifest.skills.map((s) => s.id);
          if (!filter.skill_ids.every((sid) => agentSkillIds.includes(sid))) continue;
        }

        if (filter.availability && this.#manifest.availability !== filter.availability) continue;

        if (msg.reply) {
          this.#nc.publish(msg.reply, jc.encode({
            v: "1.0.0", id: uuid(), type: "register",
            ts: new Date().toISOString(), from: this.#id,
            payload: this.#manifest,
          }));
        }
      }
    })();
  }

  #setupRequestHandler() {
    const sub = this.#nc.subscribe(`mesh.agent.${this.#id}.inbox`);
    (async () => {
      for await (const msg of sub) {
        const envelope = jc.decode(msg.data);
        if (envelope.type !== "request") continue;

        const skill = envelope.payload?.skill;
        const handler = this.#handlers.get(skill);
        const replyEnvelope = (extra) => ({
          v: "1.0.0", id: uuid(), type: "respond",
          ts: new Date().toISOString(), from: this.#id,
          to: envelope.from, task_id: envelope.task_id, trace: envelope.trace,
          ...extra,
        });

        // Handle streaming requests
        if (envelope.payload?.stream && this.#streamHandlers.has(skill)) {
          const streamHandler = this.#streamHandlers.get(skill);
          const streamSubject = `mesh.task.${envelope.task_id}.stream`;
          let seq = 0;
          (async () => {
            try {
              for await (const chunk of streamHandler(envelope.payload, {
                task_id: envelope.task_id || "", from: envelope.from,
              })) {
                this.#nc.publish(streamSubject, jc.encode({ seq: seq++, chunk, done: false }));
              }
              this.#nc.publish(streamSubject, jc.encode({ seq: seq++, chunk: {}, done: true }));
            } catch (err) {
              this.#nc.publish(streamSubject, jc.encode({
                seq: seq++, chunk: {}, done: true,
                error: { code: 5001, message: err.message, retryable: true }
              }));
            }
          })();
          continue;
        }

        if (!msg.reply) continue;

        if (handler) {
          try {
            const result = await handler(envelope.payload, {
              task_id: envelope.task_id || "",
              from: envelope.from,
            });
            this.#nc.publish(msg.reply, jc.encode(replyEnvelope({ payload: { output: result } })));
          } catch (err) {
            this.#nc.publish(msg.reply, jc.encode(replyEnvelope({
              error: { code: 5001, message: err.message, retryable: true },
            })));
          }
        } else {
          this.#nc.publish(msg.reply, jc.encode(replyEnvelope({
            error: { code: 3001, message: `Skill "${skill}" not found`, retryable: false },
          })));
        }
      }
    })();
  }

  #startHeartbeat(intervalMs = 30000) {
    this.#heartbeatInterval = setInterval(() => {
      if (this.#manifest) {
        // Publish heartbeat envelope (consistent with Python/Go SDKs)
        const heartbeat = {
          v: "1.0.0", id: uuid(), type: "heartbeat",
          ts: new Date().toISOString(), from: this.#id,
          payload: { agent_id: this.#id, timestamp: new Date().toISOString() },
        };
        this.#nc.publish(
          `mesh.heartbeat.${this.#id}`,
          jc.encode(heartbeat)
        );
      }
    }, intervalMs);
  }

  // ---- streamRequest (caller) ----

  async *streamRequest(agentId, skill, input, timeoutMs = 120000) {
    const taskId = uuid();
    const streamSubject = `mesh.task.${taskId}.stream`;
    const inbox = createInbox();

    // Subscribe BEFORE publishing to avoid missing early chunks
    const streamSub = this.#nc.subscribe(streamSubject);

    this.#nc.publish(`mesh.agent.${agentId}.inbox`, jc.encode({
      v: "1.0.0", id: uuid(), type: "request",
      ts: new Date().toISOString(), from: this.#id, to: agentId,
      task_id: taskId,
      trace: { trace_id: uuid(), span_id: uuid() },
      payload: { skill, input, stream: true },
    }), { reply: inbox });

    const timer = setTimeout(() => streamSub.unsubscribe(), timeoutMs);

    try {
      for await (const msg of streamSub) {
        const chunk = jc.decode(msg.data);
        if (chunk.done) {
          streamSub.unsubscribe();
          clearTimeout(timer);
          if (chunk.result) yield chunk.result;
          return;
        }
        yield chunk.chunk;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- onStreamRequest (handler) ----

  onStreamRequest(skill, handler) {
    this.#streamHandlers.set(skill, handler);
    console.log(`Stream handler "${skill}" registered`);
  }
}

export default Synapse;
```

**Usage (no build step):**
```javascript
// my-agent.mjs
import Synapse, { retryWithBackoff, SynapseError } from "./synapse.mjs";

const mesh = await Synapse.connect("nats://localhost:4222");
await mesh.register({ name: "My Agent", capabilities: ["demo"], skills: [] });

mesh.onRequest("ping", () => ({ pong: true }));

process.on("SIGINT", async () => { await mesh.close(); process.exit(0); });
```

---

## OpenTelemetry Integration

The SDK's `trace` field propagates trace context across agent hops. Wire up an OTLP exporter to send spans to Jaeger, Tempo, or any OTel-compatible backend.

### Quick Setup

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http
```

### Traced Agent Example

```typescript
import Synapse from "./synapse.js";
import {
  initTracing, shutdownTracing, initMetrics,
  startRequestSpan, startHandlerSpan, endSpan,
  recordRequest, recordLatency, recordError,
} from "./tracing.js";

async function main() {
  // 1. Initialize OTel (call once at startup)
  initTracing("my-agent", "1.0.0", process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  initMetrics();

  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Traced Agent",
    capabilities: ["chat"],
    skills: [{ id: "chat", name: "Chat", description: "Chat" }],
  });

  // 2. Wrap handler with span
  mesh.onRequest("chat", (payload, ctx) => {
    const span = startHandlerSpan("chat", ctx.from, payload.trace);
    try {
      const result = { text: `Echo: ${payload.input?.text}` };
      endSpan(span);
      return result;
    } catch (err: any) {
      endSpan(span, err);
      throw err;
    }
  });

  // 3. Wrap outgoing requests with span + metrics
  async function tracedRequest(agentId: string, skill: string, input: any) {
    const { span, trace } = startRequestSpan(skill, agentId);
    const start = Date.now();
    try {
      const result = await mesh.request(agentId, skill, input);
      recordRequest(skill, mesh.agentId, agentId);
      recordLatency(skill, Date.now() - start);
      endSpan(span);
      return result;
    } catch (err: any) {
      recordError(skill, err.code || 0, mesh.agentId, agentId);
      endSpan(span, err);
      throw err;
    }
  }

  process.on("SIGINT", async () => {
    await mesh.close();
    await shutdownTracing();
    process.exit(0);
  });
}

main().catch(console.error);
```

Full tracing module, Grafana dashboard, and Docker Compose observability stack are in [observability.md](./observability.md).

---

## Schema Validation

Validate envelopes and manifests using JSON Schema + Ajv to catch malformed messages before they propagate.

### Install

```bash
npm install ajv
```

### Usage

```typescript
import { validateEnvelope, assertEnvelope, validateManifest, assertManifest } from "./validate.js";

// Validate and get errors
const errors = validateEnvelope(incomingData);
if (errors.length > 0) {
  console.error("Invalid envelope:", errors);
  // Respond with error code 2001 (INVALID_ENVELOPE)
}

// Or assert (throws on invalid)
try {
  assertEnvelope(outgoingEnvelope);
  // Safe to send
} catch (err) {
  console.error("Bug: tried to send invalid envelope", err);
}
```

Full schema definitions and validator modules for all 3 SDKs are in [schema.md](./schema.md).

---

## Streaming Primitives

Synapse supports incremental responses via a stream subject per task.
Each task gets its own subject: `mesh.task.{task_id}.stream`.
Chunks are published as individual NATS messages; the final message has `done: true`.

### Caller side: `streamRequest()`

Returns an `AsyncGenerator` that yields each chunk as it arrives.

```typescript
async for (const chunk of mesh.streamRequest(agentId, "analyze", { text: "huge document" })) {
  // chunk is { word: "lorem" }, { word: "ipsum" }, etc.
  console.log("chunk:", chunk);
}
// loop exits automatically when done: true arrives
```

### Handler side: `onStreamRequest()`

Registers an async generator handler that yields chunks.

```typescript
mesh.onStreamRequest("analyze", async function* (payload, ctx) {
  const text = payload.input?.text ?? "";
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    yield { word: words[i], index: i, total: words.length };
  }
});
```

### LLM Streaming Example

```typescript
// Caller
const chunks = [];
async for (const chunk of mesh.streamRequest(agentId, "chat", { message: "explain quantum" })) {
  chunks.push(chunk.token);
  process.stdout.write(chunk.token); // live streaming to console
}
const fullResponse = chunks.join("");

// Handler (using Anthropic SDK streaming)
mesh.onStreamRequest("chat", async function* (payload) {
  const message = payload.input?.message ?? "";
  const stream = claude.messages.stream({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 2000,
    messages: [{ role: "user", content: message }],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta") {
      yield { token: event.delta.text };
    }
  }
});
```

### Wire format

Each chunk message on `mesh.task.{task_id}.stream`:

```json
{
  "seq": 0,
  "chunk": { "token": "Hello" },
  "done": false
}
```

Final message:

```json
{
  "seq": 4,
  "chunk": { "token": "world" },
  "done": true,
  "result": { "full_text": "Hello world" }
}
```

### Implementation details

```typescript
// streamRequest — caller side (add to Synapse class)
async *streamRequest(
  agentId: string,
  skill: string,
  input: any,
  timeoutMs: number = 120000  // default 120s for long-running agents
): AsyncGenerator<any> {
  const taskId = uuid();
  const streamSubject = `mesh.task.${taskId}.stream`;
  const inbox = createInbox();

  // IMPORTANT: subscribe to stream BEFORE sending request
  // This avoids the race where the handler starts publishing
  // before the caller has subscribed.
  const streamSub = this.nc.subscribe(streamSubject);

  const envelope: Envelope = {
    v: "1.0.0", id: uuid(), type: "request",
    ts: new Date().toISOString(), from: this.id, to: agentId,
    task_id: taskId,
    trace: { trace_id: uuid(), span_id: uuid() },
    payload: { skill, input, stream: true },
  };

  this.nc.publish(`mesh.agent.${agentId}.inbox`, jc.encode(envelope), { reply: inbox });

  const timeoutTimer = setTimeout(() => streamSub.unsubscribe(), timeoutMs);

  try {
    for await (const msg of streamSub) {
      const chunk = jc.decode(msg.data) as { seq: number; chunk: any; done: boolean; result?: any };
      if (chunk.done) {
        streamSub.unsubscribe();
        clearTimeout(timeoutTimer);
        if (chunk.result) yield chunk.result;
        return;
      }
      yield chunk.chunk;
    }
  } finally {
    clearTimeout(timeoutTimer);
  }
}

// onStreamRequest — handler side (add to Synapse class)
onStreamRequest(
  skill: string,
  handler: (payload: any, ctx: { task_id: string; from: string }) => AsyncGenerator<any>
): void {
  this.streamHandlers.set(skill, handler);
  console.log(`Stream handler "${skill}" registered`);
}
```

---

## Long-Running Requests

Some agents take longer than NATS's default request timeout to respond — LLM inference over 30s, API calls with many iterations, batch processing. Three strategies:

### Strategy 1: Increase timeout on `request()` (simplest)

```typescript
// Pass explicit timeout as 4th argument (milliseconds)
const result = await mesh.request(agentId, "fetch-incidents", { count: 10 }, 180_000); // 3 min
```

Works when the agent responds in one shot. NATS keeps the reply subject alive until the timeout expires.

### Strategy 2: Use `streamRequest()` (recommended for LLM agents)

Stream intermediate results so the caller sees progress, and the reply subject stays alive through the final `done: true` chunk.

```typescript
// Caller: stream results as they arrive
for await (const chunk of mesh.streamRequest(agentId, "analyze", { text: "..." }, 300_000)) {
  process.stdout.write(chunk.token ?? "");
}

// Handler: yield chunks incrementally
mesh.onStreamRequest("analyze", async function* (payload) {
  for (const chunk of processInChunks(payload.input.text)) {
    yield { token: chunk };
  }
});
```

### Strategy 3: Stable reply subject (CLI / no SDK)

When using `nats request` from the CLI or a language without the SDK, NATS's ephemeral reply subject may expire before a long-running agent responds.

**Fix:** subscribe to a stable reply subject first, then publish the request:

```bash
# Terminal 1: subscribe first (keep alive)
nats sub "_REPLY.myapp.$(date +%s)" --server nats://localhost:4222 --count 1 &
SUB_PID=$!

# Terminal 2: publish request with the stable reply subject
REPLY="_REPLY.myapp.$(date +%s)"
nats pub mesh.agent.grip-001.inbox \
  '{"v":"1.0.0","type":"request","from":"cli","task_id":"t1","trace":{"trace_id":"r1","span_id":"s1"},"payload":{"skill":"fetch","input":{}}}' \
  --reply "$REPLY" \
  --server nats://localhost:4222
```

**Python equivalent** (used in production for Grip agent):

```python
import subprocess, json, uuid, datetime

REPLY = f"_REPLY.{uuid.uuid4().hex[:8]}"

# Start subscriber FIRST
sub = subprocess.Popen(
    ["nats", "sub", REPLY, "--server", "nats://localhost:4222", "--count", "1", "--raw"],
    stdout=subprocess.PIPE, text=True
)

# Publish request with our stable reply subject
envelope = {
    "v": "1.0.0", "id": str(uuid.uuid4()), "type": "request",
    "ts": datetime.datetime.now(datetime.UTC).isoformat(),
    "from": "my-client", "to": "grip-001",
    "task_id": str(uuid.uuid4()),
    "trace": {"trace_id": str(uuid.uuid4()), "span_id": str(uuid.uuid4())},
    "payload": {"text": "your prompt here"}
}
subprocess.run([
    "nats", "pub", "mesh.agent.grip-001.inbox",
    json.dumps(envelope), "--reply", REPLY,
    "--server", "nats://localhost:4222"
])

# Wait for response (up to 5 minutes)
out, _ = sub.communicate(timeout=300)
print(json.loads(out))
```

### Decision guide

| Agent response time | Strategy |
|---|---|
| < 30s | `request()` with default timeout |
| 30s – 3min | `request()` with explicit timeout e.g. `180_000` |
| > 3min or LLM streaming | `streamRequest()` / `onStreamRequest()` |
| CLI / no SDK | Stable reply subject (subscribe first, then publish) |
| Unknown / variable | `streamRequest()` — always safe, even for fast responses |

---

## Backpressure & Flow Control

Adaptive rate limiting, concurrency limits, and queue depth management to protect agents from overload.

### Concurrency Limiter

```typescript
// src/backpressure.ts
import { Semapho } from "./semapho.js"; // or use async-semapho

export class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private maxConcurrency: number = 10) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.running--;
    if (this.queue.length > 0) {
      this.running++;
      const next = this.queue.shift()!;
      next();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.running;
  }

  get isOverloaded(): boolean {
    return this.queue.length > this.maxConcurrency * 2;
  }
}
```

### Adaptive Rate Limiter

```typescript
export class AdaptiveRateLimiter {
  private tokenBucket: number;
  private lastRefill: number;
  private consecutiveOverloads = 0;

  constructor(
    private maxTokens: number = 50,    // max requests per refill period
    private refillMs: number = 1000,     // refill every 1s
    private minTokens: number = 5,      // floor when backing off
  ) {
    this.tokenBucket = maxTokens;
    this.lastRefill = Date.now();
  }

  /** Try to acquire a token. Returns false if rate-limited. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokenBucket > 0) {
      this.tokenBucket--;
      return true;
    }
    return false;
  }

  /** Wait until a token is available */
  async acquire(): Promise<void> {
    while (!this.tryAcquire()) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Call when agent returns OVERLOADED (4001) */
  onOverload(): void {
    this.consecutiveOverloads++;
    // Exponential backoff: reduce capacity by half each time
    const newMax = Math.max(this.minTokens, Math.floor(this.maxTokens / Math.pow(2, this.consecutiveOverloads)));
    this.maxTokens = newMax;
    this.tokenBucket = Math.min(this.tokenBucket, newMax);
  }

  /** Call when a request succeeds */
  onSuccess(): void {
    // Gradually restore capacity
    if (this.consecutiveOverloads > 0) {
      this.consecutiveOverloads--;
      this.maxTokens = Math.min(this.maxTokens * 2, 50); // restore toward original
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.refillMs) {
      this.tokenBucket = Math.min(this.maxTokens, this.tokenBucket + this.maxTokens);
      this.lastRefill = now;
    }
  }
}
```

### Integration with Synapse SDK

```typescript
import { ConcurrencyLimiter, AdaptiveRateLimiter } from "./backpressure.js";

class ProtectedSynapse extends Synapse {
  private concurrency = new ConcurrencyLimiter(10); // max 10 concurrent handlers
  private rateLimiter = new AdaptiveRateLimiter(50); // 50 req/s

  // Override request handler to enforce concurrency + rate limiting
  onRequest(skill: string, handler: (payload: any, ctx: any) => any): void {
    super.onRequest(skill, async (payload, ctx) => {
      // Rate limit check
      if (!this.rateLimiter.tryAcquire()) {
        throw new SynapseError("Rate limited", 4002, true);
      }

      // Concurrency limit
      await this.concurrency.acquire();
      try {
        const result = await handler(payload, ctx);
        this.rateLimiter.onSuccess();
        return result;
      } catch (err: any) {
        if (err.code === 4001) this.rateLimiter.onOverload();
        throw err;
      } finally {
        this.concurrency.release();
      }
    });
  }

  // Override request (outgoing) to apply adaptive rate limiting on overload
  async request(agentId: string, skill: string, input: any, timeoutMs?: number) {
    try {
      const result = await super.request(agentId, skill, input, timeoutMs);
      this.rateLimiter.onSuccess();
      return result;
    } catch (err: any) {
      if (err.code === 4001) this.rateLimiter.onOverload();
      throw err;
    }
  }
}
```

---

## Known Limitations

| Limitation | Workaround / Notes |
|---|---|
| **~~No published npm package~~** | **Fixed.** Published on npm as [`synapse-nats-sdk`](https://www.npmjs.com/package/synapse-nats-sdk). `npm install synapse-nats-sdk`. |
| **~~No browser SDK (WebSocket wrapper)~~** | **Fixed.** `import Synapse from "synapse-nats-sdk/browser"` — thin WS wrapper over NATS v3 WebSocket (`wsconnect`). Connects to NATS server on WSS port 8443. |
| **~~Migrate to @nats-io/transport-node~~** | **Fixed.** v2.0.0 — Node SDK uses `@nats-io/transport-node@^3.0.0` (TCP), Browser SDK uses `@nats-io/nats-core@^3.0.0` (WebSocket). |
| **No NKey/JWT auth built in** | Pass `{ authenticator: nkeys.fromSeed(...) }` (or equivalent) as the second argument to `Synapse.connect()`. See the [NATS auth docs](https://docs.nats.io/running-a-nats-service/configuration/securing_nats). |
| **No JetStream-backed registry persistence** | Registrations are in-memory. If a registry router process restarts, agents must re-register. Consider pairing with a JetStream KV store for durable manifests. |
| **~~Discovery is peer-to-peer, not centralized~~** | **Fixed.** See [registry.md](./registry.md) — JetStream-backed registry service for deterministic discovery. |
| **~~No OpenTelemetry export built in~~** | **Fixed.** See [observability.md](./observability.md) for full OTel integration with span propagation, metrics, and Grafana dashboard. |
| **~~No schema validation~~** | **Fixed.** See [schema.md](./schema.md) for JSON Schema definitions and Ajv-based validation for TypeScript. |
| **~~No backpressure/flow control~~** | **Fixed.** See Backpressure section below — adaptive rate limiting, concurrency limits, and queue depth management built in. |
| **~~Heartbeat inconsistency across SDKs~~** | **Fixed.** All SDKs now publish to `mesh.heartbeat.{id}` with a consistent envelope format. |
| **~~No streaming request/reply~~** | **Fixed.** See [Streaming Primitives](#streaming-primitives) — `streamRequest()` / `onStreamRequest()` with async generators, wired via `streamHandlers` in `_setupRequestHandler`. Works with Anthropic SDK streaming. |
| **Long-running requests (>30s)** | Use `streamRequest()` or pass explicit `timeoutMs` to `request()`. For CLI use, subscribe to a stable reply subject before publishing. See [Long-Running Requests](#long-running-requests). |
| **~~No built-in conversation state / task persistence~~** | **Fixed.** See [tasks.md](./tasks.md) — JetStream-backed task store with state machine enforcement, `getTask()`, multi-turn conversation linking via `context_id`, and real-time dashboard support. |
| **~~No HTTP bridge for REST agents~~** | **Fixed.** See [http-bridge.md](./http-bridge.md) — bidirectional bridge wraps any Flask/FastAPI/Express agent as a Synapse participant. Zero NATS code on the HTTP side. Webhook API for HTTP→Synapse calls. |
