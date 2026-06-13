# Go SDK for Synapse

Complete Go SDK with goroutines, JetStream persistence, high-throughput patterns, and production deployment.

## Installation

```bash
go get github.com/nats-io/nats.go
go get github.com/google/uuid
```

---

## Core SDK

### `synapse.go`

```go
package synapse

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "sync"
    "time"

    "github.com/google/uuid"
    "github.com/nats-io/nats.go"
)

type Availability string

const (
    AvailableOnline  Availability = "online"
    AvailableBusy    Availability = "busy"
    AvailableOffline Availability = "offline"
)

type Skill struct {
    ID          string   `json:"id"`
    Name        string   `json:"name"`
    Description string   `json:"description"`
    InputModes  []string `json:"input_modes,omitempty"`
    OutputModes []string `json:"output_modes,omitempty"`
}

type AgentManifest struct {
    ID            string       `json:"id"`
    Name          string       `json:"name"`
    Description   string       `json:"description,omitempty"`
    Capabilities  []string     `json:"capabilities"`
    Skills        []Skill      `json:"skills"`
    Endpoint      string       `json:"endpoint"`
    Availability  Availability `json:"availability"`
    LastHeartbeat string       `json:"last_heartbeat"`
}

type Envelope struct {
    V         string                 `json:"v"`
    ID        string                 `json:"id"`
    Type      string                 `json:"type"`
    TS        string                 `json:"ts"`
    From      string                 `json:"from"`
    To        *string                `json:"to,omitempty"`
    TaskID    *string                `json:"task_id,omitempty"`
    Trace     map[string]string      `json:"trace,omitempty"`
    Payload   map[string]interface{} `json:"payload,omitempty"`
    Artifacts []interface{}          `json:"artifacts,omitempty"`
    Error     *ErrorInfo             `json:"error,omitempty"`
}

type ErrorInfo struct {
    Code      int    `json:"code"`
    Message   string `json:"message"`
    Retryable bool   `json:"retryable"`
}

type HandlerFunc func(payload map[string]interface{}, ctx map[string]string) (interface{}, error)

type Synapse struct {
    nc       *nats.Conn
    id       string
    manifest *AgentManifest
    handlers map[string]HandlerFunc
    mu       sync.RWMutex
    js       nats.JetStreamContext
    ctx      context.Context
    cancel   context.CancelFunc
}

func Connect(url string, opts ...nats.Option) (*Synapse, error) {
    nc, err := nats.Connect(url, opts...)
    if err != nil {
        return nil, fmt.Errorf("connect to NATS: %w", err)
    }

    ctx, cancel := context.WithCancel(context.Background())
    
    am := &Synapse{
        nc:       nc,
        id:       uuid.New().String(),
        handlers: make(map[string]HandlerFunc),
        ctx:      ctx,
        cancel:   cancel,
    }

    log.Printf("Connected to NATS at %s with ID: %s", url, am.id)
    return am, nil
}

func (am *Synapse) ConnectJetStream() error {
    js, err := am.nc.JetStream()
    if err != nil {
        return fmt.Errorf("create JetStream context: %w", err)
    }
    am.js = js
    return nil
}

func (am *Synapse) AgentID() string {
    return am.id
}

// PRIMITIVE 1: Register
func (am *Synapse) Register(name, description string, capabilities []string, skills []Skill, optID ...string) error {
	// Allow caller to specify a stable agent ID (e.g., for HTTP bridge proxying)
	if len(optID) > 0 {
		am.id = optID[0]
	}
	am.manifest = &AgentManifest{
		ID:            am.id,
        Name:          name,
        Description:   description,
        Capabilities:  capabilities,
        Skills:        skills,
        Endpoint:      fmt.Sprintf("mesh.agent.%s.inbox", am.id),
        Availability:  AvailableOnline,
        LastHeartbeat: time.Now().UTC().Format(time.RFC3339),
    }

    envelope := Envelope{
        V:       "1.0.0",
        ID:      uuid.New().String(),
        Type:    "register",
        TS:      time.Now().UTC().Format(time.RFC3339),
        From:    am.id,
        Payload: manifestToPayload(am.manifest),
    }

    data, _ := json.Marshal(envelope)
    if err := am.nc.Publish("mesh.registry.register", data); err != nil {
        return fmt.Errorf("publish register: %w", err)
    }

    if err := am.setupDiscoverResponder(); err != nil {
        return fmt.Errorf("setup discover: %w", err)
    }

    if err := am.setupRequestHandler(); err != nil {
        return fmt.Errorf("setup request: %w", err)
    }

    go am.heartbeatLoop(30 * time.Second)

    log.Printf("Agent '%s' (%s) registered", name, am.id)
    return nil
}

// PRIMITIVE 2: Discover
func (am *Synapse) Discover(capabilities []string, timeout time.Duration) ([]AgentManifest, error) {
    inbox := am.nc.NewInbox()
    sub, err := am.nc.SubscribeSync(inbox)
    if err != nil {
        return nil, fmt.Errorf("subscribe inbox: %w", err)
    }
    defer sub.Unsubscribe()

    envelope := Envelope{
        V:       "1.0.0",
        ID:      uuid.New().String(),
        Type:    "discover",
        TS:      time.Now().UTC().Format(time.RFC3339),
        From:    am.id,
        Payload: map[string]interface{}{"capabilities": capabilities},
    }

    data, _ := json.Marshal(envelope)
    if err := am.nc.PublishRequest("mesh.registry.discover", inbox, data); err != nil {
        return nil, fmt.Errorf("publish discover: %w", err)
    }

    var agents []AgentManifest
    deadline := time.Now().Add(timeout)
    
    for time.Now().Before(deadline) {
        msg, err := sub.NextMsg(time.Until(deadline))
        if err != nil {
            break
        }

        var env Envelope
        if err := json.Unmarshal(msg.Data, &env); err != nil {
            continue
        }

        if env.Payload != nil {
            manifest := payloadToManifest(env.Payload)
            agents = append(agents, manifest)
        }
    }

    return agents, nil
}

// PRIMITIVE 3: Request
func (am *Synapse) Request(agentID, skill string, input map[string]interface{}, timeout time.Duration) (*Envelope, error) {
    taskID := uuid.New().String()
    
    envelope := Envelope{
        V:      "1.0.0",
        ID:     uuid.New().String(),
        Type:   "request",
        TS:     time.Now().UTC().Format(time.RFC3339),
        From:   am.id,
        To:     &agentID,
        TaskID: &taskID,
        Trace: map[string]string{
            "trace_id": uuid.New().String(),
            "span_id":  uuid.New().String(),
        },
        Payload: map[string]interface{}{
            "skill": skill,
            "input": input,
        },
    }

    data, _ := json.Marshal(envelope)
    subject := fmt.Sprintf("mesh.agent.%s.inbox", agentID)
    
    msg, err := am.nc.Request(subject, data, timeout)
    if err != nil {
        return nil, fmt.Errorf("request %s: %w", agentID, err)
    }

    var response Envelope
    if err := json.Unmarshal(msg.Data, &response); err != nil {
        return nil, fmt.Errorf("unmarshal response: %w", err)
    }

    if response.Error != nil {
        return nil, fmt.Errorf("[%d] %s", response.Error.Code, response.Error.Message)
    }

    return &response, nil
}

// PRIMITIVE 4: OnRequest
func (am *Synapse) OnRequest(skill string, handler HandlerFunc) {
    am.mu.Lock()
    defer am.mu.Unlock()
    am.handlers[skill] = handler
    log.Printf("Handler '%s' registered", skill)
}

// PRIMITIVE 5: Emit
func (am *Synapse) Emit(eventType string, data map[string]interface{}) error {
    envelope := Envelope{
        V:    "1.0.0",
        ID:   uuid.New().String(),
        Type: "emit",
        TS:   time.Now().UTC().Format(time.RFC3339),
        From: am.id,
        Payload: map[string]interface{}{
            "event_type": eventType,
            "data":       data,
        },
    }

    eventData, _ := json.Marshal(envelope)
    return am.nc.Publish(fmt.Sprintf("mesh.event.%s", eventType), eventData)
}

// PRIMITIVE 6: Subscribe
func (am *Synapse) Subscribe(pattern string, handler func(payload map[string]interface{})) error {
    _, err := am.nc.Subscribe(fmt.Sprintf("mesh.event.%s", pattern), func(msg *nats.Msg) {
        var env Envelope
        if err := json.Unmarshal(msg.Data, &env); err != nil {
            log.Printf("Unmarshal event error: %v", err)
            return
        }
        handler(env.Payload)
    })
    return err
}

// Deregister removes this agent from the mesh registry.
func (am *Synapse) Deregister() error {
	if am.manifest == nil {
		return nil
	}

	envelope := Envelope{
		V:       "1.0.0",
		ID:      uuid.New().String(),
		Type:    "deregister",
		TS:      time.Now().UTC().Format(time.RFC3339),
		From:    am.id,
		Payload: map[string]interface{}{"id": am.id},
	}

	data, _ := json.Marshal(envelope)
	if err := am.nc.Publish("mesh.registry.deregister", data); err != nil {
		return fmt.Errorf("publish deregister: %w", err)
	}

	am.manifest = nil
	log.Printf("Agent %s deregistered", am.id)
	return nil
}

// Close gracefully disconnects, publishing deregister before draining.
func (am *Synapse) Close() error {
	am.cancel()
	_ = am.Deregister() // best-effort deregister before drain
	return am.nc.Drain()
}

// Internal helpers
func (am *Synapse) setupDiscoverResponder() error {
    _, err := am.nc.Subscribe("mesh.registry.discover", func(msg *nats.Msg) {
        if am.manifest == nil {
            return
        }

        var request Envelope
        if err := json.Unmarshal(msg.Data, &request); err != nil {
            return
        }

        filter := request.Payload["capabilities"]
        if caps, ok := filter.([]interface{}); ok && len(caps) > 0 {
            matched := true
            for _, cap := range caps {
                capStr := cap.(string)
                found := false
                for _, c := range am.manifest.Capabilities {
                    if c == capStr {
                        found = true
                        break
                    }
                }
                if !found {
                    matched = false
                    break
                }
            }
            if !matched {
                return
            }
        }

        response := Envelope{
            V:       "1.0.0",
            ID:      uuid.New().String(),
            Type:    "register",
            TS:      time.Now().UTC().Format(time.RFC3339),
            From:    am.id,
            Payload: manifestToPayload(am.manifest),
        }

        data, _ := json.Marshal(response)
        if msg.Reply != "" {
            am.nc.Publish(msg.Reply, data)
        }
    })

    return err
}

func (am *Synapse) setupRequestHandler() error {
    inbox := fmt.Sprintf("mesh.agent.%s.inbox", am.id)
    
    _, err := am.nc.Subscribe(inbox, func(msg *nats.Msg) {
        var envelope Envelope
        if err := json.Unmarshal(msg.Data, &envelope); err != nil {
            return
        }

        if envelope.Type != "request" {
            return
        }

        skill, _ := envelope.Payload["skill"].(string)
        
        am.mu.RLock()
        handler, exists := am.handlers[skill]
        am.mu.RUnlock()

        if !exists {
            errorResponse := Envelope{
                V:      "1.0.0",
                ID:     uuid.New().String(),
                Type:   "respond",
                TS:     time.Now().UTC().Format(time.RFC3339),
                From:   am.id,
                To:     &envelope.From,
                TaskID: envelope.TaskID,
                Trace:  envelope.Trace,
                Error: &ErrorInfo{
                    Code:      3001,
                    Message:   fmt.Sprintf("Skill '%s' not found", skill),
                    Retryable: false,
                },
            }

            data, _ := json.Marshal(errorResponse)
            if msg.Reply != "" {
                am.nc.Publish(msg.Reply, data)
            }
            return
        }

        ctx := map[string]string{
            "task_id": "",
            "from":    envelope.From,
        }
        if envelope.TaskID != nil {
            ctx["task_id"] = *envelope.TaskID
        }

        result, err := handler(envelope.Payload, ctx)
        
        if err != nil {
            errorResponse := Envelope{
                V:      "1.0.0",
                ID:     uuid.New().String(),
                Type:   "respond",
                TS:     time.Now().UTC().Format(time.RFC3339),
                From:   am.id,
                To:     &envelope.From,
                TaskID: envelope.TaskID,
                Trace:  envelope.Trace,
                Error: &ErrorInfo{
                    Code:      5001,
                    Message:   err.Error(),
                    Retryable: true,
                },
            }

            data, _ := json.Marshal(errorResponse)
            if msg.Reply != "" {
                am.nc.Publish(msg.Reply, data)
            }
            return
        }

        // Use result directly — type assertion to map[string]interface{} silently
        // drops non-map results (strings, arrays, numbers, nil).
        response := Envelope{
            V:      "1.0.0",
            ID:     uuid.New().String(),
            Type:   "respond",
            TS:     time.Now().UTC().Format(time.RFC3339),
            From:   am.id,
            To:     &envelope.From,
            TaskID: envelope.TaskID,
            Trace:  envelope.Trace,
            Payload: map[string]interface{}{
                "output": result,
            },
        }

        data, _ := json.Marshal(response)
        if msg.Reply != "" {
            am.nc.Publish(msg.Reply, data)
        }
    })

    return err
}

func (am *Synapse) heartbeatLoop(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-am.ctx.Done():
            return
        case <-ticker.C:
            // Publish to mesh.heartbeat.{id} (consistent with TS/Python SDKs)
            envelope := Envelope{
                V:    "1.0.0",
                ID:   uuid.New().String(),
                Type: "heartbeat",
                TS:   time.Now().UTC().Format(time.RFC3339),
                From: am.id,
                Payload: map[string]interface{}{
                    "agent_id":  am.id,
                    "timestamp": time.Now().UTC().Format(time.RFC3339),
                },
            }
            data, _ := json.Marshal(envelope)
            am.nc.Publish(fmt.Sprintf("mesh.heartbeat.%s", am.id), data)
        }
    }
}

func manifestToPayload(m *AgentManifest) map[string]interface{} {
    return map[string]interface{}{
        "id":             m.ID,
        "name":           m.Name,
        "description":    m.Description,
        "capabilities":   m.Capabilities,
        "skills":         m.Skills,
        "endpoint":       m.Endpoint,
        "availability":   m.Availability,
        "last_heartbeat": m.LastHeartbeat,
    }
}

func payloadToManifest(p map[string]interface{}) AgentManifest {
    m := AgentManifest{}
    if v, ok := p["id"].(string); ok {
        m.ID = v
    }
    if v, ok := p["name"].(string); ok {
        m.Name = v
    }
    if v, ok := p["description"].(string); ok {
        m.Description = v
    }
    if caps, ok := p["capabilities"].([]interface{}); ok {
        for _, c := range caps {
            if s, ok := c.(string); ok {
                m.Capabilities = append(m.Capabilities, s)
            }
        }
    }
    if skills, ok := p["skills"].([]interface{}); ok {
        for _, s := range skills {
            if sm, ok := s.(map[string]interface{}); ok {
                skill := Skill{}
                if id, ok := sm["id"].(string); ok {
                    skill.ID = id
                }
                if name, ok := sm["name"].(string); ok {
                    skill.Name = name
                }
                if desc, ok := sm["description"].(string); ok {
                    skill.Description = desc
                }
                m.Skills = append(m.Skills, skill)
            }
        }
    }
    if v, ok := p["endpoint"].(string); ok {
        m.Endpoint = v
    }
    if v, ok := p["availability"].(string); ok {
        m.Availability = Availability(v)
    }
    if v, ok := p["last_heartbeat"].(string); ok {
        m.LastHeartbeat = v
    }
    return m
}
```

