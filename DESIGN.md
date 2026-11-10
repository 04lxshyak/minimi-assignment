# Design

## How it works

This is a single-agent chat loop with exactly one model-visible tool: `web_search`. Each turn stores the user message in SQLite, builds a prompt with the recent chat and (when the user refers to an earlier conversation) internally retrieved historical messages, then calls the model. Search calls run concurrently when the model requests several; their results, including source URLs, are returned to the model for a cited answer. The final response is stored for later recall.

Conversation recall is an application concern, not a second agent tool. A small reference detector recognizes phrases such as “last time,” weekdays, and explicit dates. It retrieves matching messages from SQLite FTS5 or filters by calendar date, then adds those records as clearly labeled, untrusted historical context. FTS tries all terms first and broadens to OR when that finds nothing. Dates are interpreted and displayed in `TIME_ZONE` (default `Asia/Kolkata`), while timestamps remain stored in UTC. Recent context selects the newest rows and restores chronological order.

The loop uses the OpenAI SDK directly with an OpenAI-compatible endpoint. The provider is selected by `LLM_PROVIDER`, or inferred from available keys (Google wins if both exist). A bounded tool loop prevents runaway calls and returns an explicit limit message. Tavily supplies extracted search results; SQLite/FTS5 keeps memory local and requires no extra service.

## Why this design

- **Direct SDK, no agent framework:** the control flow is short and auditable. A framework would add abstractions without solving a multi-agent or workflow problem here.
- **One search tool:** search is the only action the model can request, matching the assignment. Memory recall is automatic, so date and “what did I ask” follow-ups do not depend on the model deciding to call an extra tool.
- **SQLite FTS5:** it is durable, local, low-latency, and supports both text and date lookups. For this assignment, avoiding embedding calls and a hosted vector store keeps setup and cost low. Semantic retrieval could complement FTS if evaluations show misses.
- **Parallel tool calls and streaming:** independent searches run together, then the final answer streams as it is generated.
- **Provider compatibility:** one loop supports Gemini and OpenAI. An explicit provider override removes ambiguity when both keys are present.

## Considered and rejected

| Option | Reason |
|---|---|
| Expose memory as a second model tool | Violates the one-tool requirement and makes recall reliability depend on tool selection. |
| LangChain or a multi-agent planner | Adds latency and indirection for a short, single-agent loop. |
| Vector database for memory | Adds infrastructure and embedding latency before there is evidence FTS misses matter. |
| Search caching or fallback provider | Useful for production cost and availability, but less important than getting memory and evidence handling right in this small submission. |

## With another week

I would build a multi-turn evaluation set around dated recall, topic recall, stale pricing, multi-product comparisons, and “nothing changed” cases. I would measure retrieval precision/recall and citation support, then tune the internal memory query and search strategy from failures. Next I would add a hybrid semantic memory index only if those measurements justify it, plus bounded retries and a TTL cache for transient search failures and repeated queries.
