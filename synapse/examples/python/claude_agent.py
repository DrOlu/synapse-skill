#!/usr/bin/env python3
"""claude_agent.py — LLM-powered agent using Anthropic Claude"""

import asyncio
import os
from anthropic import Anthropic
from synapse import connect

anthropic = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

async def chat_handler(payload, context):
    message = payload.get("input", {}).get("message", "")
    print(f"[Claude] Processing: '{message}'")

    response = anthropic.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=1000,
        messages=[{"role": "user", "content": message}],
    )

    text = response.content[0].text if response.content else ""
    return {"text": text}

async def summarize_handler(payload, context):
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
