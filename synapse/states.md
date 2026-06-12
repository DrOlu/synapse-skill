# Task State Machine

Every Synapse `request` creates a task with this lifecycle.

## State Diagram

```
                    ┌──────────────┐
                    │  submitted   │ (initial)
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
           ┌───────│   working    │───────┐
           │       └──────┬───────┘       │
           │              │               │
           │              │               │
           ▼              ▼               ▼
  ┌──────────────┐ ┌──────────┐  ┌────────────────┐
  │input_required│ │   auth   │  │  (continues    │
  │              │ │ required │  │   working)     │
  └──────┬───────┘ └────┬─────┘  └────────────────┘
         │              │
         │   respond    │  respond
         │   with more  │  with auth
         │   info       │
         └──────┬───────┘
                │
                └──── return to working
                           │
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │completed │ │  failed  │ │ canceled │
        └──────────┘ └──────────┘ └──────────┘
          (terminal)   (terminal)   (terminal)
```

## State Definitions

| State | Description | Can Transition To |
|-------|-------------|-------------------|
| `submitted` | Task created, waiting to be picked up | `working`, `failed`, `canceled` |
| `working` | Agent is actively processing | `completed`, `failed`, `canceled`, `input_required`, `auth_required` |
| `input_required` | Agent needs more info from requester | `working`, `failed`, `canceled` |
| `auth_required` | Agent needs authorization to proceed | `working`, `failed`, `canceled` |
| `completed` | Task finished successfully | (terminal) |
| `failed` | Task failed with error | (terminal) |
| `canceled` | Task canceled by requester or agent | (terminal) |

## Terminal States

Once a task reaches `completed`, `failed`, or `canceled`, it cannot transition. To retry, create a new task and link via `context_id`.

## Implementation Example

```typescript
class TaskStateMachine {
  private state: string = "submitted";
  private history: string[] = ["submitted"];
  
  validTransitions: Record<string, string[]> = {
    submitted: ["working", "failed", "canceled"],
    working: ["completed", "failed", "canceled", "input_required", "auth_required"],
    input_required: ["working", "failed", "canceled"],
    auth_required: ["working", "failed", "canceled"],
    completed: [],
    failed: [],
    canceled: [],
  };

  transition(newState: string): void {
    const valid = this.validTransitions[this.state] || [];
    if (!valid.includes(newState)) {
      throw new Error(`Invalid transition: ${this.state} → ${newState}`);
    }
    this.state = newState;
    this.history.push(newState);
  }
  
  isTerminal(): boolean {
    return ["completed", "failed", "canceled"].includes(this.state);
  }
}
```

## Publishing State Changes

```typescript
// Update task state (publishes to JetStream for persistence)
async function updateTaskState(mesh: Synapse, taskId: string, state: string, payload?: any) {
  mesh.nc.publish(`mesh.task.${taskId}.update`, jc.encode({
    v: "1.0.0",
    id: uuid(),
    type: "task_update",
    ts: new Date().toISOString(),
    from: mesh.agentId,
    task_id: taskId,
    payload: { state, ...payload },
  }));
}

// Usage
mesh.onRequest("long-running", async (payload, ctx) => {
  await updateTaskState(mesh, ctx.task_id, "working");
  // ... do work ...
  await updateTaskState(mesh, ctx.task_id, "input_required", { question: "Confirm?" });
  // ... wait for response ...
  await updateTaskState(mesh, ctx.task_id, "working");
  // ... finish ...
  return { result: "done" };
});
```
