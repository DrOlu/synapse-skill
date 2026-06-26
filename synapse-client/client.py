#!/usr/bin/env python3
"""
SynapseClient — a single-file async Python client for the Synapse mesh protocol.

Any agent can use this to connect to and operate against ANY Synapse network.
Defaults to the local mesh (nats://localhost:4222) but accepts arbitrary
url/port/auth for any remote mesh.

Requirements:
    pip install nats-py

The 6 primitives:  register · discover · request · respond · emit · subscribe
Plus: heartbeats, file transfer, task persistence (TASK_STORE), health probe.

Usage:
    from synapse_client import SynapseClient
    mesh = await SynapseClient.connect()                 # localhost default
    mesh = await SynapseClient.connect("nats://host:4222", nkey_seed_file="…")
    await mesh.register("my-agent", capabilities=["chat"], skills=[...])
    agents = await mesh.discover(capabilities=["chat"])
    reply = await mesh.request("bob-001", "chat", {"text": "hi"})
    await mesh.emit("document.created", {"doc_id": "x"})
    await mesh.subscribe("mesh.event.document.>", handler)
    await mesh.drain()
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
import base64
import hashlib
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Awaitable, Callable, Dict, List, Optional

try:
    import nats
    from nats.aio.client import Client as NATSClient
    from nats.js.client import JetStreamContext
    from nats.js.api import ConsumerConfig, AckPolicy, DeliverPolicy
    from nats.errors import TimeoutError as NatsTimeoutError
except ImportError as e:  # pragma: no cover
    raise SystemExit(
        "SynapseClient requires nats-py. Install with:  pip install nats-py"
    ) from e


# ──────────────────────────────────────────────────────────────────────
# Defaults — local mesh. Override per-call for any remote network.
# ──────────────────────────────────────────────────────────────────────
DEFAULT_URL = os.environ.get("SYNAPSE_URL", "nats://localhost:4222")
DEFAULT_TASK_BUCKET = os.environ.get("SYNAPSE_TASK_BUCKET", "TASK_STORE")
DEFAULT_INBOX_STREAM = os.environ.get("SYNAPSE_INBOX_STREAM", "AGENT_INBOXES")
DEFAULT_TIMEOUT = 30.0           # seconds, for request/reply
DEFAULT_LONG_TIMEOUT = 600.0     # seconds, for long-running LLM/API tasks
DEFAULT_HEARTBEAT_INTERVAL = 30  # seconds
PROTOCOL_VERSION = "1.0.0"


# ──────────────────────────────────────────────────────────────────────
# Data models
# ──────────────────────────────────────────────────────────────────────
class Availability(str, Enum):
    ONLINE = "online"
    BUSY = "busy"
    OFFLINE = "offline"


@dataclass
class Skill:
    id: str
    name: str
    description: str
    input_modes: List[str] = field(default_factory=lambda: ["text/plain"])
    output_modes: List[str] = field(default_factory=lambda: ["text/plain"])

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class AgentManifest:
    id: str
    name: str
    description: str = ""
    capabilities: List[str] = field(default_factory=list)
    skills: List[Skill] = field(default_factory=list)
    endpoint: str = ""
    availability: Availability = Availability.ONLINE
    last_heartbeat: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "capabilities": self.capabilities,
            "skills": [s.to_dict() for s in self.skills],
            "endpoint": self.endpoint,
            "availability": self.availability.value,
            "last_heartbeat": self.last_heartbeat or _now_iso(),
        }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uuid() -> str:
    return str(uuid.uuid4())


def _envelope(
    etype: str,
    frm: str,
    to: Optional[str] = None,
    task_id: Optional[str] = None,
    payload: Optional[Any] = None,
    trace_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Build a Synapse envelope."""
    env: Dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "id": _uuid(),
        "type": etype,
        "ts": _now_iso(),
        "from": frm,
    }
    if to:
        env["to"] = to
    if task_id:
        env["task_id"] = task_id
    env["trace"] = {"trace_id": trace_id or task_id or _uuid(),
                    "span_id": _uuid()}
    if payload is not None:
        env["payload"] = payload
    return env


