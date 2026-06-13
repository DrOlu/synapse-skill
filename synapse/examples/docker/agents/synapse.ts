// agents/synapse.ts — Synapse SDK (copy of examples/typescript/src/synapse.ts)
import { connect, ConnectionOptions, NatsConnection, createInbox, StringCodec, JSONCodec } from "nats";
import { v4 as uuid } from "uuid";

const sc = StringCodec();
const jc = JSONCodec();

export interface Skill {
  id: string; name: string; description: string;
  input_modes?: string[]; output_modes?: string[];
}

export interface AgentManifest {
  id: string; name: string; description?: string;
  capabilities: string[]; skills: Skill[];
  endpoint: string; availability: "online" | "busy" | "offline"; last_heartbeat: string;
}

export interface Envelope {
  v: string; id: string; type: string; ts: string; from: string;
  to?: string; task_id?: string;
  trace?: { trace_id: string; span_id: string; parent_span_id?: string };
  payload?: any; artifacts?: any[];
  error?: { code: number; message: string; retryable: boolean };
}

export interface DiscoverFilter {
  capabilities?: string[]; skill_ids?: string[]; availability?: string;
}

export class SynapseError extends Error {
  readonly code: number; readonly retryable: boolean;
  constructor(message: string, code: number, retryable: boolean) {
    super(message); this.name = "SynapseError"; this.code = code; this.retryable = retryable;
    Object.setPrototypeOf(this, SynapseError.prototype);
  }
}

export class Synapse {
  private nc: NatsConnection; private id: string;
  private manifest: AgentManifest | null = null;
  private handlers: Map<string, (...args: any[]) => any> = new Map();
  private heartbeatInterval?: NodeJS.Timeout;

  private constructor(nc: NatsConnection) { this.nc = nc; this.id = uuid(); }

  static async connect(url: string = "nats://localhost:4222", opts?: Partial<ConnectionOptions>): Promise<Synapse> {
    const nc = await connect({ servers: url, reconnect: true, maxReconnectAttempts: -1, reconnectTimeWait: 2000, ...opts });
    const self = new Synapse(nc);
    console.log(`Connected to NATS at ${url} with ID: ${self.id}`);
    return self;
  }

  get agentId(): string { return this.id; }
  get isConnected(): boolean { return !this.nc.isClosed(); }
  get isRegistered(): boolean { return this.manifest !== null; }

  async register(options: { name: string; description?: string; capabilities?: string[]; skills?: Skill[] }): Promise<AgentManifest> {
    this.manifest = { id: this.id, name: options.name, description: options.description, capabilities: options.capabilities || [], skills: options.skills || [], endpoint: `mesh.agent.${this.id}.inbox`, availability: "online", last_heartbeat: new Date().toISOString() };
    const envelope: Envelope = { v: "1.0.0", id: uuid(), type: "register", ts: new Date().toISOString(), from: this.id, payload: this.manifest };
    this.nc.publish("mesh.registry.register", jc.encode(envelope));
    this._setupDiscoverResponder(); this._setupRequestHandler(); this._startHeartbeat();
    console.log(`Agent "${options.name}" (${this.id}) registered`);
    return this.manifest;
  }

  async deregister(): Promise<void> {
    if (!this.manifest) return;
    this.nc.publish("mesh.registry.deregister", jc.encode({ v: "1.0.0", id: uuid(), type: "deregister", ts: new Date().toISOString(), from: this.id, payload: { id: this.id } }));
    this.manifest = null; console.log(`Agent ${this.id} deregistered`);
  }

  async discover(filter: DiscoverFilter = {}, windowMs: number = 2000): Promise<AgentManifest[]> {
    const inbox = createInbox(); const seen = new Set<string>(); const agents: AgentManifest[] = [];
    const sub = this.nc.subscribe(inbox);
    const done = (async () => { for await (const msg of sub) { const env = jc.decode(msg.data) as Envelope; const m = env.payload; if (!m || seen.has(m.id)) continue; if (filter.capabilities && !filter.capabilities.every(c => m.capabilities.includes(c))) continue; seen.add(m.id); agents.push(m); } })();
    this.nc.publish("mesh.registry.discover", jc.encode({ v: "1.0.0", id: uuid(), type: "discover", ts: new Date().toISOString(), from: this.id, payload: filter }), { reply: inbox });
    await new Promise(r => setTimeout(r, windowMs)); sub.unsubscribe(); await done.catch(() => {}); return agents;
  }

