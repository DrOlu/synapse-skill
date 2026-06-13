from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route("/skill/chat", methods=["POST"])
def chat():
    data = request.get_json()
    inp = data.get("input", {})
    text = inp.get("text", "")
    return jsonify({"output": {"text": f"Flask says: I received '{text}'"}})

@app.route("/skill/summarize", methods=["POST"])
def summarize():
    data = request.get_json()
    inp = data.get("input", {})
    text = inp.get("text", "")
    word_count = len(text.split())
    return jsonify({"output": {"summary": f"Summary of {word_count} words", "word_count": word_count}})

@app.route("/skill/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
