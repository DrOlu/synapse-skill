// Synapse SDK - Node.js transport
// Uses @nats-io/transport-node (NATS v3) - TCP connections
// All 8 Synapse primitives: register, discover, request, respond, emit, subscribe, streamRequest, streamRespond

import { connect } from "@nats-io/transport-node";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import { createInbox } from "@nats-io/nats-core";
import type { NatsConnection } from "@nats-io/nats-core";
import { v4 as uuid } from "uuid";
import { GovernanceGate, GOV_ERROR } from "./governance.js";
import type { GovernanceOptions, PolicyDocument } from "./governance.js";

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
  // Governance fields (additive — undefined in dev, populated by AGT/governance bootstrap)
  /** Verified agent identity (DID or ACL identity). Serves as the trust root. */
  did?: string;
  /** Pointer to this agent's policy document (KV key, URL, or path). */
  policy_ref?: string;
  /** Public key fingerprint for envelope signature verification. */
  public_key_fingerprint?: string;
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
  // Governance: verified caller identity (populated by ACL/AGT signature layer)
  from_identity?: string;
  from_key_fingerprint?: string;
  signature?: string;
}

export interface DiscoverFilter {
  capabilities?: string[];
  skill_ids?: string[];
  availability?: string;
}

// ==================== REPUTATION TYPES (re-exported) ====================

export type {
  LatencyStats,
  ReputationFlags,
  ReputationRecord,
  ReputationConfig,
  RankedAgent,
  RankedDiscoverFilter,
  ReputationStats,
} from "./reputation.js";

export { ReputationStore, createReputationServiceAgent } from "./reputation.js";

// ==================== GOVERNANCE (re-exported) ====================

