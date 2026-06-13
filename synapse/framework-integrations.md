# Framework Integration Guide

Adapters for connecting Synapse agents to popular agent orchestration frameworks: LangChain, CrewAI, AutoGen, LlamaIndex, Semantic Kernel, and a generic adapter contract for building custom integrations.

---

## Why Adapters?

Every framework has its own agent model — LangChain uses `Tool` objects, CrewAI uses `Agent` classes, AutoGen uses `ConversableAgent`. Synapse agents are framework-agnostic by design: they expose skills via NATS request/reply.

Adapters bridge these worlds, letting you mix-and-match:
- A LangChain agent (running in a Python REPL) discovers and calls a Synapse agent (running in a Go service)
- A CrewAI orchestration (running locally) uses Synapse as the transport between workers
- An AutoGen group chat (running across multiple hosts) routes through Synapse for persistence

---

## Generic Adapter Contract

All adapters follow the same pattern:

### 1. Define Skills as Framework-Native Objects

Map your framework's concept of "skills" or "tools" to Synapse's skill model:

```
Framework Skill → Synapse Skill
├── Name        → skill.id
├── Description → skill.description
├── Input       → payload.input
└── Output      → payload.output
```

### 2. Discovery → Framework Registration

When a Synapse agent registers with capabilities `["code-review"]`, your adapter should register it in the framework so it's callable:

```python
# Generic discovery-to-registration flow
agents = await mesh.discover(capabilities=["code-review"])
for agent in agents:
    for skill in agent.skills:
        framework.register_tool(
            name=skill.id,
            description=skill.description,
            handler=make_synapse_caller(agent.id, skill.id),
        )
```

### 3. Requests → Framework-Native Calls

When the framework invokes a tool, the adapter translates to a Synapse request:

```python
async def make_synapse_caller(agent_id, skill_id):
    async def call(kwargs):
        result = await mesh.request(agent_id, skill_id, kwargs)
        return result.payload.output
    return call
```

---

## LangChain Adapter

### Setup

```bash
pip install langchain langchain-core synapse-nats-sdk  # synapse-nats-sdk is placeholder
# In practice, use the synapse.py file from examples/python/
```

### Adapter Implementation

```python
from typing import Any, Dict, List
from langchain.tools import StructuredTool
from langchain.agents import AgentExecutor, create_openai_tools_agent
from synapse import connect, Synapse


class SynapseLangChainAdapter:
    """
    Wraps Synapse agents as LangChain Tool objects.
    Discovered Synapse skills become callable LangChain tools.
    """

    def __init__(self, mesh: Synapse):
        self.mesh = mesh
        self.tools: List[StructuredTool] = []

    async def discover_tools(self, capabilities: List[str] = None) -> List[StructuredTool]:
        """
        Discover all Synapse agents and register their skills as LangChain tools.
        """
        agents = await self.mesh.discover(capabilities=capabilities)
        
        for agent in agents:
            for skill in agent.skills:
                tool = StructuredTool.from_function(
                    coroutine=self._make_tool_fn(agent.id, skill.id),
                    name=f"{agent.name}_{skill.id}",
                    description=skill.description,
                )
                self.tools.append(tool)
        
        return self.tools

    def _make_tool_fn(self, agent_id: str, skill_id: str):
        async def call(input: Dict[str, Any]) -> Any:
            result = await self.mesh.request(agent_id, skill_id, input)
            return result.payload.get("output", {})
        return call


# Usage
async def main():
    mesh = await connect("nats://localhost:4222")
    adapter = SynapseLangChainAdapter(mesh)
    
    # Discover and register all Synapse skills as LangChain tools
    tools = await adapter.discover_tools(capabilities=["code-review", "translate"])
    
    # Now use in a LangChain agent
    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", "Use the available tools to help the user."),
        ("human", "{input}"),
    ])
    
    llm = ChatOpenAI(model="gpt-4o-mini")
    agent = create_openai_tools_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools, verbose=True)
    
    result = await executor.ainvoke({"input": "Review the code in my PR"})
    print(result)
```

---

## CrewAI Adapter

### Setup

```bash
pip install crewai synapse-nats-sdk
```

### Adapter Implementation

