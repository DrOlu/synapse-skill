# Schema Validation Reference

JSON Schema definitions for all Synapse message types. Use these to validate envelopes on send and receive, catching malformed messages before they propagate through the mesh.

## Why Validate?

Without validation, a typo like `"typ": "request"` (instead of `"type"`) silently creates an unhandleable message. Validation catches:

- Missing required fields (`id`, `type`, `from`, `ts`)
- Invalid `type` values (must be one of the 5 primitives)
- Wrong field types (string where number expected)
- Malformed `trace` objects
- Unknown error codes
- Invalid task state transitions

---

## Envelope Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://synapse.ai/schemas/envelope/v1.0.0",
  "title": "SynapseEnvelope",
  "description": "Synapse protocol message envelope v1.0.0",
  "type": "object",
  "required": ["v", "id", "type", "ts", "from"],
  "properties": {
    "v": {
      "type": "string",
      "const": "1.0.0",
      "description": "Protocol version"
    },
    "id": {
      "type": "string",
      "format": "uuid",
      "description": "Unique message ID (UUID v4 or v7)"
    },
    "type": {
      "type": "string",
      "enum": ["register", "deregister", "discover", "request", "respond", "emit"],
      "description": "Message primitive type"
    },
    "ts": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp"
    },
    "from": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Sender agent ID"
    },
    "to": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Recipient agent ID (required for request/respond)"
    },
    "task_id": {
      "type": "string",
      "format": "uuid",
      "description": "Task this message belongs to"
    },
    "in_reply_to": {
      "type": "string",
      "format": "uuid",
      "description": "ID of message being replied to"
    },
    "context_id": {
      "type": "string",
      "format": "uuid",
      "description": "Groups related tasks into a session"
    },
    "trace": {
      "$ref": "#/$defs/TraceContext",
      "description": "Distributed trace context"
    },
    "payload": {
      "type": "object",
      "description": "Message content (varies by type)",
      "additionalProperties": true
    },
    "artifacts": {
      "type": "array",
      "items": { "$ref": "#/$defs/Artifact" },
      "description": "File attachments or deliverables"
    },
    "error": {
      "$ref": "#/$defs/ErrorInfo",
      "description": "Error information (present only on error responses)"
    },
    "meta": {
      "type": "object",
      "additionalProperties": true,
      "description": "Arbitrary metadata"
    }
  },
  "additionalProperties": false,

  "$defs": {
    "TraceContext": {
      "type": "object",
      "required": ["trace_id", "span_id"],
      "properties": {
        "trace_id": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$",
          "description": "128-bit trace ID (32 hex chars)"
        },
        "span_id": {
          "type": "string",
          "pattern": "^[0-9a-f]{16}$",
          "description": "64-bit span ID (16 hex chars)"
        },
        "parent_span_id": {
          "type": "string",
          "pattern": "^[0-9a-f]{16}$",
          "description": "Parent's span ID for linking hops"
        }
      },
      "additionalProperties": false
    },

    "ErrorInfo": {
      "type": "object",
      "required": ["code", "message", "retryable"],
      "properties": {
        "code": {
          "type": "integer",
          "enum": [1001, 1002, 2001, 2002, 3001, 3002, 3003, 3004, 4001, 4002, 5001],
          "description": "Standard Synapse error code"
        },
        "message": {
          "type": "string",
          "minLength": 1,
          "description": "Human-readable error message"
        },
        "retryable": {
          "type": "boolean",
          "description": "Whether the caller should retry"
        }
      },
      "additionalProperties": false
    },

    "Artifact": {
      "type": "object",
      "required": ["name", "url"],
      "properties": {
        "name": {
          "type": "string",
          "description": "Filename or identifier"
        },
        "url": {
          "type": "string",
          "format": "uri",
          "description": "Where to download the artifact"
        },
        "mime_type": {
          "type": "string",
          "description": "MIME type (e.g., application/pdf)"
        },
        "size_bytes": {
          "type": "integer",
          "minimum": 0,
          "description": "File size in bytes"
        },
        "checksum_sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$",
          "description": "SHA-256 checksum for verification"
        }
      },
      "additionalProperties": false
    }
  },

  "if": { "properties": { "type": { "const": "request" } } },
  "then": { "required": ["to", "task_id", "trace", "payload"] },

  "if": { "properties": { "type": { "const": "respond" } } },
  "then": { "required": ["to", "task_id"] }
}
```

---

## Agent Manifest Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://synapse.ai/schemas/manifest/v1.0.0",
  "title": "SynapseAgentManifest",
  "description": "Agent registration manifest",
  "type": "object",
  "required": ["id", "name", "capabilities", "skills", "endpoint", "availability"],
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "pattern": "^[a-zA-Z0-9_-]+$",
      "description": "Unique agent identifier (alphanumeric, hyphens, underscores)"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256,
      "description": "Human-readable agent name"
    },
    "description": {
      "type": "string",
      "maxLength": 1024,
      "description": "What this agent does"
    },
    "capabilities": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "pattern": "^[a-z][a-z0-9._-]*$"
      },
      "maxItems": 32,
      "description": "Capability tags (lowercase, dot-separated)"
    },
    "skills": {
      "type": "array",
      "items": { "$ref": "#/$defs/Skill" },
      "maxItems": 64,
      "description": "Skills this agent can perform"
    },
    "endpoint": {
      "type": "string",
      "pattern": "^mesh\\.agent\\.[a-zA-Z0-9_-]+\\.inbox$",
      "description": "NATS subject for direct requests"
    },
    "availability": {
      "type": "string",
      "enum": ["online", "busy", "offline"],
      "description": "Current availability status"
    },
    "last_heartbeat": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp of last heartbeat"
    }
  },
  "additionalProperties": false,

  "$defs": {
    "Skill": {
      "type": "object",
      "required": ["id", "name", "description"],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[a-z][a-z0-9._-]*$",
          "description": "Unique skill identifier"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128,
          "description": "Human-readable skill name"
        },
        "description": {
          "type": "string",
          "minLength": 1,
          "maxLength": 512,
          "description": "What this skill does"
        },
        "input_modes": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Accepted input MIME types"
        },
        "output_modes": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Produced output MIME types"
        }
      },
      "additionalProperties": false
    }
  }
}
```

