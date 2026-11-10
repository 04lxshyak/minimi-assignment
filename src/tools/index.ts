/**
 * Tool definitions for the OpenAI function-calling API.
 *
 * Architecture note: Tools are defined as OpenAI-compatible JSON schemas
 * (not Zod, not LangChain). This keeps the tool-calling protocol transparent
 * and the dependency count low.
 *
 * Each tool has:
 * - A JSON Schema definition (sent to OpenAI)
 * - An execute function (called locally when the model requests the tool)
 *
 * The tool descriptions are part of the architecture — they teach the model
 * WHEN and HOW to use each tool.
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { webSearch } from './web-search.js';
import { MemoryStore } from '../memory/store.js';

// ── Tool Definitions (OpenAI JSON Schema format) ─────────────────────

export const toolDefinitions: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for current, real-time information. Use for: recent news, ' +
        'current pricing, product updates, release announcements, status checks, ' +
        'or any question where the answer might have changed recently. ' +
        'For multiple items to check, call this tool once per item with a specific query.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'The search query. Be specific — include the product/company name, ' +
              'what you\'re looking for (pricing, release, news), and a time frame if relevant.',
          },
          search_depth: {
            type: 'string',
            enum: ['basic', 'advanced'],
            description:
              'Search thoroughness. Use "basic" (default) for simple lookups. ' +
              'Use "advanced" for complex queries needing deeper results (e.g., comparing prices, finding obscure info).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description:
        'Search your conversation memory for past interactions with the user. ' +
        'Use when the user references a previous conversation, a specific date, ' +
        'or asks "what did I ask you" / "what did we discuss" / "last time". ' +
        'Can search by text content, date range, or both. ' +
        'Returns messages with timestamps so you can tell the user exactly when things were discussed.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Text to search for in past conversations. Use keywords related to the topic. ' +
              'Optional if searching by date only.',
          },
          date_from: {
            type: 'string',
            description:
              'Start date filter in YYYY-MM-DD format. ' +
              'Resolve relative dates (e.g., "last Tuesday") to absolute dates before passing.',
          },
          date_to: {
            type: 'string',
            description:
              'End date filter in YYYY-MM-DD format. ' +
              'Defaults to the same as date_from if only searching a specific day.',
          },
        },
        additionalProperties: false,
      },
    },
  },
];

// ── Tool Execution ───────────────────────────────────────────────────

export type ToolResult = {
  tool: string;
  result: string;
  error?: string;
};

/**
 * Execute a tool call by name and return formatted results.
 * 
 * Returns a string (not JSON) because that's what the model processes best —
 * structured but readable text, not raw data dumps.
 */
export async function executeTool(
  name: string,
  args: Record<string, any>,
  memory: MemoryStore
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'web_search': {
        const { query, search_depth = 'basic' } = args;
        const response = await webSearch(query, search_depth);

        // Format results as readable text for the model
        let formatted = `Web search results for: "${query}"\n`;
        if (response.answer) {
          formatted += `\nQuick answer: ${response.answer}\n`;
        }
        formatted += `\n${response.results.length} results found:\n`;
        for (const r of response.results) {
          formatted += `\n---\nTitle: ${r.title}\nURL: ${r.url}\nRelevance: ${(r.score * 100).toFixed(0)}%\nContent: ${r.content}\n`;
        }

        return { tool: name, result: formatted };
      }

      case 'recall_memory': {
        const { query, date_from, date_to } = args;
        const results = memory.search({
          query: query || undefined,
          dateFrom: date_from || undefined,
          dateTo: date_to || undefined,
          limit: 25,
        });

        if (results.length === 0) {
          const filters = [];
          if (query) filters.push(`text "${query}"`);
          if (date_from) filters.push(`from ${date_from}`);
          if (date_to) filters.push(`to ${date_to}`);
          return {
            tool: name,
            result: `No past conversations found matching: ${filters.join(', ') || 'the search criteria'}.`,
          };
        }

        let formatted = `Found ${results.length} messages from past conversations:\n`;
        for (const msg of results) {
          const date = new Date(msg.created_at).toLocaleString('en-US', {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          const role = msg.role === 'user' ? 'User' : 'You (assistant)';
          // Truncate very long messages for context efficiency
          const content = msg.content.length > 500
            ? msg.content.slice(0, 500) + '... [truncated]'
            : msg.content;
          formatted += `\n[${date}] ${role}: ${content}\n`;
        }

        return { tool: name, result: formatted };
      }

      default:
        return { tool: name, result: '', error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { tool: name, result: '', error: `Tool "${name}" failed: ${errorMessage}` };
  }
}
