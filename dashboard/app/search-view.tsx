'use client';

// Search: Splunk-style over everything the agents did, failures first.
// The bar takes free text plus field filters (outcome:failed tool:Bash
// exit:>=1 file:.env) and one pipe (| stats count by tool). Landing with
// no query is the failures home: top failure clusters in the window.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Search as SearchIcon, X } from 'lucide-react';
import { api } from './api';

type Hit = {
  id: string; kind: string; ts: string; ts_ms: number;
  turn_id: string | null; exchange_id: string | null; external_call_id: string | null;
  model: string | null; provider: string | null; tool_name: string | null; category: string | null;
  outcome: string; outcome_reported: string; outcome_observed: string; reported_check: string | null;
  exit_code: number | null; http_status: number | null;
  error_text: string | null; error_excerpt: string | null; failure_signature: string | null; signature_label: string | null;
  command_text: string | null; file_paths: string | null; prompt_excerpt: string | null;
  duration_ms: number | null; snippet: string | null;
};
type Facet = { value: string; count: number };
type Signature = {
  signature: string; label: string | null; count: number; first: string; last: string;
  tools: string[]; exit_codes: string[]; sample_turn: string | null; sample_call: string | null;
};
type SearchResult = {
  mode: 'events' | 'stats' | 'timechart'; errors?: string[]; error?: string;
  total?: number; hits?: Hit[]; summary?: { total: number; failed: number; mismatched: number; http_errors: number };
  histogram?: { t: number; total: number; failed: number }[];
  facets?: Record<string, Facet[]>;
  rows?: Record<string, string | number | null>[]; agg?: string; by?: string | null; series?: string[];
};

const RANGES = [
  { id: '24h', label: 'Last 24h', ms: 86_400_000 },
  { id: '7d', label: 'Last 7d', ms: 7 * 86_400_000 },
  { id: '30d', label: 'Last 30d', ms: 30 * 86_400_000 },
  { id: 'all', label: 'All time', ms: null },
] as const;
type RangeId = typeof RANGES[number]['id'] | 'custom';

const QUICK = [
  'outcome:failed',
  'reported:ok observed:failed',
  'exit:127',
  'http:>=400',
  'failed | stats count by tool',
  'failed | timechart count by model span=1d',
];
const SERIES_COLORS = ['#8a8f98', '#b03a48', '#13549b', '#9e6514', '#29996b', '#5b4bc4', '#33373d', '#c06a2b', '#777d87'];

function renderSnippet(text: string) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return parts.map((part, index) => (part.startsWith('[') && part.endsWith(']')
    ? <mark key={index}>{part.slice(1, -1)}</mark> : <span key={index}>{part}</span>));
}

