#!/usr/bin/env node
import { requestMetrics } from './request-metrics.mjs';
import { redact, parseSseResponse } from './capture.mjs';
import { trustedOrigin as originAllowed, trustedRequest, hasToken, hasSession, sessionFor, sessionCookie, viewerTokenFor } from './request-policy.mjs';
import { ensureToken } from './local-token.mjs';
/** Local API recorder. Point a compatible client at http://127.0.0.1:8797. */
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { realpathSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join, dirname, resolve, extname, sep } from 'node:path';
import { exchangesFromTranscript, parseTranscript, toolResultsFromTranscript } from './claude-code-adapter.mjs';
import { replayEligibility, createExperiment, runExperiment } from './experiment-engine.mjs';
import { loadEnvFile } from 'node:process';
import { providerConfig, routeRequest, selectModel } from './providers.mjs';
import { inspectStep, createStepRun, runDecision } from './step-lab.mjs';
import { executeSequence } from './execution-runner.mjs';
import { explanationRequest, parseExplanations } from './explanations.mjs';
import { summaryRequest, parseSummary, resultText } from './summaries.mjs';
import { fold as foldEvents, describeAll, undescribed, describeRequest, parseDescriptions, attributeMarked } from './exec-narrative.mjs';
import { ingestExecutions, attributeLateProcesses } from './runtime-attribution.mjs';
import { readTraces as traceView } from './trace-view.mjs';
import { categoryResolver } from './call-category.mjs';
import { startGvisorForwarder } from './gvisor-forwarder.mjs';
import { startPlayground, FORK_ID } from './playground.mjs';
import { omitToolChunkIds } from './tool-metadata.mjs';
import { openEvidenceStore } from './evidence-store.mjs';
import { startSandboxBridge } from './sandbox-bridge.mjs';
import { localSandboxes, VM } from './local-sandboxes.mjs';
import { typesafeConfig, systemOne } from './typesafe.mjs';
import { promptContext, contextItemText, contextSummaryRequest, parseContextSummary } from './prompt-context.mjs';
import { recapOutline, recapRequest, recapText, parseRecap, DEFAULT_OBSERVER } from './run-recap.mjs';
import { groupByCall, assessmentRequests, combineGroup, rulesOnly, withProbabilities } from './call-assessment.mjs';
import { prepareStep, attributionKey, proposerRequest, parseProposals, candidates, jevRequests, combine, withoutJev } from './step-attribution.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const routing = providerConfig();
// Summaries default to the cheapest configured alias so per-step summarizing
// (many small calls) doesn't rack up cost; override with RAYTACE_SUMMARY_MODEL.
const summaryModel = process.env.RAYTACE_SUMMARY_MODEL
  ? selectModel(routing, process.env.RAYTACE_SUMMARY_MODEL)
  : (routing.models.oss || routing.defaultModel);
// Bumped whenever the dashboard needs endpoints an older proxy lacks; the
// CLI restarts a proxy it started that reports less (src/proxy-process.mjs).
const PROXY_API = 4;
const fallbackSession = { session_id: randomUUID(), session_started_at: new Date().toISOString() };

const port = Number(process.env.RAYTACE_PORT || 8797);
// The evidence viewer of the local sandbox VM (worker/sandbox/viewer.py),
// which Lima forwards here.
const EVIDENCE_VIEWER = process.env.RAYTACE_EVIDENCE_VIEWER || 'http://127.0.0.1:8798';
// The CLI sets RAYTACE_DATA_DIR (~/.raytrace); run by hand it keeps ./.raytace.
const dataDir = process.env.RAYTACE_DATA_DIR || join(process.cwd(), '.raytace');
const store = process.env.RAYTACE_STORE || join(dataDir, 'events.jsonl');
// Who may use the local API (local-token.mjs). `raytrace open` trades it for a
// one-time ticket, so the link it hands the browser is worth nothing afterwards.
const apiToken = ensureToken(dataDir);
const TICKET_MS = 2 * 60 * 1000;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const tickets = new Set();
const NOT_SIGNED_IN = { error: 'Not signed in to this RayTrace. Run: raytrace open', code: 'not_signed_in' };
const fromViewer = (url, init = {}) => fetch(url, { ...init, headers: { authorization: `Bearer ${viewerTokenFor(apiToken)}` } });
// The local sandboxes (raytrace sandbox create --local): in place of raytace's sandbox manager.
const sandboxes = localSandboxes({ dataDir });
const NO_VM = `Local sandbox VM (${VM}) not reachable. Start a sandbox with: raytrace sandbox start <name>`;
const maxBodyBytes = Number(process.env.RAYTACE_MAX_BODY_BYTES || 2_000_000);
const liveExchanges = new Map(); // Credentials stay in process memory, never in the event log.
const jobs = new Map();
const jobControllers = new Map();
const dbFile = process.env.RAYTACE_DB || join(dirname(store), 'evidence.db');
const archiveJsonl = process.env.RAYTACE_ARCHIVE_JSONL === '1';
const db = openEvidenceStore(dbFile);
const allowedOrigins = new Set((process.env.RAYTACE_UI_ORIGINS || '').split(',').filter(Boolean));
const trustedOrigin = (origin) => originAllowed(origin, allowedOrigins);
const hash = (value) => createHash('sha256').update(value).digest('hex');
// Command severity (Jev). Without TYPESAFE_API_KEY, or when a request fails,
// only the rule floor is shown -- and only where a rule actually fired.
const typesafe = typesafeConfig();
const pendingAssessments = new Map();
const ASSESS_CONCURRENCY = 4;

