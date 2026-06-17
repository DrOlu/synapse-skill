import type { Synapse } from "./index.js";
export interface HTTPAgentConfig {
    /** Unique ID for this HTTP agent in the mesh */
    id: string;
    /** Human-readable name */
    name: string;
    /** Base HTTP URL of the agent (e.g., "http://localhost:5000") */
    baseUrl: string;
    /** Capabilities to advertise */
    capabilities: string[];
    /** Skills this agent supports */
    skills: {
        id: string;
        name: string;
        description: string;
    }[];
    /** Path template for skill calls. {skill} is replaced with skill ID. Default: "/skill/{skill}" */
    skillPath?: string;
    /** HTTP method. Default: "POST" */
    method?: "POST" | "GET";
    /** Request timeout in ms. Default: 30000 */
    timeout?: number;
}
export interface HTTPBridgeOptions {
    mesh: Synapse;
    webhookPort?: number;
}
/**
 * HTTPBridge wraps HTTP agents as Synapse mesh participants.
 *
 * Mode 1: HTTP agent joins the mesh (bridge proxies inbound requests)
 * Mode 2: HTTP agent calls Synapse (bridge exposes a webhook)
 * Mode 3: Both simultaneously (bidirectional)
 *
 * Usage:
 * ```ts
 * import Synapse from "synapse-nats-sdk";
 * import { HTTPBridge } from "synapse-nats-sdk/http-bridge";
 *
 * const mesh = await Synapse.connect("nats://localhost:4222");
 * const bridge = new HTTPBridge(mesh, 4100);
 *
 * await bridge.registerAgent({
 *   id: "flask-chat", name: "Flask Chat",
 *   baseUrl: "http://localhost:5000",
 *   capabilities: ["chat"],
 *   skills: [{ id: "chat", name: "Chat", description: "Chat via Flask" }],
 * });
 *
 * await bridge.startWebhook();
 * ```
 */
export declare class HTTPBridge {
    private mesh;
    private agents;
    private webhookPort;
    private server;
    constructor(mesh: Synapse, webhookPort?: number);
    /**
     * Register an HTTP agent in the Synapse mesh.
     * The bridge proxies inbound requests to the agent's HTTP endpoint.
     */
    registerAgent(config: HTTPAgentConfig): Promise<void>;
    /**
     * Forward a Synapse request to the HTTP agent.
     */
    private proxyRequest;
    /**
     * Start the webhook server so HTTP agents can call Synapse mesh agents.
     * Requires `express` to be installed (dynamic import).
     *
     * Endpoints:
     * - POST /mesh/discover — discover Synapse agents
     * - POST /mesh/request  — call a Synapse agent from HTTP
     * - GET  /mesh/health   — bridge health check
     */
    startWebhook(): Promise<void>;
    /** Get all registered HTTP agent configs. */
    getAgents(): HTTPAgentConfig[];
    /**
     * Stop the webhook server and close mesh connection.
     */
    stop(): Promise<void>;
}
//# sourceMappingURL=http-bridge.d.ts.map