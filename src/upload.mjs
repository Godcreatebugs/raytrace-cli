// `raytrace upload logs`: send a local sandbox's recorded evidences (the
// gzipped ~/.raytrace/evidence.db snapshot) to RayTrace cloud, where they
// render on app.raytracer.si like a cloud sandbox's. Uploading is always
// explicit: what will go is printed and confirmed first, and nothing is
// sent signed-out — the account flow runs first, like `sandbox create`.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { accessToken, login } from './auth.mjs';
import { readConfig } from './config.mjs';
import { ask, interactive } from './prompt.mjs';
import { registry } from './local-sandbox.mjs';
import { paths } from './paths.mjs';
import { openEvidenceStore } from '../proxy/evidence-store.mjs';

const say = (line = '') => console.log(line);
const API = 'https://api.raytracer.si';
const CHUNK = 8 * 1024 * 1024;
const RETRIES = 5;
const mb = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** The local sandbox an upload names: by id or name, else the only one. */
export function pickSandbox(ref, boxes = registry()) {
  const ids = Object.keys(boxes);
  if (!ids.length) throw new Error('No local sandboxes yet. Create one: raytrace sandbox create --local');
  if (!ref) {
    if (ids.length > 1) throw new Error(`More than one local sandbox; say which: raytrace upload logs --sandbox <name>\n${ids.map((id) => `  ${boxes[id].name}  ${id}`).join('\n')}`);
    return { id: ids[0], ...boxes[ids[0]] };
  }
  const byId = boxes[ref];
  if (byId) return { id: ref, ...byId };
  const byName = ids.find((id) => boxes[id].name === ref);
  if (byName) return { id: byName, ...boxes[byName] };
  throw new Error(`No local sandbox named ${ref}. Local sandboxes:\n${ids.map((id) => `  ${boxes[id].name}  ${id}`).join('\n')}`);
}

/** A consistent gzipped snapshot of the evidences database (never the live
 * WAL file itself), plus what one sandbox holds in it. */
export function snapshotEvidences(database = paths.database) {
  if (!existsSync(database)) throw new Error(`No evidences recorded yet (${database} does not exist). Run an agent in a local sandbox first.`);
  const dir = mkdtempSync(join(tmpdir(), 'raytrace-upload-'));
  const plain = join(dir, 'evidence.db');
  const source = new DatabaseSync(database, { readOnly: true });
  try { source.exec(`VACUUM INTO '${plain.replaceAll("'", "''")}'`); } finally { source.close(); }
  return { dir, plain };
}

/** Trims the snapshot to one sandbox, so nothing of any other sandbox or
 * session leaves this machine. Only ever run on the temporary copy. */
export function keepOnlySandbox(plain, keep) {
  const scratch = 'upload-unattributed';
  const db = new DatabaseSync(plain);
  let others;
  try {
    others = db.prepare('SELECT external_session_id AS id FROM agent_sessions WHERE external_session_id IS NOT NULL').all()
      .map((row) => row.id).filter((id) => !keep.includes(id));
    // Captures no sandbox claimed: forgetSessions finds a sandbox's by project id.
    db.prepare('UPDATE runtime_sandboxes SET project_id = ? WHERE project_id IS NULL').run(scratch);
    others.push(...db.prepare('SELECT DISTINCT project_id AS id FROM runtime_sandboxes WHERE project_id IS NOT NULL').all()
      .map((row) => row.id).filter((id) => !keep.includes(id) && !others.includes(id)));
  } finally { db.close(); }
  const store = openEvidenceStore(plain);
  try { store.forgetSessions(others); } finally { store.close(); }
  const compact = new DatabaseSync(plain);
  try { compact.exec('VACUUM'); } finally { compact.close(); }
}

