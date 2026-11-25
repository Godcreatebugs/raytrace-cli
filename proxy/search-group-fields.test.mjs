import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runSearch } from './search.mjs';

test('unsupported grouping fields return a query error instead of invalid SQL', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('./schema/search.sql', import.meta.url), 'utf8'));
  for (const type of ['stats', 'timechart']) {
    for (const field of ['constructor', '__proto__', 'unknown']) {
      const result = runSearch(db, { q: `| ${type} count by ${field}` });
      assert.equal(result.mode, type);
      assert.deepEqual(result.rows, []);
      assert.equal(result.error, `Cannot group by ${field}`);
    }
  }
  assert.deepEqual(runSearch(db, { q: '| stats count by outcome' }).rows, []);
  assert.deepEqual(runSearch(db, { q: '| stats count' }).rows, [{ key: '(all)', value: 0, count: 0 }]);
  assert.deepEqual(runSearch(db, { q: '| timechart count by model' }).rows, []);
});
