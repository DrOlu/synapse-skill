# Task Store

JetStream-backed persistent task lifecycle. Tracks every task from creation to terminal state, survives restarts, and supports querying by agent, state, and context.

## Why a Task Store?

The task state machine (`states.md`) defines 7 states and valid transitions, but by default it lives in-memory and disappears when the agent process dies. The Task Store persists every task in a NATS KV store so that:

- `getTask(taskId)` returns the current state at any time
- A crashed agent's task stays at `working` instead of vanishing
- Multi-turn conversations (`context_id`) link their tasks together and are queryable
- A dashboard can show all in-flight tasks across the mesh

| Feature | Without Task Store | With Task Store |
|---------|-------------------|-----------------|
| State survives restart | ❌ | ✅ |
| Query tasks by agent | ❌ | ✅ |
| Query tasks by state | ❌ | ✅ |
| Multi-turn conversation linking | Manual `context_id` | Automatic |
| Task history / audit log | ❌ | ✅ (state log) |
| TTL auto-cleanup of terminal tasks | ❌ | ✅ (configurable) |

---

## Setup

### Create the KV Bucket

```bash
nats kv add TASK_STORE --history=16 --ttl=3600s --description="Synapse task store"
```

- `--history=16`: Keep last 16 state transitions per task (enough for most workflows)
- `--ttl=3600s`: Auto-cleanup tasks 1 hour after reaching terminal state

### Create a JetStream Stream (for audit log)

```bash
nats stream add TASK_STATE_LOG \
  --subjects="mesh.task.*.update" \
  --storage=file \
  --retention=limits \
  --max-age=7d \
  --description="Permanent log of all task state transitions"
```

---

## Task Object

```json
{
  "task_id": "01912e42-7c3b-7d2e-8f4a-5b6c7d8e9f0b",
  "context_id": "01912e42-7c3b-7d2e-8f4a-5b6c7d8e9f0a",
  "from": "agent-requester-001",
  "to": "agent-handler-001",
  "skill": "research",
  "state": "working",
  "created_at": "2026-01-15T12:34:56.789Z",
  "updated_at": "2026-01-15T12:35:01.123Z",
  "history": [
    {
      "state": "submitted",
      "at": "2026-01-15T12:34:56.789Z",
      "by": "agent-requester-001",
      "detail": "Task created"
    },
    {
      "state": "working",
      "at": "2026-01-15T12:35:01.123Z",
      "by": "agent-handler-001",
      "detail": "Agent started processing"
    }
  ],
  "payload": { "topic": "explain quantum computing" },
  "result": null,
  "error": null,
  "stream": false,
  "streaming": false
}
```

---

## TypeScript Implementation

