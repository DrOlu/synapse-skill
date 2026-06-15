# File Transfer via NATS

A chunked file transfer protocol built natively on top of Synapse. Send documents to grip agents (or any Synapse agent) over the mesh — the file is split into chunks, transmitted over NATS, reassembled, written to disk, and automatically dispatched to the target agent for analysis.

## Why Chunked Transfer?

Synapse envelopes are text-only JSON:

```json
{"payload": {"text": "your message"}}
```

NATS messages have a practical size limit of ~1MB (Synadia Cloud free tier enforces this). To send files of any size, Synapse uses a **3-phase chunked protocol**:

```
Sender                          File Receiver                   Target Agent
┌──────────┐                    ┌──────────────┐                ┌──────────┐
│ 1. init  │ ─── init ────────▶│ 2. accept    │                │          │
│ 3. chunk │ ─── chunks ───────▶│ 4. buffer    │                │          │
│ 5. done  │ ─── done ─────────▶│ 6. reassemble│                │          │
│          │                    │ 7. write     │ ─── request ──▶│ 8. run   │
│          │                    │ 9. dispatch  │ ◀── respond ───│ 9. reply │
└──────────┘                    └──────────────┘                └──────────┘
```

## NATS Subject Namespace

| Phase | Subject | Direction | Payload Format |
|---|---|---|---|
| **Init** | `mesh.files.{task_id}.init` | Sender → Receiver | JSON metadata |
| **Chunk** | `mesh.files.{task_id}.chunks` | Sender → Receiver | JSON header + `\n` + raw bytes |
| **Done** | `mesh.files.{task_id}.done` | Sender → Receiver | JSON with sha256 |
| **Result** | `mesh.files.{task_id}.result` | Receiver → Sender | Original Synapse envelope |

`{task_id}` is a unique 12-character UUID prefix generated per transfer. The `*` wildcard matches it (single token), `>` cannot be used here.

## Phase 1: Init

Sender publishes transfer metadata. Receiver acknowledges readiness.

```json
{
  "task_id": "603f8b96-f1b",
  "filename": "document.pdf",
  "size": 154674,
  "chunks": 1,
  "chunk_size": 900000,
  "mime_type": "application/pdf",
  "action": "analyze",
  "prompt": "Summarize this document",
  "target_inbox": "mesh.agent.grip-001.inbox",
  "reply_to": "mesh.files.603f8b96-f1b.result"
}
```

### Supported fields

| Field | Type | Description |
|---|---|---|
| `task_id` | string | Unique transfer ID (generated if omitted) |
| `filename` | string | Original filename (sanitized before saving) |
| `size` | integer | File size in bytes |
| `chunks` | integer | Expected number of chunks |
| `chunk_size` | integer | Byte size per chunk (default: 900000) |
| `mime_type` | string | MIME type (autodetected from extension) |
| `action` | string | `analyze`, `summarize`, `extract`, `describe`, or custom |
| `prompt` | string | Custom prompt sent to the target agent |
| `target_inbox` | string | NATS inbox subject of the receiving agent |
| `reply_to` | string | Where to forward the agent's response |

### Default actions

| Action | Default Prompt |
|---|---|
| `analyze` | Read and analyze this file thoroughly. Summarize key content, extract important data points, highlight issues or concerns, and note any recommendations. |
| `summarize` | Provide a concise executive summary of this document. |
| `extract` | Extract all structured data, tables, key-value pairs, and named entities from this file. |
| `describe` | Describe the contents of this file in detail. |

### Init acknowledgment

Receiver replies with:

```json
{
  "status": "ready",
  "task_id": "603f8b96-f1b",
  "message": "Ready to receive 1 chunks for document.pdf"
}
```

## Phase 2: Chunks

Each chunk is sent as a NATS message containing a JSON header, a newline delimiter, and raw binary data:

```
{"task_id": "...", "seq": 1, "total": 1, "size": 154674}
<newline>
<raw file bytes>
```

| Header field | Meaning |
|---|---|
| `seq` | 1-indexed chunk sequence number |
| `total` | Total expected chunks |
| `size` | Bytes in this specific chunk (may be smaller than `chunk_size` for the last chunk) |

For files smaller than `chunk_size` (default 900KB), the entire file is sent as a single chunk. For larger files:

```
File size         chunk_size=900KB    # chunks
────────────      ────────────────    ──────
150KB             900KB               1
2MB               900KB               3  (900KB + 900KB + 248KB)
10MB              900KB               12
100MB             900KB               114
```

Each chunk is acknowledged:

```json
{
  "status": "received",
  "seq": 1,
  "task_id": "603f8b96-f1b",
  "received": 1,
  "total": 1
}
```

## Phase 3: Done

Sender signals completion. Receiver verifies, reassembles, writes to disk, and dispatches to the target agent.

```json
{
  "task_id": "603f8b96-f1b",
  "filename": "document.pdf",
  "sha256": "ed0c40c05de49fd548e933d5f8f1732b11a54bb7649a07a102e5aba6f5c143b5",
  "size": 154674,
  "chunks": 1
}
```

The receiver:
1. Checks all chunks arrived (1..N)
2. Optionally verifies sha256 if provided
3. Reassembles the file in chunk-order
4. Writes to `~/.grip/workspace/uploads/{filename}`
5. Sends a request to `target_inbox` with the prompt

### Dispatched prompt

The receiver constructs this prompt for the target agent:

```
Read and analyze the file at {filepath}. The file is a {mime_type}
named '{filename}' ({size} bytes). {user_prompt}
```

### Done acknowledgment

```json
{
  "status": "complete",
  "task_id": "603f8b96-f1b",
  "filename": "document.pdf",
  "filepath": "/Users/olu/.grip/workspace/uploads/document.pdf",
  "size": 154674,
  "chunks": 1
}
```

### Error acknowledgment

```json
{
  "status": "error",
  "message": "Missing 2 chunks: [2, 3]"
}
```

```json
{
  "status": "error",
  "message": "Hash mismatch: expected ed0c40..., got abcd12..."
}
```

## CLI: synapse-send-file

The `synapse-send-file.py` CLI handles all three phases end-to-end:

```bash
# Analyze a PDF (default action)
synapse-send-file document.pdf

# Summarize a spreadsheet via cloud
synapse-send-file report.xlsx \
  --action summarize \
  --via cloud

# Custom prompt targeting a specific agent
synapse-send-file image.png \
  --prompt "Extract all text using OCR" \
  --target grip-cli-001

# Via Synadia Cloud, custom chunk size
synapse-send-file large-dataset.csv \
  --via cloud \
  --chunk-size 500000 \
  --prompt "Build a dashboard from this data"
```

### CLI Arguments

| Flag | Default | Description |
|---|---|---|
| `filepath` | (required) | Path to file to send |
| `--action` | `analyze` | Action: `analyze`, `summarize`, `extract`, `describe` |
| `--prompt` | (from action) | Custom prompt overriding default |
| `--target` | `grip-001` | Target agent ID (constructs `mesh.agent.{target}.inbox`) |
| `--target-inbox` | — | Full NATS subject (overrides `--target`) |
| `--via` | `auto` | `local`, `cloud`, or `auto` |
| `--chunk-size` | `900000` | Bytes per chunk (~900KB) |
| `--timeout` | `120` | Seconds per chunk before timeout |
| `--quiet` | off | Suppress progress output |

### CLI output

```
╔══════════════════════════════════════════════════════════╗
║  Synapse File Transfer                                   ║
╠══════════════════════════════════════════════════════════╣
║  File:       report.pdf                                  ║
║  Size:       2,048,576 bytes (2.0 MB)                    ║
║  MIME:       application/pdf                             ║
║  SHA-256:    a1b2c3d4...                                 ║
║  Task ID:    9de0ec34-5b9                                ║
║  Target:     mesh.agent.grip-001.inbox                   ║
║  Via:        nats://localhost:4222                       ║
║  Chunks:     3 × ~900KB                                  ║
║  Action:     analyze                                     ║
╚══════════════════════════════════════════════════════════╝

[1/3] Sending init... ✓ (Ready to receive 3 chunks)
[2/3] Sending 3 chunks...
  [████████████████████] 100.0%  chunk 3/3  (248,576 bytes)  ✓
[3/3] Finalizing transfer... ✓

╔══════════════════════════════════════════════════════════╗
║  Transfer Complete                                        ║
║  File saved as:  report.pdf                              ║
║  Reassembled:  2,048,576 bytes                          ║
║  Chunks:                3                                ║
╚══════════════════════════════════════════════════════════╝
```