export type {
  Decision,
  PolicyContext,
  PolicyResult,
  PolicyRule,
  PolicyDocument,
  GovernanceOptions,
  ActraAdapter,
  AgtAdapter,
} from "./governance.js";
export {
  GOV_ERROR,
  GovernanceGate,
  PolicyBuilder,
  createActraAdapter,
  createAgtAdapter,
} from "./governance.js";

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
  private nc!: NatsConnection;
  private _id: string;
  private manifest: AgentManifest | null = null;
  private handlers: Map<string, (...args: any[]) => any> = new Map();
  private streamHandlers: Map<string, (...args: any[]) => AsyncGenerator<any>> = new Map();
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  /** Governance gate — evaluates every inbound request before dispatch. */
  private governance: GovernanceGate | null = null;

  private constructor() {
    this._id = uuid();
  }

  static async connect(
    url: string = "nats://localhost:4222",
    opts?: Partial<NodeConnectionOptions>
  ): Promise<Synapse> {
    const nc = await connect({
      servers: url,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
      ...opts,
    });
    const self = new Synapse();
    self.nc = nc;
    console.log(`Connected to NATS at ${url} with ID: ${self._id}`);
    return self;
  }

  get agentId(): string {
    return this._id;
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
    /** Verified identity (DID or ACL identity). Enables registry-as-trust-root. */
    did?: string;
    /** Pointer to this agent's policy document. */
    policy_ref?: string;
    /** Public key fingerprint for envelope signature verification. */
    public_key_fingerprint?: string;
    /**
     * Governance gate options. When provided, every inbound request is
     * authorized before the handler runs. Enables fail-closed, allow/deny,
     * and require_approval (human-in-the-loop) decisions.
     */
    governance?: GovernanceOptions;
  }): Promise<AgentManifest> {
    // Wire governance gate if configured
    if (options.governance) {
      this.governance = new GovernanceGate({ ...options.governance, nc: this.nc });
      console.log(`[GOV] Governance gate enabled (failClosed=${options.governance.failClosed ?? false})`);
    }

    this.manifest = {
      id: this._id,
      name: options.name,
      description: options.description,
      capabilities: options.capabilities || [],
      skills: options.skills || [],
      endpoint: `mesh.agent.${this._id}.inbox`,
      availability: "online",
      last_heartbeat: new Date().toISOString(),
      did: options.did,
      policy_ref: options.policy_ref,
      public_key_fingerprint: options.public_key_fingerprint,
    };

    this.nc.publish("mesh.registry.register", JSON.stringify({
      v: "1.0.0",
      id: uuid(),
      type: "register",
      ts: new Date().toISOString(),
      from: this._id,
      payload: this.manifest,
    }));

    this._setupDiscoverResponder();
    this._setupRequestHandler();
    this._startHeartbeat();

    console.log(`Agent "${options.name}" (${this._id}) registered`);
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
      from: this._id,
      payload: { id: this._id },
    };
    this.nc.publish("mesh.registry.deregister", JSON.stringify(envelope));
    this.manifest = null;
  }

  // ==================== PRIMITIVE 2: DISCOVER ====================

  async discover(filter: DiscoverFilter = {}, windowMs: number = 2000): Promise<AgentManifest[]> {
    const inbox = createInbox();
    const seen = new Set<string>();
    const agents: AgentManifest[] = [];

    const sub = this.nc.subscribe(inbox);
    const done = (async () => {
      for await (const msg of sub) {
        const envelope = JSON.parse(new TextDecoder().decode(msg.data)) as Envelope;
        const manifest = envelope.payload as AgentManifest;
        if (!manifest) continue;
        if (seen.has(manifest.id)) continue;
        if (filter.capabilities && !filter.capabilities.every((c) => manifest.capabilities.includes(c))) continue;
        if (filter.skill_ids) {
          const ids = manifest.skills.map((s: Skill) => s.id);
          if (!filter.skill_ids.every((sid) => ids.includes(sid))) continue;
        }
        if (filter.availability && manifest.availability !== filter.availability) continue;
        seen.add(manifest.id);
        agents.push(manifest);
      }
    })();

    this.nc.publish("mesh.registry.discover", JSON.stringify({
      v: "1.0.0", id: uuid(), type: "discover",
      ts: new Date().toISOString(), from: this._id, payload: filter,
    }), { reply: inbox });

    await new Promise((r) => setTimeout(r, windowMs));
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
    const inbox = createInbox();
    const envelope: Envelope = {
      v: "1.0.0",
      id: uuid(),
      type: "request",
      ts: new Date().toISOString(),
      from: this._id,
      to: agentId,
      task_id: uuid(),
      trace: { trace_id: uuid(), span_id: uuid() },
      payload: { skill, input },
    };

    this.nc.publish(`mesh.agent.${agentId}.inbox`, JSON.stringify(envelope), { reply: inbox  });

    return new Promise((resolve, reject) => {
      const sub = this.nc.subscribe(inbox, { max: 1 });
      const timer = setTimeout(() => {
        sub.unsubscribe();
        reject(new SynapseError("Request timeout", 4001, true));
      }, timeoutMs);
      (async () => {
        for await (const msg of sub) {
          clearTimeout(timer);
          const resp = JSON.parse(new TextDecoder().decode(msg.data)) as Envelope;
          if (resp.error) reject(new SynapseError(resp.error.message, resp.error.code, resp.error.retryable));
          else resolve(resp);
        }
      })().catch(reject);
    });
  }

  // ==================== STREAMING PRIMITIVES ====================

  async *streamRequest(
    agentId: string,
    skill: string,
    input: any,
    timeoutMs: number = 30000
  ): AsyncGenerator<any> {
    const taskId = uuid();
    const streamSubject = `mesh.task.${taskId}.stream`;
    const inbox = createInbox();

    const envelope: Envelope = {
      v: "1.0.0",
      id: uuid(),
      type: "request",
      ts: new Date().toISOString(),
      from: this._id,
      to: agentId,
      task_id: taskId,
      trace: { trace_id: uuid(), span_id: uuid() },
      payload: { skill, input, stream: true },
    };

    const sub = this.nc.subscribe(streamSubject);
    this.nc.publish(`mesh.agent.${agentId}.inbox`, JSON.stringify(envelope), { reply: inbox  });

    const timeout = setTimeout(() => sub.unsubscribe(), timeoutMs);
    let seq = 0;
    try {
      for await (const msg of sub) {
        const chunk = JSON.parse(new TextDecoder().decode(msg.data)) as { seq: number; chunk: any; done: boolean; result?: any };
        if (chunk.done) {
          sub.unsubscribe();
          clearTimeout(timeout);
          if (chunk.result) yield chunk.result;
          return;
        }
        seq = chunk.seq + 1;
        yield chunk.chunk;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  onStreamRequest(
    skill: string,
    handler: (payload: any, ctx: { task_id: string; from: string }) => AsyncGenerator<any>
  ): void {
    this.streamHandlers.set(skill, handler);
    console.log(`Stream handler "${skill}" registered`);
  }

  // ==================== PRIMITIVE 4: RESPOND ====================

  onRequest(
    skill: string,
    handler: (payload: any, context: { task_id: string; from: string }) => any
  ): void {
    this.handlers.set(skill, handler);
    console.log(`Handler "${skill}" registered`);
  }

  // ==================== PRIMITIVE 5: EMIT ====================

  emit(eventType: string, data: any): void {
    this.nc.publish(`mesh.event.${eventType}`, JSON.stringify({
      v: "1.0.0", id: uuid(), type: "emit",
      ts: new Date().toISOString(), from: this._id,
      payload: { event_type: eventType.split(".").pop(), data },
    }));
  }

  // ==================== PRIMITIVE 6: SUBSCRIBE ====================

  subscribe(pattern: string, handler: (payload: any) => void): { unsubscribe: () => void } {
    const sub = this.nc.subscribe(`mesh.event.${pattern}`);
    (async () => {
      for await (const msg of sub) {
        const envelope = JSON.parse(new TextDecoder().decode(msg.data)) as Envelope;
        handler(envelope.payload);
      }
    })();
    return { unsubscribe: () => sub.unsubscribe() };
  }

  // ==================== PRIMITIVE 7: HEALTH ====================

  getManifest(): AgentManifest | null {
    return this.manifest;
  }

  getSubscriptions(): string[] {
    return [];
  }

  /** Hot-reload the governance policy (call on mesh.policy.{version}.updated). */
  reloadGovernancePolicy(policy: PolicyDocument): void {
    if (this.governance) this.governance.reloadPolicy(policy);
  }

  /** Returns the active governance gate (for testing / inspection). */
  getGovernanceGate(): GovernanceGate | null {
    return this.governance;
  }

  // ==================== DISCONNECT ====================

  async close(): Promise<void> {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    await this.deregister();
    await this.nc.drain();
  }

  // ==================== INTERNAL ====================

  private _publishError(msg: any, envelope: Envelope, code: number, message: string, retryable: boolean): void {
    if (msg.reply) {
      this.nc.publish(msg.reply, JSON.stringify({
        v: "1.0.0", id: uuid(), type: "respond",
        ts: new Date().toISOString(), from: this._id,
        to: envelope.from, task_id: envelope.task_id, trace: envelope.trace,
        error: { code, message, retryable },
      }));
    }
  }

  private _setupDiscoverResponder(): void {
    const sub = this.nc.subscribe("mesh.registry.discover");
    (async () => {
      for await (const msg of sub) {
        if (!this.manifest) continue;
        const req = JSON.parse(new TextDecoder().decode(msg.data)) as Envelope;
        const f: DiscoverFilter = req.payload || {};
        if (f.capabilities && !f.capabilities.every((c) => this.manifest!.capabilities.includes(c))) continue;
        if (f.skill_ids) {
          const ids = this.manifest.skills.map((s) => s.id);
          if (!f.skill_ids.every((sid) => ids.includes(sid))) continue;
        }
        if (f.availability && this.manifest.availability !== f.availability) continue;
        if (msg.reply) {
          this.nc.publish(msg.reply, JSON.stringify({
            v: "1.0.0", id: uuid(), type: "register",
            ts: new Date().toISOString(), from: this._id, payload: this.manifest,
          }));
        }
      }
    })();
  }

  private _setupRequestHandler(): void {
    const sub = this.nc.subscribe(`mesh.agent.${this._id}.inbox`);
    (async () => {
      for await (const msg of sub) {
        const envelope = JSON.parse(new TextDecoder().decode(msg.data)) as Envelope;
        if (envelope.type !== "request") continue;
        const skill = envelope.payload?.skill;
        const isStream = envelope.payload?.stream === true;

        // Check stream handler first
        if (isStream && this.streamHandlers.has(skill)) {
          const streamSubject = `mesh.task.${envelope.task_id}.stream`;
          const streamHandler = this.streamHandlers.get(skill)!;
          try {
            let seq = 0;
            for await (const chunk of streamHandler(envelope.payload, {
              task_id: envelope.task_id || "", from: envelope.from,
            })) {
              this.nc.publish(streamSubject, JSON.stringify({ seq, chunk, done: false }));
              seq++;
            }
            this.nc.publish(streamSubject, JSON.stringify({ seq, chunk: {}, done: true }));
            if (msg.reply) {
              this.nc.publish(msg.reply, JSON.stringify({
                v: "1.0.0", id: uuid(), type: "respond",
                ts: new Date().toISOString(), from: this._id,
                to: envelope.from, task_id: envelope.task_id, trace: envelope.trace,
                payload: { output: { status: "streamed" } },
              }));
            }
          } catch (err: any) {
            this._publishError(msg, envelope, 5001, err.message, true);
          }
          continue;
        }

        // Regular handler
        const handler = this.handlers.get(skill);
        if (handler) {
          // ── Governance gate: authorize before dispatch ──
          if (this.governance) {
            try {
              const decision = await this.governance.authorize(envelope as Record<string, any>);
              if (decision.decision === "deny") {
                this._publishError(msg, envelope, GOV_ERROR.GOVERNANCE_DENIED,
                  `Governance denied: ${decision.reason || decision.rule || "policy"}`, false);
                console.log(`[GOV] ✗ Denied ${envelope.from} -> ${skill}: ${decision.reason}`);
                continue;
              }
              if (decision.decision === "require_approval") {
                this._publishError(msg, envelope, GOV_ERROR.APPROVAL_REQUIRED,
                  `Approval required: ${decision.reason || "policy"}`, true);
                console.log(`[GOV] ⏳ Approval required ${envelope.from} -> ${skill}`);
                continue;
              }
              console.log(`[GOV] ✓ Allowed ${envelope.from} -> ${skill} (${decision.rule})`);
            } catch (e: any) {
              // Fail-closed: on gate error, deny rather than execute ungoverned
              this._publishError(msg, envelope, GOV_ERROR.POLICY_EVALUATION_FAILED,
                `Governance evaluation failed: ${e.message}`, false);
              console.log(`[GOV] ✗ Eval error ${envelope.from} -> ${skill}: ${e.message}`);
              continue;
            }
          }

          try {
            const result = await handler(envelope.payload, {
              task_id: envelope.task_id || "", from: envelope.from,
            });
            if (msg.reply) {
              this.nc.publish(msg.reply, JSON.stringify({
                v: "1.0.0", id: uuid(), type: "respond",
                ts: new Date().toISOString(), from: this._id,
                to: envelope.from, task_id: envelope.task_id, trace: envelope.trace,
                payload: { output: result },
              }));
            }
          } catch (err: any) {
            this._publishError(msg, envelope, 5001, err.message, true);
          }
        } else {
          this._publishError(msg, envelope, 3001, `Skill "${skill}" not found`, false);
        }
      }
    })();
  }

  private _startHeartbeat(intervalMs: number = 30000): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.manifest) {
        this.nc.publish(`mesh.heartbeat.${this._id}`, JSON.stringify({
          v: "1.0.0", id: uuid(), type: "heartbeat",
          ts: new Date().toISOString(), from: this._id,
          payload: { agent_id: this._id, timestamp: new Date().toISOString() },
        }));
      }
    }, intervalMs);
  }
}

// Re-export ACL types for convenience
export type {
  Keypair,
  TrustEntry,
  TrustStore,
  VerifyResult,
  SignedEnvelope,
  ACLClientOptions,
} from "./acl.js";
export { ACLClient, generateKeypair, slugOf, keypairPath, loadKeypair, loadTrustStore, saveKeypair } from "./acl.js";

export default Synapse;