```typescript
// src/tasks.ts — JetStream-backed task store
import { connect, KeyValue, JSONCodec } from "nats";
import { v4 as uuid } from "uuid";

const jc = JSONCodec();

// ─── State Machine ───────────────────────────────────────────

type TaskState =
  | "submitted" | "working" | "input_required" | "auth_required"
  | "completed" | "failed" | "canceled";

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  submitted:        ["working", "failed", "canceled"],
  working:          ["completed", "failed", "canceled", "input_required", "auth_required"],
  input_required:   ["working", "failed", "canceled"],
  auth_required:    ["working", "failed", "canceled"],
  completed:        [],
  failed:           [],
  canceled:         [],
};

const TERMINAL: TaskState[] = ["completed", "failed", "canceled"];

function isTerminal(state: TaskState): boolean {
  return TERMINAL.includes(state);
}

function isValidTransition(from: TaskState, to: TaskState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── Task Type ───────────────────────────────────────────────

export interface HistoryEntry {
  state: TaskState;
  at: string;
  by: string;
  detail?: string;
}

export interface Task {
  task_id: string;
  context_id?: string;
  from: string;
  to: string;
  skill: string;
  state: TaskState;
  created_at: string;
  updated_at: string;
  history: HistoryEntry[];
  payload?: any;
  result?: any;
  error?: { code: number; message: string; retryable: boolean };
  stream?: boolean;
}

// ─── Task Store ──────────────────────────────────────────────

export interface TaskFilter {
  from?: string;
  to?: string;
  state?: TaskState;
  context_id?: string;
  skill?: string;
  created_after?: string;
  created_before?: string;
}

export class TaskStore {
  private kv: KeyValue;
  private nc: any;

  constructor(kv: KeyValue, nc: any) {
    this.kv = kv;
    this.nc = nc;
  }

  static async create(nc: any): Promise<TaskStore> {
    const js = nc.jetstream();
    const kv = await js.views.kv("TASK_STORE");
    return new TaskStore(kv, nc);
  }

  /** Create a new task */
  async create(params: {
    from: string;
    to: string;
    skill: string;
    payload?: any;
    context_id?: string;
    stream?: boolean;
    task_id?: string;
  }): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      task_id: params.task_id || uuid(),
      context_id: params.context_id,
      from: params.from,
      to: params.to,
      skill: params.skill,
      state: "submitted",
      created_at: now,
      updated_at: now,
      history: [{ state: "submitted", at: now, by: params.from, detail: "Task created" }],
      payload: params.payload,
      stream: params.stream ?? false,
    };

    await this.save(task);
    await this.publishUpdate(task, "Task created");
    return task;
  }

  /** Get a task by ID */
  async get(taskId: string): Promise<Task | null> {
    try {
      const entry = await this.kv.get(taskId);
      return jc.decode(entry.value) as Task;
    } catch {
      return null;
    }
  }

  /** Transition a task to a new state */
  async transition(
    taskId: string,
    newState: TaskState,
    agentId: string,
    detail?: string,
    result?: any,
    error?: { code: number; message: string; retryable: boolean }
  ): Promise<Task> {
    const task = await this.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (isTerminal(task.state)) {
      throw new Error(`Task ${taskId} is already in terminal state: ${task.state}`);
    }

    if (!isValidTransition(task.state, newState)) {
      throw new Error(
        `Invalid transition: ${task.state} → ${newState}. Valid: ${VALID_TRANSITIONS[task.state].join(", ")}`
      );
    }

    const now = new Date().toISOString();
    task.state = newState;
    task.updated_at = now;
    task.history.push({ state: newState, at: now, by: agentId, detail });

    if (result !== undefined) task.result = result;
    if (error !== undefined) task.error = error;

    await this.save(task);
    await this.publishUpdate(task, detail);
    return task;
  }

  /** Mark a task as completed */
  async complete(taskId: string, agentId: string, result: any, detail?: string): Promise<Task> {
    return this.transition(taskId, "completed", agentId, detail, result);
  }

  /** Mark a task as failed */
  async fail(
    taskId: string, agentId: string, code: number, message: string,
    retryable: boolean, detail?: string
  ): Promise<Task> {
    return this.transition(taskId, "failed", agentId, detail, undefined, { code, message, retryable });
  }

  /** Request more input */
  async requestInput(
    taskId: string, agentId: string, question?: string, detail?: string
  ): Promise<Task> {
    return this.transition(taskId, "input_required", agentId, detail, { question });
  }

  /** Mark a task as canceled */
  async cancel(taskId: string, agentId: string, detail?: string): Promise<Task> {
    return this.transition(taskId, "canceled", agentId, detail);
  }

  /** List tasks matching a filter (scans all keys) */
  async list(filter?: TaskFilter): Promise<Task[]> {
    const keys = await this.kv.keys();
    const tasks: Task[] = [];

    for await (const key of keys) {
      try {
        const entry = await this.kv.get(key);
        const task = jc.decode(entry.value) as Task;

        if (filter?.from    && task.from    !== filter.from)    continue;
        if (filter?.to      && task.to      !== filter.to)      continue;
        if (filter?.state   && task.state   !== filter.state)   continue;
        if (filter?.context_id && task.context_id !== filter.context_id) continue;
        if (filter?.skill   && task.skill   !== filter.skill)   continue;
        if (filter?.created_after  && task.created_at < filter.created_after)  continue;
        if (filter?.created_before && task.created_at > filter.created_before) continue;

        tasks.push(task);
      } catch {
        continue;
      }
    }

    return tasks;
  }

  /** Get all tasks in a conversation (linked by context_id) */
  async getConversation(contextId: string): Promise<Task[]> {
    return this.list({ context_id: contextId });
  }

  /** Get summary statistics */
  async stats(): Promise<Record<TaskState, number>> {
    const keys = await this.kv.keys();
    const counts: Record<string, number> = {
      submitted: 0, working: 0, input_required: 0,
      auth_required: 0, completed: 0, failed: 0, canceled: 0,
    };

    for await (const key of keys) {
      try {
        const entry = await this.kv.get(key);
        const task = jc.decode(entry.value) as Task;
        if (counts[task.state] !== undefined) counts[task.state]++;
      } catch {}
    }

    return counts as Record<TaskState, number>;
  }

  private async save(task: Task): Promise<void> {
    await this.kv.put(task.task_id, jc.encode(task));
  }

  private async publishUpdate(task: Task, detail?: string): Promise<void> {
    this.nc.publish(`mesh.task.${task.task_id}.update`, jc.encode({
      v: "1.0.0",
      id: uuid(),
      type: "task_update",
      ts: task.updated_at,
      from: task.to,
      task_id: task.task_id,
      payload: {
        task_id: task.task_id,
        state: task.state,
        previous_state: task.history.length > 1
          ? task.history[task.history.length - 2].state
          : undefined,
        detail,
      },
    }));
  }
}
```

