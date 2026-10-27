/**
 * Splunk-style search over the derived `search_events` index
 * (proxy/schema/search.sql, filled by evidence-store.mjs).
 *
 * Query shape: free text + `field:value` filters + one optional pipe.
 *   outcome:failed tool:Bash "permission denied"
 *   reported:ok observed:failed          (agent said ok, sandbox saw fail)
 *   exit:127 | stats count by command
 *   failed | timechart count by model span=1d
 *
 * Fields: outcome (failed|ok|unknown), reported, observed, tool, model,
 * category, kind (call|turn|proxy_error), provider, exit / exit:>=1,
 * http / http:>=400, file:<substring>, signature:<prefix>, session,
 * after:YYYY-MM-DD, before:YYYY-MM-DD. Bare `failed` means outcome:failed.
 * Prefix any filter or word with `-` to negate. Trailing `*` = prefix.
 *
 * Outcomes never upgrade missing evidence: no result and no observed
 * process is `unknown`, matching processOutcome/toolResultStatus.
 */
import { toolResultStatus } from './tool-metadata.mjs';

// ------------------------------------------------------------ outcomes

/** toolResultStatus label -> index outcome. A returned result with no
 * error marker is the agent being told it worked: reported ok. */
export function reportedOutcome(resultItem) {
  if (resultItem == null) return 'unknown';
  const status = toolResultStatus(resultItem);
  if (status === 'Failed' || status === 'Cancelled') return 'failed';
  if (status === 'Successful' || status === 'Result received') return 'ok';
  return 'unknown'; // Still running / No output / Output omitted
}

/** processOutcome status (evidence-store) -> index outcome. */
export function observedOutcome(processStatus) {
  if (processStatus === 'failed') return 'failed';
  if (processStatus === 'completed') return 'ok';
  return 'unknown';
}

/** Failed wins; ok needs at least one witness and no failure. */
export function combineOutcomes(reported, observed) {
  if (reported === 'failed' || observed === 'failed') return 'failed';
  if (reported === 'ok' || observed === 'ok') return 'ok';
  return 'unknown';
}

// ------------------------------------------------------------ text

const MAX_INDEX_TEXT = 64_000;

/** Head+tail cap so one giant tool result cannot bloat the index. */
export function clipText(text, max = MAX_INDEX_TEXT) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.7);
  return `${value.slice(0, head)}\n…[clipped]…\n${value.slice(-(max - head))}`;
}

/** Flatten a stored payload (any JSON shape) into searchable text. */
export function payloadToText(value, depth = 0) {
  if (value == null || depth > 6) return '';
  if (typeof value === 'string') {
    // Arguments/results are often JSON strings: index their inner text too.
    if ((value.startsWith('{') || value.startsWith('[')) && value.length > 1) {
      try { const inner = payloadToText(JSON.parse(value), depth + 1); if (inner) return inner; } catch { /* keep raw */ }
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => payloadToText(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const preferred = ['text', 'content', 'output', 'command', 'cmd', 'script', 'message', 'error']
      .map((key) => payloadToText(value[key], depth + 1)).filter(Boolean);
    if (preferred.length) return preferred.join('\n');
    return Object.values(value).map((item) => payloadToText(item, depth + 1)).filter(Boolean).join('\n');
  }
  return '';
}

const PATH_KEYS = new Set(['path', 'file_path', 'filepath', 'file', 'filename', 'cwd', 'workdir',
  'directory', 'dir', 'target', 'source', 'destination', 'old_path', 'new_path', 'notebook_path']);

/** File paths named in tool arguments (for file: search). */
export function extractFilePaths(value, out = new Set(), depth = 0) {
  if (value == null || depth > 6 || out.size > 40) return out;
  if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
    try { return extractFilePaths(JSON.parse(value), out, depth + 1); } catch { return out; }
  }
  if (Array.isArray(value)) { for (const item of value) extractFilePaths(item, out, depth + 1); return out; }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && PATH_KEYS.has(key.toLowerCase()) && item.length <= 1024) out.add(item);
      else extractFilePaths(item, out, depth + 1);
    }
  }
  return out;
}

