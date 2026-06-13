#!/usr/bin/env python3
"""utilities_agent.py — Agent with 5 text/math skills"""

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