export function sandboxStats(plain, sandboxId) {
  const db = new DatabaseSync(plain, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT COUNT(DISTINCT e.id) AS exchanges, COUNT(DISTINCT e.turn_id) AS turns,
        MIN(e.started_at_ms) AS first, MAX(e.started_at_ms) AS last
      FROM agent_sessions s LEFT JOIN agent_exchanges e ON e.session_id = s.id
      WHERE s.external_session_id = ?`).get(sandboxId);
    const redacted = db.prepare("SELECT COUNT(*) AS n FROM agent_payloads WHERE content LIKE '%[REDACTED]%'").get().n;
    return { exchanges: row.exchanges ?? 0, turns: row.turns ?? 0, first: row.first ?? null, last: row.last ?? null, redacted };
  } finally { db.close(); }
}

/** Sends the file in chunks. The server says where its copy ends, so an
 * interrupted upload (this run's or an earlier one's) carries on from there. */
export async function sendChunks({ url, key, sandbox, name, file, size, sha256, onProgress = () => {}, send = fetch }) {
  const handle = await open(file, 'r');
  const buffer = Buffer.alloc(CHUNK);
  let offset = 0;
  let failures = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - offset), offset);
      const query = new URLSearchParams({ sandbox, name, sha256, size: String(size), offset: String(offset) });
      let response;
      try {
        response = await send(new URL(`/v1/evidence/import?${query}`, url), {
          method: 'POST', body: buffer.subarray(0, bytesRead),
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/gzip' },
        });
      } catch (error) {
        if (++failures > RETRIES) throw new Error(`Upload interrupted: ${error.message}. Run it again to continue where it stopped.`);
        await new Promise((resolve) => { setTimeout(resolve, 500 * 2 ** failures); });
        continue;
      }
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 && data.code === 'upload_offset') { offset = data.offset; onProgress(offset); continue; }
      if (response.status >= 500 && ++failures <= RETRIES) {
        await new Promise((resolve) => { setTimeout(resolve, 500 * 2 ** failures); });
        continue;
      }
      if (!response.ok) {
        const hint = data.upgrade ? '\nUpgrade: https://raytracer.si/pricing' : '';
        throw new Error(`${data.error || `HTTP ${response.status}`}${hint}`);
      }
      failures = 0;
      if (data.complete) return data;
      offset = data.offset;
      onProgress(offset);
    }
  } finally {
    await handle.close();
  }
}

async function api() {
  const config = readConfig();
  const url = process.env.RAYTRACE_API_URL || config.RAYTRACE_API_URL || API;
  let key = process.env.RAYTRACE_API_KEY || config.RAYTRACE_API_KEY || await accessToken();
  if (!key) {
    if (!interactive()) throw new Error('Uploading evidences needs a RayTrace account. Sign in first: raytrace auth login');
    say('Uploading evidences needs a RayTrace account — let us sign you in (or create your account) first.');
    await login();
    key = await accessToken();
    if (!key) throw new Error('Not signed in. Run: raytrace auth login');
    say();
  }
  return { url: new URL(url), key };
}

async function callJson(method, path) {
  const { url, key } = await api();
  const response = await fetch(new URL(path, url), { method, headers: { authorization: `Bearer ${key}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export async function uploadStatus() {
  const me = await callJson('GET', '/v1/me');
  const plan = me.plan ?? {};
  say(`Plan: ${plan.label ?? plan.plan ?? 'Free'}`);
  say(`Evidences storage: ${mb(plan.storage_used_bytes ?? 0)} of ${mb(plan.storage_bytes ?? 0)} used`);
  say(`Retention: ${plan.retention_days ? `${plan.retention_days} days` : 'kept only while a sandbox lives (Free)'}`);
  say(`Sandboxes: up to ${plan.max_live ?? 1} live`);
  const boxes = await callJson('GET', '/v1/sandboxes');
  for (const box of Array.isArray(boxes) ? boxes : []) {
    if (!box.traces_kept_until) continue;
    const days = Math.max(0, Math.ceil((box.traces_kept_until * 1000 - Date.now()) / 86_400_000));
    say(`  ${box.name}: traces kept ${days} more day${days === 1 ? '' : 's'}`);
  }
}

export async function uploadLogs({ sandbox: ref = null, yes = false, dryRun = false } = {}) {
  const box = pickSandbox(ref);
  const { dir, plain } = snapshotEvidences();
  try {
    keepOnlySandbox(plain, [box.id]);
    const gz = `${plain}.gz`;
    await pipeline(createReadStream(plain), createGzip({ level: 6 }), createWriteStream(gz, { mode: 0o600 }));
    const size = (await stat(gz)).size;
    const stats = sandboxStats(plain, box.id);
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    say(`Sandbox ${box.name} (${box.id}): ${stats.turns} prompt${stats.turns === 1 ? '' : 's'}, ${stats.exchanges} model exchanges${stats.first ? `, ${day(stats.first)} to ${day(stats.last)}` : ''}.`);
    say(`Evidences to upload: ${mb(size)} gzipped, this sandbox only. They will be readable at https://app.raytracer.si/?view=sandboxes`);
    say(`${stats.redacted} recorded item${stats.redacted === 1 ? ' has' : 's have'} credential-shaped fields withheld. That covers named fields only: prompts and tool output can still contain secrets, with no guarantee.`);
    if (dryRun) { say('Dry run: nothing uploaded.'); return; }
    if (!yes) {
      if (!interactive()) throw new Error('Pass --yes to upload without a prompt.');
      if (!/^y(es)?$/i.test((await ask('We are uploading evidences. Continue? [y/N] ')).trim())) { say('Not uploaded.'); return; }
    }
    const { url, key } = await api();
    const sha256 = createHash('sha256');
    await pipeline(createReadStream(gz), sha256);
    const data = await sendChunks({
      url, key, sandbox: box.id, name: box.name, file: gz, size, sha256: sha256.digest('hex'),
      onProgress: (sent) => { if (process.stdout.isTTY) process.stdout.write(`\rUploading: ${mb(sent)} of ${mb(size)}`); },
    });
    if (process.stdout.isTTY) say();
    say(`Uploaded: ${data.exchanges} exchanges for ${box.name}. Storage: ${mb(data.storage.used_bytes)} of ${mb(data.storage.limit_bytes)}.`);
    if (data.kept_until) say(`Kept until ${new Date(data.kept_until * 1000).toLocaleDateString()}.`);
    if (data.runtime?.error) say(`Note: ${data.runtime.error}; its prompts and tool calls did upload.`);
    say('See it at https://app.raytracer.si/?view=sandboxes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
