# Security & Authentication

Multi-tenant isolation, NKeys, JWT auth, signed envelopes, and production security patterns.

## Authentication Options

### 1. No Auth (Development Only)

```bash
nats-server  # No credentials, no encryption
```

Use only for local development. Never in production.

### 2. Token-Based Auth

**Server (`nats.conf`):**
```conf
port: 4222
authorization {
  token: "my-secret-token"
}
```

**Client:**
```bash
nats sub mesh.event.> -s nats://localhost:4222 --token "my-secret-token"
```

```typescript
await Synapse.connect("nats://localhost:4222", { token: "my-secret-token" });
```

### 3. User/Password Auth

```conf
port: 4222
authorization {
  users: [
    { user: "bob", password: "bob_password", permissions: { publish: "mesh.event.>" } }
    { user: "alice", password: "alice_password", permissions: { subscribe: "mesh.event.>" } }
  ]
}
```

### 4. NKeys (Ed25519 - Recommended)

Ed25519 is the NATS-native cryptographic identity system — simple, secure, no certificate authority required.

#### Generate Keys

```bash
# Operator (top-level authority)
nats auth createkey -t operator -n MESH_OPERATOR
# → SOAAAAAAAAAAAAA... (operator seed — keep secret)
# → OBBBBBBBBBBBB... (operator public key)

# Account (e.g., Acme Corp)
nats auth createkey -t account -n ACME_CORP
# → SAAAAAAAAAAAAAA... (account seed)
# → ABBBBBBBBBBBB... (account public key)

# User (individual agent)
nats auth createkey -t user -n bob_agent_1
# → SUAAAAAAAAAAAAA... (user seed)
# → UBBBBBBBBBBBB... (user public key)
```

#### Sign JWTs

```bash
# Account JWT (signed by operator)
nats auth createaccount \
  --operator ./operator.key \
  --name "Acme Corp" \
  --sk "ACME_CORP_PUBLIC_KEY" \
  > acme-account.jwt

# User JWT (signed by account)
nats auth createuser \
  --account ./acme-account.jwt \
  --name "Bob Agent 1" \
  --allow-pub "mesh.agent.bob-001.>" \
  --allow-sub "mesh.event.>" \
  > bob-agent-1.jwt
```

#### Credentials File

Combine seeds + JWT into a single `.creds` file:

```bash
nats auth mkcreds \
  --account-seed "SAAAAAAAAAAAAAA..." \
  --user-seed "SUAAAAAAAAAAAAA..." \
  --output bob-agent-1.creds
```

Use in agents:

```bash
# CLI
nats request mesh.registry.discover '{}' --creds ./bob-agent-1.creds

# TypeScript
import { credsAuthenticator } from "nats";
const creds = await Deno.readTextFile("./bob-agent-1.creds");
const mesh = await Synapse.connect("tls://nats.example.com:4222", {
  authenticator: credsAuthenticator(creds),
});

# Python
import nats
nc = await nats.connect("tls://nats.example.com:4222", user_credentials="./bob-agent-1.creds")

# Go
nc, err := nats.Connect(url, nats.UserCredentials("./bob-agent-1.creds"))
```

### 5. JWT with Accounts (Multi-Tenant)

The strongest model for production — each organization gets an account with subject permissions.

#### Account Structure

```
Operator: MESH_OPERATOR
├── Account: ACME_CORP
│   ├── User: acme_agent_1 (Bob)
│   ├── User: acme_agent_2 (Alice)
│   └── User: acme_agent_3 (Charlie)
└── Account: GLOBEX_INC
    ├── User: globex_agent_1 (Diana)
    └── User: globex_agent_2 (Edward)
```

#### Subject Permissions

```bash
# Acme agents can:
# - Publish to their own inboxes: mesh.agent.acme.>
# - Subscribe to events: mesh.event.>
# - Discover (read registry): mesh.registry.discover

# Globex agents can:
# - Publish to their own inboxes: mesh.agent.globex.>
# - Subscribe to events: mesh.event.>
# - Discover (read registry): mesh.registry.discover

# Cross-account sharing (via imports):
# - Acme can read Globex's shared events: mesh.event.shared.>
# - Globex can read Acme's shared events: mesh.event.shared.>
```

---

## Multi-Tenant Setup (Acme + Globex)

### Full Configuration

```conf
# nats.conf

port: 4222
http_port: 8222

# Accounts
accounts {
  ACME_CORP: {
    jetstream: enabled
    
    exports: [
      { stream: "mesh.event.acme.>" }         # Acme internal
      { stream: "mesh.event.shared.acme.>" }  # Public to Globex
    ]
    
    imports: [
      # Subscribe to Globex's shared events
      { stream: { account: GLOBEX_INC, subject: "mesh.event.shared.globex.>" }, to: "mesh.event.shared.globex.>" }
    ]
  }

  GLOBEX_INC: {
    jetstream: enabled
    
    exports: [
      { stream: "mesh.event.globex.>" }
      { stream: "mesh.event.shared.globex.>" }
    ]
    
    imports: [
      { stream: { account: ACME_CORP, subject: "mesh.event.shared.acme.>" }, to: "mesh.event.shared.acme.>" }
    ]
  }
}
```

