#!/usr/bin/env python3
"""bob_agent.py — Bob's chat agent"""

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

    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await mesh.close()

if __name__ == "__main__":
    asyncio.run(main())
