/**
 * The sandbox bridge: where a local sandbox's Claude Code hook
 * (worker/sandbox/claude-hook.mjs) sends its transcript. A sandbox in the
 * Lima VM reaches this machine's loopback at 192.168.5.2, and the VM's
 * firewall (worker/sandbox/network.py) lets it reach this one port and no
 * other, so it listens on 127.0.0.1 only.
 *
 * Each request carries the sandbox's token (set at create, kept in
 * ~/.raytrace/sandboxes.json), which names the sandbox, and the transcript's
 * next whole lines from `offset`. `ingest(sandbox, note)` does the rest (the
 * proxy's ingestFromSandbox): an offset that is not where its copy ends is
 * answered 409 with the copy's size, and the hook resends from there.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BODY = 4_500_000;

export function startSandboxBridge({ dataDir, port, ingest }) {
  async function sandboxFor(token) {
    if (typeof token !== 'string' || token.length < 40) return null;
    try {
      const boxes = JSON.parse(await readFile(join(dataDir, 'sandboxes.json'), 'utf8'));
      return Object.keys(boxes).find((id) => boxes[id]?.token === token) ?? null;
    } catch { return null; }
  }

  const server = createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/raytace/ingest/claude-code') return json(404, { error: 'Unknown endpoint.' });
    const sandbox = await sandboxFor(req.headers['x-raytace-sandbox-token']);
    if (!sandbox) return json(403, { error: 'Unknown sandbox token.' });
    const chunks = []; let size = 0;
    for await (const part of req) { size += part.length; if (size > MAX_BODY) return json(413, { error: 'Request too large.' }); chunks.push(part); }
    let note;
    try { note = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: 'Invalid JSON.' }); }
    try {
      const { status, body } = await ingest(sandbox, note);
      json(status, body);
    } catch (error) { json(500, { error: error.message }); }
  });
  server.on('error', (error) => console.error(`Sandbox bridge on :${port} did not start: ${error.message}. Local sandboxes' Claude Code sessions will not reach the dashboard.`));
  server.listen(port, '127.0.0.1', () => console.log(`Sandbox bridge listening on http://127.0.0.1:${port}`));
  return server;
}
