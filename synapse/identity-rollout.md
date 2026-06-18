# Identity Rollout — Staged Path to a Hardened Mesh

Synapse's identity infrastructure is sound (Ed25519 signing, NKeys, trust
stores, revocation, rotation, cross-account isolation), but the secure path is
**opt-in and manual**. This doc is the staged rollout methodology — the exact
sequence to go from default-open to fully secured, with zero downtime.

## The Problem

Out of the box, Synapse is **default-open**: any connected process can
impersonate any agent (`from` is just a claim), read any task result from KV,
and call any skill on any other agent. The secure path exists in the SDK
(`ACLClient`, NKeys, signed envelopes) but isn't wired on by default.

**The fix is not "turn on auth."** It's a staged rollout that adds identity
in layers, each verifiable independently, with a transitional mode that
prevents downtime.

## The Three Stages

| Stage | What | Layer | Disruption | Can be undone? |
|-------|------|-------|------------|----------------|
| 1 | DIDs + public key fingerprints in manifests | Registry / trust root | None (additive) | Yes (remove fields) |
| 2 | NKey auth + per-agent subject permissions | Transport (NATS) | Brief NATS restart (~20s) | Yes (restore `no_auth_user`) |
| 3 | Ed25519 envelope signing | Per-message (ACL) | Coordinated cutover (verify-if-signed) | Yes (stop signing) |

### Why this order

- **Stage 1 first** because it's purely additive — no behavior change, no
  restart, no risk. It establishes the trust root (DIDs + keys) that stages 2
  and 3 depend on.
- **Stage 2 second** because transport auth is the broadest gate — it stops
  unauthenticated access to the entire mesh. It's also the simplest to verify
  (unauthenticated connections are rejected immediately).
- **Stage 3 last** because per-message signing is the most nuanced — it
  requires all agents to sign simultaneously, and the transitional mode
  (verify-if-signed) must be used to avoid rejecting unsigned messages during
  rollout.

---

## Stage 1 — Trust Root (DIDs + Key Fingerprints)

**Zero disruption.** Additive fields to manifests. No NATS restart, no behavior
change.

### Step 1: Generate Ed25519 keypairs

```python
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
import json, hashlib, os

KEYS_DIR = "~/.synapse/keys"
TRUST_DIR = "~/.synapse/trust"
AGENTS = ["grip-cli-001", "omp-cli-001", "agentspan-001"]
trust = {}

for agent_id in AGENTS:
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()
    priv_pem = priv.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    pub_pem = pub.public_bytes(serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    fp = "sha256:" + hashlib.sha256(pub_pem.encode()).hexdigest()[:16]
    did = f"did:mesh:{agent_id}"

    with open(f"{KEYS_DIR}/{agent_id}.json", "w") as f:
        json.dump({"identity": agent_id, "did": did,
                   "privateKeyPem": priv_pem, "publicKeyPem": pub_pem,
                   "fingerprint": fp}, f, indent=2)
    os.chmod(f"{KEYS_DIR}/{agent_id}.json", 0o600)

    trust[agent_id] = {
        "did": did, "public_key_pem": pub_pem, "fingerprint": fp,
        "allow_inbound": ["*"], "allow_outbound": ["*"],
        "revoked": False, "since": "2026-06-17", "trusted_pubkeys": [],
    }

with open(f"{TRUST_DIR}/trust-store.json", "w") as f:
    json.dump(trust, f, indent=2)
```

### Step 2: Add `did` + `public_key_fingerprint` to agent manifests

In each bridge's `register()` method:
```python
manifest = {
    ...
    "did": f"did:mesh:{self.agent_id}",
    "public_key_fingerprint": fp,
}
```

### Step 3: Verify

```bash
nats kv get MESH_REGISTRY grip-cli-001 --raw | jq '.did, .public_key_fingerprint'
```

---

## Stage 2 — Transport Auth (NKey + Subject Permissions)

**Brief NATS restart (~20s).** All bridges reconnect with NKey credentials.

### Step 1: Generate NKeys

```bash
nats auth nkey gen user --output ~/.synapse/nkeys/grip-cli-001.seed
nats auth nkey show ~/.synapse/nkeys/grip-cli-001.seed  # -> public key
```

### Step 2: Rewrite `nats.conf` with per-agent users

See `examples/identity/nats.conf.hardened` for the full template. Key points:

- **Remove `no_auth_user`** — unauthenticated connections must be rejected.
- **Each agent gets an NKey user** with least-privilege `publish`/`subscribe`
  permissions scoped to its own subjects.
- **Services** (registry, task-service, reputation) get password users with
  broader access for KV + JetStream.
- **Include an admin user** for operational CLI access.

### Step 3: Permission gotchas (each one took a debugging cycle)

