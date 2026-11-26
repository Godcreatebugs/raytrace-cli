import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function logTail(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    const buffer = Buffer.alloc(Math.min(size, 8192));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8').trimEnd().split(/\r?\n/).slice(-12).join('\n');
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Run a long VM setup step while keeping its output and reporting liveness. */
export async function runVmStep(binary, args, {
  stage, logFile, say = console.log, intervalMs = 10_000, timeoutMs = 30 * 60_000,
} = {}) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  writeFileSync(fd, `\n=== ${new Date().toISOString()} ${stage} ===\n`);
  const started = Date.now();
  say(`${stage}. Progress is in ${logFile}; status updates every ${intervalMs / 1000}s.`);
  let child;
  try { child = spawn(binary, args, { stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }

  await new Promise((resolve, reject) => {
    let timedOut = false;
    let forceKill;
    const progress = setInterval(() => {
      const latest = logTail(logFile).split('\n').at(-1);
      say(`${stage}: still running (${Math.floor((Date.now() - started) / 1000)}s)${latest ? ` — ${latest}` : ''}`);
    }, intervalMs);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      forceKill.unref();
    }, timeoutMs);
    const cleanup = () => {
      clearInterval(progress);
      clearTimeout(timeout);
      clearTimeout(forceKill);
    };
    const failure = (reason) => new Error(
      `${stage} ${reason}.\n${logTail(logFile)}\nFull log: ${logFile}\n`
      + 'Run `raytrace doctor`, then retry this command to resume VM setup. '
      + 'The existing VM and local sandboxes have been kept.',
    );
    child.once('error', (error) => {
      cleanup();
      reject(failure(`could not start (${error.message})`));
    });
    child.once('close', (code, signal) => {
      cleanup();
      if (timedOut) reject(failure(`timed out after ${Math.round(timeoutMs / 1000)}s`));
      else if (code !== 0) reject(failure(`failed (${signal || `exit ${code}`})`));
      else resolve();
    });
  });
  say(`${stage}: finished (${Math.floor((Date.now() - started) / 1000)}s).`);
}
