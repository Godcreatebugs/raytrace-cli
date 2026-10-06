#!/usr/bin/env node
import { requestMetrics } from './request-metrics.mjs';
/** Local API recorder. Point a compatible client at http://127.0.0.1:8797. */
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { join, dirname, resolve, extname, sep } from 'node:path';
import { exchangesFromTranscript, parseTranscript } from './claude-code-adapter.mjs';
import { evidenceFor, replayEligibility, createExperiment, runExperiment, outcome, proposedCommand } from './experiment-engine.mjs';
import { loadEnvFile } from 'node:process';
import { providerConfig, routeRequest, selectModel } from './providers.mjs';
import { latestSessionRows } from './prompt-traces.mjs';
import { inspectStep, createStepRun, runDecision } from './step-lab.mjs';
import { executeSequence } from './execution-runner.mjs';
import { explanationRequest, parseExplanations } from './explanations.mjs';
import { summaryRequest, parseSummary, resultText } from './summaries.mjs';
import { omitToolChunkIds, toolResultStatus } from './tool-metadata.mjs';
import { openEvidenceStore } from './evidence-store.mjs';
import { promptContext, contextItemText, contextSummaryRequest, parseContextSummary } from './prompt-context.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const routing = providerConfig();
// Summaries default to the cheapest configured alias so per-step summarizing
// (many small calls) doesn't rack up cost; override with RAYTACE_SUMMARY_MODEL.
const summaryModel = process.env.RAYTACE_SUMMARY_MODEL
  ? selectModel(routing, process.env.RAYTACE_SUMMARY_MODEL)
  : (routing.models.oss || routing.defaultModel);
const fallbackSession = { session_id: randomUUID(), session_started_at: new Date().toISOString() };

