# Chat Agent

A conversational AI agent with **web search** and **persistent conversation memory**.

Built with TypeScript, OpenAI GPT-4o, Tavily search, and SQLite.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up API keys
cp .env.example .env
# Edit .env with your keys:
#   OPENAI_API_KEY=sk-...
#   TAVILY_API_KEY=tvly-...

# 3. Run
npm run dev
```

## API Keys Required

| Key | Get it from | Free tier |
|-----|-------------|-----------|
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) | No (pay-as-you-go) |
| `TAVILY_API_KEY` | [tavily.com](https://tavily.com) | Yes (1,000 searches/month) |

## What it does

- **Web search**: Searches the web in real time for current information (pricing, news, releases, etc.)
- **Persistent memory**: Remembers every conversation across sessions. Ask "what did we discuss last Tuesday?" and it'll find it.
- **Streaming**: Responses stream in real time. Tool usage is shown as it happens.
- **Parallel search**: When checking multiple items, searches run simultaneously for speed.

## Architecture

See [DESIGN.md](./DESIGN.md) for a detailed explanation of the architecture, design decisions, alternatives considered, and future roadmap.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required) | OpenAI API key |
| `TAVILY_API_KEY` | (required) | Tavily search API key |
| `MODEL_NAME` | `gpt-4o` | OpenAI model |
| `MAX_CONTEXT_MESSAGES` | `40` | Messages kept in LLM context |
| `MAX_SEARCH_RESULTS` | `6` | Results per web search |
| `MAX_AGENT_STEPS` | `10` | Max tool-calling iterations per turn |
| `DB_PATH` | `./data/memory.db` | SQLite database location |

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
