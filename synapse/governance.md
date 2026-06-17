# Governance — Runtime Policy, Identity, and Enforcement for the Mesh

Synapse's primitives let any agent talk to any agent. **Governance** closes the
"default-open" gap: it makes agent-to-agent calls **verifiable, authorize-able,
enforceable, and auditable** — so the mesh is safe to expose to real credentials
and real actions, not just demos.

This doc covers the built-in SDK governance layer and how it layers with three
external engines:

| Engine | Layer | Runtime | Role in Synapse |
|--------|-------|---------|-----------------|
| **Microsoft AGT** | Identity root + master policy + approval workflow | Python / TS / .NET / Rust / Go | The trust backbone — mints agent DIDs, holds the canonical policy |
| **Actra** | In-process policy decision (allow / deny / require_approval) | JS / TS / WASM / edge | The mesh gate — evaluates at the request/respond envelope boundary |
| **EnforceCore** | Tool-call enforcement + PII redaction + Merkle audit | Python | Inside each agent — decorates backend calls, redacts results, logs tamper-evident trails |

The three are **complementary, not redundant**. They map onto distinct layers of
the trust model:

```
caller ──signed envelope──▶ [NATS subject perms]   transport auth (Layer 1)
                            ──▶ [Actra gate]        mesh decision  (Layer 2)
                                 ──▶ [agent handler]
                                      ──▶ [EnforceCore @enforce]  tool boundary (Layer 3)
                                            ──▶ backend (curl/aws/db)
                                      ◀── [EnforceCore Redactor + Merkle audit]
                            ◀── signed response ── [AGT-verified identity in audit log]
```

A request that passes one layer is re-checked at the next. This is defense in
depth — the OWASP Agentic Top-10 coverage AGT advertises becomes Synapse's.

---

## Why governance is a first-class concern

Without governance, Synapse is **default-open**:

- `from` is a claimed string, not a verified identity — anyone can impersonate anyone.
- `capabilities` are descriptive, not enforceable — any connected agent can call any skill on any other.
- Task prompts and results land in `TASK_STORE` verbatim — secrets and PII persist unencrypted.
- There is no audit trail of *who was permitted to do what, by which policy rule*.

For a weekend demo mesh this is fine. For "infrastructure that carries real
calls with real credentials" it is a maturity gap, not a config choice. The
governance layer inverts it: **the first config a new agent generates is secure,
and you opt out, not in.**

---

## The built-in SDK governance gate

The SDK ships a self-contained `GovernanceGate` (`synapse-nats-sdk/governance`)
that needs **no external dependencies** to run. It evaluates a policy document
at the request boundary and returns `allow` / `deny` / `require_approval`. When
Actra or AGT are installed, the gate transparently delegates to them for higher
fidelity; otherwise the built-in evaluator handles common patterns.

### Error codes (extend `envelope.md`)

| Code | Name | Retryable | Meaning |
|------|------|-----------|---------|
| 4003 | GOVERNANCE_DENIED | no | Action blocked by policy |
| 4004 | APPROVAL_REQUIRED | yes | Action requires approver sign-off (task → `input_required`) |
| 4005 | POLICY_EVALUATION_FAILED | no | Gate could not evaluate (fail-closed → deny) |

### Policy document (Actra/AGT-compatible)

```jsonc
{
  "apiVersion": "governance.synapse/v1",
  "name": "production-mesh",
  "version": "1.0",
  "default_action": "deny",          // fail-closed when no rule matches
  "rules": [
    {
      "name": "allow-chat",
      "match": { "action": "chat" },
      "effect": "allow",
      "priority": 100
    },
    {
      "name": "block-destructive",
      "match": { "tool": ["drop_table", "execute_shell"] },
      "effect": "deny",
      "priority": 200,
      "description": "Destructive ops require human approval"
    },
    {
      "name": "approve-send-email",
      "match": { "action": "send_email" },
      "effect": "require_approval",
      "approvers": ["security-team"],
      "priority": 150
    },
    {
      "name": "finance-scoped",
      "condition": "actor in [\"did:mesh:finance-bot\", \"did:mesh:treasury\"]",
      "effect": "allow",
      "priority": 120
    }
  ]
}
```

Rules support either `match` (literal/wildcard on actor/action/target/tool) or
`condition` (a small expression DSL: `field op value`, `op` ∈ `==, !=, in, not in`).
For richer policies, install Actra and the gate uses its WASM engine.

### Wiring the gate into an agent

