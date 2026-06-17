import Synapse from "./index.js";
interface HTTPAgentConfig {
    id: string;
    name: string;
    baseUrl: string;
    capabilities: string[];
    skills: {
        id: string;
        name: string;
        description: string;
    }[];
    skillPath?: string;
    method?: "POST" | "GET";
    timeout?: number;
}
export declare class HTTPBridge {
    private mesh;
    private agents;
    private webhookPort;
    private server;
    constructor(mesh: Synapse, webhookPort?: number);
    registerAgent(config: HTTPAgentConfig): Promise<void>;
    private proxyRequest;
    startWebhook(): Promise<void>;
    stop(): Promise<void>;
}
export {};
//# sourceMappingURL=http-bridge.d.ts.map