```python
from crewai import Agent, Task, Crew
from synapse import connect, Synapse


class SynapseCrewAdapter:
    """
    Converts Synapse agent capabilities into CrewAI Agent definitions.
    A Synapse agent's skills become the Agent's tools.
    """

    def __init__(self, mesh: Synapse):
        self.mesh = mesh
        self.crew_agents = []

    async def make_crew_agent(self, synapse_skill_ids: List[str]) -> Agent:
        """
        For a specific set of skills, create a CrewAI Agent
        that delegates to the Synapse mesh.
        """
        # Discover which Synapse agent has these skills
        agents = await self.mesh.discover(capabilities=synapse_skill_ids)
        if not agents:
            raise ValueError(f"No Synapse agent found with skills: {synapse_skill_ids}")
        
        synapse_agent = agents[0]
        
        # Build CrewAI tools from Synapse skills
        tools = []
        for skill in synapse_agent.skills:
            if skill.id in synapse_skill_ids:
                tools.append(self._make_tool(synapse_agent.id, skill))
        
        return Agent(
            role=synapse_agent.name,
            goal=f"Use {', '.join(synapse_skill_ids)} skills effectively",
            backstory=synapse_agent.description or f"Agent with skills: {', '.join(synapse_skill_ids)}",
            tools=tools,
            verbose=True,
        )

    def _make_tool(self, agent_id: str, skill):
        from crewai.tools import Tool

        def call(input: str) -> str:
            # Synchronous wrapper for CrewAI compatibility
            import asyncio
            loop = asyncio.get_event_loop()
            result = loop.run_until_complete(
                self.mesh.request(agent_id, skill.id, {"input": input})
            )
            return str(result.payload.get("output", {}))

        return Tool(
            name=skill.name,
            description=skill.description,
            func=call,
        )


# Usage
async def main():
    mesh = await connect("nats://localhost:4222")
    adapter = SynapseCrewAdapter(mesh)
    
    # Create CrewAI agents from Synapse mesh
    researcher = await adapter.make_crew_agent(["research"])
    writer = await adapter.make_crew_agent(["summarize"])
    
    task = Task(
        description="Research quantum computing and summarize findings",
        expected_output="A comprehensive summary",
    )
    
    crew = Crew(agents=[researcher, writer], tasks=[task], verbose=True)
    result = crew.kickoff()
    print(result)
```

---

## AutoGen Adapter

### Setup

```bash
pip install autogen-agentchat synapse-nats-sdk
```

### Adapter Implementation

```python
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.messages import TextMessage
from synapse import connect, Synapse


class SynapseAutoGenAdapter:
    """
    Creates AutoGen AssistantAgent wrappers around Synapse agents.
    AutoGen group chats can call Synapse agents as if they were local.
    """

    def __init__(self, mesh: Synapse):
        self.mesh = mesh

    async def make_autogen_agent(self, agent_name: str) -> AssistantAgent:
        """
        Wrap a specific Synapse agent as an AutoGen AssistantAgent.
        """
        agents = await self.mesh.discover()
        synapse_agent = next((a for a in agents if a.id == agent_name), None)
        
        if not synapse_agent:
            raise ValueError(f"Agent {agent_name} not found in Synapse mesh")

        # Create a custom model client that routes to Synapse
        adapter = self

        class SynapseModelClient:
            async def create(self, messages, **kwargs):
                # Extract the latest user message
                last_msg = messages[-1] if messages else TextMessage(content="", source="user")
                
                # Route to Synapse agent's first skill
                skill_id = synapse_agent.skills[0].id if synapse_agent.skills else "chat"
                result = await adapter.mesh.request(
                    agent_name, skill_id,
                    {"message": last_msg.content}
                )
                
                response_text = result.payload.get("output", {}).get("text", "")
                return lambda: type('obj', (object,), {'content': response_text})()

        return AssistantAgent(
            name=synapse_agent.name.replace(" ", "_"),
            model_client=SynapseModelClient(),
            system_message=synapse_agent.description or f"You are {synapse_agent.name}.",
        )


# Usage: AutoGen group chat with Synapse agents
async def main():
    mesh = await connect("nats://localhost:4222")
    adapter = SynapseAutoGenAdapter(mesh)
    
    # Create a group chat with Synapse agents
    researcher = await adapter.make_autogen_agent("researcher-001")
    writer = await adapter.make_autogen_agent("writer-001")
    
    from autogen_agentchat.teams import RoundRobinGroupChat
    from autogen_agentchat.conditions import TextMentionTermination
    
    text_term = TextMentionTermination("DONE")
    team = RoundRobinGroupChat(
        [researcher, writer],
        termination_condition=text_term,
    )
    
    result = await team.run(task="Research and summarize AI trends")
    print(result)
```

---

## LlamaIndex Adapter