/** Path-like tokens in free text (a Bash command naming src/parser.js),
 * so file: works for shell tools too, not only file-tool arguments. */
export function pathsFromText(text, out = new Set()) {
  for (const match of String(text ?? '').matchAll(/(?<![\w/.-])((?:\.?\.?\/)?(?:[\w@+~-]+\/)+[\w@+~-]+(?:\.[\w@+~-]+)+)\b/gi)) {
    if (out.size > 40) break;
    out.add(match[1]);
  }
  return out;
}

/** The command a call proposed, for display + `stats by command`.
 * Deliberately small: full rendering lives in trace-view. */
export function commandTextOf(args) {
  let value = args;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return value.slice(0, 400); } }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const cmd = value.cmd ?? value.command ?? value.script;
    if (Array.isArray(cmd)) return cmd.map(String).join(' ').slice(0, 400);
    if (typeof cmd === 'string' && cmd.trim()) return cmd.trim().slice(0, 400);
    const file = value.file_path ?? value.path ?? value.file;
    if (typeof file === 'string') return file.slice(0, 400);
  }
  if (Array.isArray(value)) return value.map(String).join(' ').slice(0, 400);
  return '';
}

// ------------------------------------------------------------ query parsing

const FIELD_ALIASES = { status: 'outcome', exit: 'exit_code', http: 'http_status', sig: 'signature' };
const KNOWN_FIELDS = new Set(['outcome', 'reported', 'observed', 'tool', 'model', 'category', 'kind',
  'provider', 'agent', 'exit_code', 'http_status', 'signature', 'file', 'session', 'after', 'before']);

function splitPipe(input) {
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === '"') quoted = !quoted;
    else if (input[i] === '|' && !quoted) return [input.slice(0, i), input.slice(i + 1)];
  }
  return [input, null];
}

function tokenize(input) {
  const tokens = [];
  const pattern = /(-)?"([^"]*)"|(-)?(\S+)/g;
  let match;
  while ((match = pattern.exec(input)) !== null) {
    if (match[2] !== undefined) tokens.push({ value: match[2], phrase: true, negated: Boolean(match[1]) });
    else tokens.push({ value: match[4], phrase: false, negated: Boolean(match[3]) });
  }
  return tokens;
}

function parsePipe(text, errors) {
  if (text == null) return null;
  const trimmed = text.trim();
  let m = trimmed.match(/^stats\s+(count|avg\s*\(\s*duration\s*\))(?:\s+by\s+([a-z_]+))?$/i);
  if (m) return { type: 'stats', agg: /^avg/i.test(m[1]) ? 'avg_duration' : 'count', by: m[2]?.toLowerCase() ?? null };
  m = trimmed.match(/^timechart\s+count(?:\s+by\s+([a-z_]+))?(?:\s+span=(\d+)([mhd]))?$/i);
  if (m) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[3] ?? 'd').toLowerCase()];
    return { type: 'timechart', by: m[1]?.toLowerCase() ?? null, spanMs: unit * Number(m[2] ?? 1) };
  }
  errors.push(`Unsupported pipe: | ${trimmed.slice(0, 60)}`);
  return null;
}

export function parseSearchQuery(input = '') {
  const errors = [];
  const [head, pipeText] = splitPipe(String(input ?? ''));
  const text = [];
  const filters = [];
  for (const token of tokenize(head)) {
    if (!token.phrase) {
      const bare = token.value.toLowerCase();
      if (!token.negated && (bare === 'failed' || bare === 'failure')) { filters.push({ field: 'outcome', value: 'failed', negated: false }); continue; }
      const fieldMatch = token.value.match(/^([a-z_]+):(.*)$/i);
      if (fieldMatch) {
        const field = FIELD_ALIASES[fieldMatch[1].toLowerCase()] ?? fieldMatch[1].toLowerCase();
        if (KNOWN_FIELDS.has(field)) { filters.push({ field, value: fieldMatch[2], negated: token.negated }); continue; }
        errors.push(`Unknown field: ${fieldMatch[1]}`);
      }
    }
    const prefix = !token.phrase && token.value.endsWith('*') && token.value.length > 1;
    text.push({ value: prefix ? token.value.slice(0, -1) : token.value, phrase: token.phrase, prefix, negated: token.negated });
  }
  return { text, filters, pipe: parsePipe(pipeText, errors), errors };
}