---

## Basic Agent

### `main.go`

```go
package main

import (
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"

    "github.com/your-org/synapse-go/synapse"
)

func main() {
    mesh, err := synapse.Connect("nats://localhost:4222")
    if err != nil {
        log.Fatalf("Failed to connect: %v", err)
    }
    defer mesh.Close()

    err = mesh.Register(
        "Bob's Agent",
        "Friendly chat agent",
        []string{"chat"},
        []synapse.Skill{
            {ID: "chat", Name: "Chat", Description: "Chat with Bob"},
        },
    )
    if err != nil {
        log.Fatalf("Failed to register: %v", err)
    }

    mesh.OnRequest("chat", func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
        input := payload["input"].(map[string]interface{})
        text := input["text"].(string)
        
        fmt.Printf("[Bob] Received: '%s'\n", text)
        
        return map[string]interface{}{
            "text": fmt.Sprintf("Bob says: I got your message! You said '%s'", text),
        }, nil
    })

    fmt.Println("Bob agent online, waiting for requests...")

    // Wait for interrupt
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    <-sigCh

    fmt.Println("\nShutting down...")
}
```

### `jeff.go`

```go
package main

import (
    "fmt"
    "log"
    "time"

    "github.com/your-org/synapse-go/synapse"
)

func main() {
    mesh, err := synapse.Connect("nats://localhost:4222")
    if err != nil {
        log.Fatalf("Failed to connect: %v", err)
    }
    defer mesh.Close()

    mesh.Register("Jeff's Agent", "", nil, nil)

    agents, err := mesh.Discover([]string{"chat"}, 2*time.Second)
    if err != nil || len(agents) == 0 {
        log.Fatal("Could not find Bob!")
    }

    bob := agents[0]
    fmt.Printf("Found Bob: %s\n", bob.ID)

    response, err := mesh.Request(bob.ID, "chat", map[string]interface{}{
        "text": "Hey Bob, how's it going?",
    }, 30*time.Second)

    if err != nil {
        log.Fatalf("Request failed: %v", err)
    }

    fmt.Printf("Bob's response: %v\n", response.Payload)
}
```