---

## Discover Filter Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://synapse.ai/schemas/discover-filter/v1.0.0",
  "title": "SynapseDiscoverFilter",
  "description": "Filter for discover requests",
  "type": "object",
  "properties": {
    "capabilities": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Required capabilities (all must match)"
    },
    "skill_ids": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Required skill IDs (all must match)"
    },
    "availability": {
      "type": "string",
      "enum": ["online", "busy", "offline"],
      "description": "Filter by availability status"
    }
  },
  "additionalProperties": false
}
```

---

## Task State Transition Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://synapse.ai/schemas/task-update/v1.0.0",
  "title": "SynapseTaskUpdate",
  "description": "Task state transition event",
  "type": "object",
  "required": ["task_id", "state", "timestamp"],
  "properties": {
    "task_id": {
      "type": "string",
      "format": "uuid"
    },
    "state": {
      "type": "string",
      "enum": ["submitted", "working", "input_required", "auth_required", "completed", "failed", "canceled"],
      "description": "New task state"
    },
    "previous_state": {
      "type": "string",
      "enum": ["submitted", "working", "input_required", "auth_required"],
      "description": "Previous state (omitted for terminal states)"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "detail": {
      "type": "string",
      "description": "Human-readable detail about the transition"
    },
    "error": {
      "$ref": "https://synapse.ai/schemas/envelope/v1.0.0#/$defs/ErrorInfo"
    }
  },
  "additionalProperties": true
}
```

---

## Using Schemas in TypeScript

### Install Ajv

```bash
npm install ajv
```

### Validator Module

