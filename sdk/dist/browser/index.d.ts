import type { ConnectionOptions } from "@nats-io/nats-core";
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
export declare class SynapseError extends Error {
    readonly code: number;
    readonly retryable: boolean;
    constructor(message: string, code: number, retryable: boolean);
}
export declare function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries?: number, baseMs?: number): Promise<T>;
export declare class Synapse {
    private nc;
    private _id;
    private manifest;
    private handlers;
    private streamHandlers;
    private heartbeatInterval?;
    private constructor();
    /**
     * Connect to NATS via WebSocket
     * @param url WebSocket URL (e.g., "ws://localhost:8443" or "wss://nats.example.com:443")
     * @param opts Connection options
     */
    static connect(url?: string, opts?: Partial<ConnectionOptions>): Promise<Synapse>;
    get agentId(): string;
    get isConnected(): boolean;
    get isRegistered(): boolean;
    register(options: {
        name: string;
        description?: string;
        capabilities?: string[];
        skills?: Skill[];
    }): Promise<AgentManifest>;
    deregister(): Promise<void>;
    discover(filter?: DiscoverFilter, windowMs?: number): Promise<AgentManifest[]>;
    request(agentId: string, skill: string, input: any, timeoutMs?: number): Promise<Envelope>;
    streamRequest(agentId: string, skill: string, input: any, timeoutMs?: number): AsyncGenerator<any>;
    onStreamRequest(skill: string, handler: (payload: any, ctx: {
        task_id: string;
        from: string;
    }) => AsyncGenerator<any>): void;
    onRequest(skill: string, handler: (payload: any, context: {
        task_id: string;
        from: string;
    }) => any): void;
    emit(eventType: string, data: any): void;
    subscribe(pattern: string, handler: (payload: any) => void): {
        unsubscribe: () => void;
    };
    getManifest(): AgentManifest | null;
    getSubscriptions(): string[];
    close(): Promise<void>;
    private _publishError;
    private _setupDiscoverResponder;
    private _setupRequestHandler;
    private _startHeartbeat;
}
export default Synapse;
//# sourceMappingURL=index.d.ts.map