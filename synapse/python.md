# Python SDK for Synapse

Complete Python SDK for building Synapse agents with async handlers, LLM integration, JetStream persistence, and production patterns.

## Table of Contents
- [Installation](#installation)
- [Core SDK](#core-sdk)
- [Basic Agent Examples](#basic-agent-examples)
- [LLM Agents](#llm-agents)
- [Event-Driven Agents](#event-driven-agents)
- [Advanced Patterns](#advanced-patterns)
- [Production Deployment](#production-deployment)

---

## Installation

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Linux/macOS
# venv\Scripts\activate   # Windows

# Install dependencies
pip install nats-py pydantic uvloop

# For async support (optional but recommended)
pip install uvloop aiodns

# For LLM integration
pip install anthropic openai

# For development
pip install pytest pytest-asyncio black mypy
```

**Requirements file (`requirements.txt`):**
```
nats-py>=2.8.0
pydantic>=2.0.0
uvloop>=0.19.0
anthropic>=0.34.0
openai>=1.0.0
```

---

## Core SDK

### `synapse.py` — Complete Synapse SDK

```python
#!/usr/bin/env python3
"""
Synapse Python SDK
Complete implementation of Synapse protocol on NATS
"""

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, TypeVar
from dataclasses import dataclass, field, asdict
from enum import Enum

import nats
from nats.aio.client import Client as NATSClient
from nats.js.client import JetStreamContext


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
    from_agent: str = ""  # Serialized as "from" in JSON (Python keyword)
    to_agent: Optional[str] = None  # Serialized as "to" in JSON (Python keyword)
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
        """Connect to NATS server"""
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
    
    # ==================== PRIMITIVE 1: REGISTER ====================
    
    async def register(
        self,
        name: str,
        description: str = "",
        capabilities: Optional[List[str]] = None,
        skills: Optional[List[Dict[str, str]]] = None,
        heartbeat_interval: int = 30,
        id: Optional[str] = None,
    ) -> AgentManifest:
        """Register agent with capabilities and skills"""
        
        # Allow caller to specify a stable agent ID (e.g., for HTTP bridge proxying)
        if id is not None:
            self.id = id
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
        
        # Publish registration
        envelope = Envelope(
            type="register",
            from_agent=self.id,
            payload=self.manifest.to_dict(),
        )
        await self.nc.publish("mesh.registry.register", json.dumps(envelope.to_dict()).encode())
        
        # Setup handlers
        await self._setup_discover_responder()
        await self._setup_request_handler()
        
        # Start heartbeat
        if heartbeat_interval > 0:
            self._heartbeat_task = asyncio.create_task(
                self._heartbeat_loop(heartbeat_interval)
            )
        
        print(f"Agent '{name}' ({self.id}) registered")
        return self.manifest
    
    # ==================== PRIMITIVE 2: DISCOVER ====================
    
    async def discover(
        self,
        capabilities: Optional[List[str]] = None,
        timeout: float = 1.0,
    ) -> List[AgentManifest]:
        """Discover agents by capability"""
        
        agents = []
        seen = set()  # Deduplicate by agent ID
        inbox = self.nc.new_inbox()
        
        fut = asyncio.Future()
        
        async def response_handler(msg):
            try:
                envelope = Envelope.from_dict(json.loads(msg.data.decode()))
                if envelope.payload and isinstance(envelope.payload, dict):
                    agent_id = envelope.payload.get("id", "unknown")
                    if agent_id in seen:
                        return  # Skip duplicate
                    seen.add(agent_id)
                    agents.append(
                        AgentManifest(
                            id=agent_id,
                            name=envelope.payload.get("name", "unknown"),
                            description=envelope.payload.get("description", ""),
                            capabilities=envelope.payload.get("capabilities", []),
                            skills=[Skill(**s) for s in envelope.payload.get("skills", [])],
                            endpoint=envelope.payload.get("endpoint", ""),
                            availability=Availability.ONLINE,
                            last_heartbeat=envelope.payload.get("last_heartbeat", ""),
                        )
                    )
            except Exception as e:
                pass
        
        sub = await self.nc.subscribe(inbox, cb=response_handler)
        self._subs.append(sub)
        
        # Send discover request
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
        
        # Wait for responses
        await asyncio.sleep(timeout)
        await sub.unsubscribe()
        
        return agents
    
    # ==================== PRIMITIVE 3: REQUEST ====================
    
    async def request(
        self,
        agent_id: str,
        skill: str,
        input_data: Optional[Dict[str, Any]] = None,
        timeout: float = 30.0,
    ) -> Envelope:
        """Send request to agent and wait for response"""
        
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
    
    # ==================== PRIMITIVE 4: RESPOND (Handler Registration) ====================
    
    def on_request(
        self,
        skill: str,
        handler: Callable,
    ):
        """Register handler for skill"""
        self._handlers[skill] = handler
        print(f"Handler '{skill}' registered")
    
    # ==================== PRIMITIVE 5: EMIT ====================
    
    async def emit(
        self,
        event_type: str,
        data: Any,
    ):
        """Emit event to subscribers"""
        
        envelope = Envelope(
            type="emit",
            from_agent=self.id,
            payload={"event_type": event_type.split(".")[-1], "data": data},
        )
        
        await self.nc.publish(
            f"mesh.event.{event_type}",
            json.dumps(envelope.to_dict()).encode(),
        )
    
    # ==================== PRIMITIVE 6: SUBSCRIBE ====================
    
    async def subscribe(
        self,
        pattern: str,
        handler: Callable,
    ) -> Any:
        """Subscribe to events with wildcard pattern"""
        
        async def message_handler(msg):
            try:
                envelope = Envelope.from_dict(json.loads(msg.data.decode()))
                await handler(envelope.payload)
            except Exception as e:
                print(f"Error in event handler: {e}")
        
        sub = await self.nc.subscribe(f"mesh.event.{pattern}", cb=message_handler)
        self._subs.append(sub)
        return sub
    
    # ==================== DISCONNECT ====================
    
    async def close(self):
        """Disconnect and cleanup"""
        
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
    
    # ==================== INTERNAL HELPERS ====================
    
    async def _setup_discover_responder(self):
        """Setup responder for discover requests"""
        
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
        """Setup handler for incoming requests"""
        
        inbox = f"mesh.agent.{self.id}.inbox"
        
        async def handler(msg):
            envelope = Envelope.from_dict(json.loads(msg.data.decode()))
            
            if envelope.type != "request":
                return
            
            skill = envelope.payload.get("skill")
            handler_fn = self._handlers.get(skill)
            
            if handler_fn:
                try:
                    # Call handler (supports both sync and async)
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
        """Send periodic heartbeats"""
        
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


# Convenience function
async def connect(url: str = "nats://localhost:4222", **kwargs) -> Synapse:
    """Create and connect Synapse instance"""
    return await Synapse.connect(url, **kwargs)
```

---

## Basic Agent Examples

### Two-Agent Chat (Alice + Bob)

```python
#!/usr/bin/env python3
"""bob_agent.py - Bob's chat agent"""

import asyncio
from synapse import connect

async def main():
    mesh = await connect("nats://localhost:4222")
    
    await mesh.register(
        name="Bob's Agent",
        description="Friendly chat agent",
        capabilities=["chat"],
        skills=[
            {"id": "chat", "name": "Chat", "description": "Chat with Bob"},
        ],
    )
    
    def chat_handler(payload, context):
        text = payload.get("input", {}).get("text", "")
        print(f"[Bob] Received: '{text}'")
        return {"text": f"Bob says: I got your message! You said '{text}'"}
    
    mesh.on_request("chat", chat_handler)
    
    print("Bob agent online, waiting for messages...")
    
    # Keep running
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await mesh.close()

if __name__ == "__main__":
    asyncio.run(main())
```

```python
#!/usr/bin/env python3
"""alice_agent.py - Alice sends requests to Bob"""

import asyncio
from synapse import connect

async def main():
    mesh = await connect("nats://localhost:4222")
    
    await mesh.register(
        name="Alice's Agent",
        capabilities=[],
        skills=[],
    )
    
    print("Alice agent online, discovering Bob...")
    
    # Discover Bob
    agents = await mesh.discover(capabilities=["chat"])
    bob = next((a for a in agents if "Bob" in a.name), None)
    
    if not bob:
        print("Could not find Bob!")
        await mesh.close()
        return
    
    print(f"Found Bob: {bob.id}")
    
    # Send request
    try:
        response = await mesh.request(
            bob.id,
            "chat",
            {"text": "Hey Bob, how's it going?"},
            timeout=5.0,
        )
        
        print(f"Bob's response: {response.payload}")
    
    except Exception as e:
        print(f"Error: {e}")
    
    await mesh.close()

if __name__ == "__main__":
    asyncio.run(main())
```

**Run:**
```bash
# Terminal 1: Start NATS
nats-server

# Terminal 2: Start Bob
python bob_agent.py

# Terminal 3: Start Alice
python alice_agent.py
```

---

### Multi-Skill Agent

```python
#!/usr/bin/env python3
"""utilities_agent.py - Agent with multiple skills"""

import asyncio
from synapse import connect

async def main():
    mesh = await connect("nats://localhost:4222")
    
    await mesh.register(
        name="Utilities Agent",
        description="Common text and math utilities",
        capabilities=["text", "math"],
        skills=[
            {"id": "uppercase", "name": "Uppercase", "description": "Convert to uppercase"},
            {"id": "reverse", "name": "Reverse", "description": "Reverse a string"},
            {"id": "strlen", "name": "String Length", "description": "Count characters"},
            {"id": "add", "name": "Add", "description": "Add two numbers"},
            {"id": "multiply", "name": "Multiply", "description": "Multiply two numbers"},
        ],
    )
    
    # Register handlers
    def uppercase_handler(payload, context):
        text = payload.get("input", {}).get("text", "")
        return {"text": text.upper()}
    
    def reverse_handler(payload, context):
        text = payload.get("input", {}).get("text", "")
        return {"text": text[::-1]}
    
    def strlen_handler(payload, context):
        text = payload.get("input", {}).get("text", "")
        return {"length": len(text)}
    
    def add_handler(payload, context):
        a = payload.get("input", {}).get("a", 0)
        b = payload.get("input", {}).get("b", 0)
        return {"result": a + b}
    
    def multiply_handler(payload, context):
        a = payload.get("input", {}).get("a", 0)
        b = payload.get("input", {}).get("b", 0)
        return {"result": a * b}
    
    mesh.on_request("uppercase", uppercase_handler)
    mesh.on_request("reverse", reverse_handler)
    mesh.on_request("strlen", strlen_handler)
    mesh.on_request("add", add_handler)
    mesh.on_request("multiply", multiply_handler)
    
    print("Utilities agent online with 5 skills")
    
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await mesh.close()

if __name__ == "__main__":
    asyncio.run(main())
```

---

## LLM Agents

### Claude Integration

```python
#!/usr/bin/env python3
"""claude_agent.py - LLM-powered agent using Anthropic Claude"""

import asyncio
import os
from anthropic import Anthropic
from synapse import connect

# Initialize Claude client
anthropic = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

async def chat_handler(payload, context):
    """Chat with Claude"""
    
    message = payload.get("input", {}).get("message", "")
    print(f"[Claude] Processing: '{message}'")
    
    # Call Claude API
    response = anthropic.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=1000,
        messages=[{"role": "user", "content": message}],
    )
    
    text = response.content[0].text if response.content else ""
    return {"text": text}

async def summarize_handler(payload, context):
    """Summarize text using Claude"""
    
    text = payload.get("input", {}).get("text", "")
    print(f"[Claude] Summarizing text ({len(text)} chars)")
    
    response = anthropic.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=500,
        messages=[
            {"role": "user", "content": f"Summarize this text in 2-3 sentences:\n\n{text}"},
        ],
    )
    
    summary = response.content[0].text if response.content else ""
    return {"summary": summary}

async def main():
    mesh = await connect("nats://localhost:4222")
    
    await mesh.register(
        name="Claude Agent",
        description="LLM-powered agent using Claude",
        capabilities=["llm", "chat", "analysis"],
        skills=[
            {"id": "chat", "name": "Chat", "description": "Chat with Claude"},
            {"id": "summarize", "name": "Summarize", "description": "Summarize text"},
        ],
    )
    
    mesh.on_request("chat", chat_handler)
    mesh.on_request("summarize", summarize_handler)
    
    print("Claude agent online")
    
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await mesh.close()

if __name__ == "__main__":
    asyncio.run(main())
```

### OpenAI Integration

```python
#!/usr/bin/env python3
"""openai_agent.py - LLM-powered agent using OpenAI"""

import asyncio
import os
from openai import OpenAI
from synapse import connect

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

async def translate_handler(payload, context):
    """Translate text using GPT"""
    
    text = payload.get("input", {}).get("text", "")
    target_lang = payload.get("input", {}).get("target", "Spanish")
    
    response = openai_client.chat.completions.create(
        model="gpt-4",
        messages=[
            {"role": "system", "content": f"You are a translator. Translate to {target_lang}."},
            {"role": "user", "content": text},
        ],
        max_tokens=1000,
    )
    
    translation = response.choices[0].message.content
    return {"translation": translation}

async def code_review_handler(payload, context):
    """Review code using GPT"""
    
    code = payload.get("input", {}).get("code", "")
    language = payload.get("input", {}).get("language", "generic")
    
    response = openai_client.chat.completions.create(
        model="gpt-4",
        messages=[
            {
                "role": "system",
                "content": f"You are a {language} code reviewer. Focus on bugs, security, and performance.",
            },
            {"role": "user", "content": f"Review this code:\n\n{code}"},
        ],
        max_tokens=1000,
    )
    
    review = response.choices[0].message.content
    return {"review": review}

async def main():
    mesh = await connect("nats://localhost:4222")
    
    await mesh.register(
        name="GPT Agent",
        capabilities=["llm", "translation", "review"],
        skills=[
            {"id": "translate", "name": "Translate", "description": "Translate text"},
            {"id": "code-review", "name": "Code Review", "description": "Review code"},
        ],
    )
    
    mesh.on_request("translate", translate_handler)
    mesh.on_request("code-review", code_review_handler)
    
    print("GPT agent online")
    
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await mesh.close()

if __name__ == "__main__":
    asyncio.run(main())
```

---

## Event-Driven Agents

### Pipeline Architecture

```python
#!/usr/bin/env python3
"""document_pipeline.py - Event-driven document processing pipeline"""

import asyncio
from synapse import connect

async def main():
    mesh = await connect("nats://localhost:4222")
    
    await mesh.register(
        name="Document Pipeline",
        capabilities=["documents"],
        skills=[],
    )
    
    async def handle_document_event(event):
        event_type = event.get("event_type")
        data = event.get("data", {})
        
        print(f"[Pipeline] Received event: {event_type}")
        print(f"[Pipeline] Data: {data}")
        
        if event_type == "uploaded":
            filename = data.get("filename")
            print(f"[Pipeline] Processing: {filename}")
            
            # Simulate processing
            await asyncio.sleep(2)
            
            # Emit processing complete
            await mesh.emit("document.processed", {
                "filename": filename,
                "status": "complete",
                "word_count": 1000,
            })
        
        elif event_type == "error":
            print(f"[Pipeline] Error: {data.get('error')}")
    
    # Subscribe to all document events
    await mesh.subscribe("document.>", handle_document_event)
    
    print("Document pipeline online, watching for events...")
    
    # Simulate uploads for testing
    async def simulate_uploads():
        await asyncio.sleep(2)
        
        for i in range(3):
            await mesh.emit("document.uploaded", {
                "filename": f"test-{i}.txt",
                "size": 1024 * (i + 1),
            })
            await asyncio.sleep(3)
    
    asyncio.create_task(simulate_uploads())
    
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await mesh.close()

if __name__ == "__main__":
    asyncio.run(main())
```

---

## Advanced Patterns

### Delegation Chain (Orchestrator Pattern)

```python
#!/usr/bin/env python3
"""orchestrator.py - Coordinates multiple agents"""

import asyncio
from synapse import connect

async def research_handler(payload, context):
    """Orchestrate research → summarize workflow"""
    
    topic = payload.get("input", {}).get("topic", "")
    print(f"[Orchestrator] Starting research on: '{topic}'")
    
    # Step 1: Discover research agent
    researchers = await mesh.discover(capabilities=["research"], timeout=2.0)
    if not researchers:
        raise Exception("No research agents available")
    
    researcher = researchers[0]
    print(f"[Orchestrator] Delegating to: {researcher.name}")
    
    # Step 2: Request research
    research_result = await mesh.request(
        researcher.id,
        "research",
        {"topic": topic},
        timeout=60.0,
    )
    findings = research_result.payload.get("output", {}).get("findings", [])
    print(f"[Orchestrator] Research complete ({len(findings)} findings)")
    
    # Step 3: Discover summarizer
    summarizers = await mesh.discover(capabilities=["summarize"], timeout=2.0)
    if not summarizers:
        raise Exception("No summarizer agents available")
    
    summarizer = summarizers[0]
    print(f"[Orchestrator] Delegating to: {summarizer.name}")
    
    # Step 4: Request summary
    summary_result = await mesh.request(
        summarizer.id,
        "summarize",
        {"findings": findings, "format": "brief"},
        timeout=30.0,
    )
    summary = summary_result.payload.get("output", {}).get("summary", "")
    print(f"[Orchestrator] Summary generated")
    
    return {
        "topic": topic,
        "findings": findings,
        "summary": summary,
        "research_agent": researcher.name,
        "summarize_agent": summarizer.name,
    }

async def main():
    global mesh
    mesh = await connect("nats://localhost:4222")
    
    await mesh.register(
        name="Orchestrator",
        capabilities=["orchestration"],
        skills=[
            {
                "id": "research-project",
                "name": "Research Project",
                "description": "Full research + summary workflow",
            },
        ],
    )
    
    mesh.on_request("research-project", research_handler)
    
    print("Orchestrator online")
    
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await mesh.close()

if __name__ == "__main__":
    asyncio.run(main())
```

---

### Fan-Out / Fan-In (Parallel Processing)

```python
#!/usr/bin/env python3
"""parallel_processor.py - Process items in parallel across workers"""

import asyncio
from synapse import connect

async def parallel_process_handler(payload, context, mesh):
    """Process items in parallel using multiple agents"""
    
    items = payload.get("input", {}).get("items", [])
    print(f"[Parallel] Processing {len(items)} items")
    
    # Discover all workers
    workers = await mesh.discover(capabilities=["worker"], timeout=2.0)
    if not workers:
        raise Exception("No worker agents available")
    
    print(f"[Parallel] Found {len(workers)} workers")
    
    # Spawn all requests in parallel
    async def process_item(item, index):
        worker = workers[index % len(workers)]
        print(f"[Parallel] Item {index + 1} → {worker.name}")
        
        result = await mesh.request(worker.id, "process", {"item": item})
        return {"index": index, "result": result.payload.get("output")}
    
    # Use asyncio.gather for true parallelism
    tasks = [process_item(item, i) for i, item in enumerate(items)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    # Filter out errors
    successful = [r for r in results if not isinstance(r, Exception)]
    failed = [r for r in results if isinstance(r, Exception)]
    
    return {
        "total": len(items),
        "successful": len(successful),
        "failed": len(failed),
        "results": successful,
    }

async def main():
    mesh = await connect("nats://localhost:4222")
    
    await mesh.register(
        name="Parallel Processor",
        capabilities=["parallel"],
        skills=[
            {
                "id": "parallel-process",
                "name": "Parallel Process",
                "description": "Process items across multiple agents",
            },
        ],
    )
    
    # Pass mesh to handler
    mesh.on_request(
        "parallel-process",
        lambda p, c: parallel_process_handler(p, c, mesh),
    )
    
    print("Parallel processor online")
    
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await mesh.close()

if __name__ == "__main__":
    asyncio.run(main())
```

---

## Production Deployment

### Docker Setup

```dockerfile
# Dockerfile
FROM python:3.11-alpine

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Set environment
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Run agent
CMD ["python", "agent.py"]
```

```yaml
# docker-compose.yml
version: "3.8"

services:
  nats:
    image: nats:2.11-alpine
    container_name: nats-server
    ports:
      - "4222:4222"
      - "8222:8222"
    command: ["-js", "-m", "8222"]
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8222/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped

  bob-agent:
    build: .
    container_name: bob-agent
    depends_on:
      - nats
    environment:
      NATS_URL: nats://nats:4222
      AGENT_NAME: bob-agent
    command: ["python", "bob_agent.py"]
    restart: unless-stopped

  claude-agent:
    build: .
    container_name: claude-agent
    depends_on:
      - nats
    environment:
      NATS_URL: nats://nats:4222
      AGENT_NAME: claude-agent
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    command: ["python", "claude_agent.py"]
    restart: unless-stopped

  openai-agent:
    build: .
    container_name: openai-agent
    depends_on:
      - nats
    environment:
      NATS_URL: nats://nats:4222
      AGENT_NAME: openai-agent
      OPENAI_API_KEY: ${OPENAI_API_KEY}
    command: ["python", "openai_agent.py"]
    restart: unless-stopped
```

**Start:**
```bash
export ANTHROPIC_API_KEY=your_key
export OPENAI_API_KEY=your_key
docker-compose up -d
```

---

## Schema Validation

Validate envelopes and manifests using JSON Schema + `jsonschema` to catch malformed messages before they propagate.

### Install

```bash
pip install jsonschema
```

### Usage

```python
from validate import validate_envelope, assert_envelope, validate_manifest, assert_manifest, SynapseValidationError

# Validate and get errors
errors = validate_envelope(incoming_data)
if errors:
    print("Invalid envelope:", errors)
    # Respond with error code 2001 (INVALID_ENVELOPE)

# Or assert (raises SynapseValidationError on invalid)
try:
    assert_envelope(outgoing_envelope_dict)
    # Safe to send
except SynapseValidationError as e:
    print(f"Bug: tried to send invalid envelope: {e}")

# Validate manifests at registration
try:
    assert_manifest(manifest_dict)
except SynapseValidationError as e:
    print(f"Bug: invalid manifest: {e}")
```

Full schema definitions and validator modules for all 3 SDKs are in [schema.md](./schema.md).

---

## OpenTelemetry Integration

Wire up OTel tracing to track requests across agent hops.

### Install

```bash
pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp
```

### Quick Setup

```python
from tracing import init_tracing, start_handler_span, start_request_span, record_request, record_latency

# Initialize at startup
init_tracing("my-agent", "http://localhost:4317")

# In handler — create a SERVER span
async def chat_handler(payload, context):
    span = start_handler_span("chat", context["from"])
    try:
        result = {"text": f"Echo: {payload.get('input', {}).get('text', '')}"}
        span.end()
        return result
    except Exception as e:
        span.record_exception(e)
        span.end()
        raise

# For outgoing requests — create a CLIENT span
async def traced_request(mesh, agent_id, skill, input_data):
    span, trace_ctx = start_request_span(skill, agent_id)
    start = time.time()
    try:
        result = await mesh.request(agent_id, skill, input_data)
        record_request(skill, mesh.id, agent_id)
        record_latency(skill, (time.time() - start) * 1000)
        span.end()
        return result
    except Exception as e:
        span.record_exception(e)
        span.end()
        raise
```

Full tracing module, Grafana dashboard, and Docker Compose observability stack are in [observability.md](./observability.md).

---

## Streaming Primitives

Synapse supports incremental responses via a stream subject per task.
Each task gets its own subject: `mesh.task.{task_id}.stream`.
Chunks are published as individual NATS messages; the final message has `done: true`.

### Caller side: `stream_request()`

Returns an async iterator yielding each chunk as it arrives.

```python
async for chunk in mesh.stream_request(agent_id, "analyze", {"text": "huge document"}):
    # chunk is {"word": "lorem"}, {"word": "ipsum"}, etc.
    print("chunk:", chunk)
# loop exits when done: true arrives
```

### Handler side: `on_stream_request()`

Registers an async generator handler that yields chunks.

```python
async def analyze_handler(payload, context):
    text = payload.get("input", {}).get("text", "")
    words = text.split()
    for i, word in enumerate(words):
        yield {"word": word, "index": i, "total": len(words)}

mesh.on_stream_request("analyze", analyze_handler)
```

### LLM Streaming Example

```python
# Caller
chunks = []
async for chunk in mesh.stream_request(agent_id, "chat", {"message": "explain quantum"}):
    chunks.append(chunk["token"])
    print(chunk["token"], end="", flush=True)
full_response = "".join(chunks)

# Handler (using Anthropic SDK streaming)
async def chat_stream_handler(payload, context):
    message = payload.get("input", {}).get("message", "")
    with anthropic.messages.stream(
        model="claude-3-5-sonnet-20241022",
        max_tokens=2000,
        messages=[{"role": "user", "content": message}],
    ) as stream:
        for chunk in stream:
            if hasattr(chunk, "delta") and hasattr(chunk.delta, "text"):
                yield {"token": chunk.delta.text}

mesh.on_stream_request("chat", chat_stream_handler)
```

### Wire format

Each chunk message on `mesh.task.{task_id}.stream`:

```json
{
  "seq": 0,
  "chunk": { "token": "Hello" },
  "done": false
}
```

Final message:

```json
{
  "seq": 4,
  "chunk": { "token": "world" },
  "done": true,
  "result": { "full_text": "Hello world" }
}
```

### Implementation

```python
# Add to Synapse class

async def stream_request(
    self,
    agent_id: str,
    skill: str,
    input_data: Optional[Dict[str, Any]] = None,
    timeout: float = 30.0,
) -> "AsyncIterator[Dict[str, Any]]":
    """Send a streaming request. Yields each chunk as it arrives."""
    task_id = str(uuid.uuid4())
    stream_subject = f"mesh.task.{task_id}.stream"

    chunk_queue: asyncio.Queue = asyncio.Queue()

    # Subscribe to stream before sending request
    async def stream_listener(msg):
        chunk = json.loads(msg.data.decode())
        await chunk_queue.put(chunk)
        if chunk.get("done"):
            await chunk_queue.put(None)  # sentinel for shutdown

    sub = await self.nc.subscribe(stream_subject, cb=stream_listener)

    # Send the request
    envelope = Envelope(
        type="request",
        from_agent=self.id,
        to_agent=agent_id,
        task_id=task_id,
        trace={"trace_id": str(uuid.uuid4()), "span_id": str(uuid.uuid4())},
        payload={"skill": skill, "input": input_data or {}, "stream": True},
    )
    await self.nc.publish(
        f"mesh.agent.{agent_id}.inbox",
        json.dumps(envelope.to_dict()).encode(),
    )

    # Yield chunks as they arrive, with timeout
    deadline = asyncio.get_event_loop().time() + timeout
    try:
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise TimeoutError(f"Stream timeout after {timeout}s")
            chunk = await asyncio.wait_for(chunk_queue.get(), timeout=remaining)
            if chunk is None:  # sentinel
                break
            if chunk.get("done"):
                if chunk.get("result"):
                    yield chunk["result"]
                break
            yield chunk.get("chunk", {})
    finally:
        await sub.unsubscribe()


def on_stream_request(self, skill: str, generator_fn):
    """Register an async generator handler for a streaming skill."""
    async def wrapped_handler(payload, ctx):
        task_id = ctx.get("task_id", str(uuid.uuid4()))
        stream_subject = f"mesh.task.{task_id}.stream"
        seq = 0

        async for chunk in generator_fn(payload, ctx):
            payload_msg = json.dumps({"seq": seq, "chunk": chunk, "done": False}).encode()
            await self.nc.publish(stream_subject, payload_msg)
            seq += 1

        # Final stream message
        final = json.dumps({"seq": seq, "chunk": {}, "done": True, "result": None}).encode()
        await self.nc.publish(stream_subject, final)

        # Return None since chunks were sent via stream
        # The caller receives via stream, final response is just acknowledgment
        return {"status": "streamed", "chunks_sent": seq}

    self.on_request(skill, wrapped_handler)
```

---

## Backpressure & Flow Control

Adaptive rate limiting, concurrency limits, and queue depth management to protect agents from overload.

### Implementation

```python
# backpressure.py
import asyncio
import time
from typing import Optional


class ConcurrencyLimiter:
    """Limit concurrent request handlers."""
    def __init__(self, max_concurrency: int = 10):
        self.max_concurrency = max_concurrency
        self.semaphore = asyncio.Semaphore(max_concurrency)
        self._active = 0
        self._pending = 0

    async def acquire(self):
        self._pending += 1
        await self.semaphore.acquire()
        self._pending -= 1
        self._active += 1

    def release(self):
        self._active -= 1
        self.semaphore.release()

    @property
    def active(self) -> int:
        return self._active

    @property
    def pending(self) -> int:
        return self._pending

    @property
    def is_overloaded(self) -> bool:
        return self._pending > self.max_concurrency * 2


class AdaptiveRateLimiter:
    """Token bucket rate limiter that backs off on OVERLOADED (4001)."""
    def __init__(self, max_tokens: int = 50, refill_ms: int = 1000, min_tokens: int = 5):
        self.max_tokens = max_tokens
        self.min_tokens = min_tokens
        self.original_max = max_tokens
        self.token_bucket = float(max_tokens)
        self.last_refill = time.monotonic()
        self.refill_ms = refill_ms / 1000.0
        self._consecutive_overloads = 0

    def try_acquire(self) -> bool:
        self._refill()
        if self.token_bucket >= 1:
            self.token_bucket -= 1
            return True
        return False

    async def acquire(self):
        while not self.try_acquire():
            await asyncio.sleep(0.05)

    def on_overload(self):
        """Call when downstream returns OVERLOADED (4001)."""
        self._consecutive_overloads += 1
        self.max_tokens = max(
            self.min_tokens,
            int(self.max_tokens / (2 ** self._consecutive_overloads))
        )
        self.token_bucket = min(self.token_bucket, self.max_tokens)

    def on_success(self):
        """Call when a request succeeds."""
        if self._consecutive_overloads > 0:
            self._consecutive_overloads -= 1
            self.max_tokens = min(self.max_tokens * 2, self.original_max)

    def _refill(self):
        now = time.monotonic()
        elapsed = now - self.last_refill
        if elapsed >= self.refill_ms:
            self.token_bucket = min(self.max_tokens, self.token_bucket + self.max_tokens)
            self.last_refill = now
```

### Integration

```python
from backpressure import ConcurrencyLimiter, AdaptiveRateLimiter
from synapse import Synapse

class ProtectedSynapse(Synapse):
    def __init__(self, nc):
        super().__init__(nc)
        self._concurrency = ConcurrencyLimiter(10)
        self._rate_limiter = AdaptiveRateLimiter(50)

    def on_request(self, skill: str, handler):
        async def protected_handler(payload, context):
            if not self._rate_limiter.try_acquire():
                raise Exception("[4002] Rate limited")

            await self._concurrency.acquire()
            try:
                result = await handler(payload, context) if asyncio.iscoroutinefunction(handler) else handler(payload, context)
                self._rate_limiter.on_success()
                return result
            except Exception as e:
                if "4001" in str(e):
                    self._rate_limiter.on_overload()
                raise
            finally:
                self._concurrency.release()

        super().on_request(skill, protected_handler)
```

---

## Next Steps

- [Complete Examples](./examples/python/) — Full runnable projects
- [Patterns Guide](./patterns.md) — Advanced patterns
- [Security](./security.md) — Authentication and multi-tenant
- [Schema Validation](./schema.md) — JSON Schema definitions
- [Observability](./observability.md) — OTel tracing and dashboards