```python
from llama_index.core.tools import FunctionTool
from synapse import connect, Synapse


class SynapseLlamaIndexAdapter:
    """
    Expose Synapse skills as LlamaIndex FunctionTool objects.
    """

    def __init__(self, mesh: Synapse):
        self.mesh = mesh

    async def make_tools(self, capabilities: List[str] = None) -> List[FunctionTool]:
        agents = await self.mesh.discover(capabilities=capabilities)
        tools = []
        
        for agent in agents:
            for skill in agent.skills:
                tool = FunctionTool.from_defaults(
                    fn=self._make_fn(agent.id, skill.id),
                    name=skill.id,
                    description=skill.description,
                )
                tools.append(tool)
        
        return tools

    def _make_fn(self, agent_id: str, skill_id: str):
        import asyncio
        loop = asyncio.get_event_loop()

        def call(input: str) -> str:
            result = loop.run_until_complete(
                self.mesh.request(agent_id, skill_id, {"input": input})
            )
            return str(result.payload.get("output", {}))
        
        return call
```

---

## Semantic Kernel (.NET) Adapter Pattern

```csharp
// Semantic Kernel uses plugins (functions) — map Synapse skills to SK functions
using Microsoft.SemanticKernel;

public class SynapsePlugin
{
    private readonly HttpClient _http; // For HTTP bridge
    
    public SynapsePlugin(string bridgeUrl = "http://localhost:4100")
    {
        _http = new HttpClient { BaseAddress = new Uri(bridgeUrl) };
    }
    
    [KernelFunction, Description("Translate text to another language")]
    public async Task<string> Translate(
        [Description("The text to translate")] string text,
        [Description("Target language")] string target = "Spanish")
    {
        // Route through Synapse HTTP bridge
        var response = await _http.PostAsJsonAsync("/mesh/request", new {
            agentId = "synapse-translate-agent",
            skill = "translate",
            input = new { text, target }
        });
        
        var result = await response.Content.ReadAsStringAsync();
        return result;
    }
    
    [KernelFunction, Description("Review code for issues")]
    public async Task<string> CodeReview(
        [Description("Code to review")] string code)
    {
        var response = await _http.PostAsJsonAsync("/mesh/request", new {
            agentId = "synapse-code-review-agent",
            skill = "code-review",
            input = new { code }
        });
        
        var result = await response.Content.ReadAsStringAsync();
        return result;
    }
}

// Register with Semantic Kernel
var kernel = Kernel.CreateBuilder()
    .AddOpenAIChatCompletion("gpt-4", "sk-...")
    .Build();

var synapse = new SynapsePlugin();
kernel.Plugins.AddFromObject(synapse);

// Use in prompts
var result = await kernel.InvokeAsync(Kernel.CreateFunctionFromPrompt(
    "Translate the following code review request: {{$input}}",
    new PromptExecutionSettings { 
        FunctionChoiceBehavior = FunctionChoiceBehavior.Auto() 
    }
));
```

---

## Generic Adapter Contract (Build Your Own)

### Interface Definition

Every adapter should implement:

```
SynapseFrameworkAdapter
├── discover_tools(capabilities?) → List[FrameworkTool]
├── make_agent(agent_id) → FrameworkAgent
├── handle_request(tool_name, input) → output
└── cleanup() → void
```

### Adapter Checklist

When building a new framework adapter, ensure:

- [ ] **Discovery maps to framework-native registration** — don't reinvent tool discovery
- [ ] **Inputs are framework-native** — accept the framework's input format, convert internally
- [ ] **Outputs are framework-native** — return what the framework expects
- [ ] **Error mapping** — Synapse error codes → framework's error model
- [ ] **Async/sync bridging** — some frameworks are sync-only; provide a sync wrapper
- [ ] **Streaming support** — if framework supports streaming, wire to `streamRequest()`
- [ ] **Circuit breaker integration** — propagate backpressure to framework
- [ ] **Telemetry** — forward OTel spans to framework's tracing system

---

## Next Steps

- [HTTP Bridge](./http-bridge.md) — Run framework agents via HTTP alongside Synapse
- [Python SDK](./python.md) — Full Python SDK reference
- [TypeScript SDK](./typescript.md) — Full TypeScript SDK reference
- [Contributing framework adapters](./contributing.md) — Submit a PR to add yours

## Adapter Repository (Community-Maintained)

| Framework | Adapter | Status | Maintainer |
|-----------|---------|--------|------------|
| LangChain | synapse-langchain | Planned | Community |
| CrewAI | synapse-crewai | Planned | Community |
| AutoGen | synapse-autogen | Planned | Community |
| LlamaIndex | synapse-llamaindex | Planned | Community |
| Semantic Kernel | synapse-sk | Planned | Community |
| DSPy | synapse-dspy | Planned | Community |

**Want to maintain an adapter?** Fork the [synapse-skill repo](https://github.com/drolu/synapse-skill), add your adapter, and open a PR.
