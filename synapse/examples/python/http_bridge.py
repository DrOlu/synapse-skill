#!/usr/bin/env python3
"""http_bridge.py — Bidirectional HTTP↔Synapse bridge for Python agents"""

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import aiohttp
from aiohttp import web

from synapse import Synapse, connect


class HTTPAgentConfig:
    def __init__(
        self,
        id: str,
        name: str,
        base_url: str,
        capabilities: List[str],
        skills: List[Dict[str, str]],
        skill_path: str = "/skill/{skill}",
        method: str = "POST",
        timeout: float = 30.0,
    ):
        self.id = id
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.capabilities = capabilities
        self.skills = skills
        self.skill_path = skill_path
        self.method = method.upper()
        self.timeout = timeout


class HTTPBridge:
    def __init__(self, mesh: Synapse, webhook_port: int = 4100):
        self.mesh = mesh
        self.webhook_port = webhook_port
        self.agents: Dict[str, HTTPAgentConfig] = {}
        self._runner: Optional[web.AppRunner] = None

    async def register_agent(self, config: HTTPAgentConfig) -> None:
        """Register an HTTP agent in the Synapse mesh."""
        self.agents[config.id] = config

        await self.mesh.register(
            name=config.name,
            capabilities=config.capabilities,
            skills=config.skills,
        )

        for skill in config.skills:
            skill_id = skill["id"]
            def make_handler(cfg, sid):
                async def handler(payload, ctx):
                    return await self._proxy_request(cfg, sid, payload.get("input", {}))
                return handler
            self.mesh.on_request(skill_id, make_handler(config, skill_id))

        print(f'HTTP agent "{config.name}" ({config.id}) bridged to {config.base_url}')

    async def _proxy_request(self, config: HTTPAgentConfig, skill: str, input_data: Any) -> Any:
        """Forward a Synapse request to the HTTP agent."""
        skill_path = config.skill_path.replace("{skill}", skill)
        url = f"{config.base_url}{skill_path}"

        async with aiohttp.ClientSession() as session:
            timeout = aiohttp.ClientTimeout(total=config.timeout)
            if config.method == "POST":
                async with session.post(url, json={"skill": skill, "input": input_data}, timeout=timeout) as resp:
                    if resp.status >= 400:
                        raise Exception(f"HTTP agent returned {resp.status}")
                    body = await resp.json()
                    return body.get("output", body)
            else:
                async with session.get(url, timeout=timeout) as resp:
                    if resp.status >= 400:
                        raise Exception(f"HTTP agent returned {resp.status}")
                    body = await resp.json()
                    return body.get("output", body)

    async def start_webhook(self) -> None:
        """Start webhook server so HTTP agents can call Synapse mesh."""
        app = web.Application()
        app.router.add_post("/mesh/discover", self._handle_discover)
        app.router.add_post("/mesh/request", self._handle_request)
        app.router.add_get("/mesh/health", self._handle_health)

        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "0.0.0.0", self.webhook_port)
        await site.start()
        print(f"HTTP bridge webhook on http://localhost:{self.webhook_port}")

    async def _handle_discover(self, request: web.Request) -> web.Response:
        try:
            body = await request.json() if request.body_exists else {}
            agents = await self.mesh.discover(
                capabilities=body.get("capabilities"),
                timeout=body.get("timeout", 2.0),
            )
            return web.json_response({"agents": [
                {"id": a.id, "name": a.name, "capabilities": a.capabilities}
                for a in agents
            ]})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_request(self, request: web.Request) -> web.Response:
        body = await request.json()
        agent_id = body.get("agentId")
        skill = body.get("skill")
        input_data = body.get("input", {})
        timeout = body.get("timeout", 30.0)

        if not agent_id or not skill:
            return web.json_response({"error": "agentId and skill required"}, status=400)

        try:
            result = await self.mesh.request(agent_id, skill, input_data, timeout)
            return web.json_response(result.payload if result.payload else {})
        except TimeoutError:
            return web.json_response({"error": "timeout", "code": 4001, "retryable": True}, status=504)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_health(self, request: web.Request) -> web.Response:
        return web.json_response({
            "status": "ok",
            "agents": list(self.agents.keys()),
            "connected": self.mesh.is_connected,
        })

    async def stop(self) -> None:
        if self._runner:
            await self._runner.cleanup()
        await self.mesh.close()