```typescript
// src/validate.ts
import Ajv, { ValidateFunction } from "ajv";

// ─── Load Schemas ────────────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: true });

// Inline the envelope schema (or load from file)
const envelopeSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://synapse.ai/schemas/envelope/v1.0.0",
  title: "SynapseEnvelope",
  type: "object",
  required: ["v", "id", "type", "ts", "from"],
  properties: {
    v: { type: "string", const: "1.0.0" },
    id: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["register", "deregister", "discover", "request", "respond", "emit"] },
    ts: { type: "string" },
    from: { type: "string", minLength: 1, maxLength: 128 },
    to: { type: "string" },
    task_id: { type: "string" },
    in_reply_to: { type: "string" },
    context_id: { type: "string" },
    trace: {
      type: "object",
      required: ["trace_id", "span_id"],
      properties: {
        trace_id: { type: "string", pattern: "^[0-9a-f]{32}$" },
        span_id: { type: "string", pattern: "^[0-9a-f]{16}$" },
        parent_span_id: { type: "string", pattern: "^[0-9a-f]{16}$" },
      },
      additionalProperties: false,
    },
    payload: { type: "object" },
    artifacts: { type: "array" },
    error: {
      type: "object",
      required: ["code", "message", "retryable"],
      properties: {
        code: { type: "integer" },
        message: { type: "string" },
        retryable: { type: "boolean" },
      },
      additionalProperties: false,
    },
    meta: { type: "object" },
  },
  additionalProperties: false,
};

const manifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://synapse.ai/schemas/manifest/v1.0.0",
  title: "SynapseAgentManifest",
  type: "object",
  required: ["id", "name", "capabilities", "skills", "endpoint", "availability"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" },
    name: { type: "string", minLength: 1, maxLength: 256 },
    description: { type: "string", maxLength: 1024 },
    capabilities: { type: "array", items: { type: "string" }, maxItems: 32 },
    skills: { type: "array", items: { type: "object" } },
    endpoint: { type: "string", pattern: "^mesh\\.agent\\.[a-zA-Z0-9_-]+\\.inbox$" },
    availability: { type: "string", enum: ["online", "busy", "offline"] },
    last_heartbeat: { type: "string" },
  },
  additionalProperties: false,
};

const validateEnvelope: ValidateFunction = ajv.compile(envelopeSchema);
const validateManifest: ValidateFunction = ajv.compile(manifestSchema);

// ─── Export Validators ────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
}

export function validateEnvelope(data: unknown): ValidationError[] {
  if (validateEnvelope(data)) return [];
  return (validateEnvelope.errors || []).map((e) => ({
    field: e.instancePath || "/",
    message: e.message || "Validation error",
    value: e.params,
  }));
}

export function validateManifest(data: unknown): ValidationError[] {
  if (validateManifest(data)) return [];
  return (validateManifest.errors || []).map((e) => ({
    field: e.instancePath || "/",
    message: e.message || "Validation error",
    value: e.params,
  }));
}

export function isValidEnvelope(data: unknown): data is Record<string, unknown> {
  return validateEnvelope(data);
}

export function isValidManifest(data: unknown): data is Record<string, unknown> {
  return validateManifest(data);
}

/** Assert and throw on invalid envelopes */
export function assertEnvelope(data: unknown): asserts data is Record<string, unknown> {
  const errors = validateEnvelope(data);
  if (errors.length > 0) {
    const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    throw new Error(`Invalid envelope: ${messages}`);
  }
}
```

### Integration with Synapse SDK

```typescript
import { assertEnvelope, validateEnvelope } from "./validate.js";

// In your Synapse class, add validation at send boundaries:
class ValidatedSynapse extends Synapse {
  async request(agentId: string, skill: string, input: any, timeoutMs?: number) {
    // Validate the outgoing envelope before sending
    const envelope = {
      v: "1.0.0",
      id: uuid(),
      type: "request",
      ts: new Date().toISOString(),
      from: this.agentId,
      to: agentId,
      task_id: uuid(),
      trace: { trace_id: uuid(), span_id: uuid() },
      payload: { skill, input },
    };
    assertEnvelope(envelope); // throws on invalid
    return super.request(agentId, skill, input, timeoutMs);
  }
}
```

---

## Using Schemas in Python

### Install jsonschema

```bash
pip install jsonschema
```

### Validator Module

