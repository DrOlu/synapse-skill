#!/usr/bin/env python3
"""
Synapse Python SDK
Complete implementation of Synapse protocol on NATS
"""

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional
from dataclasses import dataclass, field, asdict
from enum import Enum

import nats
from nats.aio.client import Client as NATSClient


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
    description: str
    capabilities: List[str]
    skills: List[Skill]
    endpoint: str
    availability: Availability = Availability.ONLINE
    last_heartbeat: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "capabilities": self.capabilities,
            "skills": [s.to_dict() for s in self.skills],
            "endpoint": self.endpoint,
            "availability": self.availability.value,
            "last_heartbeat": self.last_heartbeat,
        }


@dataclass
class Envelope:
    v: str = "1.0.0"
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    type: str = "message"
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    from_agent: str = ""
    to_agent: Optional[str] = None
    task_id: Optional[str] = None
    trace: Optional[Dict[str, str]] = None
    payload: Optional[Any] = None
    artifacts: Optional[List[Any]] = None
    error: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "v": self.v,
            "id": self.id,
            "type": self.type,
            "ts": self.ts,
            "from": self.from_agent,
        }
        if self.to_agent:
            d["to"] = self.to_agent
        if self.task_id:
            d["task_id"] = self.task_id
        if self.trace:
            d["trace"] = self.trace
        if self.payload is not None:
            d["payload"] = self.payload
        if self.artifacts:
            d["artifacts"] = self.artifacts
        if self.error:
            d["error"] = self.error
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Envelope":
        return cls(
            v=data.get("v", "1.0.0"),
            id=data.get("id", str(uuid.uuid4())),
            type=data.get("type", "message"),
            ts=data.get("ts", datetime.now(timezone.utc).isoformat()),
            from_agent=data.get("from", ""),
            to_agent=data.get("to"),
            task_id=data.get("task_id"),
            trace=data.get("trace"),
            payload=data.get("payload"),
            artifacts=data.get("artifacts"),
            error=data.get("error"),
        )


