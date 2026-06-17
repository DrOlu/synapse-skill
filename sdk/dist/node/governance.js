// Synapse Governance — runtime policy enforcement for agent-to-agent calls.
//
// Closes the "default-open" maturity gap: every request/respond can be gated
// by a policy decision (allow / deny / require_approval) BEFORE the backend
// is invoked. Designed to layer with:
//   - Actra (https://actra.dev)         — in-process policy engine (same JS/TS runtime)
//   - Microsoft AGT                     — identity root + master policy + approval workflow
//   - EnforceCore (Python)              — tool-call enforcement + PII redaction + Merkle audit
//
// This module is self-contained (no external deps) so the SDK works standalone.
// It accepts Actra/AGT-compatible policy objects and exposes adapter hooks
// (`useActra`, `useAgt`) to delegate to the real engines when installed.
import { v4 as uuid } from "uuid";
import { readFileSync } from "fs";
// ==================== TYPES ====================
/** Governance error codes (extend envelope.md). */
export const GOV_ERROR = {
    GOVERNANCE_DENIED: 4003, // action blocked by policy (not retryable)
    APPROVAL_REQUIRED: 4004, // action requires human/approver sign-off (retryable)
    POLICY_EVALUATION_FAILED: 4005, // gate could not evaluate (fail-closed -> deny)
};
// ==================== POLICY ENGINE ====================
/** True if `value` matches `pattern` (exact, wildcard suffix, or "*"). */
function matchOne(value, pattern) {
    if (pattern === "*")
        return true;
    if (value === undefined)
        return false;
    if (pattern.endsWith("/*"))
        return value.startsWith(pattern.slice(0, -2));
    if (pattern.endsWith("*"))
        return value.startsWith(pattern.slice(0, -1));
    return value === pattern;
}
function matchAny(value, patterns) {
    const arr = Array.isArray(patterns) ? patterns : [patterns];
    return arr.some((p) => matchOne(value, p));
}
/**
 * Minimal, dependency-free expression evaluator for `condition` strings.
 * Supports: `field op value` where op ∈ {==, !=, in, not in}.
 *   action == "send_email"
 *   tool in ["execute_shell", "drop_table"]
 *   actor != "anon"
 * For anything richer, install Actra and pass via `useActra`.
 */