---

## High-Throughput Patterns

### Queue Group Worker

```go
package main

import (
    "fmt"
    "log"
    "sync"

    "github.com/nats-io/nats.go"
)

func main() {
    nc, _ := nats.Connect("nats://localhost:4222")
    defer nc.Close()

    // Queue group for load balancing
    var wg sync.WaitGroup
    workerCount := 5

    for i := 0; i < workerCount; i++ {
        wg.Add(1)
        go func(workerID int) {
            defer wg.Done()
            
            _, err := nc.QueueSubscribe(
                "mesh.task.process",
                "worker-pool",
                func(msg *nats.Msg) {
                    fmt.Printf("[Worker %d] Processing: %s\n", workerID, string(msg.Data))
                    msg.Respond([]byte(`{"status":"done"}`))
                },
            )
            if err != nil {
                log.Fatalf("Subscribe error: %v", err)
            }
        }(i)
    }

    log.Printf("Started %d workers", workerCount)
    wg.Wait()
}
```

### JetStream Persistent Queue

```go
package main

import (
    "fmt"
    "log"
    "time"

    "github.com/nats-io/nats.go"
)

func main() {
    nc, _ := nats.Connect("nats://localhost:4222", nats.Name("worker"))
    defer nc.Close()

    js, err := nc.JetStream()
    if err != nil {
        log.Fatalf("JetStream: %v", err)
    }

    // Create stream for tasks
    _, err = js.AddStream(&nats.StreamConfig{
        Name:     "TASKS",
        Subjects: []string{"mesh.task.*"},
        Storage:  nats.FileStorage,
        Retention: nats.WorkQueuePolicy,
    })

    // Create durable consumer
    _, err = js.AddConsumer("TASKS", &nats.ConsumerConfig{
        Durable:       "worker-pool",
        DeliverPolicy: nats.DeliverAllPolicy,
        AckPolicy:     nats.AckExplicitPolicy,
        MaxDeliver:    3,
        AckWait:       30 * time.Second,
    })

    // Pull messages
    sub, _ := js.PullSubscribe("mesh.task.*", "worker-pool")

    for {
        msgs, _ := sub.Fetch(10, nats.MaxWait(5*time.Second))
        
        for _, msg := range msgs {
            fmt.Printf("Processing: %s\n", string(msg.Data))
            
            // Process task...
            
            // Acknowledge
            msg.Ack()
        }
    }
}
```

