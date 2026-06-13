# Observability: Tracing, Metrics & Dashboards

OpenTelemetry integration, custom metrics, and monitoring dashboards for Synapse agents.

## Architecture

```
Agent A ──request──> Agent B
   │                    │
   ├─ start span        ├─ continue span
   │  (trace_id,        │  (parent_span_id
   │   span_id)          │   from request)
   │                    │
   └─ export to OTLP    └─ export to OTLP
           │                    │
           ▼                    ▼
      ┌─────────────────────────┐
      │   OTel Collector         │
      │   (receives all traces)  │
      └────────┬────────────────┘
               │
       ┌───────┼───────┐
       ▼       ▼       ▼
   Jaeger  Prometheus  Grafana
   (traces) (metrics)  (dashboards)
```

---

## Span Propagation

Every Synapse envelope carries a `trace` field. The SDK populates it automatically, and handlers can read it to continue the trace.

### Envelope Trace Fields

```json
{
  "trace": {
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "span_id": "00f067aa0ba902b7",
    "parent_span_id": "parent-span-from-caller"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `trace_id` | string | Shared across all hops in a request chain |
| `span_id` | string | Unique per hop (each agent creates a new span) |
| `parent_span_id` | string? | The `span_id` from the calling agent's envelope |

### Propagation Rule

When Agent A sends a request to Agent B:

1. Agent A creates `trace_id` (new) and `span_id` (new)
2. Agent B receives the envelope, reads `trace.trace_id` and `trace.span_id`
3. Agent B creates a new `span_id`, sets `parent_span_id` to Agent A's `span_id`
4. Agent B includes this new trace in the response envelope

---

## OpenTelemetry Setup

### Install Dependencies

**TypeScript:**
```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions
```

**Python:**
```bash
pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp opentelemetry-instrumentation
```

**Go:**
```bash
go get go.opentelemetry.io/otel go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc
```

### OTel Collector Configuration

Save as `otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  batch:
    timeout: 5s
    send_batch_size: 1024

exporters:
  jaeger:
    endpoint: jaeger:14250
    tls:
      insecure: true
  prometheus:
    endpoint: 0.0.0.0:8889
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [jaeger, otlp/tempo]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
```

### Docker Compose for Observability Stack

```yaml
# docker-compose.observability.yml
version: "3.8"

services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    container_name: otel-collector
    ports:
      - "4317:4317"   # gRPC
      - "4318:4318"   # HTTP
      - "8889:8889"   # Prometheus metrics
    volumes:
      - ./otel-collector-config.yaml:/etc/otelcol-contrib/config.yaml

  jaeger:
    image: jaegertracing/all-in-one:latest
    container_name: jaeger
    ports:
      - "16686:16686"  # UI
      - "14250:14250"  # gRPC from collector
    environment:
      COLLECTOR_OTLP_ENABLED: true

  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    ports:
      - "3000:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: /var/lib/grafana/dashboards/synapse.json
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning
      - ./grafana/dashboards:/var/lib/grafana/dashboards
```

### Prometheus Configuration

Save as `prometheus.yml`:

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: "otel-collector"
    static_configs:
      - targets: ["otel-collector:8889"]

  - job_name: "nats"
    static_configs:
      - targets: ["nats-server:8222"]
    metrics_path: /metrics
```

---

## TypeScript Tracing Integration

### Tracing Helper Module

```typescript
// src/tracing.ts
import {
  trace, context, Span, SpanKind, StatusCode,
  propagation, TextMapSetter, TextMapGetter,
} from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

// ─── Tracer Setup ────────────────────────────────────────────

let sdk: NodeSDK | null = null;

export function initTracing(serviceName: string, serviceVersion: string = "1.0.0", otlpEndpoint: string = "http://localhost:4318") {
  const traceExporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });
  const metricExporter = new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` });

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 10000 }),
  });

  sdk.start();
  console.log(`Tracing initialized for ${serviceName} → ${otlpEndpoint}`);
  return sdk;
}

export async function shutdownTracing() {
  if (sdk) await sdk.shutdown();
}

// ─── Span Helpers ────────────────────────────────────────────

const tracer = trace.getTracer("synapse", "1.0.0");

export interface TraceContext {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
}