### Integration with Synapse SDK

```typescript
import { TaskStore } from "./tasks.js";

class TaskAwareSynapse extends Synapse {
  private taskStore?: TaskStore;

  static async connect(url?: string, opts?: any): Promise<TaskAwareSynapse> {
    const mesh = await Synapse.connect(url, opts) as any;
    const self = new TaskAwareSynapse(mesh.nc);
    self.id = mesh.id;
    try {
      self.taskStore = await TaskStore.create(mesh.nc);
    } catch (e) {
      console.warn("Task store unavailable (JetStream not enabled):", (e as Error).message);
    }
    return self;
  }

  get tasks(): TaskStore | undefined { return this.taskStore; }

  override async request(agentId: string, skill: string, input: any, timeoutMs?: number) {
    // Auto-create task on outgoing request
    if (this.taskStore) {
      const task = await this.taskStore.create({
        from: this.agentId, to: agentId, skill, payload: { skill, input },
      });

      try {
        // Transition to working before sending
        await this.taskStore.transition(task.task_id, "working", this.agentId, "Request sent");
        const result = await super.request(agentId, skill, input, timeoutMs);
        await this.taskStore.complete(task.task_id, this.agentId, result.payload?.output);
        return result;
      } catch (err: any) {
        const retryable = err.retryable ?? false;
        await this.taskStore.fail(task.task_id, this.agentId, err.code ?? 5001, err.message, retryable);
        throw err;
      }
    }
    return super.request(agentId, skill, input, timeoutMs);
  }
}
```

---

## Python Implementation

