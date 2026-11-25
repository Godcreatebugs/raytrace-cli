import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEvidenceStore } from '../proxy/evidence-store.mjs';
import { exportCommand } from '../src/export.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'raytrace-exclusive-export-'));
  const previous = process.env.RAYTRACE_HOME;
  process.env.RAYTRACE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.RAYTRACE_HOME;
    else process.env.RAYTRACE_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = openEvidenceStore(join(directory, 'evidence.db'));
  try {
    store.recordExchange({
      event_type: 'model.exchange', span_id: 'export', trace_id: 'export', session_id: 'session',
      timestamp: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:01Z',
      provider: 'openai', route: '/v1/responses', method: 'POST',
      request: { payload: { model: 'test', input: [{ role: 'user', content: 'Hello' }] } },
      response: { status: 200, payload: { output: [{ type: 'message', content: 'Hello back' }] } },
    });
    return { directory, turnId: store.db.prepare('SELECT turn_id FROM agent_exchanges WHERE id = ?').get('export').turn_id };
  } finally { store.close(); }
}

test('export preserves a file created by another writer before its write', async (t) => {
  const { directory, turnId } = fixture(t);
  const output = join(directory, 'race.json');
  const write = fs.writeFileSync;
  let raced = false;
  t.mock.method(fs, 'writeFileSync', (file, content, options) => {
    if (file === output && !raced) {
      raced = true;
      write(output, 'another writer', { flag: 'wx' });
    }
    return write(file, content, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(exportCommand(turnId, { format: 'json', output }), /File already exists/);
  assert.equal(raced, true);
  assert.equal(fs.readFileSync(output, 'utf8'), 'another writer');
});

test('export refuses dangling output symlinks', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, turnId } = fixture(t);
  const target = join(directory, 'missing.json');
  const output = join(directory, 'linked.json');
  fs.symlinkSync(target, output);
  await assert.rejects(exportCommand(turnId, { format: 'json', output }), /File already exists/);
  assert.equal(fs.lstatSync(output).isSymbolicLink(), true);
  assert.equal(fs.existsSync(target), false);
});

test('export preserves filesystem errors other than an existing output', async (t) => {
  const { directory, turnId } = fixture(t);
  await assert.rejects(exportCommand(turnId, { output: join(directory, 'missing', 'trace.md') }), { code: 'ENOENT' });
});