const port = Number(process.env.RAYTACE_PORT || 8797);
// The CLI sets RAYTACE_DATA_DIR (~/.raytrace); run by hand it keeps ./.raytace.
const dataDir = process.env.RAYTACE_DATA_DIR || join(process.cwd(), '.raytace');
const store = process.env.RAYTACE_STORE || join(dataDir, 'events.jsonl');
const maxBodyBytes = Number(process.env.RAYTACE_MAX_BODY_BYTES || 2_000_000);
const liveExchanges = new Map(); // Credentials stay in process memory, never in the event log.
const jobs = new Map();
const jobControllers = new Map();
const dbFile = process.env.RAYTACE_DB || join(dirname(store), 'evidence.db');
const archiveJsonl = process.env.RAYTACE_ARCHIVE_JSONL === '1';
const db = openEvidenceStore(dbFile);
const allowedOrigins = new Set((process.env.RAYTACE_UI_ORIGINS || '').split(',').filter(Boolean));
function trustedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try { const url = new URL(origin); return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch { return false; }
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    /authorization|api[-_]?key|token|secret|password/i.test(key) ? [key, '[REDACTED]'] : [key, redact(item)],
  ));
}
async function record(event) {
  const row = omitToolChunkIds(event);
  if (row.event_type === 'model.exchange' && row.span_id) db.recordExchange(row);
  else if (row.event_type === 'proxy.error') db.recordProxyError(row);
  // Opt-in raw archive; the database is the source of truth.
  if (archiveJsonl) { await mkdir(dirname(store), { recursive: true }); await appendFile(store, `${JSON.stringify(row)}\n`); }
}
function safeHeaders(headers) { const keep = ['content-type', 'anthropic-version', 'openai-beta', 'user-agent', 'x-request-id']; return Object.fromEntries(Object.entries(headers).filter(([key]) => keep.includes(key.toLowerCase()))); }
function shortened(value, limit = 104) { const text = typeof value === 'string' ? value : JSON.stringify(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; }
function parseSseResponse(body) {
  const events = [];
  let completedResponse = null;
  for (const frame of body.toString('utf8').replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const event = JSON.parse(data);
      events.push(event);
      if (event.type === 'response.completed' && event.response) completedResponse = event.response;
    } catch { /* retain the raw response hash when an SSE event is not JSON */ }
  }
  if (completedResponse) return completedResponse;
  return events.length ? { stream: true, events } : null;
}
function toolKind(name) { const lower = name.toLowerCase(); return /search|rg|grep/.test(lower) ? 'search' : /read|open|cat|list/.test(lower) ? 'read' : /write|edit|patch|apply/.test(lower) ? 'edit' : 'test'; }
function event(kind, title, detail, time, raw) { return { kind, title, detail, time, raw: JSON.stringify(raw, null, 2) }; }
function publicOutput(item) {
  // Reasoning items can contain opaque/private model state. Keep only the
  // configuration and any explicit summary; never present hidden content as a trace.
  if (item?.type === 'reasoning') return { type: 'reasoning', id: item.id, summary: item.summary ?? null, encrypted_content: item.encrypted_content ? '[present]' : undefined };
  return item;
}
function extractText(item) {
  const content = item?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || '').filter(Boolean).join(' ');
  return item?.text || '';
}
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
function splitExchange(row) {
  const request = row.request?.payload || {}; const response = row.response?.payload || {};
  // Preserve the date and UTC offset so each viewer can render their local time.
  const started = new Date(row.timestamp).toISOString(); const completed = new Date(row.completed_at || row.timestamp).toISOString();
  const input = Array.isArray(request.input) ? request.input : Array.isArray(request.messages) ? request.messages : [];
  const output = Array.isArray(response.output) ? response.output : Array.isArray(response.content) ? response.content : [];
  const toolCount = (request.tools || []).length + input.flatMap((item) => item?.tools || []).length;
  const live = liveExchanges.get(row.span_id);
  const reason = live ? replayEligibility(live) : 'Capture a fresh request after starting this proxy. Replay snapshots expire after 30 minutes or a restart.';
  let decision = null; try { decision = outcome(response); } catch { /* incomplete capture */ }
  const steps = [event('model', 'Context assembled', `${request.model || 'unknown model'} · ${input.length} input items · ${toolCount} available tools`, started, { exchange_id: row.span_id, model: request.model, stream: request.stream, input_items: input.length, tool_count: toolCount, reasoning: request.reasoning ?? null, replay_reason: reason, decision })];
  for (const item of input) {
    if (!/function_call_output|tool_result/i.test(item?.type || '')) continue;
    const name = item.name || item.tool_name || item.call_id || 'tool';
    steps.push(event(toolKind(name), `Tool result: ${name}`, toolResultStatus(item), started, item));
  }
  for (const [outputIndex, item] of output.entries()) {
    if (item?.type === 'reasoning') {
      const effort = response.reasoning?.effort || request.reasoning?.effort || 'model default';
      steps.push(event('model', 'Reasoning phase', `Effort: ${effort}. Private reasoning content is intentionally not displayed.`, completed, publicOutput(item)));
      continue;
    }
    const name = item?.name || item?.function?.name;
    if (name && /function_call|tool_use|tool_call/i.test(item?.type || '')) {
      const data = item.arguments || item.input || item.function?.arguments || '';
      steps.push({ ...event(toolKind(name), `Tool call: ${name}`, shortened(data), completed, publicOutput(item)), exchange_id: row.span_id, output_index: outputIndex });
      continue;
    }
    if (/message|text/i.test(item?.type || '')) steps.push({ ...event('model', 'Model answer', shortened(extractText(item), 180) || 'Message completed', completed, publicOutput(item)), exchange_id: row.span_id, output_index: outputIndex });
  }
  steps.push(event('model', `Exchange complete · ${row.response?.status || 'unknown'}`, `${row.request?.bytes || 0} B sent · ${row.response?.bytes || 0} B received`, completed, { response_status: response.status ?? null, http_status: row.response?.status ?? null, request_bytes: row.request?.bytes || 0, response_bytes: row.response?.bytes || 0, response_reasoning: response.reasoning ?? null }));
  return steps;
}
// The trace list takes seconds to build for long sessions and is polled every
// few seconds, mostly with nothing new: it is rebuilt only when the data
// behind it changed (db.dataVersion), and one build serves every caller.
// The body is serialized once per version too, and its version is its ETag,
// so a poll with nothing new is answered 304 without sending anything.
const traceCache = new Map(); // url -> { version, body: Promise<string> }
function cachedTraces(url) {
  const version = db.dataVersion();
  const hit = traceCache.get(url);
  if (hit?.version === version) return hit;
  const body = readTraces(url !== '/raytace/traces', { evidence: url !== '/raytace/traces?scope=history' })
    .then((traces) => JSON.stringify({ traces }));
  const entry = { version, etag: `"${version}"`, body };
  traceCache.set(url, entry);
  body.catch(() => { if (traceCache.get(url) === entry) traceCache.delete(url); });
  return entry;
}

