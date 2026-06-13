# Access Control & Trust

Cryptographic identity, signed envelopes, per-agent allowlists, and key revocation — so agents can cryptographically verify who is calling them and reject untrusted callers.

---

## Why ACL in a Mesh

Without ACL, any agent on the NATS server can:

1. Send requests to any other agent (`mesh.agent.*.inbox` is world-published).
2. Spoof the `from` field of an envelope (it's just a string).
3. Claim to be any agent and steal responses or poison workflows.

ACL solves this with **cryptographic identity**: each agent has a persistent Ed25519 keypair, signs every outbound envelope, and every receiving agent verifies signatures against a local **trust store**.

The result: Agent B can cryptographically confirm that the request came from Agent A, and that Agent A is on Agent B's approved callers list. If not → 403 Unauthorized.

---

## Identity Model

### Stable Agent Identities

Every ACL-enabled agent has a **persistent human-readable identity**, not a random UUID. Format: `<org>/<name>`.

```
drolu/pi-bmc-agent
drolu/omp-orchestrator
acme/code-review-agent
globex/security-agent
```

Identities are stable across restarts. This is critical — if identities changed on every boot, every signature would be useless (agents would need to re-trust each other constantly).

### Ed25519 Keypairs

Each agent gets one Ed25519 keypair:

| Component | Stored At | Shared? |
|---|---|---|
| Private key | Only with the agent (file, env var, secret manager) | **Never** |
| Public key | In every other agent's trust store | **Yes** |

Ed25519 was chosen because:
- Already used by NATS for NKeys (familiar)
- Fast signatures, small keys (32 bytes)
- No randomness bugs in deterministic signing
- Built into Node.js 18+, Python 3.8+, Go stdlib

### Signed Envelope Format

A signed Synapse envelope adds three fields to the standard envelope:

```json
{
  "v": "1.0.0",
  "id": "uuid",
  "type": "request",
  "ts": "2026-06-13T12:00:00Z",
  "from": "ephemeral-id-abc",
  "to": "target-agent-id",
  "payload": { "skill": "fetch-transactions", "input": {} },

  "from_identity": "drolu/omp-orchestrator",
  "from_key_fingerprint": "sha256:a1b2c3d4...",
  "signature": "base64-ed25519-signature"
}
```

### Signature Algorithm

```
canonical = json.stringify({
  id, type, ts, from, to, task_id, trace, payload
})  // sorted keys, deterministic encoding

signature = ed25519_sign(canonical, private_key)
```

The signature covers all identity-relevant fields. The `signature` and signing metadata fields are excluded (can't sign the signature itself).

---

## Trust Store

Each agent maintains a local trust store that maps identities to:

1. **Public key** — for verifying their signatures
2. **Allowlist** — who this agent is allowed to call (outbound ACL)
3. **Caller list** — who this agent will accept requests from (inbound ACL)
4. **Revocation flag** — if `revoked: true`, ignore this identity

### Trust Store Format (JSON)

```json
{
  "drolu/omp-orchestrator": {
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----",
    "fingerprint": "sha256:a1b2c3d4e5f6...",
    "allow_outbound": ["drolu/pi-bmc-agent", "drolu/pi-code-agent"],
    "allow_inbound": ["*"],
    "revoked": false,
    "since": "2026-06-13T00:00:00Z"
  },
  "drolu/pi-bmc-agent": {
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...",
    "fingerprint": "sha256:b2c3d4e5f6...",
    "allow_outbound": [],
    "allow_inbound": ["drolu/omp-orchestrator"],
    "revoked": false,
    "since": "2026-06-13T00:00:00Z"
  },
  "acme/code-review": {
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...",
    "fingerprint": "sha256:c3d4e5f6...",
    "allow_outbound": [],
    "allow_inbound": ["drolu/omp-orchestrator"],
    "revoked": true,
    "revoked_at": "2026-06-12T15:00:00Z",
    "revocation_reason": "agent compromised"
  }
}
```

### Inbound vs Outbound ACL

| Direction | Field | Meaning |
|---|---|---|
| **Inbound** | `allow_inbound` on the **receiving** agent | Who is allowed to call me |
| **Outbound** | `allow_outbound` on the **sending** agent | Who am I allowed to call |

Both must pass for a call to succeed. This is defense-in-depth: even if a malicious agent bypasses the receiver's check (e.g., via a bug), it can only reach agents it's outbound-allowed to contact.

### Wildcards

- `"*"` in `allow_inbound` = accept from anyone with a valid signature
- `"org/*"` in allow rules = match any identity in that org
- Empty `allow_inbound` = reject all callers (useful for one-way agents)

---

## Verification Flow

When Agent B receives a request from Agent A:

```
1. Does envelope have from_identity + signature?
   → No: reject with error 2001 INVALID_ENVELOPE (legacy unauthenticated)
   
2. Is from_identity in my trust store?
   → No: reject with error 403 "unknown identity"
   
3. Is the identity revoked?
   → Yes: reject with error 403 "identity revoked"

4. Does fingerprint match trust store record?
   → No: reject with error 403 "fingerprint mismatch"

5. Verify ed25519 signature on canonical envelope
   → Invalid: reject with error 403 "invalid signature"

6. Is from_identity in my allow_inbound list?
   → No: reject with error 403 "caller not authorized"

7. Pass to handler
```

---

## Key Generation

### Generate a Keypair (Node.js / TypeScript)

```js
import { generateKeyPairSync, createPrivateKey } from 'crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem  = publicKey.export({ type: 'spki', format: 'pem' });
```

### Generate a Keypair (Python)

```python
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

priv = Ed25519PrivateKey.generate()
priv_pem = priv.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
pub_pem  = priv.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
```

### Generate a Keypair (Go)

```go
import (
    "crypto/ed25519"
    "crypto/rand"
)

pub, priv, err := ed25519.GenerateKey(rand.Reader)
```

---

## TypeScript SDK: `ACLSynapse`

```typescript
import { createHash, sign, verify, generateKeyPairSync, createPrivateKey } from 'crypto';

export interface TrustEntry {
  public_key_pem: string;
  fingerprint: string;
  allow_outbound: string[];
  allow_inbound: string[];
  revoked?: boolean;
  revoked_at?: string;
  revocation_reason?: string;
  since?: string;
}

export type TrustStore = Record<string, TrustEntry>;

export interface ACLKeypair {
  identity: string;
  privateKeyPem: string;
  publicKeyPem: string;
  fingerprint: string;
}

export function generateACLKeypair(identity: string): ACLKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicKeyPem  = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const fingerprint   = 'sha256:' + createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16);
  return { identity, privateKeyPem, publicKeyPem, fingerprint };
}

export class ACLSynapse extends Synapse {
  private aclKeypair: ACLKeypair;
  private trustStore: TrustStore;

  static async connectAcl(opts: {
    url: string;
    keypair: ACLKeypair;
    trustStore: TrustStore;
  }): Promise<ACLSynapse> {
    const mesh = await Synapse.connect(opts.url);
    const self = new ACLSynapse((mesh as any).nc);
    (self as any)._id = opts.keypair.identity;
    self.aclKeypair = opts.keypair;
    self.trustStore = opts.trustStore;
    return self;
  }

  /** Sign an envelope before publishing */
  private signEnvelope<T extends Record<string, any>>(env: T): T & {
    from_identity: string;
    from_key_fingerprint: string;
    signature: string;
  } {
    const canonical = this.canonicalize(env);
    const privKey = createPrivateKey(this.aclKeypair.privateKeyPem);
    const sig = sign(null, Buffer.from(canonical), privKey);
    return {
      ...env,
      from_identity: this.aclKeypair.identity,
      from_key_fingerprint: this.aclKeypair.fingerprint,
      signature: sig.toString('base64'),
    };
  }

  /** Verify an inbound envelope. Returns { valid, error }. */
  private verifyEnvelope(env: any): { valid: boolean; error?: string; identity?: string } {
    if (!env.from_identity || !env.signature) {
      return { valid: false, error: 'missing signature fields' };
    }

    const entry = this.trustStore[env.from_identity];
    if (!entry) {
      return { valid: false, error: 'unknown identity' };
    }

    if (entry.revoked) {
      return { valid: false, error: `identity revoked: ${entry.revocation_reason || 'no reason'}` };
    }

    if (entry.fingerprint !== env.from_key_fingerprint) {
      return { valid: false, error: 'fingerprint mismatch — possible key rotation or spoofing' };
    }

    const canonical = this.canonicalize(this.stripAuthFields(env));
    const pubKey = entry.public_key_pem;
    const sig = Buffer.from(env.signature, 'base64');

    try {
      const ok = verify(null, Buffer.from(canonical), pubKey, sig);
      if (!ok) return { valid: false, error: 'invalid signature' };
    } catch (e) {
      return { valid: false, error: `verification error: ${(e as Error).message}` };
    }

    // Check inbound ACL — is this identity allowed to call us?
    const allowed = entry.allow_inbound || [];
    const caller = env.from_identity;
    const matches = allowed.some(rule => {
      if (rule === '*') return true;
      if (rule.endsWith('/*')) return caller.startsWith(rule.slice(0, -1));
      return rule === caller;
    });

    if (!matches) {
      return { valid: false, error: `caller ${caller} not in allow_inbound` };
    }

    return { valid: true, identity: env.from_identity };
  }

  private stripAuthFields<T extends Record<string, any>>(env: T): Omit<T, 'signature' | 'from_identity' | 'from_key_fingerprint'> {
    const { signature, from_identity, from_key_fingerprint, ...rest } = env;
    return rest;
  }

  private canonicalize(obj: any): string {
    return JSON.stringify(obj, Object.keys(obj).sort());
  }

  /** Override onRequest to enforce ACL */
  onRequest(skill: string, handler: (...args: any[]) => any): void {
    const wrapped = async (payload: any, ctx: any) => {
      const env = (ctx as any).__envelope;
      if (env) {
        const res = this.verifyEnvelope(env);
        if (!res.valid) {
          throw new ACLUnauthorizedError(res.error || 'unauthorized');
        }
      }
      return handler(payload, ctx);
    };
    super.onRequest(skill, wrapped);
  }

  /** Publish a signed envelope (override request to auto-sign) */
  async aclPublish(subject: string, env: any): Promise<void> {
    const signed = this.signEnvelope(env);
    this.nc.publish(subject, this.encode(signed));
  }
}

export class ACLUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ACLUnauthorizedError';
  }
}
```

---

## Python SDK: `ACLSynapse`

```python
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import utils
import json, hashlib

class ACLSynapse(Synapse):
    def __init__(self, mesh, identity: str, private_key: Ed25519PrivateKey, trust_store: dict):
        self.mesh = mesh
        self.identity = identity
        self.private_key = private_key
        self.public_key_pem = private_key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        self.fingerprint = "sha256:" + hashlib.sha256(self.public_key_pem.encode()).hexdigest()[:16]
        self.trust_store = trust_store

    def sign_envelope(self, env: dict) -> dict:
        canonical = self._canonicalize(env)
        sig = self.private_key.sign(canonical.encode())
        return {
            **env,
            "from_identity": self.identity,
            "from_key_fingerprint": self.fingerprint,
            "signature": sig.hex(),
        }

    def verify_envelope(self, env: dict) -> dict:
        if not env.get("from_identity") or not env.get("signature"):
            return {"valid": False, "error": "missing signature fields"}
        entry = self.trust_store.get(env["from_identity"])
        if not entry:
            return {"valid": False, "error": "unknown identity"}
        if entry.get("revoked"):
            return {"valid": False, "error": f"identity revoked: {entry.get('revocation_reason', 'no reason')}"}
        try:
            from cryptography.hazmat.primitives.serialization import load_pem_public_key
            pub = load_pem_public_key(entry["public_key_pem"].encode())
            stripped = {k: v for k, v in env.items() if k not in ("signature", "from_identity", "from_key_fingerprint")}
            canonical = self._canonicalize(stripped)
            pub.verify(bytes.fromhex(env["signature"]), canonical.encode())
        except Exception as e:
            return {"valid": False, "error": f"invalid signature: {e}"}
        # ACL check
        caller = env["from_identity"]
        if not any(r == "*" or r == caller or (r.endswith("/*") and caller.startswith(r[:-1]))
                   for r in entry.get("allow_inbound", [])):
            return {"valid": False, "error": f"caller {caller} not in allow_inbound"}
        return {"valid": True, "identity": caller}

    def _canonicalize(self, obj: dict) -> str:
        return json.dumps({k: obj[k] for k in sorted(obj.keys())}, separators=(",", ":"))
```

---

## Go SDK: `ACLSynapse`

```go
package synapse

import (
    "crypto/ed25519"
    "crypto/rand"
    "crypto/sha256"
    "crypto/x509"
    "encoding/hex"
    "encoding/pem"
    "encoding/json"
    "errors"
    "fmt"
    "sort"
    "strings"
)

type TrustEntry struct {
    PublicKeyPEM       string   `json:"public_key_pem"`
    Fingerprint        string   `json:"fingerprint"`
    AllowOutbound      []string `json:"allow_outbound"`
    AllowInbound       []string `json:"allow_inbound"`
    Revoked            bool     `json:"revoked,omitempty"`
    RevokedAt          string   `json:"revoked_at,omitempty"`
    RevocationReason   string   `json:"revocation_reason,omitempty"`
}

type TrustStore map[string]TrustEntry

type ACLKeypair struct {
    Identity    string
    PrivateKey  ed25519.PrivateKey
    PublicKeyPEM string
    Fingerprint  string
}

func GenerateACLKeypair(identity string) (*ACLKeypair, error) {
    pub, priv, err := ed25519.GenerateKey(rand.Reader)
    if err != nil {
        return nil, err
    }
    der, _ := x509.MarshalPKIXPublicKey(pub)
    pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
    h := sha256.Sum256(pubPEM)
    return &ACLKeypair{
        Identity:     identity,
        PrivateKey:   priv,
        PublicKeyPEM: string(pubPEM),
        Fingerprint:  "sha256:" + hex.EncodeToString(h[:])[:16],
    }, nil
}

func (kp *ACLKeypair) SignEnvelope(env map[string]any) map[string]any {
    canonical := canonicalize(env)
    sig := ed25519.Sign(kp.PrivateKey, []byte(canonical))
    env["from_identity"] = kp.Identity
    env["from_key_fingerprint"] = kp.Fingerprint
    env["signature"] = hex.EncodeToString(sig)
    return env
}

func VerifyEnvelope(env map[string]any, store TrustStore) error {
    identity, _ := env["from_identity"].(string)
    if identity == "" {
        return errors.New("missing from_identity")
    }
    entry, ok := store[identity]
    if !ok { return errors.New("unknown identity") }
    if entry.Revoked { return fmt.Errorf("identity revoked: %s", entry.RevocationReason) }

    stripped := map[string]any{}
    for k, v := range env {
        if k == "signature" || k == "from_identity" || k == "from_key_fingerprint" {
            continue
        }
        stripped[k] = v
    }

    block, _ := pem.Decode([]byte(entry.PublicKeyPEM))
    pub, _ := x509.ParsePKIXPublicKey(block.Bytes)
    sigHex, _ := env["signature"].(string)
    sig, _ := hex.DecodeString(sigHex)
    if !ed25519.Verify(pub.(ed25519.PublicKey), []byte(canonicalize(stripped)), sig) {
        return errors.New("invalid signature")
    }

    caller := identity
    allowed := false
    for _, r := range entry.AllowInbound {
        if r == "*" || r == caller || (strings.HasSuffix(r, "/*") && strings.HasPrefix(caller, r[:len(r)-1])) {
            allowed = true
            break
        }
    }
    if !allowed {
        return fmt.Errorf("caller %s not in allow_inbound", caller)
    }
    return nil
}

func canonicalize(obj map[string]any) string {
    keys := make([]string, 0, len(obj))
    for k := range obj { keys = append(keys, k) }
    sort.Strings(keys)
    out := map[string]any{}
    for _, k := range keys { out[k] = obj[k] }
    b, _ := json.Marshal(out)
    return string(b)
}
```

---

## Revocation

### Soft Revocation (mark as revoked)

```json
{
  "acme/compromised-agent": {
    ...
    "revoked": true,
    "revoked_at": "2026-06-12T15:00:00Z",
    "revocation_reason": "private key may be compromised"
  }
}
```

Existing agents reading this trust store will reject any signatures from this identity immediately.

### Hard Revocation (emit revocation event)

```bash
# Broadcast revocation to all agents
nats pub mesh.event.acl.revocation '{
  "identity": "acme/compromised-agent",
  "reason": "key compromise",
  "at": "2026-06-12T15:00:00Z"
}'
```

Agents subscribe to `mesh.event.acl.revocation` and update their local trust store in real-time. No restart required.

### Key Rotation

To rotate without downtime:

1. Generate new keypair
2. Add new public key to all other agents' trust stores (under same identity)
3. Start signing with new private key
4. Remove old public key from trust stores

Trust stores support multiple public keys per identity via `public_keys: [...]` (extension).

---

## Trust Store Distribution

The trust store can be:

| Method | Best For |
|---|---|
| **Static JSON file** shipped with the agent | Single-tenant, dev environments |
| **JetStream KV bucket** (`MESH_TRUST`) | Dynamic meshes, runtime revocation |
| **HTTP endpoint** serving signed trust manifests | Cross-org, centralized trust |
| **Env var** (`SYNAPSE_TRUST_STORE=...`) | Containerized deployments |

---

## Threat Model

| Threat | Mitigated by ACL? |
|---|---|
| Rogue agent spoofs another agent's ID | ✅ yes — signature won't verify |
| Compromised agent key | ✅ yes — revoke in trust store |
| Agent eavesdrops on other agents' traffic | ⚠️ partial — NATS accounts/permissions needed |
| Unauthorized agent requests a privileged skill | ✅ yes — inbound ACL |
| Agent sends malformed envelopes | ✅ yes — signature fails |
| DDoS from trusted agent | ❌ no — need rate limiting (see backpressure) |

ACL is **not a replacement** for NATS-level account isolation — it's a complementary layer.

---

## Quick Reference

```typescript
// Generate agent identity
const keypair = generateACLKeypair('drolu/pi-bmc-agent');

// Save private key to agent's secure storage
fs.writeFileSync('agent-private.pem', keypair.privateKeyPem);

// Share public key with other agents
console.log('Share:', keypair.publicKeyPem, keypair.fingerprint);

// Load trust store
const trust = JSON.parse(fs.readFileSync('trust-store.json', 'utf8'));

// Connect with ACL
const mesh = await ACLSynapse.connectAcl({
  url: "nats://localhost:4222",
  keypair,
  trustStore: trust,
});

// Register handlers — all incoming calls auto-verified
mesh.onRequest("fetch-transactions", async (input, ctx) => {
  // ctx.caller_identity is verified
  return await fetchPaystack(input);
});
```

---

## Next Steps

- [Security](./security.md) — NATS NKeys, JWT, TLS, signed envelopes
- [Cross-Org](./cross-org.md) — Leaf nodes + accounts for org isolation
- [Failure Modes](./failure-modes.md) — Revocation during network partitions