---

## Streaming Primitives

Synapse supports incremental responses via a stream subject per task.
Each task gets its own subject: `mesh.task.{task_id}.stream`.
Chunks are published as individual NATS messages; the final message has `done: true`.

### Caller side: `StreamRequest()`

Returns a channel yielding each chunk as it arrives.

```go
stream, err := mesh.StreamRequest(agentID, "analyze", map[string]interface{}{"text": "huge doc"}, 30*time.Second)
if err != nil {
    log.Fatal(err)
}

for chunk := range stream.Chunks() {
    fmt.Printf("chunk: %v\n", chunk)
}
// channel closes when done: true arrives
```

### Handler side: `OnStreamRequest()`

Registers a handler that sends chunks via a callback.

```go
mesh.OnStreamRequest("analyze", func(payload map[string]interface{}, ctx map[string]string, send func(interface{}) error) error {
    text, _ := payload["input"].(map[string]interface{})["text"].(string)
    for i, word := range strings.Fields(text) {
        if err := send(map[string]interface{}{"word": word, "index": i}); err != nil {
            return err
        }
    }
    return nil
})
```

### Wire format

Same as TypeScript and Python — `{seq, chunk, done}` messages on `mesh.task.{task_id}.stream`.

### Implementation

```go
type StreamChunk struct {
    Seq    int                    `json:"seq"`
    Chunk  map[string]interface{} `json:"chunk"`
    Done   bool                   `json:"done"`
    Result map[string]interface{} `json:"result,omitempty"`
}

type StreamResult struct {
    chunks chan map[string]interface{}
    result map[string]interface{}
    err    error
}

func (sr *StreamResult) Chunks() <-chan map[string]interface{} {
    return sr.chunks
}

func (sr *StreamResult) Result() map[string]interface{} {
    return sr.result
}

func (am *Synapse) StreamRequest(agentID, skill string, input map[string]interface{}, timeout time.Duration) (*StreamResult, error) {
    taskID := uuid.New().String()
    streamSubject := fmt.Sprintf("mesh.task.%s.stream", taskID)

    // Subscribe to stream before sending request
    sub, err := am.nc.SubscribeSync(streamSubject)
    if err != nil {
        return nil, err
    }

    // Send the request
    envelope := Envelope{
        V: "1.0.0", ID: uuid.New().String(), Type: "request",
        TS: time.Now().UTC().Format(time.RFC3339),
        From: am.id, To: &agentID, TaskID: &taskID,
        Trace: map[string]string{"trace_id": uuid.New().String(), "span_id": uuid.New().String()},
        Payload: map[string]interface{}{"skill": skill, "input": input, "stream": true},
    }

    data, _ := json.Marshal(envelope)
    subject := fmt.Sprintf("mesh.agent.%s.inbox", agentID)

    if err := am.nc.Publish(subject, data); err != nil {
        sub.Unsubscribe()
        return nil, err
    }

    // Read chunks and send to channel
    result := &StreamResult{
        chunks: make(chan map[string]interface{}, 100),
    }

    go func() {
        defer close(result.chunks)
        defer sub.Unsubscribe()
        deadline := time.After(timeout)

        for {
            select {
            case <-deadline:
                result.err = fmt.Errorf("stream timeout after %s", timeout)
                return
            default:
            }

            msg, err := sub.NextMsg(timeout)
            if err != nil {
                result.err = err
                return
            }

            var chunk StreamChunk
            if err := json.Unmarshal(msg.Data, &chunk); err != nil {
                continue
            }

            if chunk.Done {
                result.result = chunk.Result
                return
            }

            result.chunks <- chunk.Chunk
        }
    }()

    return result, nil
}

type StreamSendFunc func(chunk interface{}) error

type StreamHandlerFunc func(payload map[string]interface{}, ctx map[string]string, send StreamSendFunc) error

func (am *Synapse) OnStreamRequest(skill string, handler StreamHandlerFunc) {
    // Wrap streaming handler as a regular handler that publishes chunks
    am.OnRequest(skill, func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
        taskID := ctx["task_id"]
        streamSubject := fmt.Sprintf("mesh.task.%s.stream", taskID)
        seq := 0

        send := func(chunk interface{}) error {
            msg := map[string]interface{}{"seq": seq, "chunk": chunk, "done": false}
            data, err := json.Marshal(msg)
            if err != nil {
                return err
            }
            seq++
            return am.nc.Publish(streamSubject, data)
        }

        if err := handler(payload, ctx, send); err != nil {
            return nil, err
        }

        // Send final stream message
        finalMsg := map[string]interface{}{"seq": seq, "chunk": map[string]interface{}{}, "done": true}
        data, _ := json.Marshal(finalMsg)
        am.nc.Publish(streamSubject, data)

        return map[string]interface{}{"status": "streamed", "chunks_sent": seq}, nil
    })
}
```