class Synapse:
    """Synapse SDK for building agents on NATS"""

    def __init__(self, nc: NATSClient):
        self.nc = nc
        self.id = str(uuid.uuid4())
        self.manifest: Optional[AgentManifest] = None
        self._handlers: Dict[str, Callable] = {}
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._subs: List[Any] = []

    @classmethod
    async def connect(
        cls,
        url: str = "nats://localhost:4222",
        **kwargs,
    ) -> "Synapse":
        nc = await nats.connect(url, **kwargs)
        self = cls(nc)
        print(f"Connected to NATS at {url} with ID: {self.id}")
        return self

    @property
    def agent_id(self) -> str:
        return self.id

    @property
    def is_connected(self) -> bool:
        return self.nc.is_connected

    async def register(
        self,
        name: str,
        description: str = "",
        capabilities: Optional[List[str]] = None,
        skills: Optional[List[Dict[str, str]]] = None,
        heartbeat_interval: int = 30,
    ) -> AgentManifest:
        self.manifest = AgentManifest(
            id=self.id,
            name=name,
            description=description,
            capabilities=capabilities or [],
            skills=[Skill(**s) for s in (skills or [])],
            endpoint=f"mesh.agent.{self.id}.inbox",
            availability=Availability.ONLINE,
            last_heartbeat=datetime.now(timezone.utc).isoformat(),
        )

        envelope = Envelope(
            type="register",
            from_agent=self.id,
            payload=self.manifest.to_dict(),
        )
        await self.nc.publish("mesh.registry.register", json.dumps(envelope.to_dict()).encode())

        await self._setup_discover_responder()
        await self._setup_request_handler()

        if heartbeat_interval > 0:
            self._heartbeat_task = asyncio.create_task(
                self._heartbeat_loop(heartbeat_interval)
            )

        print(f"Agent '{name}' ({self.id}) registered")
        return self.manifest

    async def discover(
        self,
        capabilities: Optional[List[str]] = None,
        timeout: float = 1.0,
    ) -> List[AgentManifest]:
        agents = []
        inbox = self.nc.new_inbox()

        async def response_handler(msg):
            try:
                envelope = Envelope.from_dict(json.loads(msg.data.decode()))
                if envelope.payload and isinstance(envelope.payload, dict):
                    agents.append(
                        AgentManifest(
                            id=envelope.payload.get("id", "unknown"),
                            name=envelope.payload.get("name", "unknown"),
                            description=envelope.payload.get("description", ""),
                            capabilities=envelope.payload.get("capabilities", []),
                            skills=[Skill(**s) for s in envelope.payload.get("skills", [])],
                            endpoint=envelope.payload.get("endpoint", ""),
                            availability=Availability.ONLINE,
                            last_heartbeat=envelope.payload.get("last_heartbeat", ""),
                        )
                    )
            except Exception:
                pass

        sub = await self.nc.subscribe(inbox, cb=response_handler)
        self._subs.append(sub)

        request = Envelope(
            type="discover",
            from_agent=self.id,
            payload={"capabilities": capabilities or []},
        )

        await self.nc.publish(
            "mesh.registry.discover",
            json.dumps(request.to_dict()).encode(),
            reply=inbox,
        )

        await asyncio.sleep(timeout)
        await sub.unsubscribe()

        return agents

    async def request(
        self,
        agent_id: str,
        skill: str,
        input_data: Optional[Dict[str, Any]] = None,
        timeout: float = 30.0,
    ) -> Envelope:
        task_id = str(uuid.uuid4())
        inbox = self.nc.new_inbox()

        envelope = Envelope(
            type="request",
            from_agent=self.id,
            to_agent=agent_id,
            task_id=task_id,
            trace={
                "trace_id": str(uuid.uuid4()),
                "span_id": str(uuid.uuid4()),
            },
            payload={"skill": skill, "input": input_data or {}},
        )

        try:
            msg = await self.nc.request(
                f"mesh.agent.{agent_id}.inbox",
                json.dumps(envelope.to_dict()).encode(),
                timeout=timeout,
            )
            response = Envelope.from_dict(json.loads(msg.data.decode()))

            if response.error:
                raise Exception(
                    f"[{response.error.get('code', 0)}] {response.error.get('message', 'Unknown error')}"
                )

            return response

        except nats.errors.TimeoutError:
            raise TimeoutError(f"Request to {agent_id} timed out after {timeout}s")

    def on_request(self, skill: str, handler: Callable):
        self._handlers[skill] = handler
        print(f"Handler '{skill}' registered")

    async def emit(self, event_type: str, data: Any):
        envelope = Envelope(
            type="emit",
            from_agent=self.id,
            payload={"event_type": event_type.split(".")[-1], "data": data},
        )
        await self.nc.publish(
            f"mesh.event.{event_type}",
            json.dumps(envelope.to_dict()).encode(),
        )

    async def subscribe(self, pattern: str, handler: Callable) -> Any:
        async def message_handler(msg):
            try:
                envelope = Envelope.from_dict(json.loads(msg.data.decode()))
                await handler(envelope.payload)
            except Exception as e:
                print(f"Error in event handler: {e}")

        sub = await self.nc.subscribe(f"mesh.event.{pattern}", cb=message_handler)
        self._subs.append(sub)
        return sub

    async def close(self):
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass

        for sub in self._subs:
            try:
                await sub.unsubscribe()
            except:
                pass

        await self.nc.close()
        print(f"Agent {self.id} disconnected")

    async def _setup_discover_responder(self):
        async def handler(msg):
            if not self.manifest:
                return

            request = Envelope.from_dict(json.loads(msg.data.decode()))
            filter_caps = request.payload.get("capabilities", [])

            matches = not filter_caps or all(
                cap in self.manifest.capabilities for cap in filter_caps
            )

            if matches and msg.reply:
                response = Envelope(
                    type="register",
                    from_agent=self.id,
                    payload=self.manifest.to_dict(),
                )
                await self.nc.publish(
                    msg.reply,
                    json.dumps(response.to_dict()).encode(),
                )

        sub = await self.nc.subscribe("mesh.registry.discover", cb=handler)
        self._subs.append(sub)

    async def _setup_request_handler(self):
        inbox = f"mesh.agent.{self.id}.inbox"

        async def handler(msg):
            envelope = Envelope.from_dict(json.loads(msg.data.decode()))

            if envelope.type != "request":
                return

            skill = envelope.payload.get("skill")
            handler_fn = self._handlers.get(skill)

            if handler_fn:
                try:
                    if asyncio.iscoroutinefunction(handler_fn):
                        result = await handler_fn(envelope.payload, {
                            "task_id": envelope.task_id,
                            "from": envelope.from_agent,
                        })
                    else:
                        result = handler_fn(envelope.payload, {
                            "task_id": envelope.task_id,
                            "from": envelope.from_agent,
                        })

                    response = Envelope(
                        type="respond",
                        from_agent=self.id,
                        to_agent=envelope.from_agent,
                        task_id=envelope.task_id,
                        trace=envelope.trace,
                        payload={"output": result},
                    )

                    if msg.reply:
                        await self.nc.publish(
                            msg.reply,
                            json.dumps(response.to_dict()).encode(),
                        )

                except Exception as e:
                    error_response = Envelope(
                        type="respond",
                        from_agent=self.id,
                        to_agent=envelope.from_agent,
                        task_id=envelope.task_id,
                        trace=envelope.trace,
                        error={
                            "code": 5001,
                            "message": str(e),
                            "retryable": True,
                        },
                    )

                    if msg.reply:
                        await self.nc.publish(
                            msg.reply,
                            json.dumps(error_response.to_dict()).encode(),
                        )

            else:
                not_found = Envelope(
                    type="respond",
                    from_agent=self.id,
                    to_agent=envelope.from_agent,
                    task_id=envelope.task_id,
                    trace=envelope.trace,
                    error={
                        "code": 3001,
                        "message": f"Skill '{skill}' not found",
                        "retryable": False,
                    },
                )

                if msg.reply:
                    await self.nc.publish(
                        msg.reply,
                        json.dumps(not_found.to_dict()).encode(),
                    )

        sub = await self.nc.subscribe(inbox, cb=handler)
        self._subs.append(sub)

    async def _heartbeat_loop(self, interval: int):
        while True:
            try:
                # Publish to mesh.heartbeat.{id} (consistent with TS/Go SDKs)
                timestamp = datetime.now(timezone.utc).isoformat()
                envelope = Envelope(
                    type="heartbeat",
                    from_agent=self.id,
                    payload={"agent_id": self.id, "timestamp": timestamp},
                )
                await self.nc.publish(
                    f"mesh.heartbeat.{self.id}",
                    json.dumps(envelope.to_dict()).encode(),
                )
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"Heartbeat error: {e}")
                await asyncio.sleep(interval)


async def connect(url: str = "nats://localhost:4222", **kwargs) -> Synapse:
    return await Synapse.connect(url, **kwargs)
