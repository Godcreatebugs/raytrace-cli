import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runSearch } from './search.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('./schema/search.sql', import.meta.url), 'utf8'));
  const insert = db.prepare(`INSERT INTO search_events
    (id, kind, ts_ms, outcome, outcome_reported, outcome_observed, indexed_at_ms,
      tool_name, model, provider, file_paths, failure_signature, session_id, exit_code, http_status)
    VALUES (?, 'call', 1000, 'unknown', 'unknown', 'unknown', 1000, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('matched', 'Bash', 'gpt-small', 'openai', '/workspace/app.js', 'sig-good', 'session-good', 0, 404);
  insert.run('other', 'ReadFile', 'local-model', 'local', '/workspace/other.js', 'sig-other', 'session-other', 1, 200);
  insert.run('missing', null, null, null, null, null, null, null, null);
  return db;
}

test('negating a field filter includes events whose field is missing', (t) => {
  const db = fixture(t);
  for (const q of ['tool:Ba*', 'model:gpt*', 'provider:open*', 'file:app.js', 'signature:sig-good', 'session:session-good', 'exit:0', 'http:>=400', 'tool:Bash']) {
    assert.deepEqual(runSearch(db, { q }).hits.map((row) => row.id), ['matched'], q);
    assert.deepEqual(runSearch(db, { q: '-' + q }).hits.map((row) => row.id).sort(), ['missing', 'other'], '-' + q);
  }
  assert.deepEqual(runSearch(db, { q: 'tool:ReadFile -exit:invalid' }).hits.map((row) => row.id), ['other']);
});

test('aggregation applies the same complement to missing numeric values', (t) => {
  assert.deepEqual(runSearch(fixture(t), { q: '-exit:0 | stats count' }).rows, [{ key: '(all)', value: 2, count: 2 }]);
});