  async request(agentId: string, skill: string, input: any, timeoutMs: number = 30000): Promise<Envelope> {
    const envelope: Envelope = { v: "1.0.0", id: uuid(), type: "request", ts: new Date().toISOString(), from: this.id, to: agentId, task_id: uuid(), trace: { trace_id: uuid(), span_id: uuid() }, payload: { skill, input } };
    return new Promise((resolve, reject) => {
      const inbox = createInbox(); const sub = this.nc.subscribe(inbox, { max: 1 });
      const timer = setTimeout(() => { sub.unsubscribe(); reject(new SynapseError("Request timeout", 4001, true)); }, timeoutMs);
      (async () => { for await (const msg of sub) { clearTimeout(timer); const r = jc.decode(msg.data) as Envelope; if (r.error) reject(new SynapseError(r.error.message, r.error.code, r.error.retryable)); else resolve(r); } })().catch(reject);
      this.nc.publish(`mesh.agent.${agentId}.inbox`, jc.encode(envelope), { reply: inbox });
    });
  }

  onRequest(skill: string, handler: (payload: any, context: { task_id: string; from: string }) => any): void { this.handlers.set(skill, handler); }

  emit(eventType: string, data: any): void { this.nc.publish(`mesh.event.${eventType}`, jc.encode({ v: "1.0.0", id: uuid(), type: "emit", ts: new Date().toISOString(), from: this.id, payload: { event_type: eventType.split(".").pop(), data } })); }

  subscribe(pattern: string, handler: (payload: any) => void): { unsubscribe: () => void } { const sub = this.nc.subscribe(`mesh.event.${pattern}`); (async () => { for await (const msg of sub) { handler((jc.decode(msg.data) as Envelope).payload); } })(); return { unsubscribe: () => sub.unsubscribe() }; }

  async close(): Promise<void> { if (this.heartbeatInterval) clearInterval(this.heartbeatInterval); await this.deregister(); await this.nc.drain(); console.log(`Agent ${this.id} disconnected`); }

  private _setupDiscoverResponder(): void {
    const sub = this.nc.subscribe("mesh.registry.discover");
    (async () => { for await (const msg of sub) { if (!this.manifest) continue; if (msg.reply) this.nc.publish(msg.reply, jc.encode({ v: "1.0.0", id: uuid(), type: "register", ts: new Date().toISOString(), from: this.id, payload: this.manifest })); } })();
  }

  private _setupRequestHandler(): void {
    const sub = this.nc.subscribe(`mesh.agent.${this.id}.inbox`);
    (async () => { for await (const msg of sub) { const env = jc.decode(msg.data) as Envelope; if (env.type !== "request") continue; const skill = env.payload?.skill; const handler = this.handlers.get(skill);
      if (!msg.reply) continue;
      if (handler) { try { const r = await handler(env.payload, { task_id: env.task_id || "", from: env.from }); this.nc.publish(msg.reply, jc.encode({ v: "1.0.0", id: uuid(), type: "respond", ts: new Date().toISOString(), from: this.id, to: env.from, task_id: env.task_id, trace: env.trace, payload: { output: r } })); } catch (e: any) { this.nc.publish(msg.reply, jc.encode({ v: "1.0.0", id: uuid(), type: "respond", ts: new Date().toISOString(), from: this.id, to: env.from, task_id: env.task_id, trace: env.trace, error: { code: 5001, message: e.message, retryable: true } })); } }
      else { this.nc.publish(msg.reply, jc.encode({ v: "1.0.0", id: uuid(), type: "respond", ts: new Date().toISOString(), from: this.id, to: env.from, task_id: env.task_id, trace: env.trace, error: { code: 3001, message: `Skill "${skill}" not found`, retryable: false } })); }
    } })();
  }

  private _startHeartbeat(intervalMs: number = 30000): void { this.heartbeatInterval = setInterval(() => { if (this.manifest) this.nc.publish(`mesh.heartbeat.${this.id}`, sc.encode(new Date().toISOString())); }, intervalMs); }
}

export default Synapse;
