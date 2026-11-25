import test from 'node:test';
import assert from 'node:assert/strict';
import { failureSignature, normalizeErrorLine } from './failure-signature.mjs';

test('failure normalization removes quantities while preserving their units', () => {
  for (const unit of ['ms', 's', 'sec', 'seconds', 'bytes', 'kb', 'mb', 'gb']) {
    assert.equal(normalizeErrorLine(`Limit exceeded: 12.5 ${unit}`), `limit exceeded: <n>${unit}`);
  }
  const signature = text => failureSignature({ errorText: `Limit exceeded: ${text}` }).signature;
  assert.equal(signature('10 ms'), signature('250 ms'));
  assert.notEqual(signature('10 ms'), signature('10 bytes'));
});
