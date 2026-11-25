import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runSearch } from './search.mjs';

test('search reports the actual histogram interval for single and sparse buckets', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('./schema/search.sql', import.meta.url), 'utf8'));
  const insert = db.prepare(`INSERT INTO search_events
    (id, kind, ts_ms, outcome, outcome_reported, outcome_observed, indexed_at_ms)
    VALUES (?, 'call', ?, 'unknown', 'unknown', 'unknown', 0)`);
  const hour = 3_600_000;
  const day = 24 * hour;
  for (const { toMs, timestamps, interval } of [
    { toMs: day, timestamps: [hour + 1], interval: hour },
    { toMs: 30 * day, timestamps: [day + 1, 3 * day + 1], interval: day },
    { toMs: 180 * day, timestamps: [7 * day + 1, 21 * day + 1], interval: 7 * day },
  ]) {
    db.exec('DELETE FROM search_events');
    for (const timestamp of timestamps) insert.run(String(timestamp), timestamp);
    const result = runSearch(db, { fromMs: 0, toMs });
    assert.equal(result.histogramBucketMs, interval);
    for (const bucket of result.histogram) {
      const selected = runSearch(db, { fromMs: bucket.t, toMs: bucket.t + result.histogramBucketMs - 1 });
      assert.equal(selected.total, bucket.total, 'clicking one bucket selects exactly its events');
    }
    if (timestamps.length > 1) {
      assert.equal(result.histogram[1].t - result.histogram[0].t, interval * 2, 'empty buckets do not change the interval');
    }
  }
});