// ------------------------------------------------------------ SQL building

const EQUALITY = { outcome: 'outcome', reported: 'outcome_reported', observed: 'outcome_observed',
  tool: 'tool_name', model: 'model', category: 'category', kind: 'kind', provider: 'provider', agent: 'agent' };
const NUMERIC = { exit_code: 'exit_code', http_status: 'http_status' };

const likeEscape = (value) => value.replace(/[%_\\]/g, '\\$&');

function dateBound(value, upper) {
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // A bare date for `before:` means the end of that day.
  return upper && /^\d{4}-\d{2}-\d{2}$/.test(value) ? ms + 86_399_999 : ms;
}

/** WHERE clause + params for the parsed filters and time range.
 * `exclude` drops one field's filters (for facet counts). */
function buildWhere(parsed, { fromMs = null, toMs = null, exclude = null } = {}) {
  const clauses = [];
  const params = [];
  let from = fromMs;
  let to = toMs;
  for (const filter of parsed.filters) {
    if (filter.field === exclude) continue;
    const not = filter.negated ? 'NOT ' : '';
    if (filter.field === 'after') { const b = dateBound(filter.value, false); if (b != null) from = from == null ? b : Math.max(from, b); continue; }
    if (filter.field === 'before') { const b = dateBound(filter.value, true); if (b != null) to = to == null ? b : Math.min(to, b); continue; }
    if (EQUALITY[filter.field]) {
      const column = EQUALITY[filter.field];
      if (filter.value.endsWith('*')) { clauses.push(`${not}(${column} LIKE ? ESCAPE '\\')`); params.push(`${likeEscape(filter.value.slice(0, -1))}%`); }
      else { clauses.push(`${not}(LOWER(COALESCE(${column},'')) = LOWER(?))`); params.push(filter.value); }
    } else if (NUMERIC[filter.field]) {
      const m = filter.value.match(/^(>=|<=|>|<)?(-?\d+)$/);
      if (m) { clauses.push(`${not}(${NUMERIC[filter.field]} ${m[1] ?? '='} ?)`); params.push(Number(m[2])); }
    } else if (filter.field === 'file') {
      clauses.push(`${not}(file_paths LIKE ? ESCAPE '\\')`); params.push(`%${likeEscape(filter.value.replace(/\*/g, ''))}%`);
    } else if (filter.field === 'signature') {
      clauses.push(`${not}(failure_signature LIKE ? ESCAPE '\\')`); params.push(`${likeEscape(filter.value.replace(/\*/g, ''))}%`);
    } else if (filter.field === 'session') {
      clauses.push(`${not}(session_id = ? OR session_external = ?)`); params.push(filter.value, filter.value);
    }
  }
  if (from != null) { clauses.push('ts_ms >= ?'); params.push(from); }
  if (to != null) { clauses.push('ts_ms <= ?'); params.push(to); }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

const ftsTerm = (term) => `"${term.value.replace(/"/g, '""')}"${term.prefix ? '*' : ''}`;

function ftsClauses(parsed) {
  const positives = parsed.text.filter((term) => !term.negated);
  const negatives = parsed.text.filter((term) => term.negated);
  return {
    match: positives.length ? positives.map(ftsTerm).join(' AND ') : null,
    excludeMatch: negatives.length ? negatives.map(ftsTerm).join(' OR ') : null,
  };
}

function baseFrom(match) {
  return match
    ? 'FROM search_events se JOIN search_fts ON search_fts.rowid = se.rowid AND search_fts MATCH ?'
    : 'FROM search_events se';
}

/** Full WHERE across the events alias, FTS match first in params. */
function scopedWhere(parsed, range, { exclude = null } = {}) {
  const { match, excludeMatch } = ftsClauses(parsed);
  const built = buildWhere(parsed, { ...range, exclude });
  // Free-text exclusions stay out of facet-exclusion logic: always applied.
  const extra = excludeMatch ? ' AND se.rowid NOT IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)' : '';
  const params = [...(match ? [match] : []), ...built.params.map((p) => p), ...(excludeMatch ? [excludeMatch] : [])];
  // buildWhere columns are unqualified; qualify for the joined query.
  const where = built.where.replace(/(^|[^.\w])(outcome_reported|outcome_observed|outcome|tool_name|model|category|kind|provider|agent|exit_code|http_status|file_paths|failure_signature|session_id|session_external|ts_ms)\b/g, '$1se.$2');
  return { from: baseFrom(match), where: `${where}${extra}`, params, hasText: Boolean(match) };
}

const GROUP_EXPR = {
  tool: 'se.tool_name', model: 'se.model', category: 'se.category', outcome: 'se.outcome',
  reported: 'se.outcome_reported', observed: 'se.outcome_observed', kind: 'se.kind',
  provider: 'se.provider', exit: 'CAST(se.exit_code AS TEXT)', exit_code: 'CAST(se.exit_code AS TEXT)',
  http: 'CAST(se.http_status AS TEXT)', signature: 'se.failure_signature',
  command: "substr(se.command_text, 1, instr(se.command_text || ' ', ' ') - 1)",
  day: "date(se.ts_ms / 1000, 'unixepoch')",
};

function runStats(db, parsed, range) {
  const { pipe } = parsed;
  const { from, where, params } = scopedWhere(parsed, range);
  if (pipe.type === 'stats') {
    const expr = pipe.by ? GROUP_EXPR[pipe.by] : null;
    if (pipe.by && !expr) return { mode: 'stats', rows: [], error: `Cannot group by ${pipe.by}` };
    const agg = pipe.agg === 'avg_duration' ? 'ROUND(AVG(se.duration_ms))' : 'COUNT(*)';
    const sql = expr
      ? `SELECT ${expr} AS k, ${agg} AS v, COUNT(*) AS n ${from} WHERE ${where} GROUP BY k ORDER BY ${pipe.agg === 'avg_duration' ? 'v DESC' : 'n DESC'} LIMIT 50`
      : `SELECT NULL AS k, ${agg} AS v, COUNT(*) AS n ${from} WHERE ${where}`;
    return { mode: 'stats', agg: pipe.agg, by: pipe.by, rows: db.prepare(sql).all(...params).map((r) => ({ key: r.k ?? (pipe.by ? '(none)' : '(all)'), value: r.v ?? 0, count: r.n })) };
  }
  // timechart
  const expr = pipe.by ? GROUP_EXPR[pipe.by] : null;
  if (pipe.by && !expr) return { mode: 'timechart', rows: [], error: `Cannot group by ${pipe.by}` };
  const bucket = `(se.ts_ms / ${pipe.spanMs}) * ${pipe.spanMs}`;
  const rows = db.prepare(`SELECT ${bucket} AS t, ${expr ? `${expr} AS k,` : 'NULL AS k,'} COUNT(*) AS n ${from} WHERE ${where} GROUP BY t${expr ? ', k' : ''} ORDER BY t`).all(...params);
  const noneLabel = pipe.by ? '(none)' : '(all)';
  const seriesTotals = new Map();
  for (const row of rows) seriesTotals.set(row.k ?? noneLabel, (seriesTotals.get(row.k ?? noneLabel) ?? 0) + row.n);
  const series = [...seriesTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key]) => key);
  const byTime = new Map();
  for (const row of rows) {
    const key = row.k ?? noneLabel;
    const label = series.includes(key) ? key : 'other';
    if (!byTime.has(row.t)) byTime.set(row.t, { t: row.t });
    byTime.get(row.t)[label] = (byTime.get(row.t)[label] ?? 0) + row.n;
  }
  return { mode: 'timechart', by: pipe.by, spanMs: pipe.spanMs, series: [...series, ...(seriesTotals.size > 8 ? ['other'] : [])], rows: [...byTime.values()] };
}

