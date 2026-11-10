/**
 * Core agent loop with streaming.
 *
 * Architecture:
 * ┌──────────────────────────────────────────────────────────┐
 * │                      Agent Loop                          │
 * │                                                          │
 * │  User message                                            │
 * │       │                                                  │
 * │       ▼                                                  │
 * │  ┌─────────┐   tool calls   ┌──────────────┐            │
 * │  │   LLM   │ ─────────────► │ Tool Executor│            │
 * │  │ (GPT-4o)│ ◄───────────── │  (parallel)  │            │
 * │  └─────────┘   results      └──────────────┘            │
 * │       │                          │    │                  │
 * │       │ (loop until stop)        │    │                  │
 * │       ▼                          ▼    ▼                  │
 * │  Streamed text response     Memory  Web Search           │
 * │                            (SQLite) (Tavily)             │
 * └──────────────────────────────────────────────────────────┘
 *
 * Key design decisions:
 * 1. We use the OpenAI SDK directly (no LangChain/Vercel AI SDK) to keep
 *    the agent loop transparent and debuggable.
 * 2. Tool calls execute in parallel (Promise.all) for speed — when the
 *    model issues 5 web searches, they all run simultaneously.
 * 3. Streaming: we stream the final text response for perceived speed,
 *    but buffer tool-call responses (they're fast and need processing).
 * 4. The agent loop has a configurable step limit to prevent infinite loops.
 * 5. The conversation context window is managed by keeping the last N
 *    messages. For older messages, the agent uses recall_memory.
 */

import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
} from 'openai/resources/chat/completions.js';
import { config } from './config.js';
import { buildSystemPrompt } from './prompts.js';
import { toolDefinitions, executeTool } from './tools/index.js';
import { MemoryStore } from './memory/store.js';

// ── Types ────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; name: string; args: Record<string, any> }
  | { type: 'tool_end'; name: string; success: boolean }
  | { type: 'error'; message: string }
  | { type: 'done'; fullResponse: string };

// ── Agent ────────────────────────────────────────────────────────────

export class Agent {
  private openai: OpenAI;
  private memory: MemoryStore;
  private sessionId: string;
  private contextMessages: ChatCompletionMessageParam[] = [];

  constructor(memory: MemoryStore, sessionId: string) {
    this.openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
    this.memory = memory;
    this.sessionId = sessionId;

    // Load any existing messages from this session
    const existing = memory.getSessionMessages(sessionId, config.MAX_CONTEXT_MESSAGES);
    for (const msg of existing) {
      this.contextMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }
  }

  /**
   * Process a user message and yield streaming events.
   *
   * This is an async generator that yields events as the agent works:
   * - tool_start/tool_end: when the agent calls tools
   * - text_delta: streamed text chunks of the final response
   * - done: final complete response
   * - error: if something goes wrong
   */
  async *chat(userMessage: string): AsyncGenerator<AgentEvent> {
    // 1. Save user message to memory
    this.memory.addMessage(this.sessionId, 'user', userMessage);

    // 2. Add to context window
    this.contextMessages.push({ role: 'user', content: userMessage });

    // 3. Trim context window if too long (keep system prompt effective)
    this.trimContext();

    // 4. Build the full message array for the API
    const systemPrompt = buildSystemPrompt();
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...this.contextMessages,
    ];

    // 5. Agent loop: keep calling the model until it stops requesting tools
    let fullResponse = '';
    let steps = 0;

    while (steps < config.MAX_AGENT_STEPS) {
      steps++;

      try {
        // Determine if this might be the final step (no more tools expected)
        // We always stream — if tools come back, we handle them and loop again
        const stream = await this.openai.chat.completions.create({
          model: config.MODEL_NAME,
          messages,
          tools: toolDefinitions,
          stream: true,
        });

        // Collect the streamed response
        let stepContent = '';
        const toolCalls: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }> = [];

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;

          // Text content — stream it to the UI
          if (choice.delta?.content) {
            stepContent += choice.delta.content;
            yield { type: 'text_delta', content: choice.delta.content };
          }

          // Tool calls — collect chunks (they arrive in pieces)
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: '',
                  type: 'function',
                  function: { name: '', arguments: '' },
                };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) {
                toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          }
        }

        // Build the assistant message for history
        const assistantMsg: ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: stepContent || null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
        }
        messages.push(assistantMsg);

        // If no tool calls, we're done — the model produced a final text response
        if (toolCalls.length === 0) {
          fullResponse = stepContent;
          break;
        }

        // Yield tool start events BEFORE executing (so UI shows immediately)
        for (const tc of toolCalls) {
          const args = this.safeParseJson(tc.function.arguments);
          yield { type: 'tool_start' as const, name: tc.function.name, args };
        }

        // Execute all tool calls in parallel for speed
        const toolResults = await Promise.all(
          toolCalls.map(async (tc) => {
            const args = this.safeParseJson(tc.function.arguments);
            return {
              id: tc.id,
              name: tc.function.name,
              args,
              result: await executeTool(tc.function.name, args, this.memory),
            };
          })
        );

        // Yield tool end events and add results to messages
        for (const tr of toolResults) {
          yield {
            type: 'tool_end' as const,
            name: tr.name,
            success: !tr.result.error,
          };

          messages.push({
            role: 'tool' as const,
            tool_call_id: tr.id,
            content: tr.result.error || tr.result.result,
          });
        }

        // Loop back to let the model process tool results
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: errorMsg };
        fullResponse = `I encountered an error: ${errorMsg}`;
        break;
      }
    }

    // 6. Save assistant response to memory
    if (fullResponse) {
      this.memory.addMessage(this.sessionId, 'assistant', fullResponse);
      this.contextMessages.push({ role: 'assistant', content: fullResponse });
    }

    // 7. Trim context again after adding the response
    this.trimContext();

    yield { type: 'done', fullResponse };
  }

  /**
   * Keep context window manageable.
   * 
   * Strategy: keep the most recent N messages. For older context,
   * the agent can use recall_memory. This is architecturally elegant:
   * the same tool handles both cross-session and old-context recall.
   */
  private trimContext(): void {
    if (this.contextMessages.length > config.MAX_CONTEXT_MESSAGES) {
      // Keep the most recent messages
      this.contextMessages = this.contextMessages.slice(
        -config.MAX_CONTEXT_MESSAGES
      );
    }
  }

  /** Safely parse JSON, returning empty object on failure. */
  private safeParseJson(str: string): Record<string, any> {
    try {
      return JSON.parse(str);
    } catch {
      return {};
    }
  }

  /** Get memory stats for welcome message. */
  getStats() {
    return this.memory.getStats();
  }
}
