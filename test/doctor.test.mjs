import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkRunningPid, runningPid } from '../src/proxy-process.mjs';
import { paths } from '../src/paths.mjs';
import { startSandboxBridge } from '../proxy/sandbox-bridge.mjs';
import { doctor } from '../src/commands.mjs';

const tempDir = mkdtempSync(join(tmpdir(), 'raytrace-doctor-test-'));
const oldHome = process.env.RAYTRACE_HOME;
process.env.RAYTRACE_HOME = tempDir;

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (oldHome) process.env.RAYTRACE_HOME = oldHome;
  else delete process.env.RAYTRACE_HOME;
});

test('checkRunningPid does not delete stale PID file unlike runningPid', () => {
  const stalePid = 99999999; // non-existent PID
  mkdirSync(dirname(paths.proxyPid), { recursive: true });
  writeFileSync(paths.proxyPid, String(stalePid));

  const checked = checkRunningPid();
  assert.equal(checked, null);
  assert.ok(existsSync(paths.proxyPid), 'PID file should still exist after checkRunningPid');

  const removed = runningPid();
  assert.equal(removed, null);
  assert.ok(!existsSync(paths.proxyPid), 'PID file should be deleted after runningPid');
});

test('sandbox bridge serves GET /raytace/identity', async () => {
  const bridgePort = 18799;
  const bridge = startSandboxBridge({
    dataDir: tempDir,
    port: bridgePort,
    ingest: async () => ({ status: 200, body: { ok: true } })
  });

  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/raytace/identity`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, 'raytrace-bridge');
    assert.equal(body.version, 1);
  } finally {
    await new Promise((done) => bridge.close(done));
  }
});

test('doctor runs without throwing errors even in an uninitialized environment', async () => {
  // Doctor should log problems and set exitCode without crashing or throwing
  const origExitCode = process.exitCode;
  try {
    await doctor();
    assert.equal(process.exitCode, 1, 'Doctor should report problems in empty environment with exitCode 1');
  } finally {
    process.exitCode = origExitCode;
  }
});
