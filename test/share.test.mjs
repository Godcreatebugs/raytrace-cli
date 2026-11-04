import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTimeLeft, sharePrompt, revokeShare } from '../src/share.mjs';

test('formatTimeLeft: formats remaining duration correctly', () => {
  const now = Date.now() / 1000;
  assert.equal(formatTimeLeft(now - 10), 'expired');
  assert.equal(formatTimeLeft(now + 1800), '30 min');
  assert.equal(formatTimeLeft(now + 7200), '2 h');
});

test('sharePrompt: rejects empty trace ID', async () => {
  await assert.rejects(
    async () => sharePrompt(''),
    /Trace ID is required/,
  );
  await assert.rejects(
    async () => sharePrompt('   '),
    /Trace ID is required/,
  );
});

test('revokeShare: rejects empty share ID', async () => {
  await assert.rejects(
    async () => revokeShare(''),
    /Share ID is required/,
  );
  await assert.rejects(
    async () => revokeShare('   '),
    /Share ID is required/,
  );
});