async function mapLimit(items, limit, run) {
  const results = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await run(items[index]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function assessGroup(group, context) {
  if (!typesafe.enabled) return rulesOnly(group);
  const { key, requests } = assessmentRequests(group, context, typesafe.model);
  const cached = db.getCallAssessment(key);
  if (cached) return withProbabilities(cached);
  if (!pendingAssessments.has(key)) {
    const task = (async () => {
      const responses = await Promise.all(requests.map((request) => systemOne(typesafe, { state: request.state, questions: request.questions })));
      const model = responses[0]?.model ?? typesafe.model;
      const input_tokens = responses.reduce((sum, response) => sum + (response.usage?.input_tokens ?? 0), 0);
      const result = { ...combineGroup(group, requests, responses), model, input_tokens };
      db.putCallAssessment(key, group.call_id, model, { ...result, answers: responses.map((response) => response.answers) });
      return result;
    })().finally(() => pendingAssessments.delete(key));
    pendingAssessments.set(key, task);
  }
  try { return await pendingAssessments.get(key); } catch (error) {
    console.error('[raytace] Jev assessment unavailable:', error.message);
    return rulesOnly(group);
  }
}

/** Sets `severity` on each top-level command and returns call-level labels
 * keyed by call id. Never throws: severity must not cost us the evidence. */
async function assessCommands(commands) {
  const groups = groupByCall(commands);
  const contexts = db.toolCallContexts(groups.map((group) => group.call_id));
  const results = await mapLimit(groups, ASSESS_CONCURRENCY, (group) => assessGroup(group, contexts.get(group.call_id) ?? null));
  const labels = {};
  groups.forEach((group, index) => {
    const { severities, labels: callLabels } = results[index];
    group.trees.forEach((tree, position) => { tree.root.severity = severities[position] ?? null; });
    if (callLabels && group.call_id) labels[group.call_id] = callLabels;
  });
  return labels;
}

async function record(event) {
  const row = omitToolChunkIds(event);
  if (row.event_type === 'model.exchange' && row.span_id) db.recordExchange(row);
  else if (row.event_type === 'proxy.error') db.recordProxyError(row);
  // Opt-in raw archive; the database is the source of truth.
  if (archiveJsonl) { await mkdir(dirname(store), { recursive: true }); await appendFile(store, `${JSON.stringify(row)}\n`); }
}
function safeHeaders(headers) { const keep = ['content-type', 'anthropic-version', 'openai-beta', 'user-agent', 'x-request-id']; return Object.fromEntries(Object.entries(headers).filter(([key]) => keep.includes(key.toLowerCase()))); }
async function invokeReplay(entry, payload, signal) {
  const headers = Object.fromEntries(Object.entries(entry.headers).filter(([key]) =>
    ['authorization', 'content-type', 'openai-organization', 'openai-project', 'openai-beta', 'user-agent'].includes(key.toLowerCase())));
  const response = await fetch(entry.upstreamUrl, {
    method: 'POST', headers, body: JSON.stringify(payload),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Provider returned HTTP ${response.status}; batch stopped. Credentials may have expired or the intervention may be invalid.`); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > maxBodyBytes) throw new Error('Replay response exceeded the capture size limit.'); chunks.push(chunk); }
  const body = Buffer.concat(chunks);
  return response.headers.get('content-type')?.includes('text/event-stream') ? parseSseResponse(body) : JSON.parse(body.toString());
}
async function persistExperiment(job) { db.saveExperiment(redact(omitToolChunkIds(job))); }
/** The fields that identify and time the sandbox process a call ran as
 * (db.divergence). All null when nothing was observed for the call. */
// The trace list takes seconds to build for long sessions and is polled every
// few seconds, mostly with nothing new: it is rebuilt only when the data
// behind it changed (db.dataVersion), and one build serves every caller.
// The body is serialized once per version too, and its version is its ETag,
// so a poll with nothing new is answered 304 without sending anything.
/** The trace view over this proxy's store; a replay is offered for exchanges
 * still held in memory (liveExchanges). */
function readTraces(includeHistory = false, { evidence = true } = {}) {
  return traceView(db, { includeHistory, evidence, replayReason: (spanId) => {
    const live = liveExchanges.get(spanId);
    return live ? replayEligibility(live) : undefined;
  } });
}
const traceCache = new Map(); // url -> { version, body: Promise<string> }
// The Tool column's category for a shell command no rule places (Jev). An
// answer changes no row dataVersion counts, so each one moves the view's
// version itself: the next poll is rebuilt and not answered 304.
const resolveCategories = categoryResolver({ config: typesafe, ask: (request) => systemOne(typesafe, request) });
let categoryAnswers = 0;
function cachedTraces(url) {
  const version = `${db.dataVersion()}:${categoryAnswers}`;
  const hit = traceCache.get(url);
  if (hit?.version === version) return hit;
  const body = readTraces(url !== '/raytace/traces', { evidence: url !== '/raytace/traces?scope=history' })
    .then((traces) => resolveCategories(traces, { get: (key) => db.getCallAssessment(key),
      put: (key, model, value) => db.putCallAssessment(key, null, model, value),
      onSettled: () => { categoryAnswers += 1; } }))
    .then((traces) => JSON.stringify({ traces }));
  const entry = { version, etag: `"${version}"`, body };
  traceCache.set(url, entry);
  body.catch(() => { if (traceCache.get(url) === entry) traceCache.delete(url); });
  return entry;
}

/** `evidence: false` skips building each request's context items, the
 * costliest part (every request resends the conversation so far), for
 * callers that do not send them on. */


// Context window sizes, from OpenRouter's public model list (no key needed),
// fetched once. Null when the model is not listed or the list is unreachable.
let contextWindows = null;
async function contextWindow(model) {
  if (!model) return null;
  if (!contextWindows) {
    contextWindows = fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(5000) })
      .then((response) => (response.ok ? response.json() : { data: [] }))
      .then((body) => new Map((body.data ?? []).map((item) => [item.id, item.context_length ?? null])))
      .catch(() => { contextWindows = null; return new Map(); });
  }
  const windows = await contextWindows;
  return windows.get(model) ?? windows.get(`openai/${model}`) ?? windows.get(`anthropic/${model}`) ?? null;
}
/** The context analysis for one prompt, from the last request of its turn. */
async function promptContextFor(traceId) {
  const trace = (await readTraces(true, { evidence: false })).find((item) => item.id === traceId);
  const last = trace?.requests?.at(-1);
  const entry = last ? await savedOrLive(last.id) : null;
  if (!entry) return null;
  return { trace, context: promptContext(entry, trace.promptRaw ?? trace.title, trace.answer ?? '') };
}
// Recap (run-recap.mjs): the observer, a stronger model than the ones that
// label single steps, reads one prompt's run and says what it did and why.
// It is asked for by id, outside the sandboxes' model list.
const observerModel = process.env.RAYTACE_OBSERVER_MODEL || DEFAULT_OBSERVER;
const pendingRecaps = new Map();
/** The recap request for one prompt as it stands now, or null (no such prompt, or no tool calls). */
async function currentRecapRequest(traceId) {
  const trace = (await readTraces(true, { evidence: false })).find((item) => item.id === traceId);
  const outline = trace ? recapOutline(trace) : null;
  return outline ? { outline, ...recapRequest(outline, observerModel) } : null;
}
async function askObserver(payload) {
  const response = await fetch(`${routing.upstreams.openrouter}/v1/chat/completions`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${routing.apiKey}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`The observer model returned HTTP ${response.status}.`); }
  return response.json();
}
async function savedOrLive(exchangeId) {
  return liveExchanges.get(exchangeId) || db.findExchange(exchangeId);
}
/** The summary request for one step as it stands now, or null. Its key
 * changes with the summary version and with the step's own results, which
 * are recorded once a later request carries them back. */
async function currentSummaryRequest(exchangeId) {
  const entry = await savedOrLive(exchangeId);
  if (!entry) return null;
  const ownCalls = (entry.response?.output ?? []).filter((item) => item?.call_id);
  const contexts = db.toolCallContexts(ownCalls.map((item) => item.call_id));
  const ownResults = ownCalls.map((item) => ({ from: item.name, output: resultText(contexts.get(item.call_id)?.result) }));
  return summaryRequest(entry, exchangeId, summaryModel, ownResults);
}
// Chain of thought (step-attribution.mjs): why one tool call was made. Only
// for prompts run in the sandbox (rtp- sessions); anything else is refused
// before a model is called.
const attributionModel = process.env.RAYTACE_ATTRIBUTION_MODEL ? selectModel(routing, process.env.RAYTACE_ATTRIBUTION_MODEL) : routing.defaultModel;
const SANDBOX_SESSION = /^rtp-[a-f0-9]{32}$/;
const pendingAttributions = new Map();
const MAX_CONCURRENT_ATTRIBUTIONS = 4;

/** The step and its cache key, or an `{ status, error }` to send back. */
function attributionStep(exchangeId, outputIndex) {
  const entry = db.findExchange(String(exchangeId ?? ''));
  if (!entry) return { status: 404, error: 'Saved step not found.' };
  if (!SANDBOX_SESSION.test(entry.session_id ?? '')) return { status: 403, error: 'Chain of thought is only available for prompts run in the sandbox.' };
  if (!entry.payload || !entry.response) return { status: 409, error: 'This capture has no saved request or response.' };
  const step = prepareStep(omitToolChunkIds(entry), Number(outputIndex));
  if (!step) return { status: 400, error: 'That output is not a tool call.' };
  const proposer = routing.mode === 'openrouter' ? attributionModel : null;
  return { step, key: attributionKey(step, proposer, typesafe.enabled ? typesafe.model : null), proposer };
}

async function computeAttribution({ step, proposer }) {
  let proposals = [];
  let proposer_error = null;
  if (proposer) {
    try {
      const { payload } = proposerRequest(step, proposer);
      const routed = routeRequest(routing, { method: 'POST', url: '/v1/responses', headers: {} }, Buffer.from(JSON.stringify(payload)));
      const response = await invokeReplay({ headers: routed.headers, upstreamUrl: routed.url }, payload, new AbortController().signal);
      proposals = parseProposals(response, step.items);
    } catch (error) { proposer_error = error.message; console.error('[raytace] Cause proposer unavailable:', error.message); }
  }
  const cands = candidates(step, proposals);
  let result;
  let jev_model = null;
  if (!typesafe.enabled) result = withoutJev(cands, 'Add a TypeSafe key to rank these: raytrace key typesafe');
  else {
    try {
      const { requests } = jevRequests(step, cands);
      const responses = await Promise.all(requests.map((request) => systemOne(typesafe, request)));
      jev_model = responses[0]?.model ?? typesafe.model;
      result = combine(cands, responses);
    } catch (error) { console.error('[raytace] Jev attribution unavailable:', error.message); result = withoutJev(cands, 'Jev was unavailable.'); }
  }
  return { ...result, action: step.call.name, proposer_model: proposer, proposer_error, jev_model };
}

const pendingExplanations = new Map();
const pendingSummaries = new Map();
const MAX_CONCURRENT_SUMMARIES = 4; // cheap+budget-capped calls; safe to run several at once instead of one at a time


// ---------------------------------------------------------------- Claude Code
// Proxy-free capture: Claude Code's hooks ring, and its session transcript is
// rebuilt into the same exchange rows the proxy records (claude-code-adapter).
const claudeProjects = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
const CLAUDE_CODE_FINAL_EVENTS = new Set(['Stop', 'SubagentStop', 'SessionEnd']);
function claudeCodeTranscriptPath(value) {
  if (typeof value !== 'string' || !value.endsWith('.jsonl')) return null;
  try {
    const real = realpathSync(value);
    return real.startsWith(`${realpathSync(claudeProjects)}/`) ? real : null;
  } catch { return null; }
}
// One job at a time per transcript (a write, then a read); later rings queue.
const claudeCodeQueues = new Map();
function serially(path, job) {
  const next = (claudeCodeQueues.get(path) ?? Promise.resolve()).then(job);
  const settled = next.catch(() => {}).finally(() => { if (claudeCodeQueues.get(path) === settled) claudeCodeQueues.delete(path); });
  claudeCodeQueues.set(path, settled);
  return next;
}
/** `session` files the rows under a sandbox's rtp- id instead of the
 * transcript's own session, and ties its processes to them afterwards. */
function ingestClaudeCode(path, { final, session = null }) {
  serially(path, async () => {
    const lines = parseTranscript(await readFile(path, 'utf8'));
    const rows = exchangesFromTranscript(lines,
      { final, sessionId: session?.id ?? null, sessionStartedAt: session?.startedAt ?? null });
    for (const row of rows) {
      await record({ ...row, request: { ...row.request, payload: redact(row.request.payload) }, response: { ...row.response, payload: redact(row.response.payload) } });
    }
    for (const [callId, item] of toolResultsFromTranscript(lines)) {
      db.recordToolResult?.(callId, item);
    }
    if (session) await attributeLateProcesses(db, session.id);
  }).catch((error) => console.error(`Claude Code transcript ${path} could not be read: ${error.message}`));
}

// A sandboxed Claude Code's transcript lives in the sandbox. Its hook sends
// the new lines through the sandbox manager, which names the sandbox; they
// are appended to a copy here and read like any local transcript. `offset`
// must equal the copy's size, so a lost or repeated send is never spliced in
// twice: a mismatch answers 409 with the size to resend from.
const SANDBOX_ID = /^rtp-[a-f0-9]{32}$/;
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sandboxTranscripts = join(dirname(store), 'claude-code');
// Playground forks of those sessions (playground.mjs). The hook installed in
// a fork is read fresh each time, so a fork runs the repo's current version.
const playground = startPlayground({ db, transcriptsDir: sandboxTranscripts,
  hookSource: () => readFileSync(new URL('../worker/sandbox/claude-hook.mjs', import.meta.url), 'utf8') });
async function appendSandboxTranscript(sandbox, note) {
  if (!CLAUDE_SESSION_ID.test(note?.session_id ?? '') || !Number.isInteger(note.offset) || note.offset < 0
    || typeof note.text !== 'string' || (note.more !== undefined && typeof note.more !== 'boolean')) return { status: 400, body: { error: 'Expected session_id, offset and a text fragment with optional more flag.' } };
  const directory = join(sandboxTranscripts, sandbox);
  const path = join(directory, `${note.session_id}.jsonl`);
  return serially(path, async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const size = await stat(path).then((info) => info.size, () => 0);
    if (note.offset !== size) return { status: 409, body: { size } };
    await appendFile(path, note.text, { mode: 0o600 }); // creates it when a snapshot arrives before any line
    return { status: 200, body: { size: size + Buffer.byteLength(note.text) }, path };
  });
}

/** A snapshot as the sandbox hook reports it, checked field by field, or
 * null. Paths are the agent's to name, so they are only bounded, never trusted. */
function sandboxSnapshot(value) {
  const sha = /^[0-9a-f]{40}$/;
  if (!value || typeof value !== 'object' || !sha.test(value.commit ?? '') || (value.parent != null && !sha.test(value.parent))
    || !['prompt', 'tool'].includes(value.taken_on) || (value.call_id != null && !/^[A-Za-z0-9_-]{1,128}$/.test(value.call_id))
    || !Number.isFinite(Date.parse(value.taken_at ?? ''))) return null;
  const path = (item) => typeof item === 'string' && item.length <= 1024;
  const count = (item) => (Number.isInteger(item) && item >= 0 ? item : null);
  const changes = (Array.isArray(value.changes) ? value.changes : []).slice(0, 300).filter((item) => path(item?.path))
    .map((item) => ({ path: item.path, status: /^[ADMTUX]$/.test(item.status ?? '') ? item.status : '?', added: count(item.added), removed: count(item.removed) }));
  return { commit: value.commit, parent: value.parent ?? null, taken_on: value.taken_on, call_id: value.call_id ?? null,
    taken_at: value.taken_at, changed: value.changed === true, changes,
    too_big: (Array.isArray(value.too_big) ? value.too_big : []).slice(0, 300).filter(path) };
}


// The prebuilt dashboard (RAYTACE_DASHBOARD_DIR), served from / so it and the
// API share one origin. Model traffic is under /v1 and the API under /raytace,
// so any other GET from a browser (no credentials) is a dashboard file; unknown
// paths get index.html.
const dashboardDir = process.env.RAYTACE_DASHBOARD_DIR ? resolve(process.env.RAYTACE_DASHBOARD_DIR) : null;
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
async function serveDashboard(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = resolve(dashboardDir, `.${path}`);
  if (file !== dashboardDir && !file.startsWith(dashboardDir + sep)) { res.writeHead(404); return res.end(); }
  let body;
  try { body = await readFile(file); }
  catch { file = join(dashboardDir, 'index.html'); body = await readFile(file); }
  const immutable = path.startsWith('/assets/');
  res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] || 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(body);
}

/** A local sandbox's Claude Code transcript lines, from its hook through the
 * sandbox bridge (sandbox-bridge.mjs), which has named the sandbox by its
 * token: copied here and read like a local transcript, filed under the
 * sandbox's rtp- id so its recorded processes join them. Returns {status, body}. */
async function ingestFromSandbox(sandbox, note) {
  // A Playground fork sends with the project's token, so the bridge names
  // the project; the fork's own steps are filed under the fork, and only
  // for a fork RayTrace made of that project.
  const fork = note?.fork == null ? null : FORK_ID.test(note.fork) ? playground.forkOf(note.fork, sandbox) : false;
  if (fork === false || (note?.fork != null && !fork)) return { status: 403, body: { error: 'Unknown Playground fork.' } };
  const filedUnder = fork ? fork.id : sandbox;
  const written = await appendSandboxTranscript(filedUnder, note).catch(() => ({ status: 500, body: { error: 'Transcript copy could not be written.' } }));
  const snapshot = written.path ? sandboxSnapshot(note.snapshot) : null;
  if (snapshot) {
    try { db.recordSnapshot({ sessionId: filedUnder, agentSessionId: note.session_id, snapshot }); }
    catch (error) { console.error(`Snapshot for ${filedUnder} could not be recorded: ${error.message}`); }
  }
  if (written.path) ingestClaudeCode(written.path, { final: CLAUDE_CODE_FINAL_EVENTS.has(note.hook_event_name) && note.more !== true,
    session: { id: filedUnder, startedAt: fork ? fork.created_at : await sandboxes.createdAt(sandbox) } });
  return written;
}

const server = createServer(async (req, res) => {
  // Guard every route before either dashboard assets or paid provider calls.
  if (!trustedRequest(req, allowedOrigins)) {
    res.writeHead(403); return res.end('Untrusted dashboard origin or host.');
  }
  const fromAgent = req.headers.authorization || req.headers['x-api-key'] || req.headers['anthropic-version'];
  if (dashboardDir && req.method === 'GET' && !fromAgent && !req.url?.startsWith('/raytace/') && !req.url?.startsWith('/v1/')) {
    try { return await serveDashboard(req, res); }
    catch { res.writeHead(404); return res.end('Dashboard not built.'); }
  }
  const localApi = req.url?.startsWith('/raytace/');
  const corsHeaders = { ...(req.headers.origin && trustedOrigin(req.headers.origin) ? { 'access-control-allow-origin': req.headers.origin } : {}), vary: 'Origin', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'authorization,content-type,x-raytace-experiment,if-none-match', 'access-control-allow-private-network': 'true' };
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders, 'cache-control': 'no-store' }); res.end(JSON.stringify(redact(omitToolChunkIds(value)))); };
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }
  const ticket = req.url?.match(/^\/raytace\/session\?ticket=([a-f0-9]{64})$/)?.[1];
  if (req.method === 'GET' && ticket) {
    if (!tickets.delete(ticket)) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return res.end('This link was used already, or has expired. Run: raytrace open\n'); }
    res.writeHead(302, { location: '/', 'cache-control': 'no-store', 'set-cookie': `${sessionCookie(req.socket.localPort)}=${sessionFor(apiToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` });
    return res.end();
  }
  // Only the API version is public: the CLI and dashboard read it to spot an outdated proxy.
  if (localApi && req.url !== '/raytace/version' && !hasToken(req, apiToken) && !hasSession(req, apiToken, req.socket.localPort)) return json(401, NOT_SIGNED_IN);
  if (req.method === 'POST' && req.url === '/raytace/session') {
    if (!hasToken(req, apiToken)) return json(401, NOT_SIGNED_IN);
    const issued = randomBytes(32).toString('hex');
    tickets.add(issued);
    setTimeout(() => tickets.delete(issued), TICKET_MS).unref();
    return json(201, { ticket: issued });
  }
  // This machine's local sandboxes. With the VM stopped they are still listed,
  // from the CLI's records, as stopped. Prompt history comes from the traces.
  if (req.method === 'GET' && req.url === '/raytace/sandboxes') {
    const shape = (box, status) => ({ id: box.id, name: box.name, host: 'lima', on_host: true, status, created: box.created,
      deleted: null, size_bytes: box.size_bytes ?? null, imported_bytes: null, transcripts: true, skipped_count: 0, scan: null });
    try { return json(200, { sandboxes: (await sandboxes.list()).filter((box) => !box.fork_of).map((box) => shape(box, box.status === 'running' ? 'running' : 'stopped')) }); }
    catch { return json(200, { sandboxes: (await sandboxes.known()).map((box) => shape(box, 'stopped')) }); }
  }
  // What the kernel layer saw a sandbox do: the fact engine's records in the VM.
  const activityRoute = req.url?.match(/^\/raytace\/sandboxes\/(rtp-[a-f0-9]{32})\/activity(?:\?([a-z0-9=&]{1,80}))?$/);
  if (req.method === 'GET' && activityRoute) {
    const query = new URLSearchParams(activityRoute[2] ?? '');
    const window = { since: Number(query.get('since')) || 0, until: Number(query.get('until')) || 0 };
    try {
      const box = (await sandboxes.list()).find((item) => item.id === activityRoute[1]);
      if (!box) return json(404, { error: 'No such local sandbox.' });
      return json(200, { id: box.id, name: box.name, ...(await sandboxes.activity(box.id, window)) });
    } catch { return json(503, { error: NO_VM }); }
  }
  // The initial scan, restricted files and alerts are not kept for local sandboxes yet.
  if (/^\/raytace\/(sandboxes\/rtp-[a-f0-9]{32}(\/files)?|alerts(\?sandbox=rtp-[a-f0-9]{32})?|alerts\/seen)$/.test(req.url ?? '')) {
    if (req.method === 'GET' && req.url.startsWith('/raytace/alerts')) return json(200, { alerts: [] });
    return json(404, { error: 'Not available for local sandboxes yet. Destroy one with: raytrace sandbox destroy <name>' });
  }
  // The collector's raw feed, behind this API's sign-in (worker/sandbox/viewer.py).
  const feedRoute = req.url?.match(/^\/raytace\/viewer\/(events)?$/);
  if (req.method === 'GET' && feedRoute) {
    try {
      const feed = await fromViewer(`${EVIDENCE_VIEWER}/${feedRoute[1] ?? ''}`, { signal: AbortSignal.timeout(10000) });
      if (!feed.ok) throw new Error('Runtime collector unavailable');
      if (feedRoute[1]) return json(200, await feed.json());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(await feed.text());
    } catch { return json(503, { error: NO_VM }); }
  }
  if (req.method === 'GET' && req.url?.startsWith('/raytace/runtime?')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const sandbox = query.get('sandbox');
    const before = query.get('before') || '0';
    // `since`/`until` scope the page to one agent turn (the prompt through the
    // answer). Without them this returns the whole sandbox's history, which is
    // every prompt ever run in it.
    const since = query.get('since') || '0';
    const until = query.get('until') || '0';
    const raw = query.get('raw') === '1';
    const ok = (value) => /^\d{1,16}$/.test(value);
    if (!/^rtp-[a-f0-9]{32}$/.test(sandbox || '') || ![before, since, until].every(ok)) return json(400, { error: 'Invalid sandbox or cursor' });
    try {
      const project = (await sandboxes.list()).find((p) => p.id === sandbox);
      if (!project?.container_id || !/^[a-f0-9]{64}$/.test(project.container_id)) return json(404, { error: 'Sandbox mapping unavailable' });
      const window = `${since !== '0' ? `&since=${since}` : ''}${until !== '0' ? `&until=${until}` : ''}`;
      // A windowed page wants everything in the window, not the newest 100:
      // folding turns hundreds of raw events into a handful of commands.
      const limit = since !== '0' || until !== '0' ? 500 : 100;
      const evidence = await fromViewer(`${EVIDENCE_VIEWER}/events?container=${project.container_id}&before=${before}${window}&limit=${limit}&processes=1`, { signal: AbortSignal.timeout(10000) });
      if (!evidence.ok) throw new Error('Runtime collector unavailable');
      const page = await evidence.json();
      const base = { ...page, sandbox, container_id: project.container_id };
      // `raw=1` is the "show everything" escape hatch: the folded view must
      // always be auditable against what the collector actually recorded.
      if (raw) return json(200, base);

      const { commands, folded } = foldEvents(page.events);
      // Which call each process belongs to, by the process's own identity
      // (pid + start time) within this sandbox. `attribution` stays null when
      // the process was not recorded yet -- not the same as unattributed,
      // which is a recorded process that matched no call.
      const known = new Map(db.attributionsForProcesses({ containerId: project.container_id, pids: commands.map((c) => c.pid) })
        .map((row) => [`${row.pid}:${row.start_time_ns}`, row]));
      for (const command of commands) {
        const row = command.process_start_ns ? known.get(`${command.pid}:${command.process_start_ns}`) : null;
        command.attribution = row ? { call_id: row.call_id ?? null, parent_call_id: row.parent_call_id ?? null, tier: row.tier ?? null } : null;
      }
      attributeMarked(commands);
      // Cache first, so a repeat view of the same turn costs nothing. Only
      // commands no rule can describe are ever sent to a model.
      describeAll(commands, (command) => db.getCommandDescription(command));
      const missing = undescribed(commands);
      if (missing.length && routing.mode === 'openrouter') {
        try {
          const request = describeRequest(missing, summaryModel);
          const routed = routeRequest(routing, { method: 'POST', url: '/v1/responses', headers: {} }, Buffer.from(JSON.stringify(request.payload)));
          const response = await invokeReplay({ headers: routed.headers, upstreamUrl: routed.url }, request.payload, new AbortController().signal);
          const text = (response.output || []).filter((item) => item.type === 'message')
            .map((item) => (item.content || []).map((part) => part.text || '').join('')).join(' ');
          for (const [command, description] of parseDescriptions(text, request.commands)) {
            db.putCommandDescription(command, description, summaryModel);
          }
          describeAll(commands, (command) => db.getCommandDescription(command));
        } catch (error) {
          // A failed description must never cost us the evidence: the commands
          // still render, just verbatim.
          console.error('[raytace] command descriptions unavailable:', error.message);
        }
      }
      let call_labels = {};
      try { call_labels = await assessCommands(commands); }
      catch (error) { console.error('[raytace] command severity unavailable:', error.message); }
      return json(200, { ...base, commands, folded, call_labels, severity_source: typesafe.enabled ? 'jev' : 'rules', events: undefined });
    } catch { return json(503, { error: 'Runtime evidence unavailable: the local sandbox VM is not running. Missing evidence is not proof of non-execution.' }); }
  }
  // The dashboard polls the history every few seconds: its context items
  // (`evidence`) grow with the square of a session's length, so the history
  // carries them only when asked for (&evidence=1, Compare runs). The recent
  // list keeps them.
  if (req.method === 'GET' && ['/raytace/traces', '/raytace/traces?scope=history', '/raytace/traces?scope=history&evidence=1'].includes(req.url)) {
    try {
      const cached = cachedTraces(req.url);
      const headers = { ...corsHeaders, etag: cached.etag, 'cache-control': 'no-cache', 'access-control-expose-headers': 'etag' };
      if (req.headers['if-none-match'] === cached.etag) { res.writeHead(304, headers); return res.end(); }
      const body = await cached.body;
      res.writeHead(200, { 'content-type': 'application/json', ...headers }); return res.end(body);
    }
    catch (error) { res.writeHead(500, { 'content-type': 'application/json', ...corsHeaders }); return res.end(JSON.stringify({ error: String(error) })); }
  }
  // Splunk-style search over the derived index (search.mjs). `from`/`to`
  // are epoch ms or ISO dates; the query itself carries fields and pipes.
  if (req.method === 'GET' && (req.url === '/raytace/search' || req.url?.startsWith('/raytace/search?') || req.url?.startsWith('/raytace/search/signatures'))) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const bound = (name) => { const raw = params.get(name); if (!raw) return null; const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw); return Number.isFinite(ms) ? ms : null; };
      const range = { fromMs: bound('from'), toMs: bound('to') };
      if (req.url.startsWith('/raytace/search/signatures')) {
        return json(200, { signatures: db.failureSignatures({ ...range, limit: Number(params.get('limit')) || 20 }) });
      }
      return json(200, db.search({ q: params.get('q') ?? '', ...range, limit: Number(params.get('limit')) || 50, offset: Number(params.get('offset')) || 0 }));
    } catch (error) { return json(500, { error: `Search failed: ${error.message}` }); }
  }
  // Who is signed in and which paid features they have. Nobody yet: sign-in
  // comes with the RayTrace cloud; the dashboard already reads this shape.
  // Which proxy this is, so the CLI can tell an outdated one still running
  // after an upgrade (src/proxy-process.mjs PROXY_API) and replace it.
  if (req.method === 'GET' && req.url === '/raytace/version') return json(200, { api: PROXY_API });
  if (req.method === 'GET' && req.url === '/raytace/account') return json(200, { signed_in: false, plan: 'free', features: [] });
  if (req.method === 'GET' && req.url === '/raytace/models') return json(200, { models: routing.mode === 'openrouter' ? Object.entries(routing.models).map(([alias, id]) => ({ alias, id })) : [], execution_available: routing.mode === 'openrouter' });
  const stepRoute = req.url?.match(/^\/raytace\/steps\/([a-f0-9-]+)\/(\d+)$/);
  if (req.method === 'GET' && stepRoute) {
    const live = liveExchanges.get(stepRoute[1]);
    try {
      const entry = await savedOrLive(stepRoute[1]);
      if (!entry) return json(404, { error: 'This step was not found in the saved captures.' });
      if (!entry.payload || !entry.response) return json(409, { error: 'This capture contains only metadata; its full request or response was not saved.' });
      const step = inspectStep(omitToolChunkIds(entry), stepRoute[1], Number(stepRoute[2]));
      if (!live) step.replay_reason = 'Saved log — available to inspect. Rerunning requires a fresh capture: the live snapshot expired after 30 minutes, a proxy restart, or eviction from the latest 10 exchanges.';
      const request = explanationRequest(step, routing.defaultModel);
      const explanation = db.getExplanation(request.key);
      return json(200, { ...step, hypotheses: explanation?.hypotheses || [], explanation_generated: !!explanation, explanation_model: routing.defaultModel });
    }
    catch (error) { return json(400, { error: error.message }); }
  }
  const contextRoute = req.url?.match(/^\/raytace\/prompt-context\/([A-Za-z0-9_-]{1,80})$/);
  if (req.method === 'GET' && contextRoute) {
    try {
      const found = await promptContextFor(contextRoute[1]);
      if (!found) return json(404, { error: 'Prompt not found in the captured history.' });
      const request = contextSummaryRequest(found.context, summaryModel);
      const model = found.trace.requests?.at(-1)?.model ?? found.trace.model;
      return json(200, { ...found.context, model, context_window: await contextWindow(model),
        summary: request ? db.getSummary(request.key) : null, summary_needed: !!request, summary_model: summaryModel });
    } catch (error) { return json(400, { error: error.message }); }
  }
  // One context item's full text, as the model received it, for opening in
  // its own tab: /raytace/prompt-context/<trace>/item/<input index | instructions | tools>
  const itemRoute = req.url?.match(/^\/raytace\/prompt-context\/([A-Za-z0-9_-]{1,80})\/item\/(\d{1,6}|instructions|tools)$/);
  if (req.method === 'GET' && itemRoute) {
    const trace = (await readTraces(true, { evidence: false })).find((item) => item.id === itemRoute[1]);
    const last = trace?.requests?.at(-1);
    const entry = last ? await savedOrLive(last.id) : null;
    const text = entry ? contextItemText(entry, itemRoute[2]) : null;
    res.writeHead(text == null ? 404 : 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(text ?? 'Not found in the captured context.');
  }
  const recapRoute = req.url?.match(/^\/raytace\/recap\/([A-Za-z0-9_-]{1,80})$/);
  if (req.method === 'GET' && recapRoute) {
    const request = await currentRecapRequest(recapRoute[1]);
    return json(200, { recap: request ? db.getSummary(request.key) : null, available: Boolean(request), model: observerModel });
  }
  const summaryRoute = req.url?.match(/^\/raytace\/summaries\/([a-f0-9-]+)$/);
  // Only a summary of the step as it stands now: one written by an older
  // version, or before the step's own result was known, is not served.
  if (req.method === 'GET' && summaryRoute) {
    const request = await currentSummaryRequest(summaryRoute[1]);
    return json(200, { summary: request ? db.getSummary(request.key) : null, model: summaryModel });
  }
  const attributionRoute = req.url?.match(/^\/raytace\/attribution\/([A-Za-z0-9_.:-]{1,120})\/(\d{1,5})$/);
  if (req.method === 'GET' && attributionRoute) {
    const found = attributionStep(decodeURIComponent(attributionRoute[1]), attributionRoute[2]);
    if (found.error) return json(found.status, { error: found.error });
    return json(200, { attribution: db.getExplanation(found.key) });
  }
  if (req.method === 'GET' && req.url === '/raytace/experiments') return json(200, { experiments: [...jobs.values()].slice(-30).reverse() });
  // Playground forks (playground.mjs): listed and read freely, changed only
  // with the dashboard's header, like experiments.
  if (req.method === 'GET' && req.url === '/raytace/forks') return json(200, { forks: playground.list() });
  const previewRoute = req.url?.match(/^\/raytace\/forks\/preview\/([a-f0-9-]{36})$/);
  if (req.method === 'GET' && previewRoute) {
    try { return json(200, await playground.preview(previewRoute[1])); } catch (error) { return json(400, { error: error.message }); }
  }
  // A project's snapshot history, read-only: its files at a snapshot, one
  // file, or the diff between two snapshots (a fork's live under refs/forks/).
  const snapRoute = req.url?.match(/^\/raytace\/snapshots\/(rtp-[a-f0-9]{32})\/(files|file|diff)\?(.*)$/);
  if (req.method === 'GET' && snapRoute) {
    const query = new URLSearchParams(snapRoute[3]);
    const request = { op: { files: 'list', file: 'show', diff: 'diff' }[snapRoute[2]], commit: query.get('commit') ?? '',
      ...(query.get('to') ? { to: query.get('to') } : {}), ...(query.get('path') ? { path: query.get('path') } : {}) };
    try { return json(200, await playground.snapshot(snapRoute[1], request)); } catch (error) { return json(400, { error: error.message }); }
  }
  const forkRoute = req.url?.match(/^\/raytace\/forks\/(rtf-[a-f0-9]{32})(?:\/(keep|unkeep|delete|stop-all))?$/);
  if (forkRoute) {
    if (req.method === 'GET' && !forkRoute[2]) { const fork = playground.get(forkRoute[1]); return fork ? json(200, fork) : json(404, { error: 'Fork not found.' }); }
    if (req.method !== 'POST' || !forkRoute[2] || req.headers['x-raytace-experiment'] !== '1') return json(403, { error: 'Use the Playground in the dashboard.' });
    try {
      const action = forkRoute[2];
      return json(200, action === 'delete' ? await playground.remove(forkRoute[1]) : action === 'stop-all' ? await playground.stopGroup(forkRoute[1])
        : playground.keep(forkRoute[1], action === 'keep'));
    }
    catch (error) { return json(400, { error: error.message }); }
  }
  const jobRoute = req.url?.match(/^\/raytace\/experiments\/([a-f0-9-]+)(\/cancel)?$/);
  if (jobRoute) {
    const job = jobs.get(jobRoute[1]); if (!job) return json(404, { error: 'Experiment not found.' });
    if (req.method === 'GET' && !jobRoute[2]) return json(200, job);
    if (req.method === 'POST' && jobRoute[2] && req.headers['x-raytace-experiment'] === '1') { jobControllers.get(job.id)?.abort(); return json(200, job); }
    return json(405, { error: 'Unsupported experiment operation.' });
  }
  // Claude Code hook doorbell (proxy/claude-code-hook.mjs): "this session's
  // transcript has new lines". Answered at once; the transcript is read
  // afterwards so the hook never holds Claude Code up. The custom header is
  // not in the CORS allow-list, so a web page cannot ring it. A local
  // sandbox's hook sends its lines to the sandbox bridge instead (ingestFromSandbox).
  if (req.method === 'POST' && req.url === '/raytace/ingest/claude-code') {
    if (req.headers['x-raytace-hook'] !== '1' || !req.headers['content-type']?.includes('application/json')) return json(403, { error: 'Claude Code hook requests only.' });
    const chunks = []; let size = 0;
    for await (const part of req) { size += part.length; if (size > 64_000) return json(413, { error: 'Request too large.' }); chunks.push(part); }
    let note;
    try { note = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: 'Invalid JSON.' }); }
    const path = claudeCodeTranscriptPath(note?.transcript_path);
    if (!path) return json(400, { error: 'transcript_path must be a Claude Code transcript under ~/.claude/projects.' });
    json(202, { accepted: true });
    ingestClaudeCode(path, { final: CLAUDE_CODE_FINAL_EVENTS.has(note.hook_event_name) && note.more !== true });
    return;
  }
  if (localApi && (req.method !== 'POST' || !['/raytace/experiments', '/raytace/step-runs','/raytace/explanations', '/raytace/attribution', '/raytace/summaries', '/raytace/prompt-context/summary', '/raytace/forks', '/raytace/recap'].includes(req.url))) return json(404, { error: 'Unknown local endpoint.' });
  if (localApi && (req.headers['x-raytace-experiment'] !== '1' || !req.headers['content-type']?.includes('application/json'))) return json(403, { error: 'Use the experiment control in the dashboard.' });
  const parts = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > (localApi ? 600_000 : 20_000_000)) return json(413, { error: 'Request too large.' }); parts.push(part); }
  const requestBody = Buffer.concat(parts);
  if (req.method === 'POST' && req.url === '/raytace/forks') {
    try { return json(202, await playground.create(JSON.parse(requestBody))); }
    catch (error) { return json(400, { error: error.message }); }
  }
  if (req.method === 'POST' && req.url === '/raytace/explanations') {
    try {
      if (routing.mode !== 'openrouter') return json(400, { error: 'Explanations need an OpenRouter key. Add yours: raytrace key openrouter' });
      const config = JSON.parse(requestBody);
      const entry = await savedOrLive(config.exchange_id);
      if (!entry) return json(404, { error: 'Saved step not found.' });
      const step = inspectStep(omitToolChunkIds(entry), config.exchange_id, config.output_index);
      const request = explanationRequest(step, routing.defaultModel);
      const cached = db.getExplanation(request.key);
      if (cached) return json(200, cached);
      if (!pendingExplanations.has(request.key)) {
        if (pendingExplanations.size) return json(409, { error: 'Another explanation is being generated. Try again shortly.' });
        const task = (async () => {
          const routed = routeRequest(routing, { method: 'POST', url: '/v1/responses', headers: {} }, Buffer.from(JSON.stringify(request.payload)));
          const response = await invokeReplay({ headers: routed.headers, upstreamUrl: routed.url }, request.payload, new AbortController().signal);
          const result = { ...parseExplanations(response, request.sources), model: routing.defaultModel };
          db.putExplanation(request.key, result);
          return result;
        })();
        pendingExplanations.set(request.key, task);
      }
      try { return json(200, await pendingExplanations.get(request.key)); } finally { pendingExplanations.delete(request.key); }
    } catch (error) { return json(400, { error: error.message }); }
  }
  if (req.method === 'POST' && req.url === '/raytace/attribution') {
    try {
      const config = JSON.parse(requestBody);
      const found = attributionStep(config.exchange_id, config.output_index);
      if (found.error) return json(found.status, { error: found.error });
      const cached = db.getExplanation(found.key);
      if (cached) return json(200, cached);
      if (!pendingAttributions.has(found.key)) {
        if (pendingAttributions.size >= MAX_CONCURRENT_ATTRIBUTIONS) return json(409, { error: 'Too many steps in flight. Try again shortly.' });
        const task = (async () => {
          const result = await computeAttribution(found);
          // A result missing a model only because it failed is not cached, so
          // the next open retries it.
          if (!result.proposer_error && (result.ranked || !typesafe.enabled)) db.putExplanation(found.key, result);
          return result;
        })().finally(() => pendingAttributions.delete(found.key));
        pendingAttributions.set(found.key, task);
      }
      return json(200, await pendingAttributions.get(found.key));
    } catch (error) { console.error('Attribution failed:', error); return json(400, { error: error.message }); }
  }
  if (req.method === 'POST' && req.url === '/raytace/recap') {
    try {
      if (routing.mode !== 'openrouter') return json(400, { error: 'Recaps need an OpenRouter key. Add yours: raytrace key openrouter' });
      const request = await currentRecapRequest(String(JSON.parse(requestBody).trace_id ?? ''));
      if (!request) return json(404, { error: 'Nothing to recap: the prompt was not found, or it made no tool calls.' });
      const cached = db.getSummary(request.key);
      if (cached) return json(200, cached);
      if (!pendingRecaps.has(request.key)) {
        pendingRecaps.set(request.key, (async () => {
          const recap = parseRecap(recapText(await askObserver(request.payload)), request.outline);
          if (!recap) throw new Error('The observer did not return a usable recap. Try again.');
          const result = { ...recap, model: observerModel, created_at: new Date().toISOString() };
          db.putSummary(request.key, null, result);
          return result;
        })().finally(() => pendingRecaps.delete(request.key)));
      }
      return json(200, await pendingRecaps.get(request.key));
    } catch (error) { return json(400, { error: error.message }); }
  }
  if (req.method === 'POST' && req.url === '/raytace/prompt-context/summary') {
    try {
      if (routing.mode !== 'openrouter') return json(400, { error: 'Summaries need an OpenRouter key. Add yours: raytrace key openrouter' });
      const found = await promptContextFor(String(JSON.parse(requestBody).trace_id ?? ''));
      if (!found) return json(404, { error: 'Prompt not found in the captured history.' });
      const request = contextSummaryRequest(found.context, summaryModel);
      if (!request) return json(200, { prompts: [], answers: '' });
      const cached = db.getSummary(request.key);
      if (cached) return json(200, cached);
      if (!pendingSummaries.has(request.key)) {
        const task = (async () => {
          const routed = routeRequest(routing, { method: 'POST', url: '/v1/responses', headers: {} }, Buffer.from(JSON.stringify(request.payload)));
          const response = await invokeReplay({ headers: routed.headers, upstreamUrl: routed.url }, request.payload, new AbortController().signal);
          const result = { ...parseContextSummary(response), model: summaryModel };
          db.putSummary(request.key, null, result);
          return result;
        })();
        pendingSummaries.set(request.key, task);
      }
      try { return json(200, await pendingSummaries.get(request.key)); } finally { pendingSummaries.delete(request.key); }
    } catch (error) { return json(400, { error: error.message }); }
  }
  if (req.method === 'POST' && req.url === '/raytace/summaries') {
    try {
      if (routing.mode !== 'openrouter') return json(400, { error: 'Summaries need an OpenRouter key. Add yours: raytrace key openrouter' });
      const config = JSON.parse(requestBody);
      const request = await currentSummaryRequest(config.exchange_id);
      if (!request) return json(404, { error: 'Saved step not found.' });
      const cached = db.getSummary(request.key);
      if (cached) return json(200, cached);
      if (!pendingSummaries.has(request.key)) {
        if (pendingSummaries.size >= MAX_CONCURRENT_SUMMARIES) return json(409, { error: 'Too many summaries in flight. Try again shortly.' });
        const task = (async () => {
          const routed = routeRequest(routing, { method: 'POST', url: '/v1/responses', headers: {} }, Buffer.from(JSON.stringify(request.payload)));
          const response = await invokeReplay({ headers: routed.headers, upstreamUrl: routed.url }, request.payload, new AbortController().signal);
          const result = { ...parseSummary(response), model: summaryModel };
          db.putSummary(request.key, config.exchange_id, result);
          return result;
        })();
        pendingSummaries.set(request.key, task);
      }
      try { return json(200, await pendingSummaries.get(request.key)); } finally { pendingSummaries.delete(request.key); }
    } catch (error) { console.error('Summary generation failed:', error); return json(400, { error: error.message }); }
  }
  if (req.method === 'POST' && req.url === '/raytace/step-runs') {
    try {
      if (jobControllers.size) return json(409, { error: 'Wait for the active run or cancel it first.' });
      const config = JSON.parse(requestBody); const entry = liveExchanges.get(config.exchange_id);
      if (!entry) return json(409, { error: 'Snapshot expired. Capture a fresh request.' });
      const model = routing.mode === 'openrouter' ? selectModel(routing, config.model) : entry.payload.model;
      if (config.mode === 'execute' && routing.mode !== 'openrouter') return json(400, { error: 'Full execution requires OpenRouter routing.' });
      const { job, baseline, variant } = createStepRun(entry, config, model);
      const controller = new AbortController();
      jobControllers.set(job.id, controller);
      try { await persistExperiment(job); } catch (error) { jobControllers.delete(job.id); throw error; }
      jobs.set(job.id, job); json(202, job);
      const task = job.mode === 'execute'
        ? executeSequence(job, variant, routing, process.cwd(), join(dirname(store), 'runs'), controller.signal)
        : runDecision(job, baseline, variant, (payload, signal) => invokeReplay(entry, payload, signal), controller.signal);
      void task.catch((error) => { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; })
        .then(() => { job.completed_at = new Date().toISOString(); return persistExperiment(job); })
        .catch(() => { job.persistence_error = 'Could not save this result.'; })
        .finally(() => jobControllers.delete(job.id));
      return;
    } catch (error) { return json(400, { error: error.message }); }
  }
  if (req.method === 'POST' && req.url === '/raytace/experiments') {
    try {
      if (jobControllers.size) return json(409, { error: 'Another trial batch is running. Wait or cancel it first.' });
      const config = JSON.parse(requestBody); const entry = liveExchanges.get(config.exchange_id);
      if (!entry) return json(409, { error: 'Snapshot expired. Capture a new request through this proxy.' });
      const job = createExperiment(entry, config); const controller = new AbortController();
      // Persist the declared target and hashes before sending any paid requests.
      jobControllers.set(job.id, controller);
      try { await persistExperiment(job); } catch (error) { jobControllers.delete(job.id); throw error; }
      jobs.set(job.id, job);
      while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
      json(202, job);
      void runExperiment(job, entry, { invoke: (payload, signal) => invokeReplay(entry, payload, signal), signal: controller.signal })
        .catch(() => { job.status = 'failed'; })
        .then(() => persistExperiment(job))
        .catch(() => { job.persistence_error = 'The result could not be saved to disk.'; })
        .finally(() => jobControllers.delete(job.id));
      return;
    } catch (error) { return json(400, { error: error.message }); }
  }
  let routed;
  try { routed = routeRequest(routing, req, requestBody); }
  catch (error) { return json(400, { error: error.message }); }
  // OpenRouter runs on this proxy's own key; the other providers on the
  // client's, which it brought with it.
  if (routed.provider === 'openrouter' && !hasToken(req, apiToken)) return json(401, NOT_SIGNED_IN);
  const traceId = req.headers['x-raytace-trace-id'] || req.headers['x-request-id'] || randomUUID(); const started = new Date().toISOString(); const selectedProvider = routed.provider;
  const spanId = randomUUID();
  const sessionId = req.headers['x-raytace-session-id'];
  const sessionStartedAt = req.headers['x-raytace-session-started-at'];
  const session = typeof sessionId === 'string' && /^(?:[a-f0-9-]{36}|rtp-[a-f0-9]{32})$/.test(sessionId) && typeof sessionStartedAt === 'string' && Number.isFinite(Date.parse(sessionStartedAt))
    ? { session_id: sessionId, session_started_at: new Date(sessionStartedAt).toISOString() } : fallbackSession;
  const requestPayload = routed.payload;
  try {
    const response = await fetch(routed.url, { method: req.method, headers: routed.headers, body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : routed.body, duplex: 'half' });
    const responseBody = Buffer.from(await response.arrayBuffer()); let responsePayload = null;
    const contentType = response.headers.get('content-type') || '';
    if (responseBody.length <= maxBodyBytes) {
      if (contentType.includes('application/json')) try { responsePayload = JSON.parse(responseBody); } catch { /* record hash */ }
      else if (contentType.includes('text/event-stream')) responsePayload = parseSseResponse(responseBody);
    }
    const replayHeaders = routed.headers;
    if (requestPayload && responsePayload && req.url.endsWith('/responses') && response.ok) {
      liveExchanges.set(spanId, { payload: requestPayload, response: responsePayload, provider: selectedProvider, route: req.url, upstreamUrl: routed.url, headers: replayHeaders });
      while (liveExchanges.size > 10) liveExchanges.delete(liveExchanges.keys().next().value);
      setTimeout(() => liveExchanges.delete(spanId), 30 * 60 * 1000).unref();
    }
    const completedAt = new Date().toISOString();
    const metrics = requestMetrics({ timestamp: started, completed_at: completedAt, provider: selectedProvider, response: { payload: responsePayload } });
    await record({ ...session, metrics, event_type: 'model.exchange', trace_id: traceId, span_id: spanId, parent_span_id: req.headers['x-raytace-parent-span-id'] || null, timestamp: started, completed_at: completedAt, provider: selectedProvider, route: req.url, method: req.method, request: { headers: safeHeaders(routed.headers), bytes: routed.body.length, sha256: hash(routed.body), payload: requestPayload && redact(requestPayload) }, response: { status: response.status, headers: safeHeaders(Object.fromEntries(response.headers)), bytes: responseBody.length, sha256: hash(responseBody), payload: responsePayload && redact(responsePayload) } });
    // fetch decodes compressed bodies; original encoding/length no longer apply.
    const downstreamHeaders = Object.fromEntries(response.headers);
    delete downstreamHeaders['content-encoding'];
    delete downstreamHeaders['transfer-encoding'];
    downstreamHeaders['content-length'] = String(responseBody.length);
    res.writeHead(response.status, downstreamHeaders); res.end(responseBody);
  } catch (error) { await record({ event_type: 'proxy.error', trace_id: traceId, timestamp: started, provider: selectedProvider, route: req.url, error: String(error), cause: error.cause ? { name: error.cause.name, message: error.cause.message, code: error.cause.code } : null }); res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'raytace_proxy_upstream_error', trace_id: traceId })); }
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`RayTrace proxy could not start: port ${port} is already in use. Stop the existing proxy, then try again.`);
  else console.error(`RayTrace proxy could not start: ${error.message}`);
  process.exitCode = 1;
});
try {
  for (const job of db.loadExperiments(200).reverse()) {
    if (job.kind === 'fork') continue; // Playground forks: playground.mjs
    if (['queued', 'running'].includes(job.status)) job.status = 'interrupted';
    jobs.set(job.id, job);
  }
  while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
} catch (error) { console.error(`Experiment history could not be read: ${error.message}`); }
server.listen(port, '127.0.0.1', () => {
  const stats = db.stats();
  console.log(`RayTrace proxy listening on http://127.0.0.1:${server.address().port}`);
  playground.recover().catch((error) => console.error(`Playground forks could not be checked: ${error.message}`));
  console.log(`Store: ${dbFile} (journal=${db.journal}, ${stats.sessions} sessions, ${stats.turns} turns, ${stats.exchanges} exchanges, ${stats.processes} sandbox processes)`);
});
// gVisor sandbox evidence (worker/sandbox/): discovers the local sandboxes from the
// Mac-side manager (:8799) and tails each one's process events from the
// evidence viewer (:8798), recording matched execs as the primary witness
// for those sessions. Best-effort: with neither service running it logs
// once and idles. RAYTACE_GVISOR_FORWARDER=0 turns it off entirely.
const gvisorForwarder = process.env.RAYTACE_GVISOR_FORWARDER === '0' ? null : startGvisorForwarder({
  listProjects: () => sandboxes.list(),
  viewerBase: EVIDENCE_VIEWER,
  fetchImpl: fromViewer,
  ingest: (events, { sessionId }) => ingestExecutions(db, events, { sessionId }),
  // Exits, found by the process's own identity (pid + start time), so an
  // exit closes its process even after a proxy restart or for a process the
  // forwarder never tracked.
  finish: (row) => recordExit(row),
  finishByProcess: (row) => recordExit(row),
  // A sandbox whose remaining exits can no longer arrive.
  lose: (row) => db.loseOpenProcesses({ containerId: row.container_id, reason: row.reason, raw: row.raw ?? null, ended: row.ended === true }),
  // Processes that ran underneath a matched call, and ones that matched
  // nothing at all (parent_call_id null): recorded either way.
  descend: ({ exec, parent_call_id, session_id }) => {
    const started = db.recordProcessStart({ containerId: exec.container_id, projectId: session_id ?? null, raw: exec.raw, startedMs: exec.timestamp });
    if (parent_call_id && started?.eventId) db.attribute({ toolCallId: parent_call_id, eventId: started.eventId, method: 'inherited', confidence: 'corroborated' });
  },
});
function recordExit(row) {
  return db.recordProcessExit({ containerId: row.container_id, projectId: row.session_id ?? null, raw: row.raw,
    endedMs: row.ended_ms ?? null, exit_code: row.exit_code ?? null, signal: row.signal ?? null });
}
// Local sandboxes' Claude Code transcripts (raytrace sandbox create --local).
startSandboxBridge({ dataDir, port: Number(process.env.RAYTRACE_BRIDGE_PORT || 8799), ingest: ingestFromSandbox });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { try { gvisorForwarder?.stop(); db.close(); } finally { process.exit(0); } });
