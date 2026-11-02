import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_IDLE_LIMIT_MS, isIdleExpired } from '../src/auth.mjs';
import { betaExpiryWarning } from '../src/sandbox.mjs';

const DAY = 86_400_000;
const now = 1_800_000_000_000;

test('cloud sign-in is asked again after 2 idle days, not before', () => {
  assert.equal(CLOUD_IDLE_LIMIT_MS, 2 * DAY);
  assert.equal(isIdleExpired({ last_used_at: now - DAY }, now), false);
  assert.equal(isIdleExpired({ last_used_at: now - 2 * DAY }, now), false, 'exactly 2 days is not over the limit');
  assert.equal(isIdleExpired({ last_used_at: now - 2 * DAY - 1 }, now), true);
});

test('sessions saved before the idle field existed are not signed out', () => {
  assert.equal(isIdleExpired({}, now), false);
  assert.equal(isIdleExpired(null, now), false);
  assert.equal(isIdleExpired({ last_used_at: null }, now), false);
});

test('connect warning only for the credited sandbox, once its 3 days are up', () => {
  const sid = 'rtp-' + 'a'.repeat(32);
  const past = new Date(now - 60_000).toISOString();
  const warning = betaExpiryWarning({ credited_sandbox_id: sid, credit_expires_at: past, expired: true }, sid, now);
  assert.match(warning, /beta credit for this sandbox expired/);
  assert.match(warning, /model calls in this sandbox will be refused/);
  assert.match(warning, /still opens/);

  const live = new Date(now + 60_000).toISOString();
  assert.equal(betaExpiryWarning({ credited_sandbox_id: sid, credit_expires_at: live, expired: false }, sid, now), null);
  assert.equal(betaExpiryWarning({ credited_sandbox_id: 'rtp-' + 'b'.repeat(32), credit_expires_at: past, expired: true }, sid, now), null);
  assert.equal(betaExpiryWarning(null, sid, now), null);
  // The backend's expired flag alone is enough, even without a parseable date.
  assert.match(betaExpiryWarning({ credited_sandbox_id: sid, expired: true }, sid, now), /expired/);
});
