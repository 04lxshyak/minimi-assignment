/**
 * CLI entry point — the chat interface.
 *
 * Starts an interactive terminal session with the agent.
 * Displays streamed responses and tool-use indicators.
 *
 * Run: npm run dev
 */

import * as readline from 'readline';
import crypto from 'crypto';
import chalk from 'chalk';
import { config, validateConfig } from './config.js';
import { MemoryStore } from './memory/store.js';
import { Agent } from './agent.js';

// ── UI Helpers ───────────────────────────────────────────────────────

function printBanner(stats: { totalSessions: number; totalMessages: number }): void {
  console.log();
  console.log(chalk.bold.cyan('  ╭─────────────────────────────────────────────╮'));
  console.log(chalk.bold.cyan('  │') + chalk.bold('  🔍 Chat Agent                               ') + chalk.bold.cyan('│'));
  console.log(chalk.bold.cyan('  │') + chalk.dim('  Web search + Persistent memory               ') + chalk.bold.cyan('│'));
  if (stats.totalMessages > 0) {
    const memLine = `  📝 ${stats.totalMessages} messages across ${stats.totalSessions} sessions`;
    console.log(chalk.bold.cyan('  │') + chalk.dim(memLine.padEnd(46)) + chalk.bold.cyan('│'));
  }
  console.log(chalk.bold.cyan('  │') + chalk.dim('  Type "exit" or Ctrl+C to quit                ') + chalk.bold.cyan('│'));
  console.log(chalk.bold.cyan('  ╰─────────────────────────────────────────────╯'));
  console.log();
}

function printToolStart(name: string, args: Record<string, any>): void {
  if (name === 'web_search') {
    console.log(chalk.dim(`  🔍 Searching: "${args.query || ''}"`));
  }
}

function printToolEnd(name: string, success: boolean): void {
  if (!success) {
    console.log(chalk.yellow(`  ⚠  ${name} encountered an error`));
  }
}

// ── Prompt input ─────────────────────────────────────────────────────

function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
}

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate configuration
  try {
    validateConfig();
  } catch (err) {
    console.error(chalk.red(`\n  ✖ ${(err as Error).message}\n`));
    process.exit(1);
  }

  // Initialize memory store
  const memory = new MemoryStore();

  // Generate a session ID for this run
  const sessionId = `session_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  // Create agent
  const agent = new Agent(memory, sessionId);

  // Print welcome banner
  const stats = agent.getStats();
  printBanner(stats);

  // Start chat loop
  const rl = createPrompt();

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log(chalk.dim('\n\n  Goodbye! Your conversations are saved. 👋\n'));
    memory.close();
    process.exit(0);
  });

  while (true) {
    const userInput = await askQuestion(rl, chalk.bold.green('You: '));
    const trimmed = userInput.trim();

    if (!trimmed) continue;

    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      console.log(chalk.dim('\n  Goodbye! Your conversations are saved. 👋\n'));
      break;
    }

    // Start the agent response
    console.log(); // blank line before response

    let hasText = false;
    let hasToolActivity = false;

    try {
      for await (const event of agent.chat(trimmed)) {
        switch (event.type) {
          case 'text_delta':
            // Print "Agent: " label right before the first text chunk
            if (!hasText) {
              hasText = true;
              if (hasToolActivity) console.log(); // spacing after tool indicators
              process.stdout.write(chalk.bold.blue('Agent: '));
            }
            process.stdout.write(event.content);
            break;

          case 'tool_start':
            hasToolActivity = true;
            printToolStart(event.name, event.args);
            break;

          case 'tool_end':
            printToolEnd(event.name, event.success);
            break;

          case 'error':
            console.log(chalk.red(`  Error: ${event.message}`));
            break;

          case 'done':
            if (hasText) {
              process.stdout.write('\n');
            } else if (!event.fullResponse) {
              // Agent produced no text (shouldn't happen, but handle gracefully)
              console.log(chalk.bold.blue('Agent: ') + chalk.dim('(no response)'));
            }
            break;
        }
      }
    } catch (err) {
      console.log(chalk.red(`  Unexpected error: ${(err as Error).message}`));
    }

    console.log(); // Blank line between turns
  }

  memory.close();
  rl.close();
}

// ── Entry point ──────────────────────────────────────────────────────

main().catch((err) => {
  console.error(chalk.red(`\nFatal error: ${err.message}\n`));
  process.exit(1);
});
