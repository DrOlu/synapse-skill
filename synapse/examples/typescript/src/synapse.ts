// src/synapse.ts — Complete Synapse SDK for TypeScript
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
    Object.setPrototypeOf(this, SynapseError.prototype);
  }
}

// ==================== RETRY HELPER ====================

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

  get isRegistered(): boolean {
    return this.manifest !== null;
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

        if (seen.has(manifest.id)) continue;

        if (
          filter.capabilities &&
          !filter.capabilities.every((c) => manifest.capabilities.includes(c))
        ) continue;

        if (filter.skill_ids) {
          const agentSkillIds = manifest.skills.map((s) => s.id);
          if (!filter.skill_ids.every((sid) => agentSkillIds.includes(sid))) continue;
        }

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
        this.nc.publish(
          `mesh.heartbeat.${this.id}`,
          sc.encode(new Date().toISOString())
        );
      }
    }, intervalMs);
  }
}

export default Synapse;
