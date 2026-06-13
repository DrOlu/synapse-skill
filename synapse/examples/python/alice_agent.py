#!/usr/bin/env python3
"""alice_agent.py — Alice discovers Bob and sends a request"""

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

    agents = await mesh.discover(capabilities=["chat"])
    bob = next((a for a in agents if "Bob" in a.name), None)

    if not bob:
        print("Could not find Bob!")
        await mesh.close()
        return

    print(f"Found Bob: {bob.id}")

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