---

## Schema Validation

Validate envelopes and manifests using JSON Schema + `gojsonschema` to catch malformed messages before they propagate.

### Install

```bash
go get github.com/xeipuuv/gojsonschema
```

### Usage

```go
import "github.com/your-org/synapse-go/synapse"

// Validate an envelope before sending
envelopeData, _ := json.Marshal(envelope)
if err := synapse.ValidateEnvelope(envelopeData); err != nil {
    log.Fatalf("Invalid envelope: %v", err)
}

// Validate a manifest at registration
manifestData, _ := json.Marshal(manifest)
if err := synapse.ValidateManifest(manifestData); err != nil {
    log.Fatalf("Invalid manifest: %v", err)
}
```

Full schema definitions and validator code are in [schema.md](./schema.md).

---

## OpenTelemetry Integration

Wire up OTel tracing to track requests across agent hops.

### Install

```bash
go get go.opentelemetry.io/otel go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc
```

### Quick Setup

```go
import "github.com/your-org/synapse-go/tracing"

func main() {
    // Initialize at startup
    shutdown, err := tracing.InitTracing("my-agent", "localhost:4317")
    if err != nil {
        log.Fatal(err)
    }
    defer shutdown(context.Background())

    // ... create mesh, register, etc.

    // In a handler — create a SERVER span
    mesh.OnRequest("chat", func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
        ctx, span := tracing.StartHandlerSpan(ctx, "chat", ctx["from"])
        defer span.End()

        result, err := handleChat(payload)
        if err != nil {
            span.RecordError(err)
            return nil, err
        }
        return result, nil
    })

    // For outgoing requests — create a CLIENT span
    ctx, span, traceCtx := tracing.StartRequestSpan(context.Background(), "chat", targetAgentID, nil)
    start := time.Now()
    result, err := mesh.Request(targetAgentID, "chat", input, 30*time.Second)
    if err != nil {
        span.RecordError(err)
        span.End()
        return
    }
    tracing.RecordRequest("chat", mesh.AgentID(), targetAgentID)
    tracing.RecordLatency("chat", float64(time.Since(start).Milliseconds()))
    span.End()
}
```

