import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseSearchQuery, runSearch } from './search.mjs';

test('quoted field values stay together without becoming free-text phrases', () => {
  const parsed = parseSearchQuery('file:"/workspace/My App/file.js" -model:"Local Model" "tool:Bash"');
  assert.deepEqual(parsed.filters, [
    { field: 'file', value: '/workspace/My App/file.js', negated: false },
    { field: 'model', value: 'Local Model', negated: true },
  ]);
  assert.deepEqual(parsed.text, [{ value: 'tool:Bash', phrase: true, prefix: false, negated: false }]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parseSearchQuery('file:"a|b.js" | stats count').pipe.type, 'stats');
  assert.equal(parseSearchQuery('file:"a|b.js" | stats count').filters[0].value, 'a|b.js');
  const unknown = parseSearchQuery('bogus:"foo*"');
  assert.deepEqual(unknown.errors, ['Unknown field: bogus']);
  assert.deepEqual(unknown.text, [{ value: 'bogus:foo*', phrase: true, prefix: false, negated: false }]);
});

test('search finds and excludes quoted field values with spaces', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('./schema/search.sql', import.meta.url), 'utf8'));
  const insert = db.prepare(`INSERT INTO search_events
    (id, kind, ts_ms, outcome, outcome_reported, outcome_observed, indexed_at_ms, file_paths, model)
    VALUES (?, 'call', 1000, 'unknown', 'unknown', 'unknown', 1000, ?, ?)`);
  insert.run('spaced', '/workspace/My App/file.js', 'Local Model');
  insert.run('other', '/workspace/other/file.js', 'Remote Model');
  assert.deepEqual(runSearch(db, { q: 'file:"/workspace/My App/file.js"' }).hits.map((row) => row.id), ['spaced']);
  assert.deepEqual(runSearch(db, { q: 'model:"Local Model"' }).hits.map((row) => row.id), ['spaced']);
  assert.deepEqual(runSearch(db, { q: '-model:"Local Model"' }).hits.map((row) => row.id), ['other']);
  assert.deepEqual(runSearch(db, { q: 'model:"Local Model" | stats count' }).rows, [{ key: '(all)', value: 1, count: 1 }]);
});
