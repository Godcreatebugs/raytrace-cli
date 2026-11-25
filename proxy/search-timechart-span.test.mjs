import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseSearchQuery, runSearch } from './search.mjs';

test('timechart rejects zero and overflowing spans with a query error', () => {
  for (const span of ['0m', '0h', '0d', '999999999999999999d', `${'9'.repeat(400)}m`]) {
    const parsed = parseSearchQuery(`| timechart count span=${span}`);
    assert.equal(parsed.pipe, null, span);
    assert.equal(parsed.errors.length, 1, span);
    assert.match(parsed.errors[0], /span/i);
  }
});

test('valid timechart spans keep units and the default day', () => {
  for (const [suffix, spanMs] of [['', 86_400_000], [' span=1m', 60_000], [' span=02H', 7_200_000], [' span=7d', 604_800_000]]) {
    const parsed = parseSearchQuery(`| timechart count${suffix}`);
    assert.equal(parsed.pipe.spanMs, spanMs);
    assert.deepEqual(parsed.errors, []);
  }
});

test('invalid spans return useful search results rather than bad SQL or null buckets', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('./schema/search.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO search_events
    (id, kind, ts_ms, outcome, outcome_reported, outcome_observed, indexed_at_ms)
    VALUES ('one', 'call', 1000, 'failed', 'failed', 'unknown', 1000)`);
  for (const span of ['0m', `${'9'.repeat(400)}d`]) {
    const result = runSearch(db, { q: `failed | timechart count span=${span}` });
    assert.equal(result.mode, 'events');
    assert.equal(result.total, 1);
    assert.equal(result.errors.length, 1);
  }
  const result = runSearch(db, { q: '| timechart count span=1m' });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].t, 0);
  assert.equal(result.rows[0][result.seriesKeys?.[0] ?? result.series[0]], 1);
});