# ──────────────────────────────────────────────────────────────────────
# SynapseClient
# ──────────────────────────────────────────────────────────────────────
class SynapseClient:
    """Connect to and operate on any Synapse mesh via NATS."""

    def __init__(
        self,
        nc: NATSClient,
        agent_id: str,
        url: str,
        nkey_seed: Optional[str] = None,  # raw seed string or seed file path (retained for reference; not read after connect)
        creds_file: Optional[str] = None,
        jwt: Optional[str] = None,
        task_bucket: str = DEFAULT_TASK_BUCKET,
        inbox_stream: str = DEFAULT_INBOX_STREAM,
    ):
        self.nc = nc
        self.agent_id = agent_id
        self.url = url
        self._nkey_seed = nkey_seed
        self._creds_file = creds_file
        self._jwt = jwt
        self._task_bucket = task_bucket
        self._inbox_stream = inbox_stream
        self._js: Optional[JetStreamContext] = None
        self._kv = None
        self._manifest: Optional[AgentManifest] = None
        self._subs: List[Any] = []
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._handlers: Dict[str, Callable] = {}

    # ── Connection ──────────────────────────────────────────────────
    @classmethod
    async def connect(
        cls,
        url: str = DEFAULT_URL,
        *,
        agent_id: Optional[str] = None,
        nkey_seed_file: Optional[str] = None,
        nkey_seed: Optional[str] = None,
        creds_file: Optional[str] = None,
        jwt: Optional[str] = None,
        task_bucket: str = DEFAULT_TASK_BUCKET,
        inbox_stream: str = DEFAULT_INBOX_STREAM,
        name: Optional[str] = None,
        **nats_kwargs,
    ) -> "SynapseClient":
        """
        Connect to a NATS server running a Synapse mesh.

        Auth precedence: nkey_seed > nkey_seed_file > creds_file > jwt > user/pass > anonymous.
        Defaults to the local mesh (nats://localhost:4222).

        NKey auth accepts either a seed file path (`nkey_seed_file=…`) or a raw
        seed string (`nkey_seed="SUAS…"`). Paths use ``~`` expansion and work
        on POSIX and Windows (``~`` → ``%USERPROFILE%`` via expanduser).

        For user/pass auth (plain NATS users), embed in the URL:
            await SynapseClient.connect("nats://user:pass@host:4222")
        or pass via nats_kwargs (user=, password=).

        Examples:
            await SynapseClient.connect()
            await SynapseClient.connect("nats://10.0.0.5:4222")
            await SynapseClient.connect(nkey_seed_file="~/.synapse/nkeys/my.seed")
            await SynapseClient.connect(nkey_seed="SUAS52LXLHT7O5Y6MYUS7VKK2UAKPDKMFJEJENBAPQOGOXY7BNQXYXTQ")
            await SynapseClient.connect("tls://cloud.example:4222",
                                        creds_file="~/.nats/synadia.creds")
            await SynapseClient.connect("nats://admin:s3cret@host:4222")
        """
        connect_kwargs: Dict[str, Any] = {"name": name or "synapse-client"}
        # nats-py: nkeys_seed = file PATH (string); nkeys_seed_str = raw seed.
        # Earlier versions passed bytes to nkeys_seed, which nats-py treated as
        # a path (FileNotFoundError). Pass the path; fall back to seed string.
        nkey_seed_str = nats_kwargs.pop("nkey_seed_str", None) or nkey_seed
        if nkey_seed_str:
            connect_kwargs["nkeys_seed_str"] = nkey_seed_str.strip()
        elif nkey_seed_file:
            connect_kwargs["nkeys_seed"] = os.path.expanduser(nkey_seed_file)
        elif creds_file:
            connect_kwargs["user_credentials"] = os.path.expanduser(creds_file)
        elif jwt:
            connect_kwargs["user_jwt"] = jwt
        # user/pass may also be supplied via nats_kwargs (user=, password=)
        connect_kwargs.update(nats_kwargs)

        nc = await nats.connect(url, **connect_kwargs)
        self = cls(
            nc=nc,
            agent_id=agent_id or f"client-{uuid.uuid4().hex[:8]}",
            url=url,
            nkey_seed=nkey_seed_str or nkey_seed_file,
            creds_file=creds_file,
            jwt=jwt,
            task_bucket=task_bucket,
            inbox_stream=inbox_stream,
        )
        self._js = nc.jetstream()
        try:
            self._kv = await self._js.key_value(bucket=task_bucket)
        except Exception:
            # KV bucket may not exist yet; lazily create on first use.
            self._kv = None
        return self

    @property
    def is_connected(self) -> bool:
        return bool(self.nc and self.nc.is_connected)

    # ── PRIMITIVE 1: REGISTER ────────────────────────────────────────
    async def register(
        self,
        name: str,
        description: str = "",
        capabilities: Optional[List[str]] = None,
        skills: Optional[List[Dict[str, Any]]] = None,
        endpoint: str = "",
        availability: Availability = Availability.ONLINE,
    ) -> AgentManifest:
        """Announce this agent's manifest to the registry."""
        skill_objs = [Skill(**s) if isinstance(s, dict) else s for s in (skills or [])]
        self._manifest = AgentManifest(
            id=self.agent_id,
            name=name,
            description=description,
            capabilities=capabilities or [],
            skills=skill_objs,
            endpoint=endpoint or f"mesh.agent.{self.agent_id}.inbox",
            availability=availability,
        )
        payload = {"manifest": self._manifest.to_dict()}
        env = _envelope("register", frm=self.agent_id, payload=payload)
        await self.nc.publish("mesh.registry.register",
                              json.dumps(env).encode())
        return self._manifest

    async def deregister(self) -> None:
        """Remove this agent from the registry."""
        env = _envelope("deregister", frm=self.agent_id)
        await self.nc.publish("mesh.registry.deregister",
                              json.dumps(env).encode())

    # ── PRIMITIVE 2: DISCOVER ───────────────────────────────────────
    async def discover(
        self,
        capabilities: Optional[List[str]] = None,
        agent_id: Optional[str] = None,
        timeout: float = 10.0,
        ranked: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Find agents by capability or by id. Returns a list of manifests.

        Set ranked=True to request reliability-ranked results from the
        reputation service (mesh.registry.discover.ranked), when available.
        """
        subject = "mesh.registry.discover.ranked" if ranked else "mesh.registry.discover"
        if agent_id:
            subject = f"mesh.registry.get.{agent_id}"
        req = {"capabilities": capabilities or [], "id": agent_id}
        env = _envelope("discover", frm=self.agent_id, payload=req)
        try:
            resp = await self.nc.request(
                subject, json.dumps(env).encode(), timeout=timeout)
            data = json.loads(resp.data.decode())
            agents = (data.get("payload", {}) or {}).get("agents")
            if agents is None:
                agents = data.get("agents")
            if agents is None:
                manifest = data.get("manifest")
                agents = [manifest] if manifest else []
            return [a for a in agents if a]
        except NatsTimeoutError:
            return []
        except Exception:
            return []

    # ── PRIMITIVE 3: REQUEST ─────────────────────────────────────────
    async def request(
        self,
        to_agent: str,
        skill: str,
        input_data: Any,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Ask an agent to do work. Synchronous request/reply.

        For tasks that may exceed ~30s (LLM calls, multi-step API work),
        use request_long() instead, which polls the durable TASK_STORE.

        Returns the reply envelope payload dict, or an error dict.
        """
        tid = task_id or f"req-{uuid.uuid4().hex[:8]}"
        payload = {"skill": skill, "task_id": tid,
                    "text": input_data.get("text", str(input_data)) if isinstance(input_data, dict) else str(input_data),
                    "message": input_data}
        env = _envelope("request", frm=self.agent_id, to=to_agent,
                        task_id=tid, payload=payload, trace_id=tid)
        subject = f"mesh.agent.{to_agent}.inbox"
        try:
            resp = await self.nc.request(subject,
                                         json.dumps(env).encode(),
                                         timeout=timeout)
            return json.loads(resp.data.decode())
        except NatsTimeoutError:
            return {"error": {"code": 1001, "message": "request timed out",
                              "retryable": True}}
        except Exception as e:
            return {"error": {"code": 5001, "message": str(e),
                              "retryable": True}}

    async def request_long(
        self,
        to_agent: str,
        skill: str,
        input_data: Any,
        *,
        task_id: Optional[str] = None,
        timeout: float = DEFAULT_LONG_TIMEOUT,
        poll_interval: float = 4.0,
    ) -> Dict[str, Any]:
        """
        Fire-and-forget request that polls the durable TASK_STORE KV bucket
        for completion. Use for LLM/API tasks up to `timeout` seconds.

        Durable: survives agent crashes and mesh reconnects.
        """
        tid = task_id or f"task-{uuid.uuid4().hex[:8]}"
        payload = {"skill": skill, "task_id": tid,
                    "text": input_data.get("text", str(input_data)) if isinstance(input_data, dict) else str(input_data),
                    "message": input_data}
        env = _envelope("request", frm=self.agent_id, to=to_agent,
                        task_id=tid, payload=payload, trace_id=tid)
        subject = f"mesh.agent.{to_agent}.inbox"
        await self.nc.publish(subject, json.dumps(env).encode())

        kv = await self._ensure_kv()
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                entry = await kv.get(tid)
                if entry:
                    task = json.loads(entry.value.decode())
                    state = task.get("state")
                    if state == "completed":
                        return {"ok": True, "task_id": tid,
                                "result": task.get("result"),
                                "state": state}
                    if state in ("failed", "canceled"):
                        err = task.get("error") or {}
                        return {"ok": False, "task_id": tid,
                                "error": err, "state": state}
            except Exception:
                pass
            await asyncio.sleep(poll_interval)
        return {"ok": False, "task_id": tid, "state": "timeout",
                "error": {"code": 1001, "message": "task timed out in TASK_STORE",
                          "retryable": True}}

    async def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Fetch a task's current state from TASK_STORE."""
        kv = await self._ensure_kv()
        try:
            entry = await kv.get(task_id)
            return json.loads(entry.value.decode()) if entry else None
        except Exception:
            return None

    # ── PRIMITIVE 4: RESPOND ────────────────────────────────────────
    async def respond(
        self,
        reply_subject: str,
        result: Any,
        *,
        task_id: Optional[str] = None,
        error: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Reply to a request on the supplied reply subject."""
        env = _envelope("respond", frm=self.agent_id,
                        task_id=task_id,
                        payload={"result": result} if error is None else None)
        if error:
            env["error"] = error
        await self.nc.publish(reply_subject, json.dumps(env).encode())

    async def serve(
        self,
        skill: str,
        handler: Callable[[Dict[str, Any], "RequestContext"], Awaitable[Any]],
        *,
        max_concurrent: int = 5,
    ) -> None:
        """
        Subscribe to this agent's inbox and dispatch requests to `handler`.
        The handler receives the request envelope payload and a context with
        the reply subject; it should return a result dict (or raise).

        Uses a JetStream durable consumer with a long ack_wait so long-running
        handlers are not redelivered prematurely.
        """
        subject = f"mesh.agent.{self.agent_id}.inbox"
        sem = asyncio.Semaphore(max_concurrent)

        async def on_msg(msg):
            async with sem:
                try:
                    env = json.loads(msg.data.decode())
                    req = env.get("payload", env)
                    ctx = RequestContext(
                        reply_subject=msg.reply,
                        task_id=req.get("task_id") or env.get("task_id"),
                        trace=env.get("trace"),
                        from_agent=env.get("from"),
                        envelope=env,
                    )
                    try:
                        result = await handler(req, ctx)
                        if msg.reply:
                            await self.respond(msg.reply, result,
                                               task_id=ctx.task_id)
                    except Exception as e:
                        if msg.reply:
                            await self.respond(
                                msg.reply, None, task_id=ctx.task_id,
                                error={"code": 5001, "message": str(e),
                                       "retryable": True})
                finally:
                    try:
                        await msg.ack()
                    except Exception:
                        pass

        try:
            sub = await self._js.subscribe(
                subject,
                durable=self.agent_id,
                stream=self._inbox_stream,
                manual_ack=True,
                config=ConsumerConfig(
                    durable_name=self.agent_id,
                    deliver_policy=DeliverPolicy.ALL,
                    ack_policy=AckPolicy.EXPLICIT,
                    ack_wait=360,
                    max_deliver=5,
                ),
                cb=on_msg,
            )
        except Exception:
            sub = await self.nc.subscribe(subject, cb=on_msg)
        self._subs.append(sub)

    # ── PRIMITIVE 5: EMIT ───────────────────────────────────────────
    async def emit(self, event_type: str, data: Any) -> None:
        """Broadcast an event to mesh.event.<event_type> subscribers."""
        subject = f"mesh.event.{event_type}"
        env = _envelope("emit", frm=self.agent_id, payload=data)
        await self.nc.publish(subject, json.dumps(env).encode())

    # ── PRIMITIVE 6: SUBSCRIBE ──────────────────────────────────────
    async def subscribe(
        self,
        pattern: str,
        handler: Callable[[Dict[str, Any]], Awaitable[None]],
    ) -> None:
        """Listen for events/subjects matching a wildcard pattern."""
        async def on_msg(msg):
            try:
                env = json.loads(msg.data.decode())
            except Exception:
                env = {"raw": msg.data.decode(errors="replace")}
            await handler(env)
        sub = await self.nc.subscribe(pattern, cb=on_msg)
        self._subs.append(sub)

    # ── Heartbeat ───────────────────────────────────────────────────
    async def start_heartbeat(self, interval: int = DEFAULT_HEARTBEAT_INTERVAL) -> None:
        """Publish periodic heartbeats so the registry sees us as online."""
        async def beat():
            while True:
                env = _envelope("heartbeat", frm=self.agent_id,
                                 payload={"agent_id": self.agent_id,
                                          "timestamp": _now_iso()})
                await self.nc.publish(f"mesh.heartbeat.{self.agent_id}",
                                      json.dumps(env).encode())
                await asyncio.sleep(interval)
        self._heartbeat_task = asyncio.create_task(beat())

    # ── File transfer (chunked) ────────────────────────────────────
    async def send_file(
        self,
        to_agent: str,
        file_path: str,
        *,
        action: str = "analyze",
        chunk_size: int = 96 * 1024,
        timeout: float = DEFAULT_LONG_TIMEOUT,
        poll_interval: float = 4.0,
    ) -> Dict[str, Any]:
        """
        Send a file (PDF/DOCX/image/CSV) to an agent via the chunked
        file-transfer protocol over mesh.agent.<to>.inbox.

        Protocol: init → chunks → done → target dispatches to its inbox.
        """
        path = os.path.expanduser(file_path)
        with open(path, "rb") as fh:
            data = fh.read()
        total = len(data)
        transfer_id = f"file-{uuid.uuid4().hex[:12]}"
        digest = hashlib.sha256(data).hexdigest()
        subject = f"mesh.agent.{to_agent}.inbox"

        # init
        await self.nc.publish(subject, json.dumps(_envelope(
            "request", frm=self.agent_id, to=to_agent,
            task_id=transfer_id,
            payload={"file_transfer": True, "phase": "init",
                     "filename": os.path.basename(path),
                     "action": action, "total_bytes": total,
                     "total_chunks": (total // chunk_size) + 1,
                     "sha256": digest})).encode())

        # chunks
        offset = 0
        idx = 0
        while offset < total:
            chunk = data[offset:offset + chunk_size]
            env = _envelope("request", frm=self.agent_id, to=to_agent,
                            task_id=transfer_id,
                            payload={"file_transfer": True, "phase": "chunk",
                                     "index": idx, "data_b64":
                                     base64.b64encode(chunk).decode()})
            await self.nc.publish(subject, json.dumps(env).encode())
            offset += chunk_size
            idx += 1
            await asyncio.sleep(0.01)  # backpressure

        # done — ask the agent to process and reply
        tid = f"{transfer_id}-result"
        env = _envelope("request", frm=self.agent_id, to=to_agent,
                        task_id=tid,
                        payload={"file_transfer": True, "phase": "done",
                                 "transfer_id": transfer_id,
                                 "action": action,
                                 "filename": os.path.basename(path),
                                 "sha256": digest})
        await self.nc.publish(subject, json.dumps(env).encode())
        return await self.request_long(to_agent, action, {"text": action},
                                       task_id=tid, timeout=timeout,
                                       poll_interval=poll_interval)

    # ── Health / monitoring ─────────────────────────────────────────
    async def health(self, monitor_port: int = 8222, host: str = "localhost") -> Dict[str, Any]:
        """
        Probe the NATS monitoring endpoint (/healthz, /varz) to verify the
        mesh is up. Useful before issuing requests.
        """
        import urllib.request
        out: Dict[str, Any] = {}
        try:
            with urllib.request.urlopen(
                f"http://{host}:{monitor_port}/healthz", timeout=5) as r:
                out["healthz"] = json.loads(r.read().decode())
        except Exception as e:
            out["healthz"] = {"ok": False, "error": str(e)}
        try:
            with urllib.request.urlopen(
                f"http://{host}:{monitor_port}/varz", timeout=5) as r:
                out["varz"] = json.loads(r.read().decode())
        except Exception as e:
            out["varz"] = {"error": str(e)}
        return out

    # ── Lifecycle ───────────────────────────────────────────────────
    async def drain(self) -> None:
        """Unsubscribe all and flush, leaving the connection open briefly."""
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        for sub in self._subs:
            try:
                await sub.unsubscribe()
            except Exception:
                pass
        self._subs.clear()
        try:
            await self.nc.drain()
        except Exception:
            pass

    async def close(self) -> None:
        await self.drain()
        try:
            await self.nc.close()
        except Exception:
            pass

    # ── Internal ────────────────────────────────────────────────────
    async def _ensure_kv(self):
        if self._kv is not None:
            return self._kv
        try:
            self._kv = await self._js.key_value(bucket=self._task_bucket)
        except Exception:
            self._kv = await self._js.create_key_value(
                bucket=self._task_bucket,
                history=10, ttl=0)
        return self._kv


# ──────────────────────────────────────────────────────────────────────
# RequestContext — passed to serve() handlers
# ──────────────────────────────────────────────────────────────────────
@dataclass
class RequestContext:
    reply_subject: Optional[str]
    task_id: Optional[str]
    trace: Optional[Dict[str, str]]
    from_agent: Optional[str]
    envelope: Dict[str, Any]


# ──────────────────────────────────────────────────────────────────────
# CLI entrypoint — `python client.py <command> ...`
# ──────────────────────────────────────────────────────────────────────
async def _cli():
    import argparse, sys
    p = argparse.ArgumentParser(description="Synapse mesh client")
    p.add_argument("-s", "--server", default=DEFAULT_URL,
                   help="NATS URL (default: %(default)s)")
    p.add_argument("--nkey", help="path to NKey seed file for auth")
    p.add_argument("--creds", help="path to NATS creds file (JWT)")
    p.add_argument("--user", help="plain NATS username (use with --pass)")
    p.add_argument("--pass", dest="password", help="plain NATS password")
    p.add_argument("--id", help="agent id to use")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("discover", help="list/discover agents").add_argument(
        "--cap", action="append", default=[])
    d = sub.add_parser("request", help="call an agent's skill")
    d.add_argument("to"); d.add_argument("skill"); d.add_argument("text")
    d.add_argument("--timeout", type=float, default=DEFAULT_LONG_TIMEOUT)

    r = sub.add_parser("serve", help="reply to requests on a skill")
    r.add_argument("skill"); r.add_argument("--reply", default="OK")

    e = sub.add_parser("emit", help="broadcast an event")
    e.add_argument("event_type"); e.add_argument("data", default="{}")

    f = sub.add_parser("file", help="send a file to an agent")
    f.add_argument("to"); f.add_argument("path"); f.add_argument("--action", default="analyze")

    sub.add_parser("health", help="probe the mesh monitoring endpoint")

    args = p.parse_args()

    # `health` only probes the monitoring HTTP endpoint — no NATS auth needed.
    if args.cmd == "health":
        host = os.environ.get("SYNAPSE_HOST", "localhost")
        port = int(os.environ.get("SYNAPSE_MON_PORT", "8222"))
        tmp = SynapseClient.__new__(SynapseClient)  # avoid connecting
        print(json.dumps(await tmp.health(monitor_port=port, host=host), indent=2))
        return

    nats_kwargs = {}
    if args.user:
        nats_kwargs["user"] = args.user
        nats_kwargs["password"] = args.password or ""
    mesh = await SynapseClient.connect(
        args.server, agent_id=args.id,
        nkey_seed_file=args.nkey, creds_file=args.creds,
        **nats_kwargs)

    if args.cmd == "discover":
        agents = await mesh.discover(capabilities=args.cap or None)
        print(json.dumps(agents, indent=2))
    elif args.cmd == "request":
        r = await mesh.request_long(args.to, args.skill,
                                    {"text": args.text}, timeout=args.timeout)
        print(json.dumps(r, indent=2, default=str))
    elif args.cmd == "serve":
        async def h(req, ctx):
            print(f"[serve] {req}", flush=True)
            return {"text": args.reply}
        await mesh.register(args.id or "echo", capabilities=[args.skill],
                            skills=[{"id": args.skill, "name": args.skill,
                                     "description": "echo"}])
        await mesh.serve(args.skill, h)
        await asyncio.Event().wait()
    elif args.cmd == "emit":
        await mesh.emit(args.event_type, json.loads(args.data))
    elif args.cmd == "file":
        r = await mesh.send_file(args.to, args.path, action=args.action)
        print(json.dumps(r, indent=2, default=str))
    elif args.cmd == "health":
        print(json.dumps(await mesh.health(), indent=2))
    await mesh.close()


if __name__ == "__main__":
    asyncio.run(_cli())
