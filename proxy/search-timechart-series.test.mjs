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
    (id, kind, ts_ms, outcome, outcome_reported, outcome_observed, indexed_at_ms, model)
    VALUES (?, 'call', ?, 'unknown', 'unknown', 'unknown', 0, ?)`);
  let id = 0;
  return { db, add(model, count, at = 60_000) { for (let i = 0; i < count; i++) insert.run(String(id++), at, model); } };
}

test('timechart series names cannot overwrite timestamps or object properties', (t) => {
  const { db, add } = fixture(t);
  const names = ['t', '__proto__', 'constructor', 'toString', 'plain'];
  for (const name of names) add(name, 2);
  const result = JSON.parse(JSON.stringify(runSearch(db, { q: '| timechart count by model span=1m' })));
  assert.equal(result.rows[0].t, 60_000);
  assert.equal(new Set(result.seriesKeys).size, names.length);
  for (const name of names) {
    const column = result.seriesKeys[result.series.indexOf(name)];
    assert.notEqual(column, 't');
    assert.equal(result.rows[0][column], 2, name);
  }
});

test('a real other series stays separate from the remainder', (t) => {
  const { db, add } = fixture(t);
  add('other', 10);
  for (let i = 0; i < 9; i++) add(`model-${i}`, i + 1);
  const result = runSearch(db, { q: '| timechart count by model span=1m' });
  assert.equal(result.series.length, 9);
  const columns = result.seriesKeys ?? result.series;
  const actualOther = columns[result.series.indexOf('other')];
  assert.equal(result.rows[0][actualOther], 10);
  assert.equal(columns.length, 9);
  assert.equal(result.rows[0][columns.at(-1)], 3);
  assert.equal(columns.reduce((sum, key) => sum + result.rows[0][key], 0), 55);
});

test('a literal missing-value label and a null group retain separate counts', (t) => {
  const { db, add } = fixture(t);
  add('(none)', 3);
  add(null, 2);
  const result = runSearch(db, { q: '| timechart count by model span=1m' });
  const columns = result.seriesKeys ?? result.series;
  assert.equal(columns.length, 2);
  assert.deepEqual(columns.map((key) => result.rows[0][key]).sort(), [2, 3]);
});
