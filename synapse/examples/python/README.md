# Synapse Python Examples

Complete runnable Synapse agents in Python.

## Prerequisites

- Python 3.11+
- NATS server running (`nats-server -js`)

## Setup

```bash
pip install -r requirements.txt
```

## Agents

| Agent | Description | Run |
|-------|-------------|-----|
| **Bob** | Chat responder (basic request/reply) | `python bob_agent.py` |
| **Alice** | Discovers Bob and sends message | `python alice_agent.py` |
| **Utilities** | 5 skills: uppercase, reverse, strlen, add, multiply | `python utilities_agent.py` |
| **Claude** | LLM-powered chat + summarize (needs `ANTHROPIC_API_KEY`) | `python claude_agent.py` |
| **Orchestrator** | Delegation chain: research → summarize | `python orchestrator_agent.py` |

## Quick Start

```bash
# Terminal 1: Start NATS
nats-server -js

# Terminal 2: Start Bob
python bob_agent.py

# Terminal 3: Send request from Alice
python alice_agent.py
```

## Files

```
synapse.py            — Complete Synapse SDK (copy this into your projects)
bob_agent.py          — Basic chat agent
alice_agent.py        — Discover + request agent
utilities_agent.py    — Multi-skill text/math agent
claude_agent.py       — LLM-powered agent (Anthropic Claude)
orchestrator_agent.py — Delegation chain coordinator
requirements.txt      — Python dependencies
```
