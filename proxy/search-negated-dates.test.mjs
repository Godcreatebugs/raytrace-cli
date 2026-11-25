import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runSearch } from './search.mjs';

test('negated date filters complement inclusive bounds and intersect the selected range', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('./schema/search.sql', import.meta.url), 'utf8'));
  const insert = db.prepare(`INSERT INTO search_events
    (id, kind, ts_ms, outcome, outcome_reported, outcome_observed, indexed_at_ms)
    VALUES (?, 'call', ?, 'unknown', 'unknown', 'unknown', 0)`);
  const start = Date.parse('2026-01-02T00:00:00Z');
  const end = start + 86_399_999;
  for (const timestamp of [start - 1, start, start + 1, end, end + 1]) insert.run(String(timestamp), timestamp);
  const times = (q, options = {}) => runSearch(db, { q, ...options }).hits.map((row) => row.ts_ms).sort((a, b) => a - b);
  assert.deepEqual(times('-after:2026-01-02'), [start - 1]);
  assert.deepEqual(times('-before:2026-01-02'), [end + 1]);
  assert.deepEqual(times(`-after:${start + 1}`), [start - 1, start]);
  assert.deepEqual(times(`-before:${start}`), [start + 1, end, end + 1]);
  assert.deepEqual(times('after:2026-01-02'), [start, start + 1, end, end + 1]);
  assert.deepEqual(times('before:2026-01-02'), [start - 1, start, start + 1, end]);
  assert.deepEqual(times(`-after:${end + 1} -before:${start - 1}`, { fromMs: start + 1, toMs: end }), [start + 1, end]);
  assert.deepEqual(times('-after:invalid'), [start - 1, start, start + 1, end, end + 1]);
  assert.deepEqual(runSearch(db, { q: '-before:2026-01-02 | stats count' }).rows, [{ key: '(all)', value: 1, count: 1 }]);
});
