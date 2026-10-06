/**
 * RayTrace storage layer over the evidence database (proxy/schema/*.sql,
 * created and verified by init-evidence-db.mjs). This module is the only
 * place that knows about tables.
 *
 * The proxy writes it once per captured model request: session -> turn ->
 * exchange -> proposed tool calls, with payloads stored once by digest.
 *
 * Readers (the dashboard) get the row shapes they always had -- hydrated
 * exchanges -- so the evidence model can stay
 * normalized without every consumer learning it. Tool calls are identified
 * internally by their own ids; reads that the dashboard joins on use the
 * provider's call id, always scoped to specific exchanges.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initializeEvidenceDatabase } from './init-evidence-db.mjs';
import { promptInfo } from './prompt-traces.mjs';
import { TOOL_RESULT_KINDS } from './tool-metadata.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const toMs = (value) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; };
const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const asJson = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const fromJson = (value) => { if (value === null || value === undefined) return null; try { return JSON.parse(value); } catch { return null; } };
const marks = (list) => list.map(() => '?').join(',');
const CALL_TYPES = /function_call|tool_use|tool_call/i;
const ROUTES = `(e.route LIKE '%/responses' OR e.route LIKE '%/messages' OR e.route LIKE '%/chat/completions')`;

function previewOf(item) {
  const content = item?.content ?? item?.text ?? item?.output ?? item;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((part) => part?.text || part?.content || '').filter(Boolean).join(' ')
    : JSON.stringify(content ?? '');
  return (text || '').slice(0, 240);
}


export function openEvidenceStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  // Creates a fresh v2 database, or verifies an existing one; refuses
  // anything else (an old-format database, a changed schema) untouched.
  initializeEvidenceDatabase(file);
  const db = new DatabaseSync(file);
  // WAL lets the dashboard read while the proxy writes, but needs shared
  // memory network mounts cannot provide. Fall back rather than refuse.
  let journal = 'wal';
  try { db.exec('PRAGMA journal_mode = WAL'); db.exec('PRAGMA synchronous = NORMAL'); }
  catch { db.exec('PRAGMA journal_mode = DELETE'); db.exec('PRAGMA synchronous = FULL'); journal = 'delete'; }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const q = (sql) => db.prepare(sql);
  const insertPayload = q('INSERT OR IGNORE INTO agent_payloads (sha, content) VALUES (?, ?)');
  const selectPayload = q('SELECT content FROM agent_payloads WHERE sha = ?');

  function putPayload(value) {
    if (value === undefined) return null;
    const text = JSON.stringify(value);
    const sha = sha256(text);
    insertPayload.run(sha, text);
    return sha;
  }
  const getPayload = (sha) => (sha ? fromJson(selectPayload.get(sha)?.content ?? null) : null);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  // ------------------------------------------------------------ agent intent

  const selectSession = q('SELECT id FROM agent_sessions WHERE external_session_id = ? ORDER BY started_at_ms LIMIT 1');
  const insertSession = q('INSERT INTO agent_sessions (id, external_session_id, agent_name, started_at_ms) VALUES (?, ?, ?, ?)');
  const selectContinuedTurn = q('SELECT id FROM agent_turns WHERE session_id = ? AND prompt_key = ? ORDER BY sequence_number DESC LIMIT 1');
  const nextSequence = q('SELECT COALESCE(MAX(sequence_number) + 1, 0) AS n FROM agent_turns WHERE session_id = ?');
  const insertTurn = q(`INSERT INTO agent_turns (id, session_id, sequence_number, user_prompt_sha, started_at_ms, status, prompt_key)
    VALUES (?, ?, ?, ?, ?, 'active', ?)`);
  const updateTurn = q(`UPDATE agent_turns SET status = ?, ended_at_ms = MAX(COALESCE(ended_at_ms, started_at_ms), ?),
    final_response_sha = COALESCE(?, final_response_sha) WHERE id = ?`);
  const selectExchangeId = q('SELECT id FROM agent_exchanges WHERE id = ?');
  const insertExchange = q(`INSERT INTO agent_exchanges (id, turn_id, session_id, provider, model, started_at_ms, completed_at_ms,
    http_status, request_sha, response_sha, metrics_json, route, method, tools_sha, input_key, transport_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertContext = q(`INSERT INTO agent_context_items (exchange_id, position, role, kind, external_call_id, payload_sha, preview)
    VALUES (?,?,?,?,?,?,?)`);
  const insertToolCall = q(`INSERT INTO agent_tool_calls (id, exchange_id, external_call_id, output_index, tool_name, arguments_sha, proposed_at_ms)
    VALUES (?,?,?,?,?,?,?)`);
  // The call a result answers: same session, proposed no later than the
  // request carrying the result, not already answered.
  const selectAnsweredCall = q(`SELECT c.id FROM agent_tool_calls c JOIN agent_exchanges e ON e.id = c.exchange_id
    WHERE c.external_call_id = ? AND e.session_id = ? AND c.reported_result_sha IS NULL AND e.started_at_ms <= ?
    ORDER BY e.started_at_ms DESC LIMIT 1`);
  const setReportedResult = q('UPDATE agent_tool_calls SET reported_result_sha = ? WHERE id = ?');

  function ensureSession(row, startedMs) {
    const external = typeof row.session_id === 'string' && row.session_id ? row.session_id : null;
    const found = external ? selectSession.get(external) : null;
    if (found) return found.id;
    const id = randomUUID();
    insertSession.run(id, external, null, toMs(row.session_started_at) ?? startedMs);
    return id;
  }

  /** Which turn a request belongs to. A turn opens on a request whose last
   * real user message is the last input item (the user just asked); later
   * requests that carry the same conversation prefix plus the agent's own
   * work continue it. Background jobs (title generation, catch-ups) and
   * requests with no user message belong to no turn. */
  function resolveTurn(sessionId, row, request, startedMs) {
    const prompt = promptInfo(request);
    if (!prompt) return null;
    // Two sessions given the same prompt start identically, so the agent's
    // own session id is part of the key when a row has one: a session never
    // continues another's turn. Rows without one keep their original key.
    const key = sha256(JSON.stringify([row.provider ?? null, request?.model ?? null, prompt.prefix,
      ...(row.agent_session_id ? [row.agent_session_id] : [])]));
    if (prompt.continuation) {
      const turn = selectContinuedTurn.get(sessionId, key);
      if (turn) return turn.id;
    }
    const id = randomUUID();
    insertTurn.run(id, sessionId, nextSequence.get(sessionId).n, putPayload(prompt.title), startedMs, key);
    return id;
  }

  function recordExchange(row) {
    if (!row?.span_id) return;
    const request = row.request?.payload ?? null;
    const response = row.response?.payload ?? null;
    const inputKey = Array.isArray(request?.input) ? 'input' : Array.isArray(request?.messages) ? 'messages' : null;
    const items = inputKey ? request[inputKey] : [];
    const envelope = request ? Object.fromEntries(Object.entries(request).filter(([key]) => key !== inputKey && key !== 'tools')) : null;
    const startedMs = toMs(row.timestamp) ?? Date.now();
    const completedMs = Math.max(startedMs, toMs(row.completed_at) ?? startedMs);
    const output = Array.isArray(response?.output) ? response.output : [];
    const proposals = output.map((item, index) => [item, index]).filter(([item]) => item?.call_id && CALL_TYPES.test(item?.type || ''));

    transaction(() => {
      if (selectExchangeId.get(row.span_id)) return;
      const sessionId = ensureSession(row, startedMs);
      const turnId = resolveTurn(sessionId, row, request, startedMs);
      const responseSha = putPayload(response);
      insertExchange.run(row.span_id, turnId, sessionId, row.provider ?? 'unknown', request?.model ?? null, startedMs, completedMs,
        row.response?.status ?? null, putPayload(envelope), responseSha, asJson(row.metrics), row.route ?? null, row.method ?? null,
        request?.tools === undefined ? null : putPayload(request.tools), inputKey,
        asJson({ trace_id: row.trace_id ?? null, parent_span_id: row.parent_span_id ?? null,
          request: { headers: row.request?.headers ?? null, bytes: row.request?.bytes ?? null, sha256: row.request?.sha256 ?? null },
          response: { headers: row.response?.headers ?? null, bytes: row.response?.bytes ?? null, sha256: row.response?.sha256 ?? null } }));

      for (const [position, item] of items.entries()) {
        const payloadSha = putPayload(item);
        insertContext.run(row.span_id, position, item?.role ?? null, item?.type ?? null, item?.call_id ?? null, payloadSha, previewOf(item));
        // A tool result the agent sends back is its report of what the call
        // did -- recorded on the call as a report, never as evidence.
        if (item?.call_id && TOOL_RESULT_KINDS.includes(item?.type)) {
          const call = selectAnsweredCall.get(item.call_id, sessionId, startedMs);
          if (call) setReportedResult.run(payloadSha, call.id);
        }
      }
      for (const [item, outputIndex] of proposals) {
        insertToolCall.run(randomUUID(), row.span_id, item.call_id, outputIndex, item.name ?? item.function?.name ?? 'tool',
          putPayload(item.arguments ?? item.input ?? item.function?.arguments ?? null), completedMs);
      }
      if (turnId) {
        // A response that proposes nothing more is the agent's answer.
        const failed = Number(row.response?.status) >= 400;
        const status = failed ? 'failed' : proposals.length ? 'active' : 'completed';
        updateTurn.run(status, completedMs, status === 'completed' ? responseSha : null, turnId);
      }
    });
  }

  // Rebuild the capture-time row shape the dashboard and lab consume.
  const selectContextPayloads = q('SELECT payload_sha FROM agent_context_items WHERE exchange_id = ? ORDER BY position');
  const EXCHANGE_COLUMNS = `e.*, s.external_session_id, s.started_at_ms AS session_started_ms, t.user_prompt_sha`;
  function hydrate(record) {
    const payload = { ...getPayload(record.request_sha) };
    const tools = getPayload(record.tools_sha);
    if (tools !== null) payload.tools = tools;
    if (record.input_key) payload[record.input_key] = selectContextPayloads.all(record.id).map((item) => getPayload(item.payload_sha));
    const transport = fromJson(record.transport_json) ?? {};
    return {
      event_type: 'model.exchange',
      session_id: record.external_session_id, session_started_at: toIso(record.session_started_ms),
      // A trace is a turn: one prompt and everything the agent did for it.
      trace_id: record.turn_id, promptTitle: record.user_prompt_sha ? getPayload(record.user_prompt_sha) : null,
      span_id: record.id, parent_span_id: transport.parent_span_id ?? null,
      timestamp: toIso(record.started_at_ms), completed_at: toIso(record.completed_at_ms),
      provider: record.provider, route: record.route, method: record.method,
      metrics: fromJson(record.metrics_json),
      request: { headers: transport.request?.headers ?? null, bytes: transport.request?.bytes ?? null, sha256: transport.request?.sha256 ?? null, payload },
      response: { status: record.http_status, headers: transport.response?.headers ?? null, bytes: transport.response?.bytes ?? null,
        sha256: transport.response?.sha256 ?? null, payload: getPayload(record.response_sha) },
    };
  }
  const latestSession = q(`SELECT e.session_id FROM agent_exchanges e JOIN agent_sessions s ON s.id = e.session_id
    WHERE e.turn_id IS NOT NULL AND ${ROUTES} ORDER BY s.started_at_ms DESC, e.started_at_ms DESC LIMIT 1`);
  const turnExchanges = (scoped) => q(`SELECT ${EXCHANGE_COLUMNS} FROM agent_exchanges e
    JOIN agent_sessions s ON s.id = e.session_id JOIN agent_turns t ON t.id = e.turn_id
    WHERE ${ROUTES} ${scoped ? 'AND e.session_id = ?' : ''} ORDER BY e.started_at_ms DESC LIMIT ?`);
  const recentAll = turnExchanges(false);
  const recentBySession = turnExchanges(true);
  const selectExchange = q(`SELECT ${EXCHANGE_COLUMNS} FROM agent_exchanges e
    JOIN agent_sessions s ON s.id = e.session_id LEFT JOIN agent_turns t ON t.id = e.turn_id WHERE e.id = ?`);

  return {
    db, journal, recordExchange,

    /** Captured exchanges that belong to a turn, newest-first bounded,
     * returned oldest-first. Scoped to the latest session unless `history`. */
    exchangeRows({ history = false, limit = history ? 2000 : 400 } = {}) {
      const session = history ? null : latestSession.get()?.session_id ?? null;
      const rows = session ? recentBySession.all(session, limit) : recentAll.all(limit);
      return rows.map(hydrate).reverse();
    },

    findExchange(exchangeId) {
      const record = selectExchange.get(exchangeId);
      if (!record) return undefined;
      const row = hydrate(record);
      return { payload: row.request.payload, response: row.response.payload, provider: row.provider, route: row.route, session_id: row.session_id };
    },

    /** Changes whenever anything the trace list shows could have: a cheap
     * key for caching it. Counts only ever grow; a result reported back
     * changes a count too. */
    dataVersion() {
      return Object.values(q(`SELECT (SELECT count(*) FROM agent_exchanges) AS exchanges,
          (SELECT count(*) FROM agent_tool_calls WHERE reported_result_sha IS NOT NULL) AS results`).get()).join(':');
    },


    // ---- auxiliary features

    recordProxyError(row) {
      q('INSERT INTO proxy_errors (trace_id, occurred_at_ms, provider, route, error, cause_json) VALUES (?,?,?,?,?,?)')
        .run(row.trace_id ?? null, toMs(row.timestamp), row.provider ?? null, row.route ?? null, row.error ?? null, asJson(row.cause));
    },
    saveExperiment(job) {
      q(`INSERT OR REPLACE INTO lab_experiments (id, exchange_id, created_at_ms, status, kind, model, body_json) VALUES (?,?,?,?,?,?,?)`)
        .run(job.id, job.exchange_id ?? null, toMs(job.created_at) ?? Date.now(), job.status ?? null, job.kind ?? 'experiment', job.model ?? null, JSON.stringify(job));
    },
    loadExperiments(limit = 200) {
      return q('SELECT body_json FROM lab_experiments ORDER BY created_at_ms DESC LIMIT ?').all(limit)
        .map((record) => fromJson(record.body_json)).filter(Boolean);
    },
    getExplanation(key) { return fromJson(q('SELECT body_json FROM step_explanations WHERE key = ?').get(key)?.body_json ?? null); },
    putExplanation(key, value) { q('INSERT OR REPLACE INTO step_explanations (key, created_at_ms, body_json) VALUES (?,?,?)').run(key, Date.now(), JSON.stringify(value)); },
    getSummary(key) { return fromJson(q('SELECT body_json FROM exchange_summaries WHERE key = ?').get(key)?.body_json ?? null); },
    putSummary(key, exchangeId, value) {
      q('INSERT OR REPLACE INTO exchange_summaries (key, exchange_id, created_at_ms, body_json) VALUES (?,?,?,?)').run(key, exchangeId ?? null, Date.now(), JSON.stringify(value));
    },
    summaryForSpan(exchangeId) {
      return fromJson(q('SELECT body_json FROM exchange_summaries WHERE exchange_id = ? ORDER BY created_at_ms DESC LIMIT 1').get(exchangeId)?.body_json ?? null);
    },
    /** What each tool call asked for and what the agent was told back, keyed
     * by the provider's call id. */
    toolCallContexts(externalCallIds) {
      const list = [...new Set((externalCallIds ?? []).filter((id) => typeof id === 'string' && id))];
      if (!list.length) return new Map();
      const rows = q(`SELECT c.external_call_id, c.tool_name, c.arguments_sha, c.reported_result_sha
        FROM agent_tool_calls c JOIN agent_exchanges e ON e.id = c.exchange_id
        WHERE c.external_call_id IN (${marks(list)}) ORDER BY e.started_at_ms`).all(...list);
      // Later rows win: a replayed call keeps the newest arguments and result.
      return new Map(rows.map((row) => [row.external_call_id, {
        tool_name: row.tool_name, args: getPayload(row.arguments_sha), result: getPayload(row.reported_result_sha) }]));
    },

    stats() {
      const one = (sql) => db.prepare(sql).get();
      return {
        sessions: one('SELECT COUNT(*) AS n FROM agent_sessions').n,
        turns: one('SELECT COUNT(*) AS n FROM agent_turns').n,
        exchanges: one('SELECT COUNT(*) AS n FROM agent_exchanges').n,
        payloads: one('SELECT COUNT(*) AS n, COALESCE(SUM(length(content)),0) AS bytes FROM agent_payloads'),
      };
    },

    close() { db.close(); },
  };
}
