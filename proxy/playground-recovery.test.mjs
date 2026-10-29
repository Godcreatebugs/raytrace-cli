import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPlayground } from './playground.mjs';

const id = (letter) => `rtf-${letter.repeat(32)}`;
const job = (letter, status, extra = {}) => ({ id: id(letter), kind: 'fork', status,
  created_at: new Date().toISOString(), check: { status: 'pending' }, ...extra });

async function fixture(t, records, initial = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'raytrace-recovery-test-'));
  const statePath = join(directory, 'state.json');
  const before = { path: process.env.PATH, ssh: process.env.RAYTACE_WORKER_SSH, lima: process.env.RAYTRACE_LIMACTL };
  const saveHost = (state) => writeFile(statePath, JSON.stringify(state));
  const host = async () => JSON.parse(await readFile(statePath, 'utf8'));
  await saveHost({ calls: [], boxes: records.filter((r) => r.status !== 'queued').map((r) => ({ id: r.id, running: true })),
    failStop: [], failList: false, ...initial });
  // A fake host only changes an in-memory-fixture JSON file. No VM/provider is used.
  await writeFile(join(directory, 'limactl'), `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const [action, id] = process.argv.slice(process.argv.indexOf('/opt/raytace/projects.py') + 1);
state.calls.push([action, id]);
fs.writeFileSync(file, JSON.stringify(state));
if (action === 'fork-stop' && state.stopDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.stopDelayMs);
let code = 0;
if (action === 'fork-stop') {
  const box = state.boxes.find((box) => box.id === id);
  if (!box || state.failStop.includes(id)) code = 1;
  else box.running = false;
} else if (action === 'list' && state.failList) code = 1;
else if (action === 'fork-delete') throw new Error('Recovery must retain recent fork data');
fs.writeFileSync(file, JSON.stringify(state));
if (code) console.error('Simulated unavailable worker or absent container');
else console.log(JSON.stringify(action === 'list' ? state.boxes : {}));
process.exitCode = code;
`, { mode: 0o700 });
  process.env.PATH = directory + ':' + before.path;
  process.env.RAYTRACE_LIMACTL = join(directory, 'limactl');
  delete process.env.RAYTACE_WORKER_SSH;
  t.after(async () => {
    process.env.PATH = before.path;
    if (before.ssh === undefined) delete process.env.RAYTACE_WORKER_SSH;
    else process.env.RAYTACE_WORKER_SSH = before.ssh;
    if (before.lima === undefined) delete process.env.RAYTRACE_LIMACTL;
    else process.env.RAYTRACE_LIMACTL = before.lima;
    await rm(directory, { recursive: true, force: true });
  });
  const saves = [];
  const playground = startPlayground({ db: { loadExperiments: () => records,
    saveExperiment(record) { saves.push(structuredClone(record)); } }, transcriptsDir: directory,
    hookSource: () => '', orphans: false, log() {} });
  return { playground, host, saveHost, saves };
}

test('recovery stops each known active fork before saving it interrupted, retaining kept data', async (t) => {
  const records = ['creating', 'running', 'collecting', 'checking'].map((status, index) => job('abcd'[index], status, { keep: true }));
  const { playground, host, saves } = await fixture(t, records);
  await playground.recover();
  const state = await host();
  assert.equal(state.boxes.every((box) => !box.running), true);
  assert.deepEqual(state.calls, records.map((record) => ['fork-stop', record.id]));
  assert.equal(saves.length, 4);
  for (const record of records) {
    assert.equal(playground.get(record.id).status, 'interrupted');
    assert.equal(playground.get(record.id).deleted_at, undefined);
    assert.equal(playground.get(record.id).keep, true);
  }
});

test('queued, completed and deleted jobs do not stop unrelated workers', async (t) => {
  const records = [job('a', 'queued'), job('b', 'completed'), job('c', 'running', { deleted_at: 'already deleted' })];
  const { playground, host } = await fixture(t, records, { boxes: [{ id: id('d'), running: true }] });
  await playground.recover();
  assert.equal(playground.get(id('a')).status, 'interrupted');
  assert.ok(playground.get(id('a')).deleted_at);
  assert.equal(playground.get(id('b')).status, 'completed');
  assert.deepEqual((await host()).calls, []);
  assert.equal((await host()).boxes[0].running, true);
});

test('failed stop remains active and blocks new runs until a successful recovery retry', async (t) => {
  const record = job('a', 'checking');
  const { playground, host, saveHost } = await fixture(t, [record], { failStop: [record.id] });
  await playground.recover();
  assert.equal(playground.get(record.id).status, 'checking');
  assert.equal(playground.get(record.id).recovery_stop_pending, true);
  assert.match(playground.get(record.id).error, /Could not confirm.*Restart RayTrace/);
  assert.equal((await host()).boxes[0].running, true);
  await assert.rejects(playground.create({}), /previous fork could not be stopped/);
  await saveHost({ ...await host(), failStop: [] });
  await playground.recover();
  assert.equal(playground.get(record.id).status, 'interrupted');
  assert.equal(playground.get(record.id).recovery_stop_pending, undefined);
  assert.equal((await host()).boxes[0].running, false);
});

test('a creating job confirmed absent does not permanently block new runs', async (t) => {
  const record = job('a', 'creating');
  const { playground, host } = await fixture(t, [record], { boxes: [{ id: id('b'), running: true }] });
  await playground.recover();
  assert.equal(playground.get(record.id).status, 'interrupted');
  assert.equal(playground.get(record.id).recovery_stop_pending, undefined);
  assert.deepEqual((await host()).calls, [['fork-stop', record.id], ['list', null]]);
  assert.equal((await host()).boxes[0].running, true);
});

test('failed host inventory cannot establish a missing fork is stopped', async (t) => {
  const record = job('a', 'creating');
  const { playground } = await fixture(t, [record], { boxes: [], failList: true });
  await playground.recover();
  assert.equal(playground.get(record.id).status, 'creating');
  assert.equal(playground.get(record.id).recovery_stop_pending, true);
});

test('new fork creation is blocked while restart recovery is still stopping old work', async (t) => {
  const record = job('a', 'running');
  const { playground, host } = await fixture(t, [record], { stopDelayMs: 300 });
  const recovery = playground.recover();
  try {
    await assert.rejects(playground.create({}), /previous fork could not be stopped/);
  } finally {
    await recovery;
  }
  assert.equal(playground.get(record.id).status, 'interrupted');
  assert.equal((await host()).boxes[0].running, false);
});
