import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // API keys
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  TAVILY_API_KEY: process.env.TAVILY_API_KEY || '',

  // Model
  MODEL_NAME: process.env.MODEL_NAME || 'gpt-4o',

  // Agent behavior
  MAX_CONTEXT_MESSAGES: parseInt(process.env.MAX_CONTEXT_MESSAGES || '40', 10),
  MAX_SEARCH_RESULTS: parseInt(process.env.MAX_SEARCH_RESULTS || '6', 10),
  MAX_AGENT_STEPS: parseInt(process.env.MAX_AGENT_STEPS || '10', 10),

  // Storage
  DB_PATH: process.env.DB_PATH || './data/memory.db',
} as const;

/** Validate that required API keys are present. Throws on missing keys. */
export function validateConfig(): void {
  const missing: string[] = [];
  if (!config.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!config.TAVILY_API_KEY) missing.push('TAVILY_API_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      `Copy .env.example to .env and fill in your API keys.`
    );
  }
}