```typescript
import Synapse, { PolicyBuilder } from "synapse-nats-sdk";

const mesh = await Synapse.connect("nats://localhost:4222");

await mesh.register({
  name: "Treasury Agent",
  capabilities: ["payments", "chat"],
  skills: [{ id: "payments", name: "Payments", description: "Send payments" }],
  did: "did:mesh:treasury",                      // verified identity (AGT-issued)
  policy_ref: "policies/treasury.json",          // this agent's policy
  public_key_fingerprint: "sha256:ab12cd34...",  // for envelope signature verify
  governance: {
    policyPath: "./policies/mesh-policy.json",
    failClosed: true,                            // prod: deny on eval error
  },
});

mesh.onRequest("payments", async (payload) => {
  // Only reached if the gate returned `allow`.
  return { status: "sent", amount: payload.input.amount };
});
```

Every inbound request now flows through the gate **before** the handler runs:

```
[GOV] ✓ Allowed did:mesh:finance-bot -> payments (allow-chat)
[GOV] ✗ Denied anon -> payments: block-destructive
[GOV] ⏳ Approval required did:mesh:ops -> send_email
```

### Policy builders

```typescript
import { PolicyBuilder } from "synapse-nats-sdk/governance";

// Fail-closed allowlist
PolicyBuilder.allowlist([
  { actor: "did:mesh:finance-bot", action: "payments" },
  { actor: "did:mesh:ops", action: "chat" },
]);

// Block specific tools for everyone
PolicyBuilder.denyList([{ tool: ["drop_table", "execute_shell"] }]);

// Require approval for named actions (→ task state input_required)
PolicyBuilder.requireApprovalFor(["send_email", "deploy"], ["security-team"]);
```

### Hot-reload

Publish policy updates on `mesh.policy.{version}.updated`; agents call
`mesh.reloadGovernancePolicy(policy)` to apply without restart.

---

## Phase-by-phase integration with AGT / Actra / EnforceCore

The built-in gate covers ~80% of needs with zero dependencies. For full
governance (identity root, master policy, tamper-proof audit), layer the three
engines in this order. **AGT is load-bearing — do it first.**

### Phase 0 — Trust root (AGT)

Stand up an AGT `GovernanceKernel` as a mesh-sidecar (a long-running process
alongside the registry-service). It owns the operator/account keys, the master
policy, and the DID registry.

1. Mint a DID per Synapse agent (`did:mesh:grip-cli-001`).
2. Each agent's creds file carries both a NATS NKey **and** an AGT DID + signing key.
3. Extend the `AgentManifest` with `did` and `policy_ref` (the SDK already
   supports these fields — see above). The registry-service stores and serves
   them. Discovery now returns **verifiable identity**, not just claimed `from`.

**Closes:** identity provable (not claimed); registry as trust root.

### Phase 1 — Signed envelopes (AGT + SDK ACL)

The SDK already ships `ACLClient` (`synapse-nats-sdk/acl`) — Ed25519 envelope
signing/verification with a trust store. Wire it so:

1. Every outgoing envelope is signed with the agent's key (`from_identity`,
   `from_key_fingerprint`, `signature` fields — already in the `Envelope` type).
2. On receive, verify the signature against the `did` from the registry manifest.
   Reject unsigned/mismatched envelopes with error **3004 IDENTITY_MISMATCH**
   (already defined in `envelope.md`).
3. `TASK_STATE_LOG` records the *verified* DID, not the claimed `from`.

**Closes:** auditability with verified identity — the audit log becomes evidence.

### Phase 2 — Mesh decision gate (Actra)

Actra runs in-process in the same JS/TS runtime as the SDK — zero new infra.

```typescript
import { GovernanceGate, createActraAdapter } from "synapse-nats-sdk/governance";

const actra = await createActraAdapter("./policies/mesh-policy.yaml");
const gate = new GovernanceGate({ failClosed: true });
if (actra) gate.useActra(actra);
```

The gate evaluates `{actor, action, target, tool}` before dispatch. On `deny` →
fail the task with **4003 GOVERNANCE_DENIED** and never invoke the backend. On
`require_approval` → transition the task to `input_required` (Phase 4).

Use the **Actra Claude Skill** to *generate* policies from natural language —
"agents in finance may not call skills tagged destructive" → valid YAML. This
closes the "policy is hard to write" gap that makes governance unusable.

**Closes:** authorization — capabilities become enforceable, not descriptive.
This is the layer that makes default-open impossible: even if NATS auth is open,
a request without a valid policy decision is structurally blocked.

### Phase 3 — In-agent enforcement + audit (EnforceCore)

EnforceCore is Python — it lives inside the Python bridges (grip-cli, omp),
decorating the actual backend call. See `examples/governance/enforcecore-bridge.py`
for the full pattern. In short:

```python
from enforcecore import enforce

@enforce(policy="policies/agent-tools.yaml")
async def backend_chat(text: str) -> dict:
    return await self.grip.chat(text)   # the real subprocess call
```

This is the **second** check — even if Actra allowed the request, the agent's
own tool calls are re-gated at the runtime boundary. Enable three EnforceCore
subsystems:

- **Redactor** — on the result before `task_store.complete()`. Stops
  secrets/PII from landing in `TASK_STORE` (the exact failure that occurs when
  credentials are inlined in task prompts).
