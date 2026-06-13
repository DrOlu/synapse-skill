#!/usr/bin/env python3
"""flask_chat_agent.py — A pure Flask agent that knows nothing about Synapse.
Run: python flask_chat_agent.py
Listens on port 5000. The bridge proxies Synapse requests to this agent.
"""

from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route("/skill/chat", methods=["POST"])
def chat():
    """Handles: POST {"skill": "chat", "input": {"text": "hello"}}"""
    data = request.get_json()
    inp = data.get("input", {})
    text = inp.get("text", "")

    # Business logic — this agent has no idea NATS or Synapse exist
    response_text = f"Flask says: I received '{text}'"

    return jsonify({"output": {"text": response_text}})

@app.route("/skill/summarize", methods=["POST"])
def summarize():
    """Handles: POST {"skill": "summarize", "input": {"text": "long doc"}}"""
    data = request.get_json()
    inp = data.get("input", {})
    text = inp.get("text", "")

    # Fake summarization
    word_count = len(text.split())
    summary = f"This text has {word_count} words."

    return jsonify({"output": {"summary": summary, "word_count": word_count}})

if __name__ == "__main__":
    print("Flask Chat Agent listening on http://localhost:5000")
    print("  POST /skill/chat       — chat with the agent")
    print("  POST /skill/summarize  — summarize text")
    app.run(port=5000)
