import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'raytrace-config-test-'));
process.env.RAYTRACE_HOME = home;
const { writeConfig, readConfig } = await import('../src/config.mjs');
const file = join(home, 'config.env');
after(() => rmSync(home, { recursive: true, force: true }));

test('custom model JSON with apostrophes survives saving alongside credentials', () => {
  const models = JSON.stringify([{ id: 'custom', name: "Developer's model" }]);
  writeConfig({ RAYTACE_OPENROUTER_MODELS: models, OPENROUTER_API_KEY: 'fake-test-key' });
  assert.deepEqual({ ...readConfig() }, { RAYTACE_OPENROUTER_MODELS: models, OPENROUTER_API_KEY: 'fake-test-key' });
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('hashes, whitespace, literal backslashes and multiline values survive', () => {
  for (const value of ['a # b', 'one\ntwo', String.raw`path\new`, `a'"b`, 'uses `quotes`']) {
    writeConfig({ SETTING: value });
    assert.equal(readConfig().SETTING, value);
  }
});

test('unrepresentable values leave previous settings intact without disclosing them', () => {
  writeConfig({ OPENROUTER_API_KEY: 'fake-original-key' });
  const before = readFileSync(file, 'utf8');
  const value = "'\"`\nINJECTED=secret-not-to-log";
  assert.throws(() => writeConfig({ SETTING: value }), error => {
    assert.equal(error.message, 'Cannot save setting SETTING without changing its value.');
    return true;
  });
  assert.equal(readFileSync(file, 'utf8'), before);
});