- **Guard** — time/memory/cost/kill limits around backend calls. Gives Synapse
  resource governance it otherwise lacks (the semaphore gates concurrency, not
  cost or memory).
- **Merkle audit trail** — every enforced call appends a tamper-evident record.
  Publish the Merkle head to `mesh.audit.{agent_id}.head` so the mesh has a
  continuous, cross-agent verifiable audit chain.

**Closes:** credential handling (secrets never persist); resource governance;
tamper-proof audit that complements AGT's identity layer.

### Phase 4 — Approval workflow (AGT ↔ Synapse states)

`require_approval` maps onto Synapse's existing `input_required` task state —
**no protocol change needed.**

1. Gate/AGT returns `require_approval` → bridge calls
   `task_store.request_input(task_id, agent_id, question="Requires approval: security-team")`.
2. AGT's approver workflow publishes to `mesh.approval.{task_id}.request`; an
   approver service (human or automated) decides and replies on
   `mesh.approval.{task_id}.response`.
3. Bridge receives approval → `task_store.supply_input()` → back to `working` →
   proceeds. Denial → `task_store.fail()` with 4003.

The built-in `GovernanceGate.requestApproval()` implements the mesh-native
workflow when AGT isn't configured.

**Closes:** human-in-the-loop governance with zero protocol change.

### Phase 5 — One policy, three layers

Define policy once in AGT's `governance.toolkit/v1` YAML (most expressive).
Compile it to: (a) Actra YAML for the mesh gate, (b) EnforceCore YAML for the
agent decorator, (c) NATS subject permissions for transport scoping. Store in a
`POLICY_STORE` KV bucket, version it, emit `mesh.policy.{version}.updated`.

### Phase 6 — Secure bootstrap generator

`synapse init --secure` invokes AGT to mint DIDs + keys, the Actra Claude skill
to generate a starter policy from a natural-language description, emits a
hardened `nats.conf` with subject perms derived from the policy, and writes
per-agent creds files scoped to DID + policy. **Its invariant: it cannot output
an insecure config.** No `no_auth_user` on non-loopback binds, no unsigned
envelopes, no agent without a `policy_ref`. The secure path becomes the lazy
path — the maturity inversion that closes the default-open gap.

---

## What this achieves for Synapse

| Gap | Closed by | How |
|-----|-----------|-----|
| Identity provable, not claimed | AGT DID + ACL envelope signature | `from` is signed, verified against registry |
| Authorization enforceable | Actra gate + AGT policy | allow/deny at request boundary |
| Registry as trust root | AGT identity in manifest | registry serves DIDs + keys + policy_refs |
| Capabilities → enforceable | Actra decision in SDK | mesh-level allow/deny before dispatch |
| Credential handling | EnforceCore Redactor | secrets/PII redacted before `TASK_STORE` |
| Auditability with verified identity | EnforceCore Merkle + AGT DID | tamper-evident, identity-attributed chain |
| "Default-open" maturity gap | Phase 6 bootstrap generator | secure config is the default output |

Beyond closing gaps, the combination gives Synapse three things it categorically
lacks today:

1. **Defense in depth** — transport perms → mesh gate → tool boundary → audit.
2. **Explainable denials** — every denial carries the rule that fired, the
   evaluated context, and a Merkle-audited record.
3. **Compliance posture** — EnforceCore is EU AI Act aligned; AGT covers OWASP
   Agentic Top-10 10/10. Synapse alone has neither.

---

## Honest caveats

- **This adds ceremony.** AGT + Actra + EnforceCore is real weight. Phase 5
  (one policy compiled to three layers) and Phase 6 (generator) mitigate it,
  but it's more moving parts than bare Synapse. Right for production/regulated;
  wrong for a weekend demo mesh.
- **Three upstream dependencies** of varying maturity (AGT is public-preview;
  EnforceCore is small; Actra is young). The reversibility argument holds —
  envelope logic is transport-agnostic — but the governance layer is a real
  dependency.
- **AGT is load-bearing.** If you do only one, do AGT — identity + master policy
  is the foundation Actra and EnforceCore build on. Actra-without-AGT is policy
  without identity; EnforceCore-without-AGT is enforcement without a trust root.
  Sequence: Phase 0 first.

---

## See also

- [envelope.md](./envelope.md) — error codes (3004 IDENTITY_MISMATCH, 4003/4004/4005 governance)
- [states.md](./states.md) — `input_required` state used by the approval workflow
- [acl.md](./acl.md) — `ACLClient` Ed25519 signing/verification (Phase 1)
- [security.md](./security.md) — NKeys, JWT auth, signed envelopes
- [deployment.md](./deployment.md) — production hardening (governance is the next layer after transport/auth)
- [examples/governance/](./examples/governance/) — `enforcecore-bridge.py`, policy samples
