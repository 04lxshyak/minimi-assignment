/**
 * Persistent conversation memory backed by SQLite + FTS5.
 *
 * Design rationale:
 * - SQLite is zero-config, single-file, embedded. No external services.
 * - FTS5 gives us full-text search with BM25 ranking — good enough for
 *   conversation recall without the latency/complexity of vector embeddings.
 * - WAL mode for concurrent read/write without blocking.
 * - Messages stored with timestamps and session IDs, enabling both
 *   text-based and temporal queries.
 *
 * Memory retrieval is internal agent context. Web search remains the only
 * tool exposed to the model.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

// ── Types ────────────────────────────────────────────────────────────

export interface Message {
  id?: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string; // ISO 8601
}

export interface SearchOptions {
  query?: string;      // Full-text search query
  dateFrom?: string;   // YYYY-MM-DD
  dateTo?: string;     // YYYY-MM-DD
  limit?: number;      // Max results (default 20)
}

export interface SearchResult {
  role: string;
  content: string;
  created_at: string;
  session_id: string;
}

// ── Store ────────────────────────────────────────────────────────────

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || config.DB_PATH;
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  /** Create tables and FTS5 index if they don't exist. */
  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created
        ON messages(created_at);
    `);

    // FTS5 virtual table — only create if it doesn't exist
    const ftsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
    ).get();

    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content,
          content='messages',
          content_rowid='id'
        );

        -- Triggers to keep FTS index in sync with messages table
        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES('delete', old.id, old.content);
        END;

        CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES('delete', old.id, old.content);
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);

      // Backfill FTS from any existing messages (in case of schema migration)
      this.db.exec(`
        INSERT INTO messages_fts(rowid, content)
          SELECT id, content FROM messages;
      `);
    }
  }

  /** Save a message to the store. */
  addMessage(sessionId: string, role: 'user' | 'assistant', content: string): Message {
    const createdAt = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(sessionId, role, content, createdAt);

    return {
      id: result.lastInsertRowid as number,
      session_id: sessionId,
      role,
      content,
      created_at: createdAt,
    };
  }

  /**
   * Search conversation memory.
   *
   * Supports three modes:
   * 1. Text search only — FTS5 with BM25 ranking
   * 2. Date range only — chronological scan
   * 3. Text + date range — FTS5 filtered by date
   *
   * Returns results in reverse chronological order (newest first).
   */
  search(options: SearchOptions): SearchResult[] {
    const limit = options.limit || 20;

    if (options.query) {
      return this.searchByText(options.query, options.dateFrom, options.dateTo, limit);
    }

    return this.searchByDate(options.dateFrom, options.dateTo, limit);
  }

  /** Full-text search with optional date filtering. */
  private searchByText(
    query: string,
    dateFrom?: string,
    dateTo?: string,
    limit: number = 20
  ): SearchResult[] {
    const ftsQuery = this.sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

    let sql = `
      SELECT m.role, m.content, m.created_at, m.session_id
      FROM messages m
      JOIN messages_fts fts ON m.id = fts.rowid
      WHERE messages_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];
    const dateBounds = this.dateBounds(dateFrom, dateTo);

    if (dateFrom) {
      sql += ` AND m.created_at >= ?`;
      params.push(dateBounds.from);
    }
    if (dateTo) {
      sql += ` AND m.created_at <= ?`;
      params.push(dateBounds.to);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    try {
      const exactTerms = ftsQuery.replace(/ OR /g, ' AND ');
      const exactParams = [...params];
      exactParams[0] = exactTerms;
      const exact = this.db.prepare(sql).all(...exactParams) as SearchResult[];
      if (exact.length) return exact;
      return this.db.prepare(sql).all(...params) as SearchResult[];
    } catch {
      // FTS5 query failed (malformed) → fall back to LIKE search
      return this.searchByLike(query, dateFrom, dateTo, limit);
    }
  }

  /** Fallback text search using LIKE when FTS5 query fails. */
  private searchByLike(
    query: string,
    dateFrom?: string,
    dateTo?: string,
    limit: number = 20
  ): SearchResult[] {
    let sql = `SELECT role, content, created_at, session_id FROM messages WHERE content LIKE ?`;
    const params: (string | number)[] = [`%${query}%`];
    const dateBounds = this.dateBounds(dateFrom, dateTo);

    if (dateFrom) {
      sql += ` AND created_at >= ?`;
      params.push(dateBounds.from);
    }
    if (dateTo) {
      sql += ` AND created_at <= ?`;
      params.push(dateBounds.to);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params) as SearchResult[];
  }

  /** Date-only search (no text query). */
  private searchByDate(
    dateFrom?: string,
    dateTo?: string,
    limit: number = 20
  ): SearchResult[] {
    let sql = `SELECT role, content, created_at, session_id FROM messages WHERE 1=1`;
    const params: (string | number)[] = [];
    const dateBounds = this.dateBounds(dateFrom, dateTo);

    if (dateFrom) {
      sql += ` AND created_at >= ?`;
      params.push(dateBounds.from);
    }
    if (dateTo) {
      sql += ` AND created_at <= ?`;
      params.push(dateBounds.to);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params) as SearchResult[];
  }

  /**
   * Sanitize user input for FTS5 query syntax.
   * 
   * Strategy: quote each word to prevent FTS5 operator injection,
   * join with OR; search() first tries AND to favor precise topic matches.
   */
  private sanitizeFtsQuery(query: string): string {
    const stopWords = new Set(['what', 'when', 'where', 'which', 'who', 'why', 'how', 'did', 'does', 'do', 'the', 'a', 'an', 'i', 'you', 'we', 'me', 'my', 'our', 'your', 'about', 'on', 'in', 'at', 'for', 'to', 'of', 'and', 'or', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'it', 'this', 'that', 'last', 'time', 'asked', 'ask']);
    return query
      .replace(/['"\\]/g, ' ')             // Strip quotes and backslashes
      .replace(/[^a-zA-Z0-9\s\-_.]/g, ' ') // Keep only safe characters
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()))
      .map(w => `"${w}"`)                   // Quote each term
      .join(' OR ');                         // OR for broad recall
  }

  /** Convert local calendar dates in TIME_ZONE to UTC ISO boundaries. */
  private dateBounds(dateFrom?: string, dateTo?: string): { from: string; to: string } {
    const start = (day: string) => this.zonedMidnightUtc(day);
    const nextDay = (day: string) => {
      const d = new Date(`${day}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    return {
      from: dateFrom ? start(dateFrom) : '0000-01-01T00:00:00.000Z',
      to: dateTo ? new Date(Date.parse(start(nextDay(dateTo))) - 1).toISOString() : '9999-12-31T23:59:59.999Z',
    };
  }

  private zonedMidnightUtc(day: string): string {
    const target = new Date(`${day}T00:00:00.000Z`);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(target);
    const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const represented = Date.UTC(+values.year, +values.month - 1, +values.day, +values.hour, +values.minute, +values.second);
    const offset = represented - target.getTime();
    return new Date(target.getTime() - offset).toISOString();
  }

  /** Get recent messages from a specific session (for LLM context window). */
  getSessionMessages(sessionId: string, limit?: number): SearchResult[] {
    const sql = `
      SELECT role, content, created_at, session_id
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `;
    return (this.db.prepare(sql).all(sessionId, limit || config.MAX_CONTEXT_MESSAGES) as SearchResult[]).reverse();
  }

  /** Get total number of past sessions (for welcome message). */
  getStats(): { totalSessions: number; totalMessages: number } {
    const sessions = this.db.prepare(
      'SELECT COUNT(DISTINCT session_id) as count FROM messages'
    ).get() as any;
    const messages = this.db.prepare(
      'SELECT COUNT(*) as count FROM messages'
    ).get() as any;

    return {
      totalSessions: sessions?.count || 0,
      totalMessages: messages?.count || 0,
    };
  }

  /** Clean shutdown. */
  close(): void {
    this.db.close();
  }
}