/** Replace (or append) one `field:value` filter in the query text. */
function withFilter(query: string, field: string, value: string) {
  const pattern = new RegExp(`(^|\\s)-?${field}:(\\S+)`, 'g');
  const cleaned = query.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
  return `${cleaned} ${field}:${value}`.trim();
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined,
  { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Stacked bars as plain SVG (no chart dependency): one column per time
 * bucket, segments bottom-up in series order, native tooltips. */
function StackedBars({ rows, series, height = 110, onBucket }: {
  rows: Record<string, number>[];
  series: { key: string; color: string; label: string }[];
  height?: number;
  onBucket?: (t: number) => void;
}) {
  const width = 720;
  const pad = 18;
  const max = Math.max(...rows.map((row) => series.reduce((sum, s) => sum + (row[s.key] ?? 0), 0)), 1);
  const slot = (width - pad) / Math.max(rows.length, 1);
  const barW = Math.max(Math.min(slot - 2, 42), 1);
  const plotH = height - 22;
  return <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} aria-label="Events over time"><title>Events over time</title>
    {rows.map((row, index) => {
      let y = plotH;
      const total = series.reduce((sum, s) => sum + (row[s.key] ?? 0), 0);
      return <g key={index} onClick={onBucket ? () => onBucket(row.t) : undefined} style={onBucket ? { cursor: 'pointer' } : undefined}>
        <title>{`${dayLabel(row.t)} — ${total} events`}</title>
        {series.map((s) => {
          const h = ((row[s.key] ?? 0) / max) * plotH;
          y -= h;
          return h > 0 ? <rect key={s.key} x={pad + index * slot + (slot - barW) / 2} y={y} width={barW} height={h} fill={s.color} /> : null;
        })}
        {(index === 0 || index === rows.length - 1 || index === Math.floor(rows.length / 2)) &&
          <text x={pad + index * slot + slot / 2} y={height - 4} textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.55">{dayLabel(row.t)}</text>}
      </g>;
    })}
  </svg>;
}

export function SearchView({ initialQuery = '', onQuery, onOpenCall, onOpenTrace, onOpenSandbox }: {
  initialQuery?: string;
  onQuery: (query: string) => void;
  onOpenCall: (traceId: string, callId: string) => void;
  onOpenTrace: (traceId: string) => void;
  onOpenSandbox?: (traceId: string, callId: string) => void;
}) {
  const [input, setInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [range, setRange] = useState<RangeId>('7d');
  const [custom, setCustom] = useState<{ from: number; to: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useRef(0);

  const bounds = useCallback(() => {
    if (range === 'custom' && custom) return custom;
    const found = RANGES.find((item) => item.id === range);
    return found?.ms ? { from: Date.now() - found.ms, to: Date.now() } : { from: null, to: null };
  }, [range, custom]);

  const load = useCallback(async (silent = false) => {
    const mine = ++run.current;
    if (!silent) setLoading(true);
    const { from, to } = bounds();
    const params = new URLSearchParams({ q: query, limit: '50', offset: String(offset) });
    if (from) params.set('from', String(from));
    if (to) params.set('to', String(to));
    const sigParams = new URLSearchParams({ limit: '12' });
    if (from) sigParams.set('from', String(from));
    if (to) sigParams.set('to', String(to));
    try {
      const [searchRes, sigRes] = await Promise.all([
        api().fetch(`/raytace/search?${params}`, { cache: 'no-store' }),
        api().fetch(`/raytace/search/signatures?${sigParams}`, { cache: 'no-store' }),
      ]);
      if (mine !== run.current) return;
      if (!searchRes.ok) throw new Error(((await searchRes.json().catch(() => ({}))) as { error?: string }).error ?? `Search returned ${searchRes.status}`);
      setResult(await searchRes.json() as SearchResult);
      if (sigRes.ok) setSignatures((await sigRes.json() as { signatures: Signature[] }).signatures ?? []);
      setError(null);
    } catch (caught) {
      if (mine === run.current) setError(caught instanceof Error ? caught.message : 'Search unavailable. Is the proxy running?');
    } finally { if (mine === run.current) setLoading(false); }
  }, [query, offset, bounds]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = setInterval(() => void load(true), 15_000); return () => clearInterval(timer); }, [load]);

  function submit(next: string) {
    setInput(next); setQuery(next); setOffset(0); onQuery(next);
  }

  const summary = result?.summary;
  const histogram = (result?.histogram ?? []).map((row) => ({ ...row, other: Math.max(row.total - row.failed, 0) }));
  const bucketMs = histogram.length > 1 ? histogram[1].t - histogram[0].t : 86_400_000;

  return <section className="rt-view rt-search-view">
    <header className="rt-view-head"><div><span className="eyebrow">SEARCH</span><h1>What the agents did</h1></div></header>

    <form className="rt-search-bar" onSubmit={(event) => { event.preventDefault(); submit(input); }}>
      <SearchIcon size={16} />
      <input value={input} onChange={(event) => setInput(event.target.value)}
        placeholder='outcome:failed tool:Bash "permission denied"  ·  try  failed | stats count by tool'
        aria-label="Search agent activity" spellCheck={false} />
      {input && <button type="button" className="rt-search-clear" onClick={() => submit('')} aria-label="Clear search"><X size={14} /></button>}
      <select value={range} onChange={(event) => { setRange(event.target.value as RangeId); setCustom(null); setOffset(0); }} aria-label="Time range">
        {range === 'custom' && <option value="custom">Selected window</option>}
        {RANGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <button type="submit" className="rt-button primary">Search</button>
    </form>

    <div className="rt-search-quick">
      {QUICK.map((item) => <button key={item} type="button" className="rt-chip" onClick={() => submit(item)}><code>{item}</code></button>)}
      {range === 'custom' && custom && <button type="button" className="rt-chip" onClick={() => { setRange('7d'); setCustom(null); }}>
        {when(new Date(custom.from).toISOString())} – {when(new Date(custom.to).toISOString())} <X size={12} /></button>}
    </div>

    {error && <p className="rt-search-error">{error}</p>}
    {(result?.errors ?? []).map((item) => <p key={item} className="rt-search-error">{item}</p>)}
    {result?.error && <p className="rt-search-error">{result.error}</p>}

    {result?.mode === 'events' && summary && <>
      <div className="rt-search-summary">
        <div><strong>{summary.total}</strong><span>events</span></div>
        <div><strong className="rt-failed-text">{summary.failed}</strong><span>failed</span></div>
        <div><strong>{summary.mismatched}</strong><span>reported ≠ observed</span></div>
        <div><strong>{summary.http_errors}</strong><span>HTTP errors</span></div>
        <small>{result.total} match{result.total === 1 ? '' : 'es'} the full query</small>
      </div>

      {histogram.length > 0 && <div className="rt-search-chart">
        <StackedBars rows={histogram} height={110}
          series={[{ key: 'other', color: '#c3c7cd', label: 'ok / unknown' }, { key: 'failed', color: '#b03a48', label: 'failed' }]}
          onBucket={(t) => { setCustom({ from: t, to: t + bucketMs - 1 }); setRange('custom'); setOffset(0); }} />
        <small>Grey ok/unknown, red failed. Click a bar to zoom to that window.</small>
      </div>}

      {!query && signatures.length > 0 && <div className="rt-search-clusters">
        <div className="rt-list-head"><span>TOP FAILURE CLUSTERS</span><small>repeat failures, grouped by signature</small></div>
        <ol>
          {signatures.map((sig) => <li key={sig.signature}>
            <button type="button" onClick={() => submit(`signature:${sig.signature}`)}>
              <strong>×{sig.count}</strong>
              <span className="rt-cluster-label">{sig.label ?? sig.signature}</span>
              <small>{sig.tools.join(', ')}{sig.exit_codes.length ? ` · exit ${sig.exit_codes.join('/')}` : ''} · last {when(sig.last)}</small>
            </button>
            {sig.sample_turn && <button type="button" className="link-button"
              onClick={() => (sig.sample_call ? onOpenCall(sig.sample_turn!, sig.sample_call) : onOpenTrace(sig.sample_turn!))}>
              latest example <ArrowRight size={11} /></button>}
          </li>)}
        </ol>
      </div>}

      <div className="rt-search-body">
        <aside className="rt-search-facets">
          {Object.entries(result.facets ?? {}).map(([field, values]) => values.length > 0 && <div key={field}>
            <h3>{field.replace('_', ' ')}</h3>
            {values.map((facet) => <button key={facet.value} type="button"
              onClick={() => submit(withFilter(query, field === 'tool' ? 'tool' : field, facet.value))}>
              <span>{facet.value}</span><small>{facet.count}</small></button>)}
          </div>)}
        </aside>

        <div className="rt-search-results">
          <div className="rt-list-head"><span>EVENTS</span><small>{loading ? 'Searching…' : `${result.hits?.length ?? 0} shown`}</small></div>
          {!loading && !(result.hits ?? []).length && <p className="rt-empty">Nothing matches. Missing evidence reads as unknown, never as success — try widening the time range.</p>}
          <ol>
            {(result.hits ?? []).map((hit) => <li key={hit.id} className={`rt-hit outcome-${hit.outcome}`}>
              <button type="button" className="rt-hit-main" disabled={!hit.turn_id}
                onClick={() => { if (hit.turn_id && hit.external_call_id) onOpenCall(hit.turn_id, hit.external_call_id); else if (hit.turn_id) onOpenTrace(hit.turn_id); }}>
                <time dateTime={hit.ts}>{when(hit.ts)}</time>
                <span className={`rt-outcome outcome-${hit.outcome}`}>{hit.outcome}</span>
                <strong>{hit.kind === 'turn' ? 'prompt' : hit.kind === 'proxy_error' ? 'proxy error' : `${hit.tool_name ?? 'tool'}${hit.category ? ` · ${hit.category}` : ''}`}</strong>
                <span className="rt-hit-text">{hit.snippet ? renderSnippet(hit.snippet) : (hit.command_text ?? hit.prompt_excerpt ?? hit.error_excerpt ?? '')}</span>
                <small>
                  {hit.model ?? ''}{hit.exit_code != null ? ` · exit ${hit.exit_code}` : ''}{hit.http_status ? ` · HTTP ${hit.http_status}` : ''}
                  {hit.kind === 'call' ? ` · reported ${hit.outcome_reported} · observed ${hit.outcome_observed}` : ''}
                  {hit.reported_check && hit.reported_check !== 'agrees' ? ` · ${hit.reported_check.replaceAll('_', ' ')}` : ''}
                  {hit.duration_ms != null ? ` · ${(hit.duration_ms / 1000).toFixed(1)}s` : ''}
                </small>
                {hit.error_excerpt && hit.outcome === 'failed' && <span className="rt-hit-error">{hit.signature_label ?? hit.error_excerpt.split('\n')[0]}</span>}
              </button>
              {onOpenSandbox && hit.kind === 'call' && hit.turn_id && hit.external_call_id &&
                <button type="button" className="link-button" onClick={() => onOpenSandbox(hit.turn_id!, hit.external_call_id!)}>sandbox evidence</button>}
            </li>)}
          </ol>
          <div className="rt-search-pages">
            <button type="button" className="rt-button" disabled={offset === 0} onClick={() => setOffset(Math.max(offset - 50, 0))}>Newer</button>
            <button type="button" className="rt-button" disabled={offset + 50 >= (result.total ?? 0)} onClick={() => setOffset(offset + 50)}>Older</button>
          </div>
        </div>
      </div>
    </>}

    {result?.mode === 'stats' && <div className="rt-search-stats">
      <div className="rt-list-head"><span>{result.agg === 'avg_duration' ? 'AVG DURATION (MS)' : 'COUNT'}{result.by ? ` BY ${result.by.toUpperCase()}` : ''}</span></div>
      <table><tbody>
        {(result.rows ?? []).map((row, index) => <tr key={index}>
          <td>{String(row.key ?? '(none)')}</td>
          <td className="rt-stat-bar" aria-label={String(row.value ?? row.count ?? '')}><span style={{ width: `${Math.max(2, 100 * Number(row.value ?? row.count ?? 0) / Math.max(...(result.rows ?? []).map((r) => Number(r.value ?? r.count ?? 0)), 1))}%` }} /></td>
          <td>{String(row.value ?? row.count ?? '')}</td>
        </tr>)}
      </tbody></table>
      {!(result.rows ?? []).length && <p className="rt-empty">No events match.</p>}
    </div>}

    {result?.mode === 'timechart' && <div className="rt-search-chart">
      <StackedBars rows={(result.rows ?? []) as Record<string, number>[]} height={240}
        series={(result.series ?? []).map((name, index) => ({ key: name, label: name, color: SERIES_COLORS[index % SERIES_COLORS.length] }))} />
      <small>{(result.series ?? []).map((name, index) => <span key={name} className="rt-legend-item"><i style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }} />{name} </span>)}</small>
      {!(result.rows ?? []).length && <p className="rt-empty">No events match.</p>}
    </div>}

    <p className="rt-search-help">
      Fields: <code>outcome reported observed tool model category kind exit http file signature session after before</code>.
      Pipes: <code>| stats count by tool</code>, <code>| stats avg(duration) by model</code>, <code>| timechart count by outcome span=1d</code>.
      Prefix <code>-</code> negates; trailing <code>*</code> is a prefix match.
    </p>
  </section>;
}
