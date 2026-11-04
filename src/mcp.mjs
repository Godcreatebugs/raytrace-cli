// `raytrace mcp`: an MCP server on stdio, so an agent in VS Code, Cursor,
// Claude Code or any MCP client can create, list, stop and destroy cloud
// sandboxes. It runs on the user's machine (the IDE starts it), which is what
// lets create_sandbox pack the project the IDE has open, exactly as
// `raytrace sandbox create` does, and reuse the `raytrace auth login` sign-in.
//
// The protocol is newline-delimited JSON-RPC 2.0 on stdin/stdout, small
// enough to speak here without a dependency. stdout carries protocol messages
// only: anything else printed there would corrupt the stream, so console
// output is sent to stderr while serving.
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { accessToken, account, openUrl, startDeviceLogin } from './auth.mjs';
import { call, hasApiKeyOverride } from './api.mjs';
import { formatCreditDeadline } from './beta.mjs';
import { checkId, creditPlan, isCreditRefusal, listProject, liveSandboxes, packArchive, repoRoot, upload } from './sandbox.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DASHBOARD = 'https://app.raytracer.si';

const INSTRUCTIONS = `RayTrace cloud sandboxes: isolated copies of a Git project on RayTrace's servers, where coding-agent sessions are recorded for the user's organization dashboard (${DASHBOARD}).
- Every tool needs a RayTrace sign-in. If a tool says the user is not signed in, call login and show the user the code and link it returns; once they approve it in the browser, retry.
- create_sandbox uploads the open Git project (files git tracks or would track; .env files, keys and credentials are never uploaded).
- To work inside a sandbox, the user runs \`raytrace connect <id>\` in a terminal.
- destroy_sandbox deletes the sandbox's files and any sign-in made inside it. Its recorded traces are deleted too, unless keep_traces is passed on a paid plan. Confirm with the user first, including whether to keep the traces.
- Cloud sandboxes only; local sandboxes (raytrace sandbox create --local) are managed from the terminal.`;

const idSchema = { type: 'string', pattern: '^rtp-[a-f0-9]{32}$', description: 'The sandbox id (rtp-...), from list_sandboxes.' };

