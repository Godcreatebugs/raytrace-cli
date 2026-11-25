import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runSearch, topFailureSignatures } from './search.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('./schema/search.sql', import.meta.url), 'utf8'));
  const insert = db.prepare(`INSERT INTO search_events
    (id, kind, ts_ms, outcome, outcome_reported, outcome_observed, indexed_at_ms, failure_signature)
    VALUES (?, 'call', ?, 'failed', 'failed', 'unknown', 0, ?)`);
  for (let i = 1; i <= 4; i++) insert.run(String(i), i * 1000, `failure-${i}`);
  return db;
}

test('search pagination truncates fractional query parameters', (t) => {
  const result = runSearch(fixture(t), { limit: '2.9', offset: '1.9' });
  assert.equal(result.limit, 2);
  assert.equal(result.offset, 1);
  assert.deepEqual(result.hits.map((row) => row.id), ['3', '2']);
  assert.equal(result.total, 4);
});

test('search pagination bounds invalid and oversized values before SQLite', (t) => {
  const db = fixture(t);
  for (const value of [Infinity, -Infinity, NaN, 'Infinity', 'invalid']) {
    const result = runSearch(db, { limit: value, offset: value });
    assert.equal(result.limit, 50);
    assert.equal(result.offset, 0);
    assert.equal(result.hits.length, 4);
  }
  const huge = runSearch(db, { limit: 1e100, offset: 1e100 });
  assert.equal(huge.limit, 200);
  assert.equal(huge.offset, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(huge.hits, []);
  const negative = runSearch(db, { limit: -3, offset: -0.5 });
  assert.equal(negative.limit, 1);
  assert.equal(negative.offset, 0);
  assert.equal(runSearch(db, { limit: 0 }).limit, 50);
});

test('failure-signature limits use the same integer normalization', (t) => {
  const db = fixture(t);
  assert.equal(topFailureSignatures(db, { limit: 1.9 }).length, 1);
  assert.equal(topFailureSignatures(db, { limit: '2.5' }).length, 2);
  assert.equal(topFailureSignatures(db, { limit: Infinity }).length, 4);
});