```python
# tasks.py — JetStream-backed task store
import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Literal

TaskState = Literal[
    "submitted", "working", "input_required", "auth_required",
    "completed", "failed", "canceled",
]

VALID_TRANSITIONS: Dict[TaskState, List[TaskState]] = {
    "submitted":       ["working", "failed", "canceled"],
    "working":         ["completed", "failed", "canceled", "input_required", "auth_required"],
    "input_required":  ["working", "failed", "canceled"],
    "auth_required":   ["working", "failed", "canceled"],
    "completed":       [],
    "failed":          [],
    "canceled":        [],
}

TERMINAL = {"completed", "failed", "canceled"}


def _is_terminal(state: TaskState) -> bool:
    return state in TERMINAL


def _is_valid_transition(from_state: TaskState, to_state: TaskState) -> bool:
    return to_state in VALID_TRANSITIONS.get(from_state, [])


class TaskStore:
    def __init__(self, kv):
        self.kv = kv
        self.nc = None

    @classmethod
    async def create(cls, nc) -> "TaskStore":
        js = nc.jetstream()
        try:
            kv = await js.create_key_value(bucket="TASK_STORE", history=16, ttl=3600)
        except Exception:
            kv = await js.key_value(bucket="TASK_STORE")
        store = cls(kv)
        store.nc = nc
        return store

    async def create_task(
        self, *,
        from_agent: str, to_agent: str, skill: str,
        payload: Any = None,
        context_id: str | None = None,
        stream: bool = False,
        task_id: str | None = None,
    ) -> Dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        task = {
            "task_id": task_id or str(uuid.uuid4()),
            "context_id": context_id,
            "from": from_agent,
            "to": to_agent,
            "skill": skill,
            "state": "submitted",
            "created_at": now,
            "updated_at": now,
            "history": [{"state": "submitted", "at": now, "by": from_agent, "detail": "Task created"}],
            "payload": payload,
            "result": None,
            "error": None,
            "stream": stream,
        }
        await self._save(task)
        await self._publish_update(task, "Task created")
        return task

    async def get(self, task_id: str) -> Optional[Dict[str, Any]]:
        try:
            entry = await self.kv.get(task_id)
            return json.loads(entry.value.decode())
        except Exception:
            return None

    async def transition(
        self, task_id: str, new_state: TaskState, agent_id: str,
        detail: str | None = None,
        result: Any = None,
        error: Dict[str, Any] | None = None,
    ) -> Dict[str, Any]:
        task = await self.get(task_id)
        if not task:
            raise ValueError(f"Task {task_id} not found")
        if _is_terminal(task["state"]):
            raise ValueError(f"Task {task_id} already terminal: {task['state']}")
        if not _is_valid_transition(task["state"], new_state):
            valid = VALID_TRANSITIONS[task["state"]]
            raise ValueError(f"Invalid transition: {task['state']} → {new_state}. Valid: {valid}")

        now = datetime.now(timezone.utc).isoformat()
        task["state"] = new_state
        task["updated_at"] = now
        task["history"].append({"state": new_state, "at": now, "by": agent_id, "detail": detail})
        if result is not None:
            task["result"] = result
        if error is not None:
            task["error"] = error

        await self._save(task)
        await self._publish_update(task, detail)
        return task

    async def complete(self, task_id: str, agent_id: str, result: Any, detail: str = "Done") -> Dict[str, Any]:
        return await self.transition(task_id, "completed", agent_id, detail, result=result)

    async def fail(self, task_id: str, agent_id: str, code: int, message: str, retryable: bool = False, detail: str = "Failed") -> Dict[str, Any]:
        return await self.transition(task_id, "failed", agent_id, detail, error={"code": code, "message": message, "retryable": retryable})

    async def request_input(self, task_id: str, agent_id: str, question: str, detail: str = "Need more info") -> Dict[str, Any]:
        return await self.transition(task_id, "input_required", agent_id, detail, result={"question": question})

    async def cancel(self, task_id: str, agent_id: str, detail: str = "Canceled") -> Dict[str, Any]:
        return await self.transition(task_id, "canceled", agent_id, detail)

    async def list_tasks(self, *, from_agent: str | None = None, to_agent: str | None = None,
                          state: TaskState | None = None, context_id: str | None = None,
                          skill: str | None = None) -> List[Dict[str, Any]]:
        keys = await self.kv.keys()
        tasks = []
        for key in keys:
            try:
                entry = await self.kv.get(key)
                task = json.loads(entry.value.decode())
                if from_agent and task.get("from") != from_agent:
                    continue
                if to_agent and task.get("to") != to_agent:
                    continue
                if state and task.get("state") != state:
                    continue
                if context_id and task.get("context_id") != context_id:
                    continue
                if skill and task.get("skill") != skill:
                    continue
                tasks.append(task)
            except Exception:
                continue
        return tasks

    async def get_conversation(self, context_id: str) -> List[Dict[str, Any]]:
        return await self.list_tasks(context_id=context_id)

    async def stats(self) -> Dict[str, int]:
        keys = await self.kv.keys()
        counts = {s: 0 for s in VALID_TRANSITIONS}
        for key in keys:
            try:
                entry = await self.kv.get(key)
                task = json.loads(entry.value.decode())
                s = task.get("state", "submitted")
                if s in counts:
                    counts[s] += 1
            except Exception:
                pass
        return counts

    async def _save(self, task: Dict[str, Any]) -> None:
        await self.kv.put(task["task_id"], json.dumps(task).encode())

    async def _publish_update(self, task: Dict[str, Any], detail: str | None = None) -> None:
        if not self.nc:
            return
        prev = task["history"][-2]["state"] if len(task["history"]) > 1 else None
        payload = {
            "task_id": task["task_id"],
            "state": task["state"],
            "previous_state": prev,
            "detail": detail,
        }
        await self.nc.publish(
            f"mesh.task.{task['task_id']}.update",
            json.dumps({
                "v": "1.0.0", "id": str(uuid.uuid4()), "type": "task_update",
                "ts": task["updated_at"], "from": task["to"],
                "task_id": task["task_id"], "payload": payload,
            }).encode(),
        )
```

---

## Go Implementation