### Generate All Credentials

```bash
# Operator
nats auth createkey -t operator -n MESH_OPERATOR
OPERATOR_PUB="OBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

# Accounts
nats auth createkey -t account -n ACME_CORP
ACME_PUB="AAAAAAAAAAAAAAAAA..."

nats auth createkey -t account -n GLOBEX_INC
GLOBEX_PUB="GGGGGGGGGGGGG..."

# Users for Acme agents
nats auth createkey -t user -n bob_agent
nats auth createkey -t user -n alice_agent

# Users for Globex agents
nats auth createkey -t user -n diana_agent
nats auth createkey -t user -n edward_agent

# Generate creds files
nats auth mkcreds --account-seed $ACME_SEED --user-seed $BOB_SEED > ./creds/acme/bob.creds
nats auth mkcreds --account-seed $ACME_SEED --user-seed $ALICE_SEED > ./creds/acme/alice.creds
nats auth mkcreds --account-seed $GLOBEX_SEED --user-seed $DIANA_SEED > ./creds/globex/diana.creds
nats auth mkcreds --account-seed $GLOBEX_SEED --user-seed $EDWARD_SEED > ./creds/globex/edward.creds
```

### Agent Usage

```typescript
// Acme agent connects with Acme credentials
const acmeMesh = await Synapse.connect("tls://nats.example.com:4222", {
  authenticator: credsAuthenticator(await Deno.readTextFile("./creds/acme/bob.creds")),
});

// Globex agent connects with Globex credentials
const globexMesh = await Synapse.connect("tls://nats.example.com:4222", {
  authenticator: credsAuthenticator(await Deno.readTextFile("./creds/globex/diana.creds")),
});
```

---

## TLS Configuration

### Self-Signed Certificates

```bash
# Generate CA
openssl genrsa -out ca-key.pem 4096
openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days 365 -out ca-cert.pem

# Generate server cert
openssl genrsa -out server-key.pem 2048
openssl req -new -key server-key.pem -out server.csr
openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial -out server-cert.pem -days 365
```

**Server config:**
```conf
tls {
  cert_file: "./server-cert.pem"
  key_file: "./server-key.pem"
  ca_file: "./ca-cert.pem"
  verify: true
}
```

### Let's Encrypt (Production)

Use certbot with NATS:

```bash
certbot certonly --standalone -d nats.example.com
```

```conf
tls {
  cert_file: "/etc/letsencrypt/live/nats.example.com/fullchain.pem"
  key_file: "/etc/letsencrypt/live/nats.example.com/privkey.pem"
}
```

---

## Signed Envelopes

For additional security, sign Synapse envelopes with Ed25519 and verify at the receiver.

```typescript
import { sign, verify } from "crypto";

function signEnvelope(envelope: Envelope, privateKey: Buffer): Envelope {
  const canonical = JSON.stringify(envelope, Object.keys(envelope).sort());
  const signature = sign(null, Buffer.from(canonical), privateKey);
  return { ...envelope, signature: signature.toString("base64") };
}

function verifyEnvelope(envelope: Envelope, publicKey: Buffer): boolean {
  const { signature, ...rest } = envelope;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  return verify(null, Buffer.from(canonical), publicKey, Buffer.from(signature, "base64"));
}
```

---

## Security Checklist

- [ ] All external connections use TLS (`tls://...`)
- [ ] Each agent has unique NKey credentials (no shared `.creds` files)
- [ ] Accounts have minimal subject permissions (principle of least privilege)
- [ ] JetStream retention policies are configured (don't accumulate forever)
- [ ] Credentials are rotated quarterly (or on security events)
- [ ] Agent manifests include version field for tracking
- [ ] Input validation on handler functions (never trust raw payloads)
- [ ] Rate limits configured for agent inboxes (prevent abuse)
- [ ] Audit logs enabled (NATS system account monitoring)
- [ ] Network segmentation (separate NATS servers for dev/staging/prod)

---

## Common Attacks & Mitigations

| Attack | Mitigation |
|--------|-----------|
| Man-in-the-middle | TLS with certificate verification |
| Agent impersonation | NKey JWT authentication |
| Message tampering | Signed envelopes |
| Denial of service | Rate limits, JetStream queue depth limits |
| Cross-account leaks | Account isolation with explicit imports |
| Credential theft | OS-level secret storage (Keychain, Vault) |
| Unauthorized publishing | Subject-level publish permissions |