## File Receiver Service

`file-receiver.py` is a long-running Synapse service agent that:

1. Subscribes to `mesh.files.*.init`, `mesh.files.*.chunks`, `mesh.files.*.done` on both local NATS and Synadia Cloud (but only processes one subscription to avoid dedup)
2. Buffers chunks per `task_id` in memory
3. Reassembles, verifies (sha256), and writes to `~/.grip/workspace/uploads/`
4. Dispatches to the target agent's inbox via standard Synapse request
5. Cleans up stale transfers (default timeout: 5 minutes)
6. Forwards the agent's response to `reply_to` if specified

### Deploying as a LaunchAgent

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ng.synapse.file-receiver</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/Users/olu/.grip/workspace/file-receiver.py</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
</dict>
</plist>
```

### Configuration

Edit `CONFIG` at the top of `file-receiver.py`:

```python
CONFIG = {
    'local_nats': 'nats://localhost:4222',
    'cloud_nats': 'tls://connect.ngs.global:4222',
    'creds_file': '~/.nats/synadia.creds',
    'upload_dir': '~/.grip/workspace/uploads',
    'chunk_size': 900_000,       # ~900KB per chunk
    'grip_inbox': 'mesh.agent.grip-001.inbox',  # default target
    'transfer_timeout': 300,     # 5 minutes
}
```

## Task Classification

Files sent via the receiver are dispatched as standard Synapse requests. The bridge's task classifier detects file-related keywords and routes them appropriately:

```python
complex_keywords = [
    ...
    'read and analyze', 'analyze the file', 'summarize', 'extract',
    'this file', 'this document', 'this pdf', 'this spreadsheet',
    '.pdf', '.docx', '.xlsx', '.csv', '.doc',
]
```

File analysis requests are classified as **`complex-task`** with a 300-second threshold, so speed scoring is fair for document-heavy work.

## NATS Chunk Sizes

The max per-chunk size is constrained by:

| Environment | Max message size | Recommended chunk_size |
|---|---|---|
| Local NATS (default) | Unlimited | 900KB–10MB |
| Synadia Cloud free | 1 MB | 900 KB |
| Synadia Cloud Starter | 2 MB | 1.8 MB |
| Synadia Cloud Pro | 8 MB | 7 MB |

The 900KB default leaves headroom for JSON envelope overhead on Synadia's free tier.

## Examples

### Send PDF via cloud to grip-cli

```bash
synapse-send-file contract.pdf \
  --target grip-cli-001 \
  --via cloud \
  --prompt "Extract dates, obligations, and penalties in a table"
```

### Send image for OCR via local

```bash
synapse-send-file scan.png \
  --via local \
  --action extract \
  --prompt "Read all text from this scanned document and structure it"
```

### Multi-step: send CSV, analyze, output to S3

```bash
# Send and analyze
synapse-send-file sales.csv \
  --prompt "Generate a sales trend chart with moving averages, then upload the PNG to ~/.grip/workspace/uploads/sales_trend.png"

# Result is written by grip to its workspace
ls ~/.grip/workspace/uploads/sales_trend.png
```

## Limits and Considerations

- **Memory**: File is buffered in receiver memory during transfer. For very large files (>100MB), consider streaming the chunks to a temp file instead.
- **Deduplication**: Receiver only subscribes on local NATS to avoid duplicate dispatch via the leaf node.
- **Stale transfers**: Transfers that don't complete within `transfer_timeout` are automatically cleaned up and logged.
- **Filename sanitization**: Path components are stripped; only the basename is used. No path traversal.
- **SHA-256 verification**: Optional. If provided, a hash mismatch causes an error response and the file is not written.

## Related

- [tasks.md](./tasks.md) — JetStream-backed task persistence (can log file transfers as tasks)
- [patterns.md](./patterns.md) — Routing, fan-out, long-running requests
- [reputation.md](./reputation.md) — File analysis tasks are scored under the `complex-task` threshold
- [subjects.md](./subjects.md) — Full subject namespace with wildcards and permissions
- [envelope.md](./envelope.md) — Standard Synapse envelope format (used for dispatch and result)
