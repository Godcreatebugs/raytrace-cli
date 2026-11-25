import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { systemOne, typesafeConfig } from './typesafe.mjs';

const config = typesafeConfig({ TYPESAFE_API_KEY: 'test-key' });
const input = { state: 'test state', questions: {} };

test('TypeSafe cancels immediately when aborted while reading a retryable response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  let outcome;
  let calls = 0;
  const pending = systemOne(config, input, {
    signal: controller.signal,
    fetchImpl: async () => {
      calls++;
      return {
        ok: false, status: 429, headers: new Headers({ 'retry-after': '3600' }),
        text: async () => { controller.abort(reason); return 'rate limited'; },
      };
    },
  }).then(() => { outcome = 'resolved'; }, error => { outcome = error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(outcome, reason);
  assert.equal(calls, 1);
  await pending;
});

test('TypeSafe releases the cancellation listener after a successful retry delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let calls = 0;
  const pending = systemOne(config, input, {
    signal: controller.signal,
    fetchImpl: async () => ++calls === 1
      ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), text: async () => '' }
      : { ok: true, json: async () => ({ answers: {} }) },
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await pending;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('TypeSafe cancels an active retry delay without issuing another request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const reason = new Error('cancel retry');
  let calls = 0;
  const pending = systemOne(config, input, {
    signal: controller.signal,
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 529, headers: new Headers(), text: async () => '' };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