```python
# validate.py
"""Synapse envelope and manifest validation using JSON Schema."""

import json
from pathlib import Path
from typing import Any, List, Optional

import jsonschema

# ─── Schema Definitions ──────────────────────────────────────

ENVELOPE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://synapse.ai/schemas/envelope/v1.0.0",
    "title": "SynapseEnvelope",
    "type": "object",
    "required": ["v", "id", "type", "ts", "from"],
    "properties": {
        "v": {"type": "string", "const": "1.0.0"},
        "id": {"type": "string", "minLength": 1},
        "type": {"type": "string", "enum": ["register", "deregister", "discover", "request", "respond", "emit"]},
        "ts": {"type": "string"},
        "from": {"type": "string", "minLength": 1, "maxLength": 128},
        "to": {"type": "string"},
        "task_id": {"type": "string"},
        "in_reply_to": {"type": "string"},
        "context_id": {"type": "string"},
        "trace": {
            "type": "object",
            "required": ["trace_id", "span_id"],
            "properties": {
                "trace_id": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
                "span_id": {"type": "string", "pattern": "^[0-9a-f]{16}$"},
                "parent_span_id": {"type": "string", "pattern": "^[0-9a-f]{16}$"},
            },
            "additionalProperties": False,
        },
        "payload": {"type": "object"},
        "artifacts": {"type": "array"},
        "error": {
            "type": "object",
            "required": ["code", "message", "retryable"],
            "properties": {
                "code": {"type": "integer"},
                "message": {"type": "string"},
                "retryable": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
        "meta": {"type": "object"},
    },
    "additionalProperties": False,
}

MANIFEST_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://synapse.ai/schemas/manifest/v1.0.0",
    "title": "SynapseAgentManifest",
    "type": "object",
    "required": ["id", "name", "capabilities", "skills", "endpoint", "availability"],
    "properties": {
        "id": {"type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_-]+$"},
        "name": {"type": "string", "minLength": 1, "maxLength": 256},
        "description": {"type": "string", "maxLength": 1024},
        "capabilities": {"type": "array", "items": {"type": "string"}, "maxItems": 32},
        "skills": {"type": "array", "items": {"type": "object"}},
        "endpoint": {"type": "string", "pattern": r"^mesh\.agent\.[a-zA-Z0-9_-]+\.inbox$"},
        "availability": {"type": "string", "enum": ["online", "busy", "offline"]},
        "last_heartbeat": {"type": "string"},
    },
    "additionalProperties": False,
}


# ─── Validation Functions ─────────────────────────────────────

class SynapseValidationError(Exception):
    """Raised when envelope or manifest validation fails."""
    def __init__(self, errors: List[dict]):
        self.errors = errors
        messages = "; ".join(
            f"{e.get('path', '/')}: {e.get('message', 'validation error')}"
            for e in errors
        )
        super().__init__(f"Validation failed: {messages}")


def validate_envelope(data: Any) -> List[dict]:
    """Validate a Synapse envelope. Returns list of errors (empty if valid)."""
    validator = jsonschema.Draft202012Validator(ENVELOPE_SCHEMA)
    errors = []
    for error in sorted(validator.iter_errors(data), key=lambda e: list(e.path)):
        errors.append({
            "path": "/" + "/".join(str(p) for p in error.path),
            "message": error.message,
            "value": error.instance if len(error.path) > 0 else None,
        })
    return errors


def validate_manifest(data: Any) -> List[dict]:
    """Validate an agent manifest. Returns list of errors (empty if valid)."""
    validator = jsonschema.Draft202012Validator(MANIFEST_SCHEMA)
    errors = []
    for error in sorted(validator.iter_errors(data), key=lambda e: list(e.path)):
        errors.append({
            "path": "/" + "/".join(str(p) for p in error.path),
            "message": error.message,
            "value": error.instance if len(error.path) > 0 else None,
        })
    return errors


def is_valid_envelope(data: Any) -> bool:
    """Check if data is a valid Synapse envelope."""
    return len(validate_envelope(data)) == 0


def is_valid_manifest(data: Any) -> bool:
    """Check if data is a valid agent manifest."""
    return len(validate_manifest(data)) == 0


def assert_envelope(data: Any) -> None:
    """Assert data is a valid envelope, raise SynapseValidationError if not."""
    errors = validate_envelope(data)
    if errors:
        raise SynapseValidationError(errors)


def assert_manifest(data: Any) -> None:
    """Assert data is a valid manifest, raise SynapseValidationError if not."""
    errors = validate_manifest(data)
    if errors:
        raise SynapseValidationError(errors)
```

### Integration with Python SDK

```python
from synapse import Synapse, Envelope
from validate import assert_envelope, assert_manifest

# Wrap Synapse to validate on every message
class ValidatedSynapse(Synapse):
    async def request(self, agent_id, skill, input_data=None, timeout=30.0):
        # Validate outgoing envelope
        envelope = Envelope(
            type="request",
            from_agent=self.id,
            to_agent=agent_id,
            task_id=str(uuid.uuid4()),
            trace={"trace_id": str(uuid.uuid4()), "span_id": str(uuid.uuid4())},
            payload={"skill": skill, "input": input_data or {}},
        )
        assert_envelope(envelope.to_dict())  # raises SynapseValidationError if invalid
        return await super().request(agent_id, skill, input_data, timeout)

    async def register(self, name, description="", capabilities=None, skills=None, heartbeat_interval=30):
        manifest = await super().register(name, description, capabilities, skills, heartbeat_interval)
        assert_manifest(manifest.to_dict())  # raises SynapseValidationError if invalid
        return manifest
```