```go
// tasks/store.go
package tasks

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

type TaskState string

const (
	StateSubmitted    TaskState = "submitted"
	StateWorking      TaskState = "working"
	StateInputReq     TaskState = "input_required"
	StateAuthReq      TaskState = "auth_required"
	StateCompleted    TaskState = "completed"
	StateFailed       TaskState = "failed"
	StateCanceled     TaskState = "canceled"
)

var validTransitions = map[TaskState][]TaskState{
	StateSubmitted: {StateWorking, StateFailed, StateCanceled},
	StateWorking:   {StateCompleted, StateFailed, StateCanceled, StateInputReq, StateAuthReq},
	StateInputReq:  {StateWorking, StateFailed, StateCanceled},
	StateAuthReq:   {StateWorking, StateFailed, StateCanceled},
	StateCompleted: {},
	StateFailed:    {},
	StateCanceled:  {},
}

var terminalStates = map[TaskState]bool{
	StateCompleted: true, StateFailed: true, StateCanceled: true,
}

type HistoryEntry struct {
	State  TaskState `json:"state"`
	At     string    `json:"at"`
	By     string    `json:"by"`
	Detail string    `json:"detail,omitempty"`
}

type ErrorInfo struct {
	Code      int    `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type Task struct {
	TaskID    string          `json:"task_id"`
	ContextID string          `json:"context_id,omitempty"`
	From      string          `json:"from"`
	To        string          `json:"to"`
	Skill     string          `json:"skill"`
	State     TaskState       `json:"state"`
	CreatedAt string          `json:"created_at"`
	UpdatedAt string          `json:"updated_at"`
	History   []HistoryEntry  `json:"history"`
	Payload   interface{}     `json:"payload,omitempty"`
	Result    interface{}     `json:"result,omitempty"`
	Error     *ErrorInfo      `json:"error,omitempty"`
	Stream    bool            `json:"stream"`
}

type TaskStore struct {
	kv nats.KeyValue
	nc *nats.Conn
	mu sync.Mutex
}

func NewTaskStore(nc *nats.Conn) (*TaskStore, error) {
	js, err := nc.JetStream()
	if err != nil {
		return nil, fmt.Errorf("jetstream: %w", err)
	}
	kv, err := js.CreateKeyValue(&nats.KeyValueConfig{
		Bucket:  "TASK_STORE",
		History: 16,
		TTL:     3600 * time.Second,
	})
	if err != nil {
		kv, err = js.KeyValue("TASK_STORE")
		if err != nil {
			return nil, fmt.Errorf("kv bucket: %w", err)
		}
	}
	return &TaskStore{kv: kv, nc: nc}, nil
}

