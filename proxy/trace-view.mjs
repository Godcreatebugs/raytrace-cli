/**
 * The dashboard's trace view: captured exchanges grouped into turns, each
 * with its steps, its evidence, and what the sandbox observed for every tool
 * call. Shared by the local proxy (raytace-proxy.mjs, its SQLite store) and
 * the hosted evidence service (RayTrace's cloud, a Postgres
 * store bound to one org); `db` is either, every call into it awaited.
 */
import { evidenceFor, outcome, proposedCommand } from './experiment-engine.mjs';
import { callKind } from './tool-metadata.mjs';
import { callCategory } from './call-category.mjs';
import { latestSessionRows, promptAsWritten } from './prompt-traces.mjs';
import { omitToolChunkIds, toolResultStatus } from './tool-metadata.mjs';
import { requestMetrics } from './request-metrics.mjs';
import { describeCommand } from './exec-narrative.mjs';

function shortened(value, limit = 104) { const text = typeof value === 'string' ? value : JSON.stringify(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; }
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
export function executionFields(real) {
  return {
    exec_id: real?.exec_id ?? null,
    pid: real?.pid ?? null,
    start_time_ns: real?.start_time_ns ?? null,
    argv: Array.isArray(real?.argv) ? real.argv : null,
    started_at: real?.started_at ?? null,
    ended_at: real?.ended_at ?? null,
    exit_code: real?.exit_code ?? null,
    window_start_ms: real?.window_start_ms ?? null,
    window_end_ms: real?.window_end_ms ?? null,
  };
}
export function splitExchange(row, replayReason = () => undefined) {
  const request = row.request?.payload || {}; const response = row.response?.payload || {};
  // Preserve the date and UTC offset so each viewer can render their local time.
  const started = new Date(row.timestamp).toISOString(); const completed = new Date(row.completed_at || row.timestamp).toISOString();
  const input = Array.isArray(request.input) ? request.input : Array.isArray(request.messages) ? request.messages : [];
  const output = Array.isArray(response.output) ? response.output : Array.isArray(response.content) ? response.content : [];
  const toolCount = (request.tools || []).length + input.flatMap((item) => item?.tools || []).length;
  // undefined: no replay snapshot held for it; null: replayable.
  const held = replayReason(row.span_id);
  const reason = held === undefined ? 'Capture a fresh request after starting this proxy. Replay snapshots expire after 30 minutes or a restart.' : held;
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
export async function readTraces(db, { includeHistory = false, evidence = true, replayReason = () => undefined } = {}) {
  const rows = (await db.exchangeRows({ history: includeHistory })).map(omitToolChunkIds);
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
        const args = item.arguments ?? item.input ?? item.function?.arguments ?? '';
        origins.set(item.call_id, { call_id: item.call_id, trace_id: row.trace_id, exchange_id: row.span_id, output_index: outputIndex, name: item.name,
          kind: callKind(item.name),
          // What the call did, for the Tool column; null with its command
          // when only Jev can say (call-category.mjs resolveCategories).
          category: callCategory(item.name, args),
          proposed: proposedCommand(args, item.name) });
      }
    }
  }
  const grouped = new Map();
  const shownResultsByTrace = new Map(); // trace_id -> Set(call_id) already rendered once
  for (const row of exchangeRows) {
    const trace = grouped.get(row.trace_id) || { id: row.trace_id, provider: row.provider, model: row.request?.payload?.model || 'unknown model', title: promptAsWritten(row.promptTitle), promptRaw: row.promptTitle, startedAt: row.timestamp, status: 'complete', events: [], evidence: [], requests: [] };
    const shownResults = shownResultsByTrace.get(row.trace_id) || new Set();
    // rtp- a project's sandbox; rtf- a Playground fork of one (playground.mjs).
    if (/^rt[pf]-[a-f0-9]{32}$/.test(row.session_id || '')) trace.sandboxId = row.session_id;
    if (/^rtf-[a-f0-9]{32}$/.test(row.session_id || '')) trace.forkId = row.session_id;
    shownResultsByTrace.set(row.trace_id, shownResults);
    trace.requests.push({ id: row.span_id, model: row.request?.payload?.model || 'unknown', startedAt: row.timestamp, completedAt: row.completed_at || null, ...(row.metrics || requestMetrics(row)) });
    // Rows are oldest-first, so the last request that produced text is the
    // turn's final answer, and the last completion is when the turn ended.
    trace.endedAt = row.completed_at || row.timestamp;
    try { const text = outcome(row.response?.payload || {}).text; if (text) trace.answer = text; } catch { /* incomplete capture */ }
    trace.events.push(...splitExchange(row, replayReason).map((step) => {
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
  // Overlay observed sandbox execution (runtime_processes + attributions,
  // via db.divergence) onto each tool-result evidence item, keyed by call_id —
  // the one field both sides share. Falls back to evidenceFor's regex
  // heuristic (succeeded, based on scanning the result text) wherever no
  // process was tied to the call, e.g. a session run outside the sandbox.
  for (const trace of grouped.values()) {
    const spanIds = trace.requests.map((request) => request.id);
    const divergenceRows = (await db.divergence(spanIds)).filter((row) => row.call_id);
    const byCallId = new Map(divergenceRows.map((row) => [row.call_id, row]));
    // Processes that ran underneath each call. divergence() joins on call_id
    // and a descendant's is null by definition, so these need their own query
    // (inherited attributions; see db.descendants in evidence-store.mjs).
    const descendantsByCall = new Map();
    for (const row of await db.descendants(spanIds)) {
      if (!descendantsByCall.has(row.parent_call_id)) descendantsByCall.set(row.parent_call_id, []);
      descendantsByCall.get(row.parent_call_id).push({
        id: row.id, tier: row.tier, pid: row.pid, ppid: row.ppid, start_time_ns: row.start_time_ns ?? null, argv: row.argv,
        status: row.status ?? null, error: row.error ?? null,
        started_at: row.started_at ?? null, ended_at: row.ended_at ?? null,
      });
    }
    trace.evidence = trace.evidence.map((item) => {
      const real = item.call_id ? byCallId.get(item.call_id) : null;
      if (!real) return item;
      // 'not_executed' means no execution row was correlated — this could be
      // a call that genuinely never ran, or one the (deliberately
      // conservative) matcher failed to correlate. Either way, there is no
      // real ground truth to show yet, so this stays "unverified" and keeps
      // the regex-heuristic succeeded value rather than asserting a fact we
      // don't actually have.
      const verified = real.outcome !== 'not_executed';
      return {
        ...item,
        real_outcome: real.outcome,
        real_status: real.status ?? null,
        real_error: real.error ?? null,
        match_score: real.match_score ?? null,
        match_basis: real.match_basis ?? null,
        // Which witness observed it (only 'gvisor' now), and whether the
        // runtime layer saw it start. Both drive the badge.
        source: real.source ?? null,
        kernel_confirmed: real.kernel_confirmed === 1,
        // How this call's execution was attributed, recorded at capture (see
        // migration 005). The UI badges this directly instead of re-deriving
        // confidence from kernel_confirmed + match_basis, which is how a
        // text-similarity guess ended up wearing the same badge as an exact
        // join. Null for rows written before 005.
        tier: real.tier ?? null,
        // The call's own process, so the decision chain can say which pid
        // this call ran as and jump to it in the sandbox tree.
        ...executionFields(real),
        descendants: descendantsByCall.get(item.call_id) ?? [],
        descendant_count: real.descendant_count ?? 0,
        verified,
        // Whether the agent's own report of the result (exit code, wall
        // time) agrees with what the runtime observed. See migration 007.
        reported_check: real.reported_check ?? null,
        // Real ground truth overrides the text-scanning heuristic once we
        // have it -- except while a sandbox command is still 'running'
        // (gVisor has seen it start but not exit yet) or its outcome is
        // 'unknown' (the evidence that would say was lost): asserting success
        // or failure there would be a fact we don't have, so keep the heuristic.
        succeeded: verified && real.status !== 'running' && real.status !== 'unknown' ? real.status === 'completed' : item.succeeded,
      };
    });

    // Flat, per-call verification list for the graph view: unlike `evidence`
    // above, this isn't limited to calls whose result got resent as later
    // input — it covers every call this trace ever proposed, including one
    // in the very last response with no later request to resend it into.
    // `origins` already has one entry per call_id with the exchange that
    // proposed it, so this is just that, decorated with whatever real
    // execution data (if any) `divergence()` found for the same call_id.
    const traceOrigins = [...origins.values()].filter((origin) => origin.trace_id === trace.id);
    // Where a sandboxed Claude Code's project folder stood after each call.
    const snapshots = await db.snapshotsForCalls(traceOrigins.map((origin) => origin.call_id));
    trace.callVerifications = traceOrigins.map((origin) => {
      const real = byCallId.get(origin.call_id);
      return {
        call_id: origin.call_id,
        exchange_id: origin.exchange_id,
        name: origin.name,
        kind: origin.kind,
        category: origin.category.category,
        category_source: origin.category.source,
        ...(origin.category.command ? { category_command: origin.category.command } : {}),
        verified: real ? real.outcome !== 'not_executed' : false,
        status: real?.status ?? null,
        error: real?.error ?? null,
        match_score: real?.match_score ?? null,
        match_basis: real?.match_basis ?? null,
        source: real?.source ?? null,
        kernel_confirmed: real?.kernel_confirmed === 1,
        tier: real?.tier ?? null,
        reported_check: real?.reported_check ?? null,
        descendant_count: real?.descendant_count ?? 0,
        // Everything the "proposed vs observed" table needs for this row:
        // what the model asked for, and the process that actually ran.
        output_index: origin.output_index,
        proposed: origin.proposed ?? null,
        // The proposed command in plain English, from the same rules Sandbox
        // evidence uses (exec-narrative.mjs). Rule-only here: a model fallback
        // would spend on every trace fetch, and the raw command stays beside it.
        description: origin.kind === 'command' ? describeCommand(origin.proposed) : null,
        ...executionFields(real),
        descendants: descendantsByCall.get(origin.call_id) ?? [],
        snapshot: snapshots.get(origin.call_id) ?? null,
      };
    });
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
