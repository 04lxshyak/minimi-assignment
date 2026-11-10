import dotenv from 'dotenv';
dotenv.config();

// ── Provider detection ───────────────────────────────────────────────
// Support Google Gemini (free) and OpenAI (paid) via the same OpenAI SDK.
// Google's Gemini API exposes an OpenAI-compatible endpoint, so the
// agent loop code doesn't change at all — just the base URL and key.

const provider = detectProvider();

function detectProvider(): 'google' | 'openai' {
  const configured = process.env.LLM_PROVIDER?.toLowerCase();
  if (configured === 'google' || configured === 'openai') return configured;
  if (process.env.GOOGLE_API_KEY) return 'google';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'google'; // default to free option
}

export const config = {
  // Provider
  PROVIDER: provider,

  // API keys
  API_KEY: provider === 'google'
    ? (process.env.GOOGLE_API_KEY || '')
    : (process.env.OPENAI_API_KEY || ''),

  BASE_URL: provider === 'google'
    ? 'https://generativelanguage.googleapis.com/v1beta/openai/'
    : undefined, // OpenAI SDK default

  TAVILY_API_KEY: process.env.TAVILY_API_KEY || '',

  // Model — sensible defaults per provider
  MODEL_NAME: process.env.MODEL_NAME
    || (provider === 'google' ? 'gemini-2.0-flash' : 'gpt-4o'),

  // Agent behavior
  MAX_CONTEXT_MESSAGES: parseInt(process.env.MAX_CONTEXT_MESSAGES || '40', 10),
  MAX_SEARCH_RESULTS: parseInt(process.env.MAX_SEARCH_RESULTS || '6', 10),
  MAX_AGENT_STEPS: parseInt(process.env.MAX_AGENT_STEPS || '10', 10),

  // Storage
  DB_PATH: process.env.DB_PATH || './data/memory.db',
  TIME_ZONE: process.env.TIME_ZONE || 'Asia/Kolkata',
} as const;

/** Validate that required API keys are present. Throws on missing keys. */
export function validateConfig(): void {
  const missing: string[] = [];

  if (!config.API_KEY) {
    missing.push(
      config.PROVIDER === 'google' ? 'GOOGLE_API_KEY' : 'OPENAI_API_KEY'
    );
  }
  if (!config.TAVILY_API_KEY) missing.push('TAVILY_API_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      `Copy .env.example to .env and fill in your API keys.\n` +
      `Get a free Google API key at: https://aistudio.google.com/apikey`
    );
  }
}