func (s *TaskStore) Create(from, to, skill string, payload interface{}, opts ...string) (*Task, error) {
	ctxID := ""
	if len(opts) > 0 {
		ctxID = opts[0]
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	task := &Task{
		TaskID:    uuid.New().String(),
		ContextID: ctxID,
		From:      from, To: to, Skill: skill,
		State: StateSubmitted, CreatedAt: now, UpdatedAt: now,
		History: []HistoryEntry{{State: StateSubmitted, At: now, By: from, Detail: "Task created"}},
		Payload: payload, Stream: len(opts) > 1 && opts[1] == "stream",
	}
	if err := s.save(task); err != nil {
		return nil, err
	}
	s.publishUpdate(task, "Task created")
	return task, nil
}

func (s *TaskStore) Get(taskID string) (*Task, error) {
	entry, err := s.kv.Get(taskID)
	if err != nil {
		return nil, err
	}
	var task Task
	json.Unmarshal(entry.Value(), &task)
	return &task, nil
}

func (s *TaskStore) Transition(taskID string, newState TaskState, agentID, detail string) (*Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	task, err := s.Get(taskID)
	if err != nil {
		return nil, err
	}
	if terminalStates[task.State] {
		return nil, fmt.Errorf("task %s already terminal: %s", taskID, task.State)
	}
	if !isValidTransition(task.State, newState) {
		return nil, fmt.Errorf("invalid transition: %s → %s, valid: %v", task.State, newState, validTransitions[task.State])
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	task.State = newState
	task.UpdatedAt = now
	task.History = append(task.History, HistoryEntry{State: newState, At: now, By: agentID, Detail: detail})

	if err := s.save(task); err != nil {
		return nil, err
	}
	s.publishUpdate(task, detail)
	return task, nil
}

func (s *TaskStore) Complete(taskID, agentID string, result interface{}) (*Task, error) {
	task, err := s.Transition(taskID, StateCompleted, agentID, "Completed")
	if err != nil {
		return nil, err
	}
	task.Result = result
	s.save(task)
	return task, nil
}

func (s *TaskStore) Fail(taskID, agentID string, code int, message string, retryable bool) (*Task, error) {
	task, err := s.Transition(taskID, StateFailed, agentID, "Failed")
	if err != nil {
		return nil, err
	}
	task.Error = &ErrorInfo{Code: code, Message: message, Retryable: retryable}
	s.save(task)
	return task, nil
}

func (s *TaskStore) Stats() (map[TaskState]int, error) {
	keys, err := s.kv.Keys()
	if err != nil {
		return nil, err
	}
	counts := map[TaskState]int{}
	for _, state := range []TaskState{StateSubmitted, StateWorking, StateInputReq, StateAuthReq, StateCompleted, StateFailed, StateCanceled} {
		counts[state] = 0
	}
	for _, key := range keys {
		entry, err := s.kv.Get(key)
		if err != nil {
			continue
		}
		var task Task
		json.Unmarshal(entry.Value(), &task)
		counts[task.State]++
	}
	return counts, nil
}

func isValidTransition(from, to TaskState) bool {
	valid := validTransitions[from]
	for _, v := range valid {
		if v == to {
			return true
		}
	}
	return false
}

func (s *TaskStore) save(task *Task) error {
	data, err := json.Marshal(task)
	if err != nil {
		return err
	}
	_, err = s.kv.Put(task.TaskID, data)
	return err
}

func (s *TaskStore) publishUpdate(task *Task, detail string) {
	var prev string
	if len(task.History) > 1 {
		prev = string(task.History[len(task.History)-2].State)
	}
	payload := map[string]interface{}{
		"task_id": task.TaskID, "state": task.State,
		"previous_state": prev, "detail": detail,
	}
	data, _ := json.Marshal(map[string]interface{}{
		"v": "1.0.0", "id": uuid.New().String(), "type": "task_update",
		"ts": task.UpdatedAt, "from": task.To, "task_id": task.TaskID, "payload": payload,
	})
	s.nc.Publish(fmt.Sprintf("mesh.task.%s.update", task.TaskID), data)
}
```

---

## CLI Usage

```bash
# Create KV bucket
nats kv add TASK_STORE --history=16 --ttl=3600s

# Create a task manually
nats kv put TASK_STORE task-001 '{
  "task_id": "task-001", "from": "agent-a", "to": "agent-b",
  "skill": "analyze", "state": "submitted",
  "created_at": "2026-01-15T12:34:56.789Z",
  "updated_at": "2026-01-15T12:34:56.789Z",
  "history": []
}'

# Get task state
nats kv get TASK_STORE task-001

# Watch all task state changes in real-time
nats sub 'mesh.task.*.update'

# List all tasks
nats kv status TASK_STORE
```

---

## Multi-Turn Conversation

Use `context_id` to link related tasks in a conversation:

```typescript
// Start a conversation
const ctxId = uuid();

// First turn
const task1 = await store.create({
  from: agentA.id, to: agentB.id, skill: "research",
  context_id: ctxId,
  payload: { topic: "quantum computing" },
});

// Agent B asks for clarification
await store.requestInput(task1.task_id, agentB.id, "What aspect interests you most?");

// Agent A provides more info → new task in same conversation
const task2 = await store.create({
  from: agentA.id, to: agentB.id, skill: "research",
  context_id: ctxId,
  payload: { topic: "quantum computing", focus: "error correction" },
});

// Query the entire conversation
const conversation = await store.getConversation(ctxId);
// → [task1 (state: input_required), task2 (state: completed)]
```

---

## Dashboard Integration

Subscribe to `mesh.task.*.update` for real-time dashboards:

```typescript
// Live task dashboard
mesh.subscribe(">*.update", (event) => {
  const { task_id, state, previous_state } = event.payload;
  console.log(`[Dashboard] Task ${task_id}: ${previous_state} → ${state}`);

  // Update Grafana annotation, log to file, send alert
});
```

---

## Next Steps

- [State Machine Reference](./states.md) — Full transition diagram and rules
- [Envelope Reference](./envelope.md) — `task_id`, `in_reply_to`, `context_id` fields
- [Setup Guide](./setup.md) — JetStream configuration
