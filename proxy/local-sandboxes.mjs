/**
 * This machine's local sandboxes, for the proxy: what raytace's sandbox
 * manager answers there, from the CLI's own records instead. Each sandbox is
 * one the CLI made (`raytrace sandbox create --local`, kept in
 * ~/.raytrace/sandboxes.json); its container and state come from the Lima VM
 * (worker/sandbox/projects.py list), and what the kernel saw it do from the
 * fact engine's records there (projects.py activity).
 *
 * limactl is the one the CLI resolved (src/lima.mjs): the user's own, or the
 * one RayTrace downloaded.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findLima } from '../src/lima.mjs';

export const VM = process.env.RAYTRACE_VM || 'raytrace';
const SANDBOX = /^rtp-[a-f0-9]{32}$/;
// Listing goes through the VM, a few hundred milliseconds: the forwarder and
// the dashboard both poll it, so one answer serves for a few seconds.
const LIST_TTL_MS = 4000;

export const limactl = () => process.env.RAYTRACE_LIMACTL || findLima()?.binary || 'limactl';

function run(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(limactl(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8'))
      : reject(new Error(Buffer.concat(err).toString('utf8').trim().split('\n').at(-1) || `limactl exited ${code}`))));
    child.stdin.end(input ?? '');
  });
}
const projects = (args) => run(['shell', '--workdir', '/', VM, 'sudo', 'python3', '/opt/raytace/projects.py', ...args]);

async function vmRunning() {
  const listed = await run(['list', '--format', '{{.Name}} {{.Status}}']);
  return listed.split('\n').some((line) => line === `${VM} Running`);
}

export function localSandboxes({ dataDir }) {
  const registryFile = join(dataDir, 'sandboxes.json');
  const registry = async () => { try { return JSON.parse(await readFile(registryFile, 'utf8')); } catch { return {}; } };
  let cached = null;

  /** Every local sandbox: {id, name, status, created, container_id}. Throws
   * while the VM is stopped or unreachable, which says nothing about whether
   * the sandboxes exist (the forwarder must not take them for removed). */
  async function list() {
    if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.value;
    const boxes = await registry();
    if (!Object.keys(boxes).length) return [];
    if (!(await vmRunning())) throw new Error(`the ${VM} VM is not running`);
    const containers = new Map(JSON.parse((await projects(['list'])) || '[]').map((box) => [box.id, box]));
    const value = Object.entries(boxes).map(([id, box]) => {
      const container = containers.get(id);
      return { id, name: box.name, root: box.root ?? null, created: box.created, status: container?.status ?? 'missing',
        container_id: container?.container_id ?? null, size_bytes: container?.size_bytes ?? null };
    });
    cached = { at: Date.now(), value };
    return value;
  }

  /** The registry alone, for a listing that must answer with the VM stopped. */
  async function known() {
    const boxes = await registry();
    return Object.entries(boxes).map(([id, box]) => ({ id, name: box.name, root: box.root ?? null, created: box.created }));
  }

  /** What the kernel saw a sandbox do, by kind (files, network, lookups, ...);
   * since/until are epoch ms, to scope it to one prompt. */
  async function activity(id, { since = 0, until = 0 } = {}) {
    if (!SANDBOX.test(id)) throw new Error('Invalid sandbox id');
    const window = [...(since ? ['--since', String(since)] : []), ...(until ? ['--until', String(until)] : [])];
    return JSON.parse(await projects(['activity', id, ...window]));
  }

  /** When a sandbox was created, for its session's start (the CLI's record). */
  async function createdAt(id) { return (await registry())[id]?.created ?? null; }

  return { list, known, activity, createdAt, invalidate: () => { cached = null; } };
}
