/** Governance error codes (extend envelope.md). */
export declare const GOV_ERROR: {
    readonly GOVERNANCE_DENIED: 4003;
    readonly APPROVAL_REQUIRED: 4004;
    readonly POLICY_EVALUATION_FAILED: 4005;
};
/** A policy decision returned by the gate. */
export type Decision = "allow" | "deny" | "require_approval";
export interface PolicyContext {
    /** Verified caller identity (DID or ACL identity). "*" if unsigned/dev mode. */
    actor: string;
    /** Skill being invoked (envelope.payload.skill). */
    action: string;
    /** Target agent id (envelope.to). */
    target: string;
    /** Tool the agent will call on the backend, if known. */
    tool?: string;
    /** Full envelope, for advanced rules. */
    envelope?: Record<string, any>;
}
export interface PolicyResult {
    decision: Decision;
    /** Rule that fired, for explainability/audit. */
    rule?: string;
    /** Human-readable reason. */
    reason?: string;
    /** For require_approval: who must approve. */
    approvers?: string[];
    /** Evaluated context snapshot (for audit log). */
    context?: PolicyContext;
}
export interface PolicyRule {
    name: string;
    /** Condition expression evaluated against the PolicyContext. */
    condition?: string;
    /** Literal match shortcut (no expression engine needed). */
    match?: {
        actor?: string | string[];
        action?: string | string[];
        target?: string | string[];
        tool?: string | string[];
    };
    effect: Decision;
    priority?: number;
    approvers?: string[];
    description?: string;
}
export interface PolicyDocument {
    apiVersion?: string;
    name: string;
    version?: string;
    /** Default decision when no rule matches. "deny" = fail-closed. */
    default_action: Decision;
    rules: PolicyRule[];
}
export interface GovernanceOptions {
    /** Inline policy document. */
    policy?: PolicyDocument;
    /** Path to a JSON policy file. */
    policyPath?: string;
    /**
     * Fail-closed mode: if the gate cannot evaluate (no policy, eval error),
     * deny the request. Default: false (dev-permissive) — set true in prod.
     */
    failClosed?: boolean;
    /** Optional Actra engine adapter (see useActra). */
    actra?: ActraAdapter;
    /** Optional AGT kernel adapter (see useAgt). */
    agt?: AgtAdapter;
    /** Optional NATS connection for approval workflow. */
    nc?: any;
    /** Approval request timeout (ms). Default 5 min. */
    approvalTimeoutMs?: number;
}
/**
 * Adapter for the real Actra in-process engine (`@getactra/actra`).
 * Implement and pass via `useActra()` to delegate evaluation to Actra's
 * WASM engine instead of the built-in evaluator.
 */
export interface ActraAdapter {
    evaluate(context: PolicyContext): Promise<PolicyResult>;
}
/**
 * Adapter for Microsoft AGT (`@microsoft/agent-governance-sdk` / Python kernel).
 * AGT owns the identity root, master policy, and approval workflow.
 */
export interface AgtAdapter {
    /** Resolve a verified identity for an envelope (DID lookup). */
    resolveIdentity(envelope: Record<string, any>): Promise<string>;
    /** Fetch the canonical policy compiled from AGT's master policy. */
    getPolicy(): Promise<PolicyDocument>;
    /** Request approval via AGT's approver workflow. Returns true if approved. */
    requestApproval(ctx: PolicyContext, approvers: string[]): Promise<boolean>;
}
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
export declare class GovernanceGate {
    private policy;
    private failClosed;
    private actra?;
    private agt?;
    private nc?;
    private approvalTimeoutMs;
    constructor(opts?: GovernanceOptions);
    /** Attach an Actra engine adapter at runtime. */
    useActra(adapter: ActraAdapter): this;
    /** Attach an AGT kernel adapter at runtime. */
    useAgt(adapter: AgtAdapter): this;
    /** Attach a NATS connection for the approval workflow. */
    setConnection(nc: any): this;
    /** Hot-reload policy (called on `mesh.policy.{version}.updated` events). */
    reloadPolicy(policy: PolicyDocument): void;
    /** True if the gate has a policy or adapter configured. */
    get isEnabled(): boolean;
    /**
     * Evaluate a request against policy. Returns a PolicyResult.
     * Never throws — evaluation errors yield a deny (fail-closed) or allow.
     */
    evaluate(ctx: PolicyContext): Promise<PolicyResult>;
    /**
     * Resolve the verified actor identity for an envelope.
     * Uses AGT if configured; else falls back to `from_identity` (ACL) or `from`.
     */
    resolveActor(envelope: Record<string, any>): Promise<string>;
    /**
     * Run the full gate + approval flow for an inbound request.
     * Returns a PolicyResult. If `require_approval`, blocks until the approver
     * responds (via `mesh.approval.{task_id}.response`) or the timeout fires.
     */
    authorize(envelope: Record<string, any>): Promise<PolicyResult>;
    /**
     * Publish an approval request and await the response.
     * Subject: mesh.approval.{task_id}.request  /  .response
     * Falls back to `allow` (fail-open) if no NATS connection.
     */
    requestApproval(ctx: PolicyContext, approvers: string[], taskId: string): Promise<boolean>;
}
/** Builder for common policy patterns. */
export declare const PolicyBuilder: {
    /** Fail-closed default-deny with an explicit allowlist. */
    allowlist(allowed: {
        actor?: string;
        action?: string;
        tool?: string;
    }[], opts?: {
        approvers?: Record<string, string[]>;
    }): PolicyDocument;
    /** Block a set of tools/actions for everyone. */
    denyList(denied: {
        action?: string | string[];
        tool?: string | string[];
    }[]): PolicyDocument;
    /** Require approval for named actions (maps to task state input_required). */
    requireApprovalFor(actions: string[], approvers: string[]): PolicyDocument;
};
/**
 * Lazy adapter that loads `@getactra/actra` if installed and delegates
 * evaluation to its WASM engine. Returns null if Actra isn't available.
 *
 * Usage:
 *   const actra = await createActraAdapter("./policies/mesh-policy.yaml");
 *   if (actra) gate.useActra(actra);
 */
export declare function createActraAdapter(_policyPath: string): Promise<ActraAdapter | null>;
/**
 * Lazy adapter for `@microsoft/agent-governance-sdk`. Returns null if not installed.
 * The heavier GovernanceKernel (Python) can also be wired via a custom AgtAdapter
 * that calls the kernel over HTTP.
 */
export declare function createAgtAdapter(opts?: {
    policyPath?: string;
    kernelUrl?: string;
}): Promise<AgtAdapter | null>;
export default GovernanceGate;
//# sourceMappingURL=governance.d.ts.map