---

## Using Schemas in Go

### Generate Types from Schema

```bash
# Install go-jsonschema
go install github.com/atomben/go-jsonschema/cmd/go-jsonschema@latest

# Generate Go types from the envelope schema
go-jsonschema -pkg synapse -o envelope_gen.go envelope.schema.json
```

### Runtime Validation

```go
// validate.go
package synapse

import (
	"encoding/json"
	"fmt"

	"github.com/xeipuuv/gojsonschema"
)

var envelopeLoader gojsonschema.JSONLoader
var manifestLoader gojsonschema.JSONLoader

func init() {
	envelopeLoader = gojsonschema.NewStringLoader(envelopeSchemaJSON)
	manifestLoader = gojsonschema.NewStringLoader(manifestSchemaJSON)
}

// ValidateEnvelope validates a Synapse envelope against the JSON schema.
func ValidateEnvelope(data []byte) error {
	docLoader := gojsonschema.NewBytesLoader(data)
	result, err := gojsonschema.Validate(envelopeLoader, docLoader)
	if err != nil {
		return fmt.Errorf("schema validation error: %w", err)
	}
	if result.Valid() {
		return nil
	}
	var errs []string
	for _, desc := range result.Errors() {
		errs = append(errs, desc.String())
	}
	return fmt.Errorf("invalid envelope: %s", errs)
}

// ValidateManifest validates an agent manifest against the JSON schema.
func ValidateManifest(data []byte) error {
	docLoader := gojsonschema.NewBytesLoader(data)
	result, err := gojsonschema.Validate(manifestLoader, docLoader)
	if err != nil {
		return fmt.Errorf("schema validation error: %w", err)
	}
	if result.Valid() {
		return nil
	}
	var errs []string
	for _, desc := range result.Errors() {
		errs = append(errs, desc.String())
	}
	return fmt.Errorf("invalid manifest: %s", errs)
}

// AssertEnvelope panics on invalid envelopes (use in tests).
func AssertEnvelope(data []byte) {
	if err := ValidateEnvelope(data); err != nil {
		panic(err)
	}
}

// ─── Inline Schemas ──────────────────────────────────────────

const envelopeSchemaJSON = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SynapseEnvelope",
  "type": "object",
  "required": ["v", "id", "type", "ts", "from"],
  "properties": {
    "v": {"type": "string", "const": "1.0.0"},
    "id": {"type": "string", "minLength": 1},
    "type": {"type": "string", "enum": ["register", "deregister", "discover", "request", "respond", "emit"]},
    "ts": {"type": "string"},
    "from": {"type": "string", "minLength": 1, "maxLength": 128},
    "to": {"type": "string"},
    "task_id": {"type": "string"},
    "trace": {
      "type": "object",
      "required": ["trace_id", "span_id"],
      "properties": {
        "trace_id": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
        "span_id": {"type": "string", "pattern": "^[0-9a-f]{16}$"},
        "parent_span_id": {"type": "string", "pattern": "^[0-9a-f]{16}$"}
      },
      "additionalProperties": false
    },
    "payload": {"type": "object"},
    "error": {
      "type": "object",
      "required": ["code", "message", "retryable"],
      "properties": {
        "code": {"type": "integer"},
        "message": {"type": "string"},
        "retryable": {"type": "boolean"}
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}`

const manifestSchemaJSON = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SynapseAgentManifest",
  "type": "object",
  "required": ["id", "name", "capabilities", "skills", "endpoint", "availability"],
  "properties": {
    "id": {"type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_-]+$"},
    "name": {"type": "string", "minLength": 1, "maxLength": 256},
    "description": {"type": "string", "maxLength": 1024},
    "capabilities": {"type": "array", "items": {"type": "string"}, "maxItems": 32},
    "skills": {"type": "array", "items": {"type": "object"}},
    "endpoint": {"type": "string", "pattern": "^mesh\\\\.agent\\\\.[a-zA-Z0-9_-]+\\\\.inbox$"},
    "availability": {"type": "string", "enum": ["online", "busy", "offline"]},
    "last_heartbeat": {"type": "string"}
  },
  "additionalProperties": false
}`
```

