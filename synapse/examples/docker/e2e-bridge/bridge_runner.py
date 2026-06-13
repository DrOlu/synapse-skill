import asyncio
import os
import sys

sys.path.insert(0, "/app")
from http_bridge import HTTPBridge, HTTPAgentConfig
from synapse import connect

async def main():
    nats_url = os.environ.get("NATS_URL", "nats://nats:4222")
    flask_url = os.environ.get("FLASK_AGENT_URL", "http://flask-agent:5000")

    mesh = await connect(nats_url)
    bridge = HTTPBridge(mesh, webhook_port=4100)

    await bridge.register_agent(HTTPAgentConfig(
        id="flask-chat-001",
        name="Flask Chat Agent",
        base_url=flask_url,
        capabilities=["chat", "summarize"],
        skills=[
            {"id": "chat", "name": "Chat", "description": "Chat with Flask agent"},
            {"id": "summarize", "name": "Summarize", "description": "Summarize text"},
        ],
    ))

    await bridge.start_webhook()
    print("Bridge ready.")

    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await bridge.stop()

if __name__ == "__main__":
    asyncio.run(main())