function facet(db, parsed, range, field, column, limit) {
  const scoped = scopedWhere(parsed, range, { exclude: field });
  return db.prepare(`SELECT ${column} AS k, COUNT(*) AS n ${scoped.from} WHERE ${scoped.where} GROUP BY k ORDER BY n DESC LIMIT ${limit}`)
    .all(...scoped.params).filter((row) => row.k !== null && row.k !== '').map((row) => ({ value: String(row.k), count: row.n }));
}

/** Materialize the matching rowids once (temp table, per connection).
 * Summary, histogram and facets then aggregate only the matched set
 * instead of re-evaluating the filters (FTS MATCH, LIKE) once per
 * aggregate. Safe because runSearch is fully synchronous: no other
 * search can interleave between the refill and the reads. */
function materialize(db, parsed, range) {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _raytace_m (rid INTEGER PRIMARY KEY, ts_ms INTEGER, rank REAL)');
  const scoped = scopedWhere(parsed, range);
  db.exec('DELETE FROM _raytace_m');
  db.prepare(`INSERT INTO _raytace_m (rid, ts_ms, rank)
    SELECT se.rowid, se.ts_ms, ${scoped.hasText ? 'bm25(search_fts)' : '0'} ${scoped.from} WHERE ${scoped.where}`)
    .run(...scoped.params);
  return scoped;
}