---

## CLI Validation

A standalone validation script for CI/CD or debugging:

```bash
#!/bin/bash
# validate-envelope.sh — Validate a Synapse envelope JSON file against schema
# Usage: ./validate-envelope.sh envelope.json

set -e

ENVELOPE_SCHEMA_URL="https://synapse.ai/schemas/envelope/v1.0.0"

if [ -z "$1" ]; then
  echo "Usage: $0 <envelope.json>"
  exit 1
fi

FILE="$1"

if [ ! -f "$FILE" ]; then
  echo "Error: File not found: $FILE"
  exit 1
fi

# Install check-jsonschema if not present
if ! command -v check-jsonschema &>/dev/null; then
  pip install check-jsonschema
fi

check-jsonschema --schemafile "$ENVELOPE_SCHEMA_URL" "$FILE"
echo "✓ Valid envelope"
```

---

## Validation in CI/CD

Add to your test suite:

```yaml
# .github/workflows/validate.yml
name: Validate Schemas

on: [push, pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install tools
        run: pip install check-jsonschema

      - name: Validate test envelopes
        run: |
          for f in tests/fixtures/envelopes/*.json; do
            echo "Validating $f"
            check-jsonschema --schemafile schemas/envelope.schema.json "$f"
          done

      - name: Validate manifests
        run: |
          for f in tests/fixtures/manifests/*.json; do
            echo "Validating $f"
            check-jsonschema --schemafile schemas/manifest.schema.json "$f"
          done
```

---

## Test Fixtures

Create sample valid and invalid envelopes for testing:

```json
// tests/fixtures/envelopes/valid-request.json
{
  "v": "1.0.0",
  "id": "01912e42-7c3b-7d2e-8f4a-5b6c7d8e9f0a",
  "type": "request",
  "ts": "2026-01-15T12:34:56.789Z",
  "from": "agent-bob-001",
  "to": "agent-alice-001",
  "task_id": "01912e42-7c3b-7d2e-8f4a-5b6c7d8e9f0b",
  "trace": {
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "span_id": "00f067aa0ba902b7"
  },
  "payload": {
    "skill": "chat",
    "input": { "text": "Hello" }
  }
}
```

```json
// tests/fixtures/envelopes/invalid-missing-type.json
{
  "v": "1.0.0",
  "id": "01912e42-7c3b-7d2e-8f4a-5b6c7d8e9f0a",
  "ts": "2026-01-15T12:34:56.789Z",
  "from": "agent-bob-001"
}
// Expected error: missing required property "type"
```

```json
// tests/fixtures/envelopes/invalid-bad-type.json
{
  "v": "1.0.0",
  "id": "01912e42-7c3b-7d2e-8f4a-5b6c7d8e9f0a",
  "type": "message",
  "ts": "2026-01-15T12:34:56.789Z",
  "from": "agent-bob-001"
}
// Expected error: "type" must be one of register, deregister, discover, request, respond, emit
```

---

## Error Code Quick Reference

| Code | Name | Retryable | Schema Constraint |
|------|------|-----------|-------------------|
| 1001 | TRANSPORT_TIMEOUT | yes | — |
| 1002 | TRANSPORT_NO_RESPONDERS | no | — |
| 2001 | INVALID_ENVELOPE | no | Fails envelope schema validation |
| 2002 | INVALID_MANIFEST | no | Fails manifest schema validation |
| 3001 | SKILL_NOT_FOUND | no | — |
| 3002 | AGENT_UNAVAILABLE | yes | — |
| 3003 | TASK_INVALID_TRANSITION | no | Fails state transition rules |
| 3004 | IDENTITY_MISMATCH | no | — |
| 4001 | OVERLOADED | yes | — |
| 4002 | RATE_LIMITED | yes | — |
| 5001 | INTERNAL_ERROR | yes | — |

When `validateEnvelope()` catches a bad message on receive, the handler should respond with error code 2001 (`INVALID_ENVELOPE`). When `validateManifest()` catches a bad registration, the registry should reject it with code 2002 (`INVALID_MANIFEST`).

---

## Next Steps

- [Envelope Reference](./envelope.md) — Full field specification
- [States](./states.md) — Task state machine and transitions
- [Security](./security.md) — Signed envelopes and authentication