/**
 * Web search via Tavily API.
 *
 * Why Tavily over Google/Bing/Brave:
 * - Purpose-built for AI agents: returns clean extracted text, not raw HTML.
 * - Relevance scoring per result.
 * - Optional AI-generated answer summary.
 * - "advanced" search depth for thorough queries.
 * - Simple REST API, no SDK needed.
 */

import { config } from '../config.js';

// ── Types ────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  content: string;    // Extracted text snippet
  score: number;      // Relevance score 0-1
}

export interface WebSearchResponse {
  answer?: string;    // AI-generated answer (when available)
  results: SearchResult[];
  query: string;
}

// ── Search function ──────────────────────────────────────────────────

export async function webSearch(
  query: string,
  searchDepth: 'basic' | 'advanced' = 'basic'
): Promise<WebSearchResponse> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.TAVILY_API_KEY,
      query,
      search_depth: searchDepth,
      max_results: config.MAX_SEARCH_RESULTS,
      include_answer: true,
      include_raw_content: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Tavily search failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as any;

  return {
    answer: data.answer || undefined,
    query,
    results: (data.results || []).map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || '',
      score: r.score || 0,
    })),
  };
}