/** Start a new span for an outgoing request */
export function startRequestSpan(
  skill: string,
  targetAgent: string,
  parentTrace?: TraceContext
): { span: Span; trace: TraceContext } {
  const span = tracer.startSpan(`synapse.request/${skill}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "synapse.target_agent": targetAgent,
      "synapse.skill": skill,
    },
  });

  if (parentTrace) {
    span.setAttribute("synapse.parent_trace_id", parentTrace.trace_id);
  }

  const trace: TraceContext = {
    trace_id: parentTrace?.trace_id || span.spanContext().traceId,
    span_id: span.spanContext().spanId,
    parent_span_id: parentTrace?.span_id,
  };

  return { span, trace };
}

/** Start a span for an incoming request handler */
export function startHandlerSpan(
  skill: string,
  fromAgent: string,
  envelopeTrace?: TraceContext
): Span {
  const span = tracer.startSpan(`synapse.handle/${skill}`, {
    kind: SpanKind.SERVER,
    attributes: {
      "synapse.from_agent": fromAgent,
      "synapse.skill": skill,
    },
  });

  if (envelopeTrace) {
    span.setAttribute("synapse.trace_id", envelopeTrace.trace_id);
    span.setAttribute("synapse.parent_span_id", envelopeTrace.span_id);
  }

  return span;
}

/** End a span with optional error */
export function endSpan(span: Span, error?: Error) {
  if (error) {
    span.setStatus({ code: StatusCode.ERROR, message: error.message });
    span.recordException(error);
  } else {
    span.setStatus({ code: StatusCode.OK });
  }
  span.end();
}

// ─── Metrics ─────────────────────────────────────────────────

import { MeterProvider, Counter, Histogram } from "@opentelemetry/sdk-metrics";

const meter = trace.getMeter("synapse", "1.0.0");

let requestCounter: Counter;
let requestLatency: Histogram;
let errorCounter: Counter;
let activeAgents: Counter;

export function initMetrics() {
  requestCounter = meter.createCounter("synapse_requests_total", {
    description: "Total number of Synapse requests",
    unit: "1",
  });

  requestLatency = meter.createHistogram("synapse_request_duration_ms", {
    description: "Request latency in milliseconds",
    unit: "ms",
  });

  errorCounter = meter.createCounter("synapse_errors_total", {
    description: "Total number of Synapse errors",
    unit: "1",
  });

  activeAgents = meter.createCounter("synapse_active_agents", {
    description: "Number of registered agents",
    unit: "1",
  });
}

export function recordRequest(skill: string, fromAgent: string, toAgent: string) {
  requestCounter.add(1, { skill, from_agent: fromAgent, to_agent: toAgent });
}

export function recordLatency(skill: string, durationMs: number) {
  requestLatency.record(durationMs, { skill });
}

export function recordError(skill: string, errorCode: number, fromAgent: string, toAgent: string) {
  errorCounter.add(1, { skill, error_code: errorCode.toString(), from_agent: fromAgent, to_agent: toAgent });
}

export function recordAgentRegistration(agentName: string, capabilities: string[]) {
  activeAgents.add(1, { agent_name: agentName, capabilities: capabilities.join(",") });
}
```

### Integration with Synapse SDK

```typescript
// src/synapse-traced.ts — Wrapper that adds tracing to every primitive
import Synapse from "./synapse.js";
import {
  initTracing, shutdownTracing, initMetrics,
  startRequestSpan, startHandlerSpan, endSpan,
  recordRequest, recordLatency, recordError, recordAgentRegistration,
} from "./tracing.js";

export class TracedSynapse extends Synapse {
  // Override request to add spans and metrics
  async request(agentId: string, skill: string, input: any, timeoutMs?: number) {
    const { span, trace } = startRequestSpan(skill, agentId);
    const startTime = Date.now();

    try {
      // The envelope will carry the trace context
      const result = await super.request(agentId, skill, input, timeoutMs);
      recordRequest(skill, this.agentId, agentId);
      recordLatency(skill, Date.now() - startTime);
      endSpan(span);
      return result;
    } catch (err: any) {
      recordError(skill, err.code || 0, this.agentId, agentId);
      endSpan(span, err);
      throw err;
    }
  }

  // Override register to track metrics
  async register(options: any) {
    const manifest = await super.register(options);
    recordAgentRegistration(options.name, options.capabilities || []);
    return manifest;
  }
}

// Usage
async function main() {
  initTracing("my-agent", "1.0.0");
  initMetrics();

  const mesh = new TracedSynapse();
  await (mesh as any).connect("nats://localhost:4222");
  await mesh.register({ name: "Traced Agent", capabilities: ["chat"], skills: [] });

  process.on("SIGINT", async () => {
    await mesh.close();
    await shutdownTracing();
    process.exit(0);
  });
}
```

---

## Python Tracing Integration

### Tracing Helper Module

```python
# tracing.py
import time
from dataclasses import dataclass, field
from typing import Optional

from opentelemetry import trace, metrics
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.resources import Resource


@dataclass
class TraceContext:
    trace_id: str
    span_id: str
    parent_span_id: Optional[str] = None


def init_tracing(service_name: str, otlp_endpoint: str = "http://localhost:4317"):
    """Initialize OpenTelemetry tracing and metrics."""
    resource = Resource.create({
        "service.name": service_name,
        "service.version": "1.0.0",
    })

    # Traces
    trace_exporter = OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True)
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(trace_exporter))
    trace.set_tracer_provider(tracer_provider)

    # Metrics
    metric_exporter = OTLPMetricExporter(endpoint=otlp_endpoint, insecure=True)
    metric_reader = PeriodicExportingMetricReader(metric_exporter, export_interval_millis=10000)
    meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(meter_provider)

    print(f"Tracing initialized for {service_name} → {otlp_endpoint}")


_tracer = trace.get_tracer("synapse", "1.0.0")
_meter = metrics.get_meter("synapse", "1.0.0")

# Metric instruments
_request_counter = _meter.create_counter("synapse_requests_total", description="Total Synapse requests")
_request_latency = _meter.create_histogram("synapse_request_duration_ms", description="Request latency (ms)", unit="ms")
_error_counter = _meter.create_counter("synapse_errors_total", description="Total Synapse errors")


def start_request_span(skill: str, target_agent: str, parent_trace: Optional[TraceContext] = None) -> tuple:
    """Start a CLIENT span for an outgoing request."""
    span = _tracer.start_span(
        f"synapse.request/{skill}",
        kind=trace.SpanKind.CLIENT,
        attributes={
            "synapse.target_agent": target_agent,
            "synapse.skill": skill,
        },
    )
    if parent_trace:
        span.set_attribute("synapse.parent_trace_id", parent_trace.trace_id)

    trace_ctx = TraceContext(
        trace_id=parent_trace.trace_id if parent_trace else format(span.context.trace_id, "032x"),
        span_id=format(span.context.span_id, "016x"),
        parent_span_id=parent_trace.span_id if parent_trace else None,
    )
    return span, trace_ctx


def start_handler_span(skill: str, from_agent: str, envelope_trace: Optional[TraceContext] = None):
    """Start a SERVER span for an incoming request handler."""
    span = _tracer.start_span(
        f"synapse.handle/{skill}",
        kind=trace.SpanKind.SERVER,
        attributes={
            "synapse.from_agent": from_agent,
            "synapse.skill": skill,
        },
    )
    if envelope_trace:
        span.set_attribute("synapse.trace_id", envelope_trace.trace_id)
        span.set_attribute("synapse.parent_span_id", envelope_trace.span_id)
    return span


def record_request(skill: str, from_agent: str, to_agent: str):
    _request_counter.add(1, {"skill": skill, "from_agent": from_agent, "to_agent": to_agent})


def record_latency(skill: str, duration_ms: float):
    _request_latency.record(duration_ms, {"skill": skill})


def record_error(skill: str, error_code: int, from_agent: str, to_agent: str):
    _error_counter.add(1, {"skill": skill, "error_code": str(error_code), "from_agent": from_agent, "to_agent": to_agent})
```

---

## Go Tracing Integration

### Tracing Helper

```go
// tracing/tracing.go
package tracing

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type TraceContext struct {
	TraceID      string `json:"trace_id"`
	SpanID       string `json:"span_id"`
	ParentSpanID string `json:"parent_span_id,omitempty"`
}

var tracer trace.Tracer
var requestCounter metric.Int64Counter
var requestLatency metric.Float64Histogram
var errorCounter metric.Int64Counter

func InitTracing(serviceName, otlpEndpoint string) (func(context.Context) error, error) {
	ctx := context.Background()

	// Resource
	res, _ := resource.New(ctx, resource.WithAttributes(
		attribute.String("service.name", serviceName),
		attribute.String("service.version", "1.0.0"),
	))

	// Trace exporter
	traceExporter, _ := otlptracegrpc.NewClient(ctx,
		otlptracegrpc.WithEndpoint(otlpEndpoint),
		otlptracegrpc.WithInsecure(),
	)

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	tracer = tp.Tracer("synapse")

	// Metric exporter
	metricExporter, _ := otlpmetricgrpc.NewClient(ctx,
		otlpmetricgrpc.WithEndpoint(otlpEndpoint),
		otlpmetricgrpc.WithInsecure(),
	)

	mp := metric.NewMeterProvider(
		metric.WithResource(res),
		metric.WithReader(metric.NewPeriodicReader(metricExporter,
			metric.WithInterval(10*time.Second))),
	)
	otel.SetMeterProvider(mp)

	m := mp.Meter("synapse")
	requestCounter, _ = m.Int64Counter("synapse_requests_total")
	requestLatency, _ = m.Float64Histogram("synapse_request_duration_ms")
	errorCounter, _ = m.Int64Counter("synapse_errors_total")

	fmt.Printf("Tracing initialized for %s → %s\n", serviceName, otlpEndpoint)
	return tp.Shutdown, nil
}

func StartRequestSpan(ctx context.Context, skill, targetAgent string, parentTrace *TraceContext) (context.Context, trace.Span, TraceContext) {
	ctx, span := tracer.Start(ctx, fmt.Sprintf("synapse.request/%s", skill),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("synapse.target_agent", targetAgent),
			attribute.String("synapse.skill", skill),
		),
	)

	traceCtx := TraceContext{
		TraceID:      span.SpanContext().TraceID().String(),
		SpanID:       span.SpanContext().SpanID().String(),
		ParentSpanID: "",
	}
	if parentTrace != nil {
		traceCtx.TraceID = parentTrace.TraceID
		traceCtx.ParentSpanID = parentTrace.SpanID
	}

	return ctx, span, traceCtx
}

func RecordRequest(skill, fromAgent, toAgent string) {
	requestCounter.Add(context.Background(), 1,
		attribute.String("skill", skill),
		attribute.String("from_agent", fromAgent),
		attribute.String("to_agent", toAgent),
	)
}

func RecordLatency(skill string, durationMs float64) {
	requestLatency.Record(context.Background(), durationMs,
		attribute.String("skill", skill),
	)
}

func RecordError(skill string, errorCode int, fromAgent, toAgent string) {
	errorCounter.Add(context.Background(), 1,
		attribute.String("skill", skill),
		attribute.String("error_code", fmt.Sprintf("%d", errorCode)),
		attribute.String("from_agent", fromAgent),
		attribute.String("to_agent", toAgent),
	)
}
```

---

## Grafana Dashboard

Save as `grafana/dashboards/synapse.json`:

```json
{
  "annotations": { "list": [] },
  "editable": true,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 1,
  "links": [],
  "panels": [
    {
      "title": "Request Rate (req/s)",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "targets": [
        { "expr": "rate(synapse_requests_total[5m])", "legendFormat": "{{skill}}" }
      ]
    },
    {
      "title": "Request Latency (p50, p95, p99)",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "targets": [
        { "expr": "histogram_quantile(0.5, rate(synapse_request_duration_ms_bucket[5m]))", "legendFormat": "p50" },
        { "expr": "histogram_quantile(0.95, rate(synapse_request_duration_ms_bucket[5m]))", "legendFormat": "p95" },
        { "expr": "histogram_quantile(0.99, rate(synapse_request_duration_ms_bucket[5m]))", "legendFormat": "p99" }
      ]
    },
    {
      "title": "Error Rate",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "targets": [
        { "expr": "rate(synapse_errors_total[5m])", "legendFormat": "{{skill}} ({{error_code}})" }
      ]
    },
    {
      "title": "Active Agents",
      "type": "stat",
      "gridPos": { "h": 4, "w": 6, "x": 12, "y": 8 },
      "targets": [
        { "expr": "synapse_active_agents", "legendFormat": "{{agent_name}}" }
      ]
    },
    {
      "title": "NATS Connections",
      "type": "stat",
      "gridPos": { "h": 4, "w": 6, "x": 18, "y": 8 },
      "targets": [
        { "expr": "nats_core_connections", "legendFormat": "connections" }
      ]
    },
    {
      "title": "Requests by Skill",
      "type": "piechart",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 12 },
      "targets": [
        { "expr": "synapse_requests_total", "legendFormat": "{{skill}}" }
      ]
    },
    {
      "title": "Error Code Distribution",
      "type": "piechart",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 16 },
      "targets": [
        { "expr": "synapse_errors_total", "legendFormat": "{{error_code}}" }
      ]
    }
  ],
  "schemaVersion": 39,
  "tags": ["synapse", "nats"],
  "templating": { "list": [] },
  "time": { "from": "now-1h", "to": "now" },
  "title": "Synapse Agent Mesh",
  "uid": "synapse-mesh"
}
```

### Grafana Provisioning

Save as `grafana/provisioning/datasources/datasources.yml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true

  - name: Jaeger
    type: jaeger
    access: proxy
    url: http://jaeger:16686
    jsonData:
      tracesToMetrics:
        datasourceUid: prometheus
```

Save as `grafana/provisioning/dashboards/dashboards.yml`:

```yaml
apiVersion: 1
providers:
  - name: Synapse
    orgId: 1
    folder: Synapse
    type: file
    disableDeletion: false
    editable: true
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: false
```

---

## Quick Start: Observability Stack

```bash
# 1. Start the observability stack
docker compose -f docker-compose.observability.yml up -d

# 2. Start NATS with JetStream
nats-server -js -m 8222 &

# 3. Run your agents with OTLP endpoint set
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# 4. Open dashboards
# Jaeger UI:  http://localhost:16686
# Grafana:     http://localhost:3000 (admin/admin)
# Prometheus:  http://localhost:9090
```

---

## NATS Prometheus Exporter

NATS Server exposes metrics natively. Add the Prometheus exporter:

```bash
docker run -d \
  --name nats-prom-exporter \
  -p 7777:7777 \
  natsio/prometheus-nats-exporter:latest \
  -varz -connz -subsz -jsz all \
  http://nats-server:8222
```

**Key NATS metrics to monitor:**

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| `nats_core_connections` | varz | Drop > 50% = agent disconnect |
| `nats_core_subscriptions` | subsz | Sudden spike = subscription leak |
| `jetstream_stream_messages` | jsz | Growing without bound = stuck consumer |
| `nats_server_cpu` | varz | > 80% sustained |
| `nats_server_mem` | varz | > 90% of limit |

---

## Health Check Pattern

Every production agent should expose a health endpoint via NATS:

```typescript
// Health check pattern
mesh.onRequest("health", () => ({
  status: "healthy",
  uptime: process.uptime(),
  memory: process.memoryUsage(),
  agent: mesh.agentId,
  registered: mesh.isRegistered,
  connected: mesh.isConnected,
  timestamp: new Date().toISOString(),
}));
```

```bash
# Check agent health
nats request mesh.agent.bob-001.inbox '{"skill":"health","input":{}}'
```

Monitor health from Prometheus:

```yaml
# prometheus.yml — add health checks
scrape_configs:
  - job_name: "nats"
    static_configs:
      - targets: ["nats-server:8222"]
```

---

## W3C Trace Context Interop

For interop with HTTP services, propagate W3C `traceparent` headers:

```typescript
// Convert Synapse trace → W3C traceparent
function toW3CTraceParent(trace: TraceContext): string {
  // W3C format: 00-{trace_id}-{span_id}-{flags}
  return `00-${trace.trace_id}-${trace.span_id}-01`;
}

// Parse W3C traceparent → Synapse trace
function fromW3CTraceParent(tp: string): TraceContext {
  const parts = tp.split("-");
  return {
    trace_id: parts[1],
    span_id: parts[2],
  };
}
```

This enables linking Synapse traces with HTTP API traces in a single trace tree visible in Jaeger/Tempo.

---

## Next Steps

- [Envelope Reference](./envelope.md) — Trace field specification
- [Security](./security.md) — Auth and permissions
- [Patterns](./patterns.md) — Circuit breaker and health check patterns