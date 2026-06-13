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

func (am *Synapse) Register(name, description string, capabilities []string, skills []Skill) error {
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

func (am *Synapse) OnRequest(skill string, handler HandlerFunc) {
	am.mu.Lock()
	defer am.mu.Unlock()
	am.handlers[skill] = handler
	log.Printf("Handler '%s' registered", skill)
}

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

func (am *Synapse) Close() error {
	am.cancel()
	return am.nc.Drain()
}

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

		outputMap, _ := result.(map[string]interface{})

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
				"output": outputMap,
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
