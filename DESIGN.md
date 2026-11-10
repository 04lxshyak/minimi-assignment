# DESIGN.md

## How it works

A single-agent loop with two tools: **web search** and **persistent memory**.

```
User message
     │
     ▼
┌─────────┐   tool calls (parallel)   ┌──────────────┐
│  GPT-4o │ ─────────────────────────► │ Tool Executor│
│         │ ◄───────────────────────── │              │
└─────────┘        results             └──────┬───────┘
     │                                   │         │
     │ (loop until no more tools)        │         │
     ▼                                   ▼         ▼
 Streamed response               recall_memory  web_search
                                  (SQLite+FTS5)  (Tavily)
```

Every user and assistant message is persisted to SQLite. Every session shares one database. The agent can recall any past conversation through the `recall_memory` tool — by text (full-text search) or date range or both.

The agent loop is a standard **ReAct** pattern: the LLM decides which tools to call, we execute them, feed results back, and repeat until the LLM generates a final text response. Streaming is on throughout — text chunks go to the terminal as they arrive.

When the model requests multiple tool calls in one step (e.g., 5 separate web searches for 5 CRM tools), they all execute in **parallel** via `Promise.all`. This is a significant latency win for multi-item queries.

## Why I built it this way

### OpenAI SDK directly, no framework

I used the OpenAI SDK directly instead of LangChain, Vercel AI SDK, or similar. Reason: the agent loop is ~80 lines of code. A framework would hide those lines behind abstractions without adding value for a single-tool agent. The loop is now fully transparent — you can read exactly what happens at each step, which matters for debugging, auditing, and extending.

### SQLite + FTS5 for memory, not a vector database

The test examples reference past conversations by topic and date. Full-text search (FTS5's BM25 ranking) handles topic search well. Date filtering handles temporal queries. Together they cover every example in the prompt.

A vector database (Pinecone, Chroma, pgvector) would add:
- An embedding model call per message (~100ms latency per write)
- An external service dependency or container
- Semantic similarity search (better for "vibe" matching)

For conversation recall, FTS5 is better because:
- Exact keyword matching is what you want ("CRM tools" should find messages containing "CRM")
- No embedding drift or hallucination
- Zero latency on writes (synchronous SQLite)
- Zero infrastructure (single file, embedded)
- BM25 ranking is well-understood and predictable

I'd add vector search later as a **complement** (not replacement) if FTS5 recall precision proved insufficient.

### Tavily for web search, not SerpAPI or raw Google

Tavily is purpose-built for AI agents:
- Returns clean extracted text, not HTML or snippet fragments
- Provides relevance scores (0-1) per result
- Has a `search_depth: "advanced"` mode for thorough queries
- Includes an optional AI-generated answer summary
- Simple API (one POST endpoint, API key in body)

SerpAPI returns raw Google results that need parsing. Brave Search is good but Tavily's extraction quality is better for agent consumption.

### Streaming + parallel tools = perceived speed

The response streams token-by-token to the terminal. Tool calls execute in parallel. For a query like "check pricing for 5 tools," the user sees:
1. Tool indicators appear (~100ms)
2. All 5 searches run simultaneously (~1-2s total, not 5-10s serial)
3. Final answer streams in

This makes the agent feel fast even when doing significant work.

### System prompt as architecture

The system prompt includes:
- Today's date and time (for resolving "last Tuesday")
- A decision table for when to use which tool
- Instructions to search per-item for multi-item queries
- Citation format guidelines
- Honesty instructions (admit when memory is empty)

This is not decoration — it's the behavioral architecture. The same code with a different prompt would be a different (worse) agent.

### Context window management

The last 40 messages stay in the LLM's context window. Older messages drop out but remain in SQLite. If the user asks about an old conversation, the agent uses `recall_memory` — the same tool that handles cross-session recall. This is architecturally clean: one mechanism handles both "what did we just talk about?" and "what did I ask you on November 3rd?"

## What I considered and rejected

| Alternative | Why I rejected it |
|---|---|
| **Multi-agent system** (planner + searcher + summarizer) | Adds latency (multiple LLM calls in series). A single GPT-4o call with good tools is faster and accurate enough. Multi-agent shines for complex workflows, not single-tool chat. |
| **RAG over search results** (embed + retrieve + generate) | Over-engineered for this use case. The LLM already receives full search results in context. RAG would add embedding latency without improving quality. |
| **Conversation summarization** for context management | Lossy. Summarizing old messages risks losing details the user might ask about later. Keeping raw messages in SQLite and retrieving on-demand preserves everything. |
| **LangChain / CrewAI** | Too much abstraction for what's fundamentally a simple loop. The code is clearer without it. Framework lock-in makes the architecture harder to evaluate. |
| **Web UI** (Next.js, React) | The brief says "Not the prettiest screen." A terminal interface lets the architecture speak. A web UI would add 10x code for 0x architectural insight. |
| **Brave Search / SerpAPI** | Tavily's extracted text is cleaner for LLM consumption. Less parsing, better results. |
| **Topic extraction on write** (extract entities per message, store as metadata) | Adds an LLM call per message (~100ms). FTS5 already handles keyword matching. Would only help if FTS5 recall proved insufficient. |

## What I'd do with another week

1. **Semantic memory layer**: Add embeddings (OpenAI `text-embedding-3-small`) alongside FTS5. Use a hybrid retrieval strategy: FTS5 for keyword matches, cosine similarity for semantic matches, merge and re-rank. This handles cases where the user's query uses different words than the original conversation.

2. **Fact verification loop**: After generating the answer, run a second pass that checks each factual claim against the search results. Flag anything unsupported. This catches hallucinations before they reach the user.

3. **Query decomposition**: For complex queries like "Compare the pricing of Salesforce, HubSpot, and Pipedrive, and tell me which is cheapest for a 20-person team," decompose into sub-queries, search each, then synthesize. The current agent sometimes does this via multi-tool calls, but explicit decomposition would be more reliable.

4. **Search result caching with TTL**: Cache Tavily results with a configurable time-to-live. Same query within 5 minutes → serve from cache. Saves API costs and reduces latency for conversational follow-ups.

5. **Conversation-level summaries**: After each session ends, generate and store a brief summary. These summaries would be returned alongside full-text search results, giving the agent faster context about past sessions without loading full message histories.

6. **Evaluation harness**: Build a test suite that runs scripted multi-turn conversations and grades the agent on: (a) correct tool selection, (b) factual accuracy, (c) source citation, (d) memory recall precision. This enables iterating on the system prompt and tool descriptions with confidence.

7. **Graceful degradation**: If Tavily is down, fall back to a secondary search API (Brave). If OpenAI is rate-limited, retry with exponential backoff. If SQLite is corrupted, start with a fresh database and notify the user.
