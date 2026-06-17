// Synapse SDK - Build multi-agent systems on NATS
// 6 primitives: register, discover, request, respond, emit, subscribe
import { connect, createInbox, StringCodec, JSONCodec } from "nats";
import { v4 as uuid } from "uuid";
const sc = StringCodec();
const jc = JSONCodec();
// ==================== ERROR CLASS ====================
export class SynapseError extends Error {
    code;
    retryable;
    constructor(message, code, retryable) {
        super(message);
        this.name = "SynapseError";
        this.code = code;
        this.retryable = retryable;
        Object.setPrototypeOf(this, SynapseError.prototype);
    }
}
// ==================== RETRY HELPER ====================
export async function retryWithBackoff(fn, maxRetries = 3, baseMs = 100) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastError = err;
            if (err instanceof SynapseError && !err.retryable)
                throw err;
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
    nc;
    _id;
    manifest = null;
    handlers = new Map();
    streamHandlers = new Map();
    heartbeatInterval;
    constructor(nc) {
        this.nc = nc;
        this._id = uuid();
    }
    static async connect(url = "nats://localhost:4222", opts) {
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
    get agentId() {
        return this._id;
    }
    get isConnected() {
        return !this.nc.isClosed();
    }
    get isRegistered() {
        return this.manifest !== null;
    }
    // ==================== PRIMITIVE 1: REGISTER ====================
    async register(options) {
        this.manifest = {
            id: this._id,
            name: options.name,
            description: options.description,
            capabilities: options.capabilities || [],
            skills: options.skills || [],
            endpoint: `mesh.agent.${this._id}.inbox`,
            availability: "online",
            last_heartbeat: new Date().toISOString(),
        };
        const envelope = {
            v: "1.0.0",
            id: uuid(),
            type: "register",
            ts: new Date().toISOString(),
            from: this._id,
            payload: this.manifest,
        };
        this.nc.publish("mesh.registry.register", jc.encode(envelope));
        this._setupDiscoverResponder();
        this._setupRequestHandler();
        this._startHeartbeat();
        console.log(`Agent "${options.name}" (${this._id}) registered`);
        return this.manifest;
    }
    // ==================== DEREGISTER ====================
    async deregister() {
        if (!this.manifest)
            return;
        const envelope = {
            v: "1.0.0",
            id: uuid(),
            type: "deregister",
            ts: new Date().toISOString(),
            from: this._id,
            payload: { id: this._id },
        };
        this.nc.publish("mesh.registry.deregister", jc.encode(envelope));
        this.manifest = null;
    }
    // ==================== PRIMITIVE 2: DISCOVER ====================
    async discover(filter = {}, windowMs = 2000) {
        const inbox = createInbox();
        const seen = new Set();
        const agents = [];
        const sub = this.nc.subscribe(inbox);
        const done = (async () => {
            for await (const msg of sub) {
                const envelope = jc.decode(msg.data);
                const manifest = envelope.payload;
                if (!manifest)
                    continue;
                if (seen.has(manifest.id))
                    continue;
                if (filter.capabilities && !filter.capabilities.every((c) => manifest.capabilities.includes(c)))
                    continue;
                if (filter.skill_ids) {
                    const ids = manifest.skills.map((s) => s.id);
                    if (!filter.skill_ids.every((sid) => ids.includes(sid)))
                        continue;
                }
                if (filter.availability && manifest.availability !== filter.availability)
                    continue;
                seen.add(manifest.id);
                agents.push(manifest);
            }
        })();
        this.nc.publish("mesh.registry.discover", jc.encode({
            v: "1.0.0", id: uuid(), type: "discover",
            ts: new Date().toISOString(), from: this._id, payload: filter,
        }), { reply: inbox });
        await new Promise((r) => setTimeout(r, windowMs));
        sub.unsubscribe();
        await done.catch(() => { });
        return agents;
    }
    // ==================== PRIMITIVE 3: REQUEST ====================
    async request(agentId, skill, input, timeoutMs = 30000) {
        return this._buildRequest(agentId, skill, input, timeoutMs);
    }
    // ==================== STREAMING PRIMITIVES ====================
    async *streamRequest(agentId, skill, input, timeoutMs = 30000) {
        const taskId = uuid();
        const streamSubject = `mesh.task.${taskId}.stream`;
        const inbox = createInbox();
        const sub = this.nc.subscribe(streamSubject);
        this.nc.publish(`mesh.agent.${agentId}.inbox`, jc.encode({
            v: "1.0.0", id: uuid(), type: "request",
            ts: new Date().toISOString(), from: this._id, to: agentId,
            task_id: taskId,
            trace: { trace_id: uuid(), span_id: uuid() },
            payload: { skill, input, stream: true },
        }), { reply: inbox });
        const timeout = setTimeout(() => sub.unsubscribe(), timeoutMs);
        let seq = 0;
        try {
            for await (const msg of sub) {
                const chunk = jc.decode(msg.data);
                if (chunk.done) {
                    sub.unsubscribe();
                    clearTimeout(timeout);
                    if (chunk.result)
                        yield chunk.result;
                    return;
                }
                seq = chunk.seq + 1;
                yield chunk.chunk;
            }
        }
        finally {
            clearTimeout(timeout);
        }
    }
    onStreamRequest(skill, handler) {
        this.streamHandlers.set(skill, handler);
        console.log(`Stream handler "${skill}" registered`);
    }
    // ==================== PRIMITIVE 4: RESPOND ====================
    onRequest(skill, handler) {
        this.handlers.set(skill, handler);
        console.log(`Handler "${skill}" registered`);
    }
    // ==================== PRIMITIVE 5: EMIT ====================
    emit(eventType, data) {
        this.nc.publish(`mesh.event.${eventType}`, jc.encode({
            v: "1.0.0", id: uuid(), type: "emit",
            ts: new Date().toISOString(), from: this._id,
            payload: { event_type: eventType.split(".").pop(), data },
        }));
    }
    // ==================== PRIMITIVE 6: SUBSCRIBE ====================
    subscribe(pattern, handler) {
        const sub = this.nc.subscribe(`mesh.event.${pattern}`);
        (async () => {
            for await (const msg of sub) {
                handler(jc.decode(msg.data).payload);
            }
        })();
        return { unsubscribe: () => sub.unsubscribe() };
    }
    // ==================== DISCONNECT ====================
    async close() {
        if (this.heartbeatInterval)
            clearInterval(this.heartbeatInterval);
        await this.deregister();
        await this.nc.drain();
    }
    // ==================== INTERNAL ====================
    async _buildRequest(agentId, skill, input, timeoutMs) {
        const inbox = createInbox();
        this.nc.publish(`mesh.agent.${agentId}.inbox`, jc.encode({
            v: "1.0.0", id: uuid(), type: "request",
            ts: new Date().toISOString(), from: this._id, to: agentId,
            task_id: uuid(),
            trace: { trace_id: uuid(), span_id: uuid() },
            payload: { skill, input },
        }), { reply: inbox });
        return new Promise((resolve, reject) => {
            const sub = this.nc.subscribe(inbox, { max: 1 });
            const timer = setTimeout(() => {
                sub.unsubscribe();
                reject(new SynapseError("Request timeout", 4001, true));
            }, timeoutMs);
            (async () => {
                for await (const msg of sub) {
                    clearTimeout(timer);
                    const resp = jc.decode(msg.data);
                    if (resp.error)
                        reject(new SynapseError(resp.error.message, resp.error.code, resp.error.retryable));
                    else
                        resolve(resp);
                }
            })().catch(reject);
        });
    }
    _setupDiscoverResponder() {
        const sub = this.nc.subscribe("mesh.registry.discover");
        (async () => {
            for await (const msg of sub) {
                if (!this.manifest)
                    continue;
                const req = jc.decode(msg.data);
                const f = req.payload || {};
                if (f.capabilities && !f.capabilities.every((c) => this.manifest.capabilities.includes(c)))
                    continue;
                if (f.skill_ids) {
                    const ids = this.manifest.skills.map((s) => s.id);
                    if (!f.skill_ids.every((sid) => ids.includes(sid)))
                        continue;
                }
                if (f.availability && this.manifest.availability !== f.availability)
                    continue;
                if (msg.reply) {
                    this.nc.publish(msg.reply, jc.encode({
                        v: "1.0.0", id: uuid(), type: "register",
                        ts: new Date().toISOString(), from: this._id, payload: this.manifest,
                    }));
                }
            }
        })();
    }
    _setupRequestHandler() {
        const sub = this.nc.subscribe(`mesh.agent.${this._id}.inbox`);
        (async () => {
            for await (const msg of sub) {
                const envelope = jc.decode(msg.data);
                if (envelope.type !== "request")
                    continue;
                const skill = envelope.payload?.skill;
                const isStream = envelope.payload?.stream === true;
                // Check stream handler first
                if (isStream && this.streamHandlers.has(skill)) {
                    const streamSubject = `mesh.task.${envelope.task_id}.stream`;
                    const streamHandler = this.streamHandlers.get(skill);
                    try {
                        let seq = 0;
                        for await (const chunk of streamHandler(envelope.payload, {
                            task_id: envelope.task_id || "", from: envelope.from,
                        })) {
                            this.nc.publish(streamSubject, jc.encode({ seq, chunk, done: false }));
                            seq++;
                        }
                        this.nc.publish(streamSubject, jc.encode({ seq, chunk: {}, done: true }));
                        if (msg.reply) {
                            this.nc.publish(msg.reply, jc.encode({
                                v: "1.0.0", id: uuid(), type: "respond",
                                ts: new Date().toISOString(), from: this._id,
                                to: envelope.from, task_id: envelope.task_id, trace: envelope.trace,
                                payload: { output: { status: "streamed" } },
                            }));
                        }
                    }
                    catch (err) {
                        this._publishError(msg, envelope, 5001, err.message, true);
                    }
                    continue;
                }
                // Regular handler
                const handler = this.handlers.get(skill);
                if (handler) {
                    try {
                        const result = await handler(envelope.payload, {
                            task_id: envelope.task_id || "", from: envelope.from,
                        });
                        if (msg.reply) {
                            this.nc.publish(msg.reply, jc.encode({
                                v: "1.0.0", id: uuid(), type: "respond",
                                ts: new Date().toISOString(), from: this._id,
                                to: envelope.from, task_id: envelope.task_id, trace: envelope.trace,
                                payload: { output: result },
                            }));
                        }
                    }
                    catch (err) {
                        this._publishError(msg, envelope, 5001, err.message, true);
                    }
                }
                else {
                    this._publishError(msg, envelope, 3001, `Skill "${skill}" not found`, false);
                }
            }
        })();
    }
    _publishError(msg, envelope, code, message, retryable) {
        if (msg.reply) {
            this.nc.publish(msg.reply, jc.encode({
                v: "1.0.0", id: uuid(), type: "respond",
                ts: new Date().toISOString(), from: this._id,
                to: envelope.from, task_id: envelope.task_id, trace: envelope.trace,
                error: { code, message, retryable },
            }));
        }
    }
    _startHeartbeat(intervalMs = 30000) {
        this.heartbeatInterval = setInterval(() => {
            if (this.manifest) {
                this.nc.publish(`mesh.heartbeat.${this._id}`, jc.encode({
                    v: "1.0.0", id: uuid(), type: "heartbeat",
                    ts: new Date().toISOString(), from: this._id,
                    payload: { agent_id: this._id, timestamp: new Date().toISOString() },
                }));
            }
        }, intervalMs);
    }
}
export default Synapse;
//# sourceMappingURL=index.js.map