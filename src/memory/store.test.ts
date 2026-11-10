import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { config } from '../config.js';
import { MemoryStore } from './store.js';

function withStore(run: (store: MemoryStore) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'chat-agent-test-'));
  const store = new MemoryStore(path.join(directory, 'memory.db'));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function localDateNow(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

test('loads the newest session messages in chronological order', () => {
  withStore((store) => {
    store.addMessage('session-a', 'user', 'first');
    store.addMessage('session-a', 'assistant', 'second');
    store.addMessage('session-a', 'user', 'third');

    const recent = store.getSessionMessages('session-a', 2);
    assert.deepEqual(recent.map(message => message.content), ['second', 'third']);
  });
});

test('prefers all-term memory matches and broadens when none match', () => {
  withStore((store) => {
    store.addMessage('session-a', 'user', 'We compared CRM pricing for HubSpot.');
    store.addMessage('session-a', 'assistant', 'Postgres hosting options were discussed.');

    const precise = store.search({ query: 'CRM HubSpot', limit: 10 });
    assert.equal(precise.length, 1);
    assert.match(precise[0].content, /HubSpot/);

    const broadened = store.search({ query: 'CRM unrelatedtoken', limit: 10 });
    assert.ok(broadened.some(message => /CRM/.test(message.content)));
  });
});

test('finds messages within the configured local calendar date', () => {
  withStore((store) => {
    store.addMessage('session-a', 'user', 'A message for today in the configured timezone.');

    const today = localDateNow();
    const matches = store.search({ dateFrom: today, dateTo: today });
    assert.ok(matches.some(message => message.content.includes('configured timezone')));
  });
});
