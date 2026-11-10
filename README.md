# Chat Agent

A conversational AI agent with **web search** and **persistent conversation memory**.

Built with TypeScript, Gemini or OpenAI, Tavily search, and SQLite.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up API keys (both are FREE)
cp .env.example .env
# Edit .env with your keys:
#   GOOGLE_API_KEY=...   (free at https://aistudio.google.com/apikey)
#   TAVILY_API_KEY=...   (free at https://tavily.com)

# 3. Run
npm run dev
```

## API Keys Required

| Key | Get it from | Cost |
|-----|-------------|------|
| `GOOGLE_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | **Free** |
| `TAVILY_API_KEY` | [tavily.com](https://tavily.com) | **Free** (1,000 searches/month) |

> **Optional**: Set `OPENAI_API_KEY` instead of `GOOGLE_API_KEY` to use GPT-4o (paid). If both keys are set, Google is selected by default; set `LLM_PROVIDER=openai` to choose OpenAI.

## What it does

- **Web search**: Searches the web in real time for current information (pricing, news, releases, etc.)
- **Persistent memory**: Retrieves earlier messages internally for follow-ups such as "what did we discuss last Tuesday?" The model has exactly one tool: web search.
- **Streaming**: Responses stream in real time. Tool usage is shown as it happens.
- **Parallel search**: When checking multiple items, searches run simultaneously for speed.

## Architecture

See [DESIGN.md](./DESIGN.md) for a detailed explanation of the architecture, design decisions, alternatives considered, and future roadmap.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_API_KEY` | (required*) | Google Gemini API key (free) |
| `OPENAI_API_KEY` | (optional) | OpenAI API key (paid, used instead of Google if set) |
| `TAVILY_API_KEY` | (required) | Tavily search API key (free) |
| `LLM_PROVIDER` | inferred | `google` or `openai`; resolves which model endpoint to use when both keys are set |
| `MODEL_NAME` | auto | `gemini-2.0-flash` for Google, `gpt-4o` for OpenAI |
| `MAX_CONTEXT_MESSAGES` | `40` | Messages kept in LLM context |
| `MAX_SEARCH_RESULTS` | `6` | Results per web search |
| `MAX_AGENT_STEPS` | `10` | Max tool-calling iterations per turn |
| `DB_PATH` | `./data/memory.db` | SQLite database location |
| `TIME_ZONE` | `Asia/Kolkata` | Calendar timezone used to interpret and display memory dates |

## Project Structure

```
src/
├── index.ts          # CLI interface and main loop
├── agent.ts          # Core agent with streaming tool-call loop
├── config.ts         # Environment configuration
├── prompts.ts        # System prompt (behavioral architecture)
├── memory/
│   └── store.ts      # SQLite + FTS5 persistent memory
└── tools/
    ├── index.ts      # Tool definitions and executor
    └── web-search.ts # Tavily API integration
```
