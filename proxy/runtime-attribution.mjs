/**
 * Ties sandbox processes the gVisor forwarder observed to the tool calls they
 * ran for. Shared by the local proxy (raytace-proxy.mjs, its SQLite store)
 * and the hosted evidence service (RayTrace's cloud, a
 * Postgres store bound to one org); `db` is either, and every call into it is
 * awaited, which a synchronous store answers at once.
 */
import { matchBatch, OPEN_WINDOW_CAP_MS } from './execution-correlation.mjs';
import { commandMarker } from './gvisor-forwarder.mjs';

// Tools that run a command. Only their calls are matched to a process by its
// text: Claude Code's Read reads the file itself, so a `cat` that ran nearby
// (its own shell setup runs several) is never that call. A call recorded
// without a tool name is still considered, as before. Call-id markers are
// exact and need no such check.
const COMMAND_TOOLS = /^(bash|shell|exec_command|local_shell|container\.exec)$/i;
const runsCommands = (candidate) => !candidate.tool_name || COMMAND_TOOLS.test(candidate.tool_name);

/**
 * Records sandbox processes the gVisor forwarder observed and ties each to
 * the proposed tool call it ran for, when one can be identified. Every
 * process is recorded whether or not it matches: a process with no
 * attribution is what "ran, but no tool call accounts for it" means.
 *
 * Candidates are the session's proposed calls not yet tied to a process,
 * each with its causal window (proposal -> result sent back). A process
 * carrying RAYTRACE_CALL_ID needs no matching: the call id travelled with
 * it, so that join is exact and overrides the text match. It is still
 * checked against this session's own candidates, so a forged or stale
 * marker cannot attach a process to a call in another session.
 * Returns exec id -> match for whatever matched; see
 * execution-correlation.mjs for why this is not a plain id lookup.
 */
export async function ingestExecutions(db, events, { sessionId = null } = {}) {
  const matches = new Map();
  if (!Array.isArray(events) || !events.length) return matches;
  const recorded = new Map();
  for (const event of events) {
    recorded.set(event.id, await db.recordProcessStart({
      containerId: event.container_id, projectId: sessionId, raw: event.raw, startedMs: event.timestamp }));
  }
  const timestamps = events.map((e) => e.timestamp).filter(Number.isFinite);
  if (!sessionId || !timestamps.length) return matches;
  // The pool reaches back as far as an open window may stay open, plus the
  // clock margin between the proxy and the sandbox.
  const margin = Math.max(0, ...events.map((e) => e.margin).filter(Number.isFinite));
  const candidates = await db.candidatesInWindow(Math.min(...timestamps) - OPEN_WINDOW_CAP_MS - margin, Math.max(...timestamps) + margin, { sessionId });
  const found = matchBatch(events, candidates.filter(runsCommands));
  const byExternalId = new Map(candidates.map((c) => [c.external_call_id, c.call_id]));
  for (const event of events) {
    const eventId = recorded.get(event.id)?.eventId;
    const markedCall = event.call_marker ? byExternalId.get(event.call_marker) : null;
    const match = markedCall ? { call_id: markedCall, score: 1, basis: 'marker' } : found.get(event.id);
    if (!match || !eventId) continue; // no confident match: the process stays recorded, unattributed -- never a guess
    await db.attribute({ toolCallId: match.call_id, eventId, method: match.basis === 'id' ? 'marker' : match.basis,
      // A marker join is exact; a text match that gVisor itself observed is
      // corroborated. Recorded at capture, never promoted later.
      confidence: markedCall ? 'exact' : 'corroborated', score: match.score,
      windowStartMs: match.window_start ?? null, windowEndMs: match.window_end ?? null });
    matches.set(event.id, match);
  }
  return matches;
}

/**
 * Ties a sandbox's processes to the calls they ran for, after the fact.
 * Claude Code starts a tool before its answer has finished streaming, and a
 * call is only recorded once the answer is complete, so the gVisor forwarder
 * has usually seen the process before the call it belongs to exists. Once
 * the call is recorded, the same rules apply as at exec time: the call id the
 * process carries (checked against this session's own calls), else a process
 * started by one already tied to a call inherits it, else the text match.
 */
export async function attributeLateProcesses(db, sessionId, log = console.log) {
  const now = Date.now();
  const candidates = await db.candidatesInWindow(now - 24 * 3_600_000, now + 60_000, { sessionId });
  if (!candidates.length) return;
  const margin = 2_000;
  const processes = await db.unattributedProcesses({ sessionId, sinceMs: Math.min(...candidates.map((c) => c.window_start)) - margin });
  const byExternalId = new Map(candidates.map((c) => [c.external_call_id, c]));
  const claimed = new Set();
  const callOfProcess = new Map(); // process id -> call id, for children within this pass
  const unmatched = [];
  let tied = 0;
  for (const proc of processes) {
    const argv = Array.isArray(proc.raw.argv) ? proc.raw.argv.filter((part) => typeof part === 'string') : [];
    const command = argv.join(' ').trim();
    const marker = proc.raw.markers?.RAYTRACE_CALL_ID ?? commandMarker(command);
    const marked = marker ? byExternalId.get(marker) : null;
    const parentCall = proc.parent_call_id ?? callOfProcess.get(proc.parent_process_id);
    let call = null; let method = null;
    if (marked && !claimed.has(marked.call_id)) { call = marked.call_id; method = 'marker'; claimed.add(call); }
    else if (parentCall) { call = parentCall; method = 'inherited'; }
    else if (marked) { call = marked.call_id; method = 'inherited'; }
    if (call) {
      await db.attribute({ toolCallId: call, eventId: proc.event_id, method, confidence: method === 'marker' ? 'exact' : 'corroborated', score: method === 'marker' ? 1 : null });
      callOfProcess.set(proc.process_id, call);
      tied += 1;
    } else if (command && Number.isFinite(proc.first_seen_ms)) unmatched.push({ id: proc.event_id, command, timestamp: proc.first_seen_ms, margin, process_id: proc.process_id });
  }
  const found = matchBatch(unmatched, candidates.filter((c) => !claimed.has(c.call_id) && runsCommands(c)));
  for (const exec of unmatched) {
    const match = found.get(exec.id);
    if (!match) continue;
    await db.attribute({ toolCallId: match.call_id, eventId: exec.id, method: match.basis === 'id' ? 'marker' : match.basis, confidence: 'corroborated',
      score: match.score, windowStartMs: match.window_start ?? null, windowEndMs: match.window_end ?? null });
    tied += 1;
  }
  if (tied) log(`[raytace][claude-code] ${sessionId.slice(0, 12)}: tied ${tied} sandbox process(es) to calls recorded after they ran`);
}