const TOOLS = [
  {
    name: 'login',
    title: 'Sign in to RayTrace',
    description: 'Sign in to RayTrace (or create an account) in the browser. Returns a code and a link to show the user; the sign-in completes when they approve it. When already signed in, says which account.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'list_sandboxes',
    title: 'List sandboxes',
    description: "The signed-in workspace's cloud sandboxes: id, name, status, age and beta credit.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'sandbox_status',
    title: 'Sandbox status',
    description: "One sandbox's details, with the command that opens a terminal in it.",
    inputSchema: { type: 'object', properties: { id: idSchema }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'create_sandbox',
    title: 'Create a sandbox',
    description: 'Upload a Git project to a new cloud sandbox and start it. Uploads what git tracks or would track, never .env files, keys or credentials; up to 200 MiB, 25 MiB a file, 20,000 files. Takes a minute or so.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A folder inside the Git project to upload; relative paths are resolved against the workspace. Defaults to the open workspace.' },
        name: { type: 'string', description: "The sandbox's name. Defaults to the project folder's name." },
        without_beta_credit: { type: 'boolean', description: "Create a plain sandbox, not using the user's beta credit. Only after the user agrees, when create_sandbox reported the credit expired or used." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'start_sandbox',
    title: 'Start a sandbox',
    description: 'Start a stopped sandbox.',
    inputSchema: { type: 'object', properties: { id: idSchema }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'stop_sandbox',
    title: 'Stop a sandbox',
    description: 'Stop a running sandbox. Its files are kept; start_sandbox brings it back.',
    inputSchema: { type: 'object', properties: { id: idSchema }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'destroy_sandbox',
    title: 'Destroy a sandbox',
    description: "Delete a sandbox: its files and any sign-in made inside it. Its recorded traces are deleted too unless keep_traces is true, which only paid plans honour (traces then stay until the plan's retention date). This cannot be undone; confirm with the user first.",
    inputSchema: {
      type: 'object',
      properties: { id: idSchema, keep_traces: { type: 'boolean', description: "Keep the sandbox's recorded traces until the retention date (paid plans). Defaults to false." } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];

// ------------------------------------------------------------- transport

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const pending = new Map(); // our requests to the client, by id
let nextId = 1;
let client = { capabilities: {} };

/** Ask the client something (roots/list); null when it does not answer in time. */
function request(method, params, timeoutMs = 5000) {
  const id = `raytrace-${nextId++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message.error ? null : message.result); });
    send({ id, method, params });
  });
}

function progress(token) {
  let step = 0;
  return (message) => { if (token !== undefined) send({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } }); };
}

// ------------------------------------------------------------- tools

const text = (body, structured) => ({ content: [{ type: 'text', text: body }], ...(structured ? { structuredContent: structured } : {}) });
class ToolError extends Error {}

let signIn = null; // the device login under way: { user_code, verification_uri, ..., error }

async function requireSignIn() {
  if (hasApiKeyOverride()) return;
  let token;
  try { token = await accessToken(); }
  catch (error) { throw new ToolError(`${error.message.replace(/ Run: raytrace auth login$/, '')} Call the login tool to sign in again.`); }
  if (token) return;
  if (signIn && !signIn.error) {
    throw new ToolError(`Not signed in yet: waiting for the user to approve code ${signIn.user_code} at ${signIn.verification_uri_complete || signIn.verification_uri}. Retry once they have.`);
  }
  throw new ToolError('Not signed in to RayTrace. Call the login tool, then show the user the code and link it returns.');
}

async function login() {
  if (hasApiKeyOverride()) return text('Using the RAYTRACE_API_KEY development key; no sign-in needed.');
  const token = await accessToken().catch(() => null);
  if (token) return text(`Signed in to RayTrace as ${account() ?? 'an unknown account'}.`, { signed_in: true, account: account() });
  if (!signIn || signIn.error) {
    const started = await startDeviceLogin();
    signIn = { ...started, error: null };
    const current = signIn;
    started.done.then(() => { if (signIn === current) signIn = null; },
      (error) => { current.error = error.message; });
    openUrl(started.verification_uri_complete || started.verification_uri);
  }
  const link = signIn.verification_uri_complete || signIn.verification_uri;
  return text(`Show the user this, then retry their request once they have approved it:\n\n`
    + `Sign in to RayTrace: open ${link} (a browser tab was opened on this machine) and approve the code ${signIn.user_code}. `
    + 'New to RayTrace? The same page creates an account.',
  { signed_in: false, user_code: signIn.user_code, verification_uri: link });
}

function describe(box) {
  const created = typeof box.created === 'number' ? box.created * 1000 : Date.parse(box.created);
  const minutes = Number.isFinite(created) ? Math.round((Date.now() - created) / 60000) : null;
  const age = minutes === null ? '' : `, ${minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} old`;
  const beta = box.beta && typeof box.credit_usd === 'number'
    ? `, beta credit $${Math.max(0, box.credit_usd - (box.credit_spent_usd ?? 0)).toFixed(2)} of $${box.credit_usd} left${box.credit_expires_at ? ` (ends ${formatCreditDeadline(box.credit_expires_at)})` : ''}`
    : '';
  return `${box.id}  ${box.status}  ${box.name}${age}${beta}`;
}

async function listSandboxes() {
  const boxes = await liveSandboxes();
  if (!boxes.length) return text('No sandboxes yet. create_sandbox makes one from the open Git project.', { sandboxes: [] });
  return text(boxes.map(describe).join('\n'), { sandboxes: boxes });
}

async function findSandbox(id) {
  const box = (await liveSandboxes()).find((each) => each.id === checkId(id));
  if (!box) throw new ToolError(`No sandbox ${id} in ${account() ? `${account()}'s` : 'this'} workspace. list_sandboxes shows the ones there are.`);
  return box;
}

async function sandboxStatus({ id }) {
  const box = await findSandbox(id);
  return text(`${describe(box)}\nOpen a terminal in it: raytrace connect ${box.id}\nRecorded sessions: ${DASHBOARD}`, { sandbox: box, connect: `raytrace connect ${box.id}` });
}

/** The folders the client has open, as paths; [] when it shares none. */
async function workspaceRoots() {
  if (!client.capabilities.roots) return [];
  const result = await request('roots/list', {});
  return (result?.roots ?? []).filter((root) => root.uri?.startsWith('file://')).map((root) => fileURLToPath(root.uri));
}

async function projectRoot(path) {
  const roots = await workspaceRoots();
  if (path) {
    const base = roots[0] ?? process.cwd();
    const dir = isAbsolute(path) ? path : resolve(base, path);
    const root = repoRoot(dir);
    if (!root) throw new ToolError(`${dir} is not inside a Git repository. A sandbox is made from one.`);
    return root;
  }
  const repos = [...new Set((roots.length ? roots : [process.cwd()]).map((dir) => repoRoot(dir)).filter(Boolean))];
  if (repos.length === 1) return repos[0];
  if (repos.length > 1) throw new ToolError(`The workspace has more than one Git project; pass path as one of:\n${repos.join('\n')}`);
  throw new ToolError(`No Git project in ${roots.length ? roots.join(', ') : process.cwd()}. Pass path: a folder inside the Git project to upload.`);
}

async function createSandbox({ path, name, without_beta_credit: plain = false }, step) {
  const root = await projectRoot(path);
  const { plan, beta } = plain ? { plan: 'none' } : await creditPlan();
  if (plan === 'expired') {
    throw new ToolError('No sandbox was created: the user\'s $10 beta credit expired (its 3 days ran out; unused credit does not carry over). '
      + 'Ask the user whether to create a plain sandbox without beta credit; if they agree, call create_sandbox again with without_beta_credit: true.');
  }
  const useCredit = plan === 'use';
  const { files, skipped, total } = listProject(root);
  const listed = `Uploaded ${files.length} files (${(total / 1048576).toFixed(1)} MiB) from ${root}.`
    + (skipped.length ? ` Not uploaded (${skipped.length}): ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', ...' : ''}.` : '');
  step(`Packing ${files.length} files from ${root}`);
  const archive = await packArchive(root, files);
  step('Creating the sandbox');
  let box;
  try {
    box = await upload(archive, name || basename(root), useCredit);
  } catch (error) {
    if (!useCredit || !isCreditRefusal(error)) throw error;
    throw new ToolError(`No sandbox was created: the user's beta credit ${error.status === 410 ? 'expired before the sandbox was created' : 'was already used on another sandbox'}. `
      + 'Ask the user whether to create a plain sandbox without beta credit; if they agree, call create_sandbox again with without_beta_credit: true.');
  }
  const lines = [
    `Sandbox ${box.id} is running.`,
    listed,
    box.credit_applied ? `Beta credit applied: $${box.credit_usd ?? beta?.credit_usd ?? 10} (OpenRouter)${box.credit_expires_at ? `, ends ${formatCreditDeadline(box.credit_expires_at)}` : ''}.` : '',
    box.transcripts ? 'Claude Code sessions in it are recorded.' : `Claude Code transcripts are off: ${box.transcripts_off}. Commands are still recorded.`,
    `Open a terminal in it: raytrace connect ${box.id}`,
    `Recorded sessions: ${DASHBOARD}`,
  ];
  return text(lines.filter(Boolean).join('\n'), { sandbox: box, connect: `raytrace connect ${box.id}` });
}

async function lifecycle(action, { id }) {
  const box = await call('POST', `/v1/sandboxes/${checkId(id)}/${action}`);
  return text(action === 'stop' ? `${box.id} stopped; its files are kept.` : `${box.id} running.`, { sandbox: box });
}

async function destroySandbox({ id, keep_traces: keep = false }) {
  const result = await call('DELETE', `/v1/sandboxes/${checkId(id)}${keep ? '?keep_traces=1' : ''}`);
  const traces = result.traces_kept ? `Its traces are kept until ${new Date(result.traces_kept_until * 1000).toLocaleDateString()}.`
    : result.traces_deleted === false ? 'Its traces could not be deleted; they may still show on the dashboard.'
    : keep ? 'Its traces were deleted: keeping them needs a paid plan (https://raytracer.si/pricing).'
    : 'Its traces were deleted too.';
  return text(`${id} destroyed. ${traces}`, { id, destroyed: true, ...result });
}

const HANDLERS = {
  login: () => login(),
  list_sandboxes: () => listSandboxes(),
  sandbox_status: (args) => sandboxStatus(args),
  create_sandbox: (args, step) => createSandbox(args, step),
  start_sandbox: (args) => lifecycle('start', args),
  stop_sandbox: (args) => lifecycle('stop', args),
  destroy_sandbox: (args) => destroySandbox(args),
};

async function callTool({ name, arguments: args = {}, _meta: meta } = {}) {
  const handler = HANDLERS[name];
  if (!handler) return null;
  try {
    if (name !== 'login') await requireSignIn();
    return await handler(args, progress(meta?.progressToken));
  } catch (error) {
    // Failures go back to the agent as tool results it can act on.
    return { ...text(error.message), isError: true };
  }
}

// ------------------------------------------------------------- dispatch

async function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  if (!method) { // a response to one of our requests
    pending.get(id)?.(message);
    pending.delete(id);
    return;
  }
  const respond = (result) => { if (id !== undefined) send({ id, result }); };
  const fail = (code, error) => { if (id !== undefined) send({ id, error: { code, message: error } }); };
  switch (method) {
    case 'initialize': {
      client = { capabilities: params?.capabilities ?? {}, info: params?.clientInfo };
      const asked = params?.protocolVersion;
      return respond({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'raytrace', title: 'RayTrace', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return respond({});
    case 'tools/list': return respond({ tools: TOOLS });
    case 'tools/call': {
      const result = await callTool(params);
      return result ? respond(result) : fail(-32602, `Unknown tool: ${params?.name}`);
    }
    default:
      if (method.startsWith('notifications/')) return; // initialized, cancelled, roots/list_changed
      return fail(-32601, `Method not found: ${method}`);
  }
}

export async function serve() {
  for (const level of ['log', 'info', 'warn', 'debug']) console[level] = console.error;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    // Not awaited one by one: a ping must be answered while a sandbox is being created.
    for (const each of Array.isArray(message) ? message : [message]) {
      const job = handle(each).catch((error) => {
        if (each?.id !== undefined && each?.method) send({ id: each.id, error: { code: -32603, message: error.message } });
      });
      inFlight.add(job);
      job.finally(() => inFlight.delete(job));
    }
  }
  await Promise.all(inFlight);
}