function evalCondition(expr, ctx) {
    try {
        const m = expr.match(/^\s*(\w+)\s*(==|!=|in|not in)\s*(.+?)\s*$/);
        if (!m)
            return false;
        const [, field, op, raw] = m;
        const value = ctx[field];
        const val = raw.trim();
        if (op === "==")
            return String(value) === val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
        if (op === "!=")
            return String(value) !== val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
        // parse array literal
        const arrMatch = val.match(/^\[(.*)\]$/);
        const list = arrMatch
            ? arrMatch[1].split(",").map((s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
            : [val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")];
        if (op === "in")
            return list.includes(String(value));
        if (op === "not in")
            return !list.includes(String(value));
        return false;
    }
    catch {
        return false;
    }
}
function evalRule(rule, ctx) {
    if (rule.match) {
        if (rule.match.actor && !matchAny(ctx.actor, rule.match.actor))
            return false;
        if (rule.match.action && !matchAny(ctx.action, rule.match.action))
            return false;
        if (rule.match.target && !matchAny(ctx.target, rule.match.target))
            return false;
        if (rule.match.tool && !matchAny(ctx.tool, rule.match.tool))
            return false;
        return true;
    }
    if (rule.condition)
        return evalCondition(rule.condition, ctx);
    return false;
}
// ==================== GOVERNANCE GATE ====================
/**
 * GovernanceGate is the in-mesh decision point. Place it at the request
 * boundary so every agent-to-agent call is evaluated before dispatch.
 *
 * Decision precedence:
 *   1. If an Actra adapter is set, delegate to it (highest fidelity).
 *   2. Otherwise, evaluate rules in priority order (higher priority first).
 *   3. If no rule matches, return `default_action`.
 *   4. On evaluation error: `failClosed` ? deny : allow.
 */
export class GovernanceGate {
    policy;
    failClosed;
    actra;
    agt;
    nc;
    approvalTimeoutMs;
    constructor(opts = {}) {
        this.failClosed = opts.failClosed ?? false;
        this.actra = opts.actra;
        this.agt = opts.agt;
        this.nc = opts.nc;
        this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 300_000;
        if (opts.policy) {
            this.policy = opts.policy;
        }
        else if (opts.policyPath) {
            this.policy = JSON.parse(readFileSync(opts.policyPath, "utf8"));
        }
        else {
            this.policy = null;
        }
    }
    /** Attach an Actra engine adapter at runtime. */
    useActra(adapter) {
        this.actra = adapter;
        return this;
    }
    /** Attach an AGT kernel adapter at runtime. */
    useAgt(adapter) {
        this.agt = adapter;
        return this;
    }
    /** Attach a NATS connection for the approval workflow. */
    setConnection(nc) {
        this.nc = nc;
        return this;
    }
    /** Hot-reload policy (called on `mesh.policy.{version}.updated` events). */
    reloadPolicy(policy) {
        this.policy = policy;
    }
    /** True if the gate has a policy or adapter configured. */
    get isEnabled() {
        return this.policy !== null || this.actra !== undefined;
    }
    /**
     * Evaluate a request against policy. Returns a PolicyResult.
     * Never throws — evaluation errors yield a deny (fail-closed) or allow.
     */
    async evaluate(ctx) {
        // 1. Delegate to Actra if configured
        if (this.actra) {
            try {
                return await this.actra.evaluate(ctx);
            }
            catch (e) {
                if (this.failClosed) {
                    return { decision: "deny", rule: "actra-error", reason: `Actra evaluation failed: ${e.message}`, context: ctx };
                }
                return { decision: "allow", rule: "actra-error-fallback", reason: `Actra failed, allowing (fail-open): ${e.message}`, context: ctx };
            }
        }
        // 2. No policy and no adapter
        if (!this.policy) {
            if (this.failClosed) {
                return { decision: "deny", rule: "no-policy", reason: "No policy configured (fail-closed)", context: ctx };
            }
            return { decision: "allow", rule: "no-policy-dev", reason: "No policy configured (dev-permissive)", context: ctx };
        }
        // 3. Evaluate rules in priority order (desc), then declaration order
        try {
            const sorted = [...this.policy.rules]
                .map((r, i) => ({ r, i }))
                .sort((a, b) => (b.r.priority ?? 0) - (a.r.priority ?? 0) || a.i - b.i);
            for (const { r } of sorted) {
                if (evalRule(r, ctx)) {
                    return {
                        decision: r.effect,
                        rule: r.name,
                        reason: r.description ?? `matched rule ${r.name}`,
                        approvers: r.approvers,
                        context: ctx,
                    };
                }
            }
            return { decision: this.policy.default_action, rule: "default", reason: `no rule matched; default=${this.policy.default_action}`, context: ctx };
        }
        catch (e) {
            if (this.failClosed) {
                return { decision: "deny", rule: "eval-error", reason: `Policy evaluation error: ${e.message}`, context: ctx };
            }
            return { decision: "allow", rule: "eval-error-fallback", reason: `Eval failed, allowing (fail-open): ${e.message}`, context: ctx };
        }
    }
    /**
     * Resolve the verified actor identity for an envelope.
     * Uses AGT if configured; else falls back to `from_identity` (ACL) or `from`.
     */
    async resolveActor(envelope) {
        if (this.agt) {
            try {
                return await this.agt.resolveIdentity(envelope);
            }
            catch {
                // fall through
            }
        }
        return envelope.from_identity || envelope.from || "*";
    }
    /**
     * Run the full gate + approval flow for an inbound request.
     * Returns a PolicyResult. If `require_approval`, blocks until the approver
     * responds (via `mesh.approval.{task_id}.response`) or the timeout fires.
     */
    async authorize(envelope) {
        const actor = await this.resolveActor(envelope);
        const skill = envelope.payload?.skill || envelope.payload?.action || "*";
        const ctx = {
            actor,
            action: skill,
            target: envelope.to || "*",
            tool: envelope.payload?.tool,
            envelope,
        };
        const result = await this.evaluate(ctx);
        if (result.decision !== "require_approval")
            return result;
        // Approval workflow
        const approvers = result.approvers || [];
        const approved = await this.requestApproval(ctx, approvers, envelope.task_id || uuid());
        return {
            decision: approved ? "allow" : "deny",
            rule: result.rule ? `${result.rule} (approval)` : "approval",
            reason: approved ? "Approved by approver" : "Approval denied or timed out",
            approvers,
            context: ctx,
        };
    }
    /**
     * Publish an approval request and await the response.
     * Subject: mesh.approval.{task_id}.request  /  .response
     * Falls back to `allow` (fail-open) if no NATS connection.
     */
    async requestApproval(ctx, approvers, taskId) {
        if (!this.nc) {
            // No connection -> cannot do async approval. Fail-closed? fail-open?
            // Fail-open in dev, fail-closed in prod (failClosed applies).
            return !this.failClosed;
        }
        if (this.agt) {
            try {
                return await this.agt.requestApproval(ctx, approvers);
            }
            catch {
                // fall through to mesh-native workflow
            }
        }
        const sc = new TextEncoder();
        const dc = new TextDecoder();
        const reqSubject = `mesh.approval.${taskId}.request`;
        const respSubject = `mesh.approval.${taskId}.response`;
        const sub = this.nc.subscribe(respSubject, { max: 1 });
        this.nc.publish(reqSubject, sc.encode(JSON.stringify({
            v: "1.0.0", id: uuid(), type: "approval_request",
            ts: new Date().toISOString(), from: ctx.target,
            payload: { task_id: taskId, actor: ctx.actor, action: ctx.action, approvers },
        })));
        const timer = new Promise((resolve) => setTimeout(() => resolve(false), this.approvalTimeoutMs));
        const reply = new Promise((resolve) => {
            (async () => {
                for await (const msg of sub) {
                    const env = JSON.parse(dc.decode(msg.data));
                    resolve(env.payload?.approved === true);
                    return;
                }
                resolve(false);
            })();
        });
        return Promise.race([reply, timer]);
    }
}
// ==================== CONVENIENCE: POLICY BUILDER ====================
/** Builder for common policy patterns. */
export const PolicyBuilder = {
    /** Fail-closed default-deny with an explicit allowlist. */
    allowlist(allowed, opts = {}) {
        const rules = allowed.map((a, i) => ({
            name: `allow-${i}`,
            match: { actor: a.actor, action: a.action, tool: a.tool },
            effect: "allow",
            priority: 100,
        }));
        // require_approval examples for destructive actions
        return {
            apiVersion: "governance.synapse/v1",
            name: "allowlist",
            version: "1.0",
            default_action: "deny",
            rules,
        };
    },
    /** Block a set of tools/actions for everyone. */
    denyList(denied) {
        return {
            apiVersion: "governance.synapse/v1",
            name: "denylist",
            version: "1.0",
            default_action: "allow",
            rules: denied.map((d, i) => ({
                name: `deny-${i}`,
                match: { action: d.action, tool: d.tool },
                effect: "deny",
                priority: 200,
            })),
        };
    },
    /** Require approval for named actions (maps to task state input_required). */
    requireApprovalFor(actions, approvers) {
        return {
            apiVersion: "governance.synapse/v1",
            name: "approval-gated",
            version: "1.0",
            default_action: "allow",
            rules: actions.map((a) => ({
                name: `approve-${a}`,
                match: { action: a },
                effect: "require_approval",
                priority: 150,
                approvers,
            })),
        };
    },
};
// ==================== ACTRA ADAPTER SHIM ====================
/**
 * Lazy adapter that loads `@getactra/actra` if installed and delegates
 * evaluation to its WASM engine. Returns null if Actra isn't available.
 *
 * Usage:
 *   const actra = await createActraAdapter("./policies/mesh-policy.yaml");
 *   if (actra) gate.useActra(actra);
 */
export async function createActraAdapter(_policyPath) {
    try {
        // Dynamic import — only requires @getactra/actra if the user installed it.
        // Specifier kept dynamic so TS doesn't statically resolve an optional peer dep.
        const specifier = "@getactra/actra";
        const mod = await import(/* @vite-ignore */ specifier);
        const engine = mod.default ?? mod.Actra ?? mod;
        return {
            async evaluate(ctx) {
                // Actra's API: engine.evaluate({ actor, action, target, tool })
                const decision = await engine.evaluate({
                    actor: ctx.actor, action: ctx.action, target: ctx.target, tool: ctx.tool,
                });
                const effect = decision.allow === false || decision.decision === "deny"
                    ? "deny"
                    : decision.decision === "require_approval"
                        ? "require_approval"
                        : "allow";
                return {
                    decision: effect,
                    rule: decision.rule || "actra",
                    reason: decision.reason || "Actra evaluation",
                    approvers: decision.approvers,
                    context: ctx,
                };
            },
        };
    }
    catch {
        return null; // Actra not installed — caller uses built-in engine
    }
}
// ==================== AGT ADAPTER SHIM ====================
/**
 * Lazy adapter for `@microsoft/agent-governance-sdk`. Returns null if not installed.
 * The heavier GovernanceKernel (Python) can also be wired via a custom AgtAdapter
 * that calls the kernel over HTTP.
 */
export async function createAgtAdapter(opts = {}) {
    try {
        const specifier = "@microsoft/agent-governance-sdk";
        const mod = await import(/* @vite-ignore */ specifier);
        const PolicyEngine = mod.PolicyEngine ?? mod.default;
        let policy = null;
        if (opts.policyPath) {
            policy = JSON.parse(readFileSync(opts.policyPath, "utf8"));
        }
        return {
            async resolveIdentity(envelope) {
                // AGT DID resolution: prefer signed from_identity, else from.
                return envelope.from_identity || envelope.from || "anon";
            },
            async getPolicy() {
                if (policy)
                    return policy;
                // Minimal default — real deployments pass a compiled master policy.
                return PolicyBuilder.denyList([]);
            },
            async requestApproval(ctx, approvers) {
                // Delegate to AGT kernel over HTTP if configured.
                if (!opts.kernelUrl)
                    return false;
                const r = await fetch(`${opts.kernelUrl}/approval`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ...ctx, approvers }),
                });
                const j = await r.json();
                return j.approved === true;
            },
        };
    }
    catch {
        return null;
    }
}
export default GovernanceGate;
//# sourceMappingURL=governance.js.map