/** `evidence: false` skips building each request's context items, the
 * costliest part (every request resends the conversation so far), for
 * callers that do not send them on. */
async function readTraces(includeHistory = false, { evidence = true } = {}) {
  const rows = db.exchangeRows({ history: includeHistory }).map(omitToolChunkIds);
  // Rows arrive already grouped: each carries its turn as trace_id and the
  // turn's prompt as promptTitle, decided once at capture (evidence-store.mjs).
  const groupedRows = rows;
  // The store already scopes the live view to the newest session; keep the
  // filter so captures made before session tracking behave as they always did.
  const exchangeRows = includeHistory ? groupedRows : (latestSessionRows(groupedRows).length ? latestSessionRows(groupedRows) : groupedRows);
  // A tool call proposed in one captured exchange comes back as evidence (its
  // result) in a later one. Index call_id -> the exchange that first proposed it
  // so the UI can jump from "this evidence" to "the decision that produced it".
  const origins = new Map();
  for (const row of exchangeRows) {
    const output = row.response?.payload?.output;
    if (!Array.isArray(output)) continue;
    for (const [outputIndex, item] of output.entries()) {
      if (item?.call_id && /function_call|tool_use|tool_call/i.test(item?.type || '') && !origins.has(item.call_id)) {
        origins.set(item.call_id, { call_id: item.call_id, trace_id: row.trace_id, exchange_id: row.span_id, output_index: outputIndex, name: item.name,
          proposed: proposedCommand(item.arguments ?? item.input ?? item.function?.arguments ?? '') });
      }
    }
  }
  const grouped = new Map();
  const shownResultsByTrace = new Map(); // trace_id -> Set(call_id) already rendered once
  for (const row of exchangeRows) {
    const trace = grouped.get(row.trace_id) || { id: row.trace_id, provider: row.provider, model: row.request?.payload?.model || 'unknown model', title: row.promptTitle, startedAt: row.timestamp, status: 'complete', events: [], evidence: [], requests: [] };
    const shownResults = shownResultsByTrace.get(row.trace_id) || new Set();
    shownResultsByTrace.set(row.trace_id, shownResults);
    trace.requests.push({ id: row.span_id, model: row.request?.payload?.model || 'unknown', startedAt: row.timestamp, completedAt: row.completed_at || null, ...(row.metrics || requestMetrics(row)) });
    // Rows are oldest-first, so the last request that produced text is the
    // turn's final answer, and the last completion is when the turn ended.
    trace.endedAt = row.completed_at || row.timestamp;
    try { const text = outcome(row.response?.payload || {}).text; if (text) trace.answer = text; } catch { /* incomplete capture */ }
    trace.events.push(...splitExchange(row).map((step) => {
      if (!step.title.startsWith('Tool result:')) return step;
      const raw = JSON.parse(step.raw); const origin = origins.get(raw.call_id);
      // The tool result carries only a call_id and output, never the tool's
      // name — fall back to the exchange that originally proposed the call,
      // where the real name is known, instead of showing the raw id.
      const label = origin?.name ? `Tool result: ${origin.name}` : step.title;
      // The icon was classified from the same fallback name (usually the raw
      // call_id, which never matches any category) — reclassify once the real
      // tool name is known so the icon matches what the tool actually did.
      const kind = origin?.name ? toolKind(origin.name) : step.kind;
      // Clicking a result investigates the earlier decision to call that tool,
      // using its pre-action context rather than its newly returned contents.
      return { ...step, title: label, kind, ...(origin ? { exchange_id: origin.exchange_id, output_index: origin.output_index } : {}) };
    }).filter((step) => {
      if (!step.title.startsWith('Tool result:')) return true;
      // Full conversation history is resent on every turn, so the same result
      // would otherwise appear again in every later request's input — once is
      // enough; the repeats carry no new information.
      const raw = JSON.parse(step.raw);
      if (!raw.call_id || !shownResults.has(raw.call_id)) { if (raw.call_id) shownResults.add(raw.call_id); return true; }
      return false;
    }));
    for (const item of evidence ? evidenceFor(row.request?.payload, row.span_id) : []) {
      const origin = item.call_id ? origins.get(item.call_id) : null;
      trace.evidence.push({ ...item, origin: origin && origin.exchange_id !== row.span_id ? origin : null });
    }
    grouped.set(row.trace_id, trace);
  }
  // Every call each trace proposed, in order: unlike `evidence`, this is not
  // limited to calls whose result got resent as later input, so it includes
  // a call in the very last response with no later request to resend it into.
  for (const trace of grouped.values()) {
    trace.callVerifications = [...origins.values()].filter((origin) => origin.trace_id === trace.id).map((origin) => ({
      call_id: origin.call_id, exchange_id: origin.exchange_id, name: origin.name, output_index: origin.output_index, proposed: origin.proposed ?? null,
    }));
  }

  // Codex requests include a large tool schema. Return recent traces only so the
  // live dashboard stays responsive instead of repeatedly transferring history.
  const result = [...grouped.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, includeHistory ? 100 : 10);
  // Every request resends the whole conversation, so each earlier item comes
  // back once per later request: a long Claude Code session made one prompt
  // tens of MB, fetched every few seconds. An item is sent in full once; a
  // repeat keeps only where it sits and names the item that has the rest
  // (content_of).
  for (const trace of result) {
    const first = new Map();
    trace.evidence = trace.evidence.map((item) => {
      const key = `${item.kind}\0${item.label}\0${item.content ?? item.preview ?? ''}`;
      if (!first.has(key)) { first.set(key, item.id); return item; }
      return { id: item.id, exchange_id: item.exchange_id, index: item.index, kind: item.kind, label: item.label, call_id: item.call_id ?? null, content_of: first.get(key) };
    });
  }
  return result;
}


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
  return { trace, context: promptContext(entry, trace.title, trace.answer ?? '') };
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
function ingestClaudeCode(path, { final }) {
  serially(path, async () => {
    const rows = exchangesFromTranscript(parseTranscript(await readFile(path, 'utf8')), { final });
    for (const row of rows) {
      await record({ ...row, request: { ...row.request, payload: redact(row.request.payload) }, response: { ...row.response, payload: redact(row.response.payload) } });
    }
  }).catch((error) => console.error(`Claude Code transcript ${path} could not be read: ${error.message}`));
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

const server = createServer(async (req, res) => {
  const fromAgent = req.headers.authorization || req.headers['x-api-key'] || req.headers['anthropic-version'];
  if (dashboardDir && req.method === 'GET' && !fromAgent && !req.url?.startsWith('/raytace/') && !req.url?.startsWith('/v1/')) {
    try { return await serveDashboard(req, res); }
    catch { res.writeHead(404); return res.end('Dashboard not built.'); }
  }
  const localApi = req.url?.startsWith('/raytace/');
  // Paid replay endpoints require a preflighted custom header and trusted origin.
  if (localApi && (!trustedOrigin(req.headers.origin) || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host || ''))) {
    res.writeHead(403); return res.end('Untrusted dashboard origin or host.');
  }
  const corsHeaders = { ...(req.headers.origin && trustedOrigin(req.headers.origin) ? { 'access-control-allow-origin': req.headers.origin } : {}), vary: 'Origin', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-raytace-experiment,if-none-match', 'access-control-allow-private-network': 'true' };
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders, 'cache-control': 'no-store' }); res.end(JSON.stringify(redact(omitToolChunkIds(value)))); };
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }
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
  // Who is signed in and which paid features they have. Nobody yet: sign-in
  // comes with the RayTrace cloud; the dashboard already reads this shape.
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
  const summaryRoute = req.url?.match(/^\/raytace\/summaries\/([a-f0-9-]+)$/);
  // Only a summary of the step as it stands now: one written by an older
  // version, or before the step's own result was known, is not served.
  if (req.method === 'GET' && summaryRoute) {
    const request = await currentSummaryRequest(summaryRoute[1]);
    return json(200, { summary: request ? db.getSummary(request.key) : null, model: summaryModel });
  }
  if (req.method === 'GET' && req.url === '/raytace/experiments') return json(200, { experiments: [...jobs.values()].slice(-30).reverse() });
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
  // not in the CORS allow-list, so a web page cannot ring it.
  if (req.method === 'POST' && req.url === '/raytace/ingest/claude-code') {
    if (req.headers['x-raytace-hook'] !== '1' || !req.headers['content-type']?.includes('application/json')) return json(403, { error: 'Claude Code hook requests only.' });
    const chunks = []; let size = 0;
    for await (const part of req) { size += part.length; if (size > 64_000) return json(413, { error: 'Request too large.' }); chunks.push(part); }
    let note;
    try { note = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: 'Invalid JSON.' }); }
    const path = claudeCodeTranscriptPath(note?.transcript_path);
    if (!path) return json(400, { error: 'transcript_path must be a Claude Code transcript under ~/.claude/projects.' });
    json(202, { accepted: true });
    ingestClaudeCode(path, { final: CLAUDE_CODE_FINAL_EVENTS.has(note.hook_event_name) });
    return;
  }
  if (localApi && (req.method !== 'POST' || !['/raytace/experiments', '/raytace/step-runs', '/raytace/explanations', '/raytace/summaries', '/raytace/prompt-context/summary'].includes(req.url))) return json(404, { error: 'Unknown local endpoint.' });
  if (localApi && (req.headers['x-raytace-experiment'] !== '1' || !req.headers['content-type']?.includes('application/json'))) return json(403, { error: 'Use the experiment control in the dashboard.' });
  const parts = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > (localApi ? 600_000 : 20_000_000)) return json(413, { error: 'Request too large.' }); parts.push(part); }
  const requestBody = Buffer.concat(parts);
  if (req.method === 'POST' && req.url === '/raytace/explanations') {
    try {
      if (routing.mode !== 'openrouter') return json(400, { error: 'Enable OpenRouter to generate explanations.' });
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
  if (req.method === 'POST' && req.url === '/raytace/prompt-context/summary') {
    try {
      if (routing.mode !== 'openrouter') return json(400, { error: 'Enable OpenRouter to generate summaries.' });
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
      if (routing.mode !== 'openrouter') return json(400, { error: 'Enable OpenRouter to generate summaries.' });
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
  const traceId = req.headers['x-raytace-trace-id'] || req.headers['x-request-id'] || randomUUID(); const started = new Date().toISOString(); const selectedProvider = routed.provider;
  const spanId = randomUUID();
  const sessionId = req.headers['x-raytace-session-id'];
  const sessionStartedAt = req.headers['x-raytace-session-started-at'];
  const session = typeof sessionId === 'string' && /^[a-f0-9-]{36}$/.test(sessionId) && typeof sessionStartedAt === 'string' && Number.isFinite(Date.parse(sessionStartedAt))
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
    if (['queued', 'running'].includes(job.status)) job.status = 'interrupted';
    jobs.set(job.id, job);
  }
  while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
} catch (error) { console.error(`Experiment history could not be read: ${error.message}`); }
server.listen(port, '127.0.0.1', () => {
  const stats = db.stats();
  console.log(`RayTrace proxy listening on http://127.0.0.1:${server.address().port}`);
  console.log(`Store: ${dbFile} (journal=${db.journal}, ${stats.sessions} sessions, ${stats.turns} turns, ${stats.exchanges} exchanges)`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { try { db.close(); } finally { process.exit(0); } });
