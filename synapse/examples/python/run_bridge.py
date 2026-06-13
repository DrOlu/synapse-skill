#!/usr/bin/env python3
"""run_bridge.py — Bridges the Flask chat agent into the Synapse mesh.

Prerequisites:
  1. Start NATS:         nats-server -js
  2. Start Flask agent:  python flask_chat_agent.py  (in another terminal)
  3. Run this:           python run_bridge.py

After running, any Synapse agent can discover and call the Flask agent:
  nats request mesh.registry.discover '{"capabilities":["chat"]}'
"""

import asyncio
from http_bridge import HTTPBridge, HTTPAgentConfig
from synapse import connect


async def main():
    # Connect to NATS mesh
    mesh = await connect("nats://localhost:4222")
    bridge = HTTPBridge(mesh, webhook_port=4100)

    # Bridge the Flask agent (running on localhost:5000) into Synapse
    await bridge.register_agent(HTTPAgentConfig(
        id="flask-chat-001",
        name="Flask Chat Agent",
        base_url="http://localhost:5000",
        capabilities=["chat", "summarize"],
        skills=[
            {"id": "chat", "name": "Chat", "description": "Chat with Flask agent"},
            {"id": "summarize", "name": "Summarize", "description": "Summarize text"},
        ],
    ))

    # Start webhook so the Flask agent can call Synapse agents too
    await bridge.start_webhook()

    print("\n✅ Bridge running!")
    print("   Flask agent is now a Synapse participant.")
    print("   Webhook: http://localhost:4100/mesh/request")
    print("")
    print("Test from another terminal:")
    print('   curl -X POST http://localhost:4100/mesh/discover -H "Content-Type: application/json" -d \'{"capabilities":["chat"]}\'')

    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down...")
        await bridge.stop()


if __name__ == "__main__":
    asyncio.run(main())
