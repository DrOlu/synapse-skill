export class HTTPBridge {
    mesh;
    agents = new Map();
    webhookPort;
    server;
    constructor(mesh, webhookPort = 4100) {
        this.mesh = mesh;
        this.webhookPort = webhookPort;
    }
    async registerAgent(config) {
        this.agents.set(config.id, config);
        await this.mesh.register({
            name: config.name,
            capabilities: config.capabilities,
            skills: config.skills,
        });
        for (const skill of config.skills) {
            const cfg = config;
            const sid = skill.id;
            this.mesh.onRequest(sid, async (payload) => {
                return this.proxyRequest(cfg, sid, payload.input);
            });
        }
        console.log(`HTTP agent "${config.name}" (${config.id}) bridged to ${config.baseUrl}`);
    }
    async proxyRequest(config, skill, input) {
        const skillPath = (config.skillPath || "/skill/{skill}").replace("{skill}", skill);
        const url = new URL(skillPath, config.baseUrl).toString();
        const method = config.method || "POST";
        const timeout = config.timeout || 30000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const opts = {
                method,
                signal: controller.signal,
                headers: { "Content-Type": "application/json" },
            };
            if (method === "POST") {
                opts.body = JSON.stringify({ skill, input });
            }
            const resp = await fetch(url, opts);
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
            }
            const body = await resp.json();
            return body.output ?? body;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async startWebhook() {
        // Dynamic import to avoid requiring express for non-webhook use
        const { default: express } = await import("express");
        const app = express();
        app.use(express.json());
        app.post("/mesh/discover", async (req, res) => {
            try {
                const agents = await this.mesh.discover(req.body || {});
                res.json({ agents });
            }
            catch (err) {
                res.status(500).json({ error: err.message });
            }
        });
        app.post("/mesh/request", async (req, res) => {
            const { agentId, skill, input, timeout } = req.body;
            if (!agentId || !skill) {
                res.status(400).json({ error: "agentId and skill required" });
                return;
            }
            try {
                const result = await this.mesh.request(agentId, skill, input, timeout);
                res.json(result.payload?.output ?? result.payload);
            }
            catch (err) {
                res.status(err.code === 3001 ? 404 : 500).json({
                    error: err.message, code: err.code, retryable: err.retryable,
                });
            }
        });
        app.get("/mesh/health", (_req, res) => {
            res.json({
                status: "ok",
                agents: Array.from(this.agents.keys()),
                connected: this.mesh.isConnected,
            });
        });
        return new Promise((resolve) => {
            this.server = app.listen(this.webhookPort, () => {
                console.log(`HTTP bridge webhook on http://localhost:${this.webhookPort}`);
                resolve();
            });
        });
    }
    async stop() {
        if (this.server)
            this.server.close();
        await this.mesh.close();
    }
}
//# sourceMappingURL=http-bridge.js.map