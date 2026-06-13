#!/usr/bin/env python3
"""orchestrator_agent.py — Coordinates research → summarize delegation chain"""

import asyncio
from synapse import connect

mesh = None

async def research_handler(payload, context):
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
    print("[Orchestrator] Summary generated")

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