Full tracing module, Grafana dashboard, and Docker Compose observability stack are in [observability.md](./observability.md).

---

## Backpressure & Flow Control

Adaptive rate limiting, concurrency limits, and queue depth management to protect agents from overload.

### Implementation

```go
// backpressure/backpressure.go
package backpressure

import (
	"context"
	"sync"
	"time"
)

// ConcurrencyLimiter limits concurrent request handlers using a semaphore.
type ConcurrencyLimiter struct {
	sem       chan struct{}
	active    int
	pending   int
	mu        sync.Mutex
}

func NewConcurrencyLimiter(maxConcurrency int) *ConcurrencyLimiter {
	return &ConcurrencyLimiter{
		sem: make(chan struct{}, maxConcurrency),
	}
}

func (cl *ConcurrencyLimiter) Acquire(ctx context.Context) error {
	cl.mu.Lock()
	cl.pending++
	cl.mu.Unlock()

	select {
	case cl.sem <- struct{}{}:
		cl.mu.Lock()
		cl.pending--
		cl.active++
		cl.mu.Unlock()
		return nil
	case <-ctx.Done():
		cl.mu.Lock()
		cl.pending--
		cl.mu.Unlock()
		return ctx.Err()
	}
}

func (cl *ConcurrencyLimiter) Release() {
	cl.mu.Lock()
	cl.active--
	cl.mu.Unlock()
	<-cl.sem
}

func (cl *ConcurrencyLimiter) IsOverloaded() bool {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	return cl.pending > cap(cl.sem)*2
}

// AdaptiveRateLimiter implements token bucket with backoff on OVERLOADED.
type AdaptiveRateLimiter struct {
	maxTokens    int
	minTokens    int
	originalMax  int
	bucket       float64
	lastRefill   time.Time
	refillMs     time.Duration
	consecutiveOv int
	mu           sync.Mutex
}

func NewAdaptiveRateLimiter(maxTokens, minTokens int, refillMs time.Duration) *AdaptiveRateLimiter {
	return &AdaptiveRateLimiter{
		maxTokens:   maxTokens,
		minTokens:   minTokens,
		originalMax: maxTokens,
		bucket:      float64(maxTokens),
		lastRefill:  time.Now(),
		refillMs:    refillMs,
	}
}

func (rl *AdaptiveRateLimiter) TryAcquire() bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	rl.refill()
	if rl.bucket >= 1 {
		rl.bucket--
		return true
	}
	return false
}

func (rl *AdaptiveRateLimiter) OnOverload() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.consecutiveOv++
	newMax := rl.maxTokens / (1 << rl.consecutiveOv)
	if newMax < rl.minTokens {
		newMax = rl.minTokens
	}
	rl.maxTokens = newMax
	if rl.bucket > float64(newMax) {
		rl.bucket = float64(newMax)
	}
}

func (rl *AdaptiveRateLimiter) OnSuccess() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if rl.consecutiveOv > 0 {
		rl.consecutiveOv--
		newMax := rl.maxTokens * 2
		if newMax > rl.originalMax {
			newMax = rl.originalMax
		}
		rl.maxTokens = newMax
	}
}

func (rl *AdaptiveRateLimiter) refill() {
	now := time.Now()
	elapsed := now.Sub(rl.lastRefill)
	if elapsed >= rl.refillMs {
		rl.bucket = float64(rl.maxTokens)
		rl.lastRefill = now
	}
}
```

### Integration

```go
mesh.OnRequest("chat", func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
    // Check rate limit
    if !rateLimiter.TryAcquire() {
        return nil, fmt.Errorf("[4002] Rate limited")
    }

    // Acquire concurrency slot
    if err := concurrency.Acquire(context.Background()); err != nil {
        return nil, err
    }
    defer concurrency.Release()

    // Handle the request
    result, err := handleChat(payload)
    if err != nil {
        return nil, err
    }
    rateLimiter.OnSuccess()
    return result, nil
})

// On receiving OVERLOADED from downstream:
if err != nil && strings.Contains(err.Error(), "4001") {
    rateLimiter.OnOverload()
}
```

---

**Continue to:**
- [Full Go Examples](./examples/go/) — Complete projects
- [JetStream Patterns](./patterns.md#jetstream) — Persistent messaging
- [Security](./security.md) — NKeys and JWT authentication
- [Schema Validation](./schema.md) — JSON Schema definitions
- [Observability](./observability.md) — OTel tracing and dashboards
