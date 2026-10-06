// Starting, stopping and checking the background proxy. What scripts/lib.sh
// did in the repo, in Node so it needs neither bash nor curl.
//
// Health is an answered HTTP probe, never "a process exists": a wedged proxy,
// or a port held by something unrelated, both have a pid.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { paths } from './paths.mjs';
import { portOf, proxyEnv, readConfig } from './config.mjs';

export async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/raytace/models`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch { return false; }
}

/** True when anything at all is listening on the port. */
export function portInUse(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** The pid this CLI started, if that process is still running. */
export function runningPid() {
  if (!existsSync(paths.proxyPid)) return null;
  const pid = Number(readFileSync(paths.proxyPid, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) return pid;
  rmSync(paths.proxyPid, { force: true });
  return null;
}

export async function status() {
  const port = portOf(readConfig());
  const pid = runningPid();
  const ok = await healthy(port);
  return { port, pid, healthy: ok, url: `http://127.0.0.1:${port}` };
}

function tail(file, lines = 8) {
  try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

/**
 * Starts the proxy detached, logging to ~/.raytrace/logs/proxy.log, and waits
 * until it answers. A healthy proxy already on the port is reused, whoever
 * started it.
 */
export async function start() {
  const config = readConfig();
  const port = portOf(config);
  if (await healthy(port)) return { started: false, port, pid: runningPid() };
  if (await portInUse(port)) throw new Error(`Port ${port} is in use by something that is not answering as RayTrace. Free it, or set RAYTACE_PORT in ${paths.config}.`);
  if (!existsSync(paths.dashboard)) throw new Error(`The dashboard is missing from ${paths.dashboard}. Reinstall @raytrace/cli.`);

  mkdirSync(paths.logs, { recursive: true });
  mkdirSync(paths.run, { recursive: true });
  const log = openSync(paths.proxyLog, 'a');
  writeFileSync(log, `\n=== ${new Date().toISOString()} starting on :${port} ===\n`);
  // cwd is the data folder, so the proxy's own .env lookup finds nothing there
  // and every setting comes from config.env through the environment.
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', paths.proxy], {
    cwd: paths.home, env: proxyEnv(config), detached: true, stdio: ['ignore', log, log],
  });
  closeSync(log);
  let exited = null;
  child.once('exit', (code) => { exited = code ?? 1; });
  child.unref();
  writeFileSync(paths.proxyPid, `${child.pid}\n`);

  for (let waited = 0; waited < 20_000; waited += 250) {
    if (exited !== null) break;
    if (await healthy(port)) return { started: true, port, pid: child.pid };
    await sleep(250);
  }
  if (exited === null) try { process.kill(child.pid); } catch { /* already gone */ }
  rmSync(paths.proxyPid, { force: true });
  throw new Error(`The proxy did not come up. Last lines of ${paths.proxyLog}:\n${tail(paths.proxyLog)}`);
}

export async function stop() {
  const pid = runningPid();
  if (!pid) {
    const { port, healthy: up } = await status();
    return { stopped: false, foreign: up, port };
  }
  process.kill(pid, 'SIGTERM');
  for (let waited = 0; waited < 5000 && alive(pid); waited += 100) await sleep(100);
  if (alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(paths.proxyPid, { force: true });
  return { stopped: true, pid };
}