function facetFromMatches(db, column, limit) {
  return db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM _raytace_m m JOIN search_events se ON se.rowid = m.rid
      GROUP BY k ORDER BY n DESC LIMIT ${limit}`)
    .all().filter((row) => row.k !== null && row.k !== '').map((row) => ({ value: String(row.k), count: row.n }));
}

/**
 * Run one search against the evidence db (node:sqlite handle).
 * Events mode returns hits + facets + histogram + summary; a pipe
 * returns its aggregation instead.
 */
export function runSearch(db, { q = '', fromMs = null, toMs = null, limit = 50, offset = 0 } = {}) {
  const parsed = parseSearchQuery(q);
  const range = { fromMs, toMs };
  if (parsed.pipe) return { query: q, errors: parsed.errors, ...runStats(db, parsed, range) };

  const scoped = materialize(db, parsed, range);
  const MATCHED = 'FROM _raytace_m m JOIN search_events se ON se.rowid = m.rid';
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const boundedOffset = Math.max(Number(offset) || 0, 0);
  const total = db.prepare('SELECT COUNT(*) AS n FROM _raytace_m').get().n;
  const snippetJoin = scoped.hasText ? 'JOIN search_fts ON search_fts.rowid = se.rowid AND search_fts MATCH ?' : '';
  const snippet = scoped.hasText ? `snippet(search_fts, -1, '[', ']', '…', 18) AS snippet,` : '';
  const order = scoped.hasText ? 'm.rank, m.ts_ms DESC' : 'm.ts_ms DESC';
  const { match } = ftsClauses(parsed);
  const hits = db.prepare(`SELECT ${snippet} se.* ${MATCHED} ${snippetJoin} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...(match ? [match] : []), boundedLimit, boundedOffset)
    .map((full) => {
      // Full args/result text stays server-side; hits carry excerpts only.
      const { prompt_text, args_text, result_text, ...row } = full;
      void args_text; void result_text;
      return {
        ...row,
        snippet: row.snippet ?? null,
        ts: new Date(row.ts_ms).toISOString(),
        prompt_excerpt: (prompt_text ?? '').slice(0, 220) || null,
        error_excerpt: (row.error_text ?? '').slice(0, 400) || null,
      };
    });

  const summaryRow = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN se.outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN se.outcome_reported != 'unknown' AND se.outcome_observed != 'unknown'
        AND se.outcome_reported != se.outcome_observed THEN 1 ELSE 0 END) AS mismatched,
      SUM(CASE WHEN se.http_status >= 400 THEN 1 ELSE 0 END) AS http_errors
    ${MATCHED}`).get();

  const span = (toMs ?? Date.now()) - (fromMs ?? (hits.at(-1)?.ts_ms ?? 0));
  const bucketMs = span <= 2 * 86_400_000 ? 3_600_000 : span <= 120 * 86_400_000 ? 86_400_000 : 7 * 86_400_000;
  const histogram = db.prepare(`SELECT (se.ts_ms / ${bucketMs}) * ${bucketMs} AS t, COUNT(*) AS total,
      SUM(CASE WHEN se.outcome = 'failed' THEN 1 ELSE 0 END) AS failed
    ${MATCHED} GROUP BY t ORDER BY t`).all();

  // Facets from the matched set, except a facet whose own field is
  // filtered: that one re-runs without its filter so the other values
  // stay visible (standard faceted-search behavior).
  const filteredFields = new Set(parsed.filters.map((filter) => filter.field));
  const facetFor = (field, column, limit) => (filteredFields.has(field)
    ? facet(db, parsed, range, field, column, limit)
    : facetFromMatches(db, column, limit));

  return {
    mode: 'events', query: q, errors: parsed.errors, total,
    limit: boundedLimit, offset: boundedOffset, hits,
    summary: { total: summaryRow.total, failed: summaryRow.failed ?? 0, mismatched: summaryRow.mismatched ?? 0, http_errors: summaryRow.http_errors ?? 0 },
    histogram: histogram.map((row) => ({ t: row.t, total: row.total, failed: row.failed ?? 0 })),
    facets: {
      outcome: facetFor('outcome', 'se.outcome', 5),
      tool: facetFor('tool', 'se.tool_name', 15),
      model: facetFor('model', 'se.model', 10),
      category: facetFor('category', 'se.category', 15),
      exit_code: facetFor('exit_code', 'se.exit_code', 10),
    },
  };
}

/** Top failure clusters (the failures home). */
export function topFailureSignatures(db, { fromMs = null, toMs = null, limit = 20 } = {}) {
  const clauses = ["outcome = 'failed'", 'failure_signature IS NOT NULL'];
  const params = [];
  if (fromMs != null) { clauses.push('ts_ms >= ?'); params.push(fromMs); }
  if (toMs != null) { clauses.push('ts_ms <= ?'); params.push(toMs); }
  const rows = db.prepare(`SELECT failure_signature AS signature, signature_label AS label,
      COUNT(*) AS count, MIN(ts_ms) AS first_ms, MAX(ts_ms) AS last_ms,
      GROUP_CONCAT(DISTINCT tool_name) AS tools, GROUP_CONCAT(DISTINCT exit_code) AS exit_codes,
      (SELECT turn_id FROM search_events s2 WHERE s2.failure_signature = se.failure_signature ORDER BY s2.ts_ms DESC LIMIT 1) AS sample_turn,
      (SELECT external_call_id FROM search_events s2 WHERE s2.failure_signature = se.failure_signature ORDER BY s2.ts_ms DESC LIMIT 1) AS sample_call
    FROM search_events se WHERE ${clauses.join(' AND ')} GROUP BY failure_signature ORDER BY count DESC LIMIT ?`)
    .all(...params, Math.min(Math.max(Number(limit) || 20, 1), 100));
  return rows.map((row) => ({ ...row,
    tools: (row.tools ?? '').split(',').filter(Boolean).slice(0, 4),
    exit_codes: (row.exit_codes ?? '').split(',').filter(Boolean).slice(0, 4),
    first: new Date(row.first_ms).toISOString(), last: new Date(row.last_ms).toISOString() }));
}
