#!/usr/bin/env python3
"""
EnforceCore-integrated Synapse bridge — Phase 3 of the governance integration.

Wraps the backend call (e.g. grip / omp CLI subprocess) with EnforceCore so:
  - every tool call is policy-gated at the runtime boundary (not just at the mesh gate)
  - PII / secrets in the RESULT are redacted before task_store.complete()
  - resource limits (time / memory / cost / kill) are enforced
  - every enforced call appends a tamper-evident Merkle audit record,
    whose head is published to mesh.audit.{agent_id}.head

Layering:
    caller ──▶ [NATS subject perms]   (transport)
            ──▶ [Actra gate in SDK]   (mesh decision — see governance.md Phase 2)
                ──▶ [this bridge]
                      ──▶ @enforce(backend_chat)   (EnforceCore — Phase 3)
                            ──▶ subprocess (grip/omp)
                      ◀── Redactor (strips PII before persist)
                      ◀── Merkle audit head published to mesh

Requirements:
    pip install enforcecore nats-py

This file is a pattern, not a runnable service — adapt the backend_chat /
manifest / policy to your agent. See governance.md for the full layering.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from enforcecore import enforce, Auditor, Redactor, Guard
from nats.aio.client import Client as NATS


# ──────────────────────────────────────────────────────────────────────
# 1. EnforceCore policy (mirrors the Actra/AGT policy where possible)
# ──────────────────────────────────────────────────────────────────────
ENFORCECORE_POLICY = "policies/agent-tools.yaml"
#   name: "agent-tool-policy"
#   rules:
#     allowed_tools: ["search_web", "calculator", "get_weather"]
#     denied_tools:  ["execute_shell", "drop_table"]
#     max_output_size_bytes: 524288
#   on_violation: "block"


# ──────────────────────────────────────────────────────────────────────
# 2. Backend call — DECORATED. This is the second gate (after Actra).
# ──────────────────────────────────────────────────────────────────────
@enforce(policy=ENFORCECORE_POLICY)
async def backend_chat(agent_cmd: list[str], message: str, timeout: int = 300) -> dict:
    """Run the underlying agent CLI (grip/omp). Policy-enforced before exec."""
    proc = await asyncio.create_subprocess_exec(
        *agent_cmd, message,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return {"response": f"[TIMEOUT after {timeout}s]", "error": True}
    return {"response": stdout.decode().strip(), "error": False}


# ──────────────────────────────────────────────────────────────────────
# 3. Redactor — strip PII / secrets from results before they hit TASK_STORE
# ──────────────────────────────────────────────────────────────────────
redactor = Redactor()  # default PII patterns (emails, phones, cards, SSNs, API keys)
# Add org-specific patterns, e.g. redact anything matching BMC/AWS secret shapes:
#   redactor.add_pattern(r"Owzre ![^\s]+", "[REDACTED-BMC-PWD]")
#   redactor.add_pattern(r"ghp_[A-Za-z0-9]{36}", "[REDACTED-GITHUB-PAT]")
#   redactor.add_pattern(r"AKIA[0-9A-Z]{16}", "[REDACTED-AWS-KEY]")


# ──────────────────────────────────────────────────────────────────────
# 4. Guard — resource limits on every backend call
# ──────────────────────────────────────────────────────────────────────
guard = Guard(
    max_time_seconds=300,    # hard timeout (mirrors backend_chat default)
    max_memory_mb=1024,      # cap subprocess RSS
    max_cost_usd=0.50,       # per-call cost ceiling (wire to your billing)
    kill_on_violation=True,
)


# ──────────────────────────────────────────────────────────────────────
# 5. Auditor — tamper-evident Merkle trail; publish head to the mesh
# ──────────────────────────────────────────────────────────────────────
auditor = Auditor(chain_path="./audit/merkle-chain.jsonl")


async def publish_audit_head(nc: NATS, agent_id: str) -> None:
    """Publish the current Merkle root so the mesh has a cross-agent audit chain."""
    head = auditor.head()  # hex Merkle root after latest append
    await nc.publish(
        f"mesh.audit.{agent_id}.head",
        json.dumps({
            "v": "1.0.0", "id": str(uuid.uuid4()), "type": "audit_head",
            "ts": datetime.now(timezone.utc).isoformat(), "from": agent_id,
            "payload": {"head": head, "entries": auditor.count()},
        }).encode(),
    )


# ──────────────────────────────────────────────────────────────────────
# 6. The bridge handler — called after the Actra gate has already `allow`ed
# ──────────────────────────────────────────────────────────────────────
async def handle_request(envelope: dict, agent_cmd: list[str], nc: NATS,
                         agent_id: str, task_store) -> dict:
    text = envelope.get("payload", {}).get("text", "")
    task_id = envelope.get("task_id") or envelope.get("payload", {}).get("task_id")

    # Guard wraps the enforce-decorated call (time/mem/cost/kill)
    async def guarded():
        return await backend_chat(agent_cmd, text, timeout=guard.max_time_seconds)

    try:
        result = await guard.run(guarded)
    except Exception as e:
        # EnforceCore blocked the tool call, or Guard killed it
        if task_store and task_id:
            await task_store.fail(task_id, agent_id, code=5001,
                                  message=f"EnforceCore/Guard: {e}", retryable=False)
        auditor.append({
            "task_id": task_id, "actor": envelope.get("from_identity", envelope.get("from")),
            "action": envelope.get("payload", {}).get("skill"),
            "decision": "blocked", "reason": str(e),
        })
        await publish_audit_head(nc, agent_id)
        return {"error": str(e)}

    response_text = result.get("response", "")

    # Redact PII / secrets BEFORE persisting to TASK_STORE
    redacted = redactor.redact(response_text)

    # Audit the allowed call (decision, context, redacted-output-hash)
    auditor.append({
        "task_id": task_id,
        "actor": envelope.get("from_identity", envelope.get("from")),  # verified DID
        "action": envelope.get("payload", {}).get("skill"),
        "target": envelope.get("to"),
        "decision": "allowed",
        "output_sha256": hashlib_sha256(redacted),
    })
    await publish_audit_head(nc, agent_id)

    # Persist the REDACTED result only
    if task_store and task_id:
        await task_store.complete(task_id, agent_id, result={
            "text": redacted,
            "iterations": result.get("iterations", 1),
            "session_key": result.get("session_key"),
            "audit_head": auditor.head(),
        })
    return {"text": redacted}


def hashlib_sha256(s: str) -> str:
    import hashlib
    return hashlib.sha256(s.encode()).hexdigest()


# ──────────────────────────────────────────────────────────────────────
# Why this layer matters even with the Actra gate in place
# ──────────────────────────────────────────────────────────────────────
# 1. Actra gates the MESH decision (can A call skill X on B).
#    EnforceCore gates the TOOL decision (can B run `execute_shell` to answer).
#    A request can pass Actra and still be blocked at the tool boundary.
# 2. The Redactor is the only thing that stops secrets/PII from landing in
#    TASK_STORE. Without it, credentials inlined in prompts (a common anti-
#    pattern) persist in KV for the TTL window.
# 3. The Merkle audit chain is tamper-evident and cross-agent: each agent
#    publishes its head to mesh.audit.{id}.head, so a compromised agent
#    cannot rewrite history without breaking the published chain.
# 4. The Guard gives resource governance (cost/time/memory) that the SDK's
#    concurrency semaphore does not — it gates how many calls, not how
#    expensive each one is.
