#!/usr/bin/env python3
"""
Synapse envelope signing — Ed25519 sign-on-send, verify-on-receive.
Reusable module for any Python Synapse bridge (grip-cli, omp-cli, agentspan, etc).

Stage 3 of the identity rollout: per-message cryptographic identity.
Uses the Ed25519 keypairs generated in Stage 1, stored in ~/.synapse/keys/.

Verify-if-signed mode: accepts both signed AND unsigned envelopes.
This enables a zero-downtime rollout — sign outbound first, then flip
to require-signed once all agents are signing.

Usage:
    from envelope_signing import sign_envelope, verify_envelope

    # Sign outbound
    signed_env = sign_envelope(envelope, "grip-cli-001")

    # Verify inbound (accepts unsigned during transition)
    valid, identity = verify_envelope(envelope)
    if not valid:
        reject(envelope)
"""
from __future__ import annotations
import json
import os
import hashlib
from typing import Any, Optional, Tuple
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import serialization
from cryptography.exceptions import InvalidSignature

KEYS_DIR = os.path.expanduser("~/.synapse/keys")
TRUST_STORE_PATH = os.path.expanduser("~/.synapse/trust/trust-store.json")

AUTH_FIELDS = ["signature", "from_identity", "from_key_fingerprint"]


def _load_keypair(agent_id: str) -> Optional[dict]:
    path = os.path.join(KEYS_DIR, f"{agent_id}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def _load_trust_store() -> dict:
    if not os.path.exists(TRUST_STORE_PATH):
        return {}
    with open(TRUST_STORE_PATH) as f:
        return json.load(f)


def _strip_auth_fields(env: dict) -> dict:
    return {k: v for k, v in env.items() if k not in AUTH_FIELDS}


def _canonicalize(obj: dict) -> bytes:
    """Stable JSON encoding for signing (sorted keys, no whitespace)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def sign_envelope(env: dict, agent_id: str) -> dict:
    """Sign an envelope with the agent's Ed25519 private key.
    Adds from_identity, from_key_fingerprint, signature.
    Returns a new dict (does not mutate input)."""
    kp = _load_keypair(agent_id)
    if not kp:
        return env  # no keypair — return unsigned (dev mode)

    priv_pem = kp["privateKeyPem"].encode()
    priv = serialization.load_pem_private_key(priv_pem, password=None)

    stripped = _strip_auth_fields(env)
    canonical = _canonicalize(stripped)
    sig = priv.sign(canonical)

    result = dict(env)
    result["from_identity"] = kp.get("did", agent_id)
    result["from_key_fingerprint"] = kp["fingerprint"]
    result["signature"] = sig.hex()
    return result


def verify_envelope(env: dict) -> Tuple[bool, str]:
    """Verify an envelope's signature against the trust store.
    Returns (valid, identity_or_error).

    Verify-if-signed mode: if envelope has no signature, returns (True, "unsigned").
    Once all agents sign, flip to strict mode by rejecting "unsigned" here.
    """
    if not env.get("signature"):
        return True, "unsigned"  # transitional: accept unsigned

    from_identity = env.get("from_identity")
    fingerprint = env.get("from_key_fingerprint")
    if not from_identity or not fingerprint:
        return False, "missing identity fields"

    trust = _load_trust_store()
    agent_id = from_identity.replace("did:mesh:", "") if from_identity.startswith("did:mesh:") else from_identity
    entry = trust.get(agent_id)
    if not entry:
        return False, f"unknown identity: {agent_id}"
    if entry.get("revoked"):
        return False, f"identity revoked: {agent_id}"
    if entry.get("fingerprint") != fingerprint:
        return False, f"fingerprint mismatch: {fingerprint} != {entry.get('fingerprint')}"

    pub_pem = entry["public_key_pem"].encode()
    pub = serialization.load_pem_public_key(pub_pem)

    stripped = _strip_auth_fields(env)
    canonical = _canonicalize(stripped)
    sig = bytes.fromhex(env["signature"])

    try:
        pub.verify(sig, canonical)
        return True, from_identity
    except InvalidSignature:
        return False, "invalid signature"
    except Exception as e:
        return False, f"verify error: {e}"


if __name__ == "__main__":
    import sys
    agent = sys.argv[1] if len(sys.argv) > 1 else "grip-cli-001"
    env = {"v": "1.0", "type": "request", "from": agent, "payload": {"test": True}}
    signed = sign_envelope(env, agent)
    print(f"signed: from_identity={signed.get('from_identity')} fp={signed.get('from_key_fingerprint')}")
    print(f"signature: {signed.get('signature','')[:32]}...")
    valid, ident = verify_envelope(signed)
    print(f"verify: valid={valid} identity={ident}")
    # Test tampering
    signed["payload"]["test"] = False
    valid2, ident2 = verify_envelope(signed)
    print(f"tampered: valid={valid2} error={ident2}")