| Gotcha | Symptom | Fix |
|--------|---------|-----|
| NATS KV subjects are **UPPERCASE** (`$KV.BUCKETNAME.key`) | `permissions violation for publish to "$KV.MESH_REGISTRY..."` | Add `"$KV.>"` (not just `"$kv.>"`) to publish allow |
| JetStream push consumers create `_inbox.*` reply subs | `permissions violation for subscription to "_inbox.*"` | Add `"_inbox.>"` (lowercase) to subscribe allow |
| nats-py `request()` uses `_INBOX.>` (uppercase) for replies | `nats: timeout` on JetStream API calls | Add `"_INBOX.>"` (uppercase) to subscribe allow |
| Caller reply subjects `_REPLY.*` are published by the agent | Agent replies vanish silently | Add `"_REPLY.>"` to publish allow |
| JetStream API calls go to `$JS.API.>` | `nats: timeout` on KV/stream operations | Add `"$JS.API.>"` to publish allow |
| Each agent doing KV operations needs `$KV.>` in BOTH pub + sub | `nats: timeout` on `kv.put()` | Add `"$KV.>"` to subscribe allow too |

### Step 4: Update bridges to connect with NKey

```python
seed = os.path.expanduser(f"~/.synapse/nkeys/{self.agent_id}.seed")
await nc.connect(nats_url, nkeys_seed=seed)
```

### Step 5: Verify

```bash
# Unauthenticated rejected
nats kv ls MESH_REGISTRY -s nats://localhost:4222
# -> Authorization Violation

# Authenticated works
nats kv ls MESH_REGISTRY -s "nats://admin:password@localhost:4222"
# -> grip-cli-001, omp-cli-001, agentspan-001
```

---

## Stage 3 — Envelope Signing (Ed25519 Sign-on-Send, Verify-on-Receive)

**Coordinated cutover with verify-if-signed transitional mode.** No downtime.

### The transitional pattern

Signing must be rolled out to ALL agents simultaneously — a signed message
received by an agent that doesn't verify is fine, but an unsigned message
received by an agent in strict mode is rejected. The fix: **verify-if-signed**
mode.

```python
def verify_envelope(env: dict) -> Tuple[bool, str]:
    # Transitional: accept unsigned envelopes
    if not env.get("signature"):
        return True, "unsigned"  # ← flip to (False, "unsigned required") when all agents sign

    # Verify signed envelopes against the trust store
    ...  # full Ed25519 verification
```

### Step 1: Add the signing module

Copy `examples/identity/envelope_signing.py` to `~/.synapse/envelope_signing.py`.
Import it in each bridge:

```python
import sys; sys.path.insert(0, "~/.synapse")
from envelope_signing import sign_envelope, verify_envelope
```

### Step 2: Sign outbound envelopes

In each bridge's `_envelope()` method (where response envelopes are built):

```python
env = { ... }  # build the envelope
if SIGNING_ENABLED:
    env = sign_envelope(env, self.agent_id)
return env
```

### Step 3: Verify inbound envelopes

In each bridge's `_process_request()`:

```python
if SIGNING_ENABLED:
    valid, ident = verify_envelope(envelope)
    if not valid:
        await self._reply_error(msg.reply, 3004, f"Identity verification failed: {ident}")
        await msg.ack()
        return
    if ident != "unsigned":
        print(f"[SIGN] Verified: {ident}")
```

### Step 4: Roll out

1. Deploy all 3 bridges with signing enabled (sign-on-send + verify-if-signed).
2. Test: responses now carry `signature`, `from_identity`, `from_key_fingerprint`.
3. Test: unsigned requests still accepted (transitional mode).
4. **Flip to strict** (optional, when confident): change `return True, "unsigned"`
   to `return False, "unsigned envelope rejected"` in `verify_envelope()`.

### Step 5: Verify

```python
# Response should carry signature fields
response = await query_agent("agentspan-001", "status")
assert "signature" in response
assert response["from_identity"] == "did:mesh:agentspan-001"
```

---

## After All Three Stages

| Layer | Status | Security |
|-------|--------|----------|
| Envelope `from` | Still present (baseline) | Claim only |
| NATS NKey auth | ✅ Enforced | Connection-level cryptographic identity |
| Subject permissions | ✅ Per-agent least privilege | Can't publish/subscribe outside scope |
| Envelope signing | ✅ Ed25519 per-message | `from` is now provable, not claimable |
| Registry DID + pubkey | ✅ Trust root | Registry serves verified identity |

**What this stops:**
- Rogue process impersonating an agent (NKey auth + envelope signing)
- Agent reading another's task results (subject permissions scope KV access)
- Agent publishing to another's inbox (publish scoped to own `mesh.agent.{id}.>`)
- Forged audit trail (signed envelopes = verified identity in every log entry)

**What this doesn't stop (yet):**
- A compromised key keeps working until revoked (add ACL revocation to the trust store)
- An authenticated agent calling any skill on any other (add the governance gate — see `governance.md`)

## See Also

- [acl.md](./acl.md) — ACLClient (TypeScript): signing, trust store, rotation, revocation
- [security.md](./security.md) — NKeys, JWT auth, multi-tenant permissions
- [governance.md](./governance.md) — Policy gate (Actra/AGT/EnforceCore integration)
- [deployment.md](./deployment.md) — Production hardening (3-account isolation, leaf deny_imports)
- [examples/identity/](./examples/identity/) — `envelope_signing.py`, `nats.conf.hardened`
