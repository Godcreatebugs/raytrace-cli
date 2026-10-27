'use client';

// Playground: rerun a Claude Code session from one step, with what the model
// had seen or the project's files changed, and compare where it ends up.
//   Steps     pick the model call to rerun from
//   Change    earlier tool results (remove or edit), files, model, time limit,
//             and a check command that grades where the fork ends up
//   Runs      a batch's pass rate and typical cost/steps over its repeats,
//             next to the same step run unchanged as often (the baseline),
//             then each fork live and original vs fork: check, steps, answer, files
// A fork is its own sandbox started from the snapshot taken just before the
// step (proxy/playground.mjs), so only runs recorded in the sandbox with
// snapshots can be forked; the preview says when a step cannot be.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, GitFork, Pin, PinOff, Play, Trash2, X } from 'lucide-react';
import { type Fork, type ForkPreview, type Trace } from './types';
import { ResizeHandle } from './resize-handle';
import { runPlace } from './trace-utils';
import { api } from './api';
import { DiffText } from './snapshot-diff';

const MUTATE = { 'content-type': 'application/json', 'x-raytace-experiment': '1' };
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1'];
// What a removed tool result is replaced with. Saying so is itself a change
// the model sees; it is shown, and can be edited, before running.
const REMOVED = '(output removed)';
const oneLine = (text: string, max = 120) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const running = (fork: Fork) => ['queued', 'creating', 'running', 'collecting', 'checking'].includes(fork.status);
const STATUS: Record<Fork['status'], string> = { queued: 'Waiting', creating: 'Starting sandbox', running: 'Running', collecting: 'Comparing', checking: 'Checking',
  completed: 'Done', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled' };
const REPEATS = [1, 3, 5, 10];
const graded = (fork: Fork) => fork.check && ['passed', 'failed', 'timed_out'].includes(fork.check.status);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
type ForkCheck = NonNullable<Fork['check']>;
const CHECK: Record<ForkCheck['status'], string> = { pending: 'Check waiting', running: 'Checking…', passed: 'Check passed', failed: 'Check failed',
  timed_out: 'Check timed out', error: 'Check could not run', skipped: 'Check not run' };
const seconds = (ms: number | null) => (ms == null ? '' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

/** The check's verdict, with its output a click away. */
function CheckResult({ check }: { check: ForkCheck }) {
  const detail = check.status === 'passed' || check.status === 'failed' ? `exit ${check.exit_code} · ${seconds(check.duration_ms)}`
    : check.status === 'timed_out' ? `stopped after ${seconds(check.duration_ms)}`
    : check.status === 'skipped' ? 'the fork stopped before it got there' : '';
  return <div className={`pg-check c-${check.status}`}>
    <p>{check.status === 'passed' ? <Check size={14} /> : check.status === 'failed' || check.status === 'timed_out' ? <X size={14} /> : null}
      <strong>{CHECK[check.status]}</strong><code>{check.command}</code>{detail && <small>{detail}</small>}</p>
    {check.output && <details><summary>Output</summary><pre className="pg-diff">{check.output}</pre></details>}
  </div>;
}

type ResultEdit = { mode: 'remove' | 'edit'; text: string };

function useForks(traceRequestIds: Set<string>) {
  const [forks, setForks] = useState<Fork[]>([]);
  const refresh = useCallback(async () => {
    try {
      const response = await api().fetch(`/raytace/forks`);
      if (response.ok) setForks(((await response.json()) as { forks: Fork[] }).forks);
    } catch { /* the shell shows the proxy as offline */ }
  }, []);
  useEffect(() => {
    let closed = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { await refresh(); if (!closed) timer = setTimeout(tick, 2500); };
    void tick();
    return () => { closed = true; clearTimeout(timer); };
  }, [refresh]);
  return { forks: forks.filter((fork) => traceRequestIds.has(fork.exchange_id)), refresh };
}

function usePreview(exchangeId: string | null) {
  const [preview, setPreview] = useState<ForkPreview | null>(null);
  useEffect(() => {
    // The view is remounted per step (keyed in page.tsx), so this starts empty.
    if (!exchangeId) return;
    let closed = false;
    api().fetch(`/raytace/forks/preview/${exchangeId}`).then(async (response) => {
      const value = await response.json() as ForkPreview;
      if (!closed) setPreview(response.ok ? value : { forkable: false, reason: value.error ?? 'Preview unavailable.' });
    }).catch(() => { if (!closed) setPreview({ forkable: false, reason: 'RayTrace is not reachable.' }); });
    return () => { closed = true; };
  }, [exchangeId]);
  return preview;
}

/** One file's diff between the original's final snapshot and the fork's. */
function FileDiff({ fork, path }: { fork: Fork; path: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    if (!fork.comparison?.fork) return;
    const query = new URLSearchParams({ commit: fork.comparison.original, to: fork.comparison.fork, path });
    api().fetch(`/raytace/snapshots/${fork.parent}/diff?${query}`).then(async (response) => {
      const value = await response.json() as { diff?: string; error?: string };
      setDiff(response.ok ? value.diff || '(no difference)' : `Could not load the diff: ${value.error}`);
    }).catch(() => setDiff('Could not load the diff.'));
  }, [fork, path]);
  if (diff === null) return <p className="pg-note">Loading diff…</p>;
  // An error message is not a diff; a real one reads side by side like elsewhere.
  return diff.startsWith('Could not load') ? <p className="pg-note">{diff}</p> : <DiffText diff={diff} />;
}

function ForkRun({ fork, trace, fromIndex, forkTrace, onChanged, onOpenTrace }: {
  fork: Fork; trace: Trace; fromIndex: number;
  /** The fork's own recorded run, once RayTrace has it. */
  forkTrace: Trace | null;
  onChanged: () => void; onOpenTrace: (traceId: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requests = trace.requests ?? [];
  const originalCalls = (trace.callVerifications ?? []).filter((call) => requests.findIndex((request) => request.id === call.exchange_id) >= fromIndex);
  const changes = fork.comparison?.changes ?? [];
  const act = async (action: 'keep' | 'unkeep' | 'delete') => {
    setBusy(true);
    try { await api().fetch(`/raytace/forks/${fork.id}/${action}`, { method: 'POST', headers: MUTATE }); } finally { setBusy(false); onChanged(); }
  };
  const verdict = running(fork) ? null : fork.status !== 'completed' ? null
    : fork.comparison?.same_files ? 'Same files as the original.' : `${changes.length} file${changes.length === 1 ? '' : 's'} differ from the original.`;

  return <article className="pg-run">
    <header className="pg-run-head">
      <div>
        <span className={`pg-status s-${fork.status}`}>{STATUS[fork.status]}{running(fork) && fork.progress.tool_calls ? ` · ${fork.progress.tool_calls} tool call${fork.progress.tool_calls === 1 ? '' : 's'}` : ''}</span>
        <strong>{fork.model}</strong>
        <small>{(fork.attempts ?? 1) > 1 && `Run ${fork.attempt} of ${fork.attempts} · `}{when(fork.created_at)}{(() => {
          const excluded = fork.edits.excluded ?? [];
          // With files excluded, the removed results are theirs; the list says so.
          const otherResults = excluded.length ? 0 : fork.edits.results.length;
          const parts = [excluded.length && `excluded ${excluded.join(', ')}`, !excluded.length && otherResults && `${otherResults} tool result${otherResults === 1 ? '' : 's'} edited`,
            fork.edits.files.length && `edited ${fork.edits.files.join(', ')}`].filter(Boolean);
          return parts.length ? ` · ${parts.join(' · ')}` : fork.message ? '' : ' · nothing changed';
        })()}</small>
        {fork.message && <p className="pg-told"><b>You told it:</b> {fork.message}</p>}
      </div>
      <div className="rt-actions">
        {forkTrace && <button type="button" className="rt-button" onClick={() => onOpenTrace(forkTrace.id)}
          title="The fork's steps, commands and sandbox evidence, like any recorded run">{"Fork's tool calls"} <ArrowRight size={13} /></button>}
        {!fork.deleted_at && !running(fork) && <button type="button" className="rt-button" disabled={busy} onClick={() => act(fork.keep ? 'unkeep' : 'keep')}
          title={fork.keep ? 'Let it be deleted like any other fork' : 'Keep this fork\'s sandbox instead of deleting it with the next run'}>
          {fork.keep ? <><PinOff size={13} /> Unkeep</> : <><Pin size={13} /> Keep</>}</button>}
        {!fork.deleted_at && <button type="button" className="rt-button" disabled={busy} onClick={() => act('delete')}><Trash2 size={13} />
          {fork.status === 'queued' ? 'Cancel this run' : running(fork) ? 'Stop and delete' : 'Delete sandbox'}</button>}
        {fork.deleted_at && fork.status !== 'cancelled' && <span className="pg-note">Sandbox deleted · results kept</span>}
      </div>
    </header>
    {fork.error && <p role="alert" className="pg-error">{fork.error}</p>}
    {fork.check && <CheckResult check={fork.check} />}
    {verdict && <p className={`pg-verdict${fork.comparison?.same_files ? ' same' : ''}`}>{verdict}</p>}

    <div className="pg-compare">
      <section>
        <h3>Original, from this step</h3>
        <ol className="pg-steps">{originalCalls.map((call) => <li key={call.call_id}><b>{call.name}</b><code>{oneLine(call.proposed ?? '', 140)}</code></li>)}
          {!originalCalls.length && <li className="pg-note">Answered without another tool call.</li>}</ol>
        {trace.answer && <><h4>Answer</h4><p className="pg-answer">{trace.answer}</p></>}
      </section>
      <section>
        <h3>Fork</h3>
        <ol className="pg-steps">{fork.events.filter((event) => event.kind === 'tool').map((event, index) => <li key={index}><b>{event.name}</b><code>{oneLine(event.detail, 140)}</code></li>)}
          {running(fork) && <li className="pg-note pg-live">{fork.status === 'queued' ? `Waiting for run ${(fork.attempt ?? 2) - 1} to finish…` : fork.status === 'creating' ? 'Restoring the project and starting Claude Code…' : fork.status === 'collecting' ? 'Comparing files with the original…' : fork.status === 'checking' ? `Running ${fork.check?.command ?? 'the check'}…` : 'Working…'}</li>}
          {!running(fork) && !fork.events.some((event) => event.kind === 'tool') && <li className="pg-note">Answered without another tool call.</li>}</ol>
        {fork.result?.text && <><h4>Answer</h4><p className="pg-answer">{fork.result.text}</p></>}
        {fork.result && <p className="pg-note">{[fork.result.turns != null && `${fork.result.turns} turns`, fork.result.duration_ms != null && `${Math.round(fork.result.duration_ms / 1000)} s`,
          fork.result.cost_usd != null && `≈ $${fork.result.cost_usd.toFixed(4)} at API prices`].filter(Boolean).join(' · ')}</p>}
      </section>
    </div>

    {fork.comparison && <section className="pg-files">
      <h3>Files, original vs fork</h3>
      {changes.length ? <ul>{changes.map((change) => <Fragment key={change.path}>
        <li><button type="button" onClick={() => setOpen(open === change.path ? null : change.path)} aria-expanded={open === change.path}>
          <span className={`rt-file-status s-${change.status}`}>{{ A: 'only fork', D: 'only original', M: 'differs' }[change.status] ?? change.status}</span>
          <code>{change.path}</code>
          <small>{change.added == null ? 'binary' : `+${change.added} −${change.removed}`}</small>
        </button></li>
        {open === change.path && <li><FileDiff fork={fork} path={change.path} /></li>}
      </Fragment>)}</ul> : <p className="pg-note">{fork.comparison.fork ? 'Every file is the same.' : 'The fork took no snapshot, so there is nothing to compare.'}</p>}
      {(fork.attempts ?? 1) === 1 && <p className="pg-note">Models do not answer the same way twice: even a fork with nothing changed can word things differently. Run it more than once before reading much into one difference.</p>}
    </section>}
  </article>;
}

/** A batch at a glance: how often the check passed, what a typical run
 * cost and took, and one row per run to open. */
/** A batch's numbers: pass rate over the graded runs, medians over the finished ones. */
function batchStats(runs: Fork[]) {
  const finished = runs.filter((fork) => !running(fork) && fork.status !== 'cancelled');
  const checked = runs.filter(graded);
  const passed = checked.filter((fork) => fork.check?.status === 'passed').length;
  const pick = (value: (fork: Fork) => number | null | undefined) => median(finished.map(value).filter((item): item is number => typeof item === 'number'));
  return { finished, checked, passed, rate: checked.length ? passed / checked.length : null, live: runs.some(running),
    cost: pick((fork) => fork.result?.cost_usd), calls: pick((fork) => fork.progress.tool_calls),
    time: pick((fork) => fork.result?.duration_ms), differ: pick((fork) => fork.comparison?.changes.length),
    same: finished.filter((fork) => fork.comparison?.same_files).length };
}

/** Two-sided Fisher exact test on passes/fails of two batches: how likely a
 * split at least this uneven is if the change made no difference. */
function fisher(passA: number, failA: number, passB: number, failB: number) {
  const choose = (n: number, k: number) => { let value = 1; for (let i = 1; i <= k; i += 1) value = (value * (n - k + i)) / i; return value; };
  const rowA = passA + failA; const passes = passA + passB; const total = rowA + passB + failB;
  const prob = (a: number) => (choose(passes, a) * choose(total - passes, rowA - a)) / choose(total, rowA);
  const observed = prob(passA);
  let p = 0;
  for (let a = Math.max(0, rowA - (total - passes)); a <= Math.min(rowA, passes); a += 1) { const value = prob(a); if (value <= observed * (1 + 1e-7)) p += value; }
  return Math.min(1, p);
}

/** The change next to the same step run unchanged: what the change did,
 * with how far a gap this size can be trusted at this many runs. */
function BaselineCompare({ change, base, onShow }: { change: Fork[]; base: Fork[]; onShow: (id: string) => void }) {
  const a = batchStats(change); const b = batchStats(base);
  const pct = (stats: ReturnType<typeof batchStats>) => (stats.rate == null ? '—' : `${stats.passed}/${stats.checked.length}`);
  let verdict: string;
  if (a.rate == null || b.rate == null) {
    verdict = change[0].check ? 'Waiting for both sides to be checked…' : 'No check, so there is no pass rate to compare: only how the runs went.';
  } else {
    const p = fisher(a.passed, a.checked.length - a.passed, b.passed, b.checked.length - b.passed);
    const sofar = a.live || b.live ? ' so far' : '';
    verdict = a.rate === b.rate ? `Both passed ${Math.round(a.rate * 100)}% of the time${sofar}: no sign the change made a difference to the check.`
      : `Your change passed ${a.rate > b.rate ? 'more' : 'less'} often${sofar}: ${pct(a)} against ${pct(b)} unchanged. `
        + (a.live || b.live ? '' : p < 0.05 ? 'A gap this large is unlikely to be luck.' : 'At this many runs that could still be luck; more runs would tell.');
  }
  const row = (label: string, value: (stats: ReturnType<typeof batchStats>) => string) => <tr><th>{label}</th><td>{value(b)}</td><td>{value(a)}</td></tr>;
  const or = (value: number | null, show: (n: number) => string) => (value == null ? '—' : show(value));
  return <section className="pg-baseline">
    <h3>Against the step run unchanged</h3>
    <p className={`pg-baseline-verdict${a.rate != null && b.rate != null && !a.live && !b.live ? a.rate > b.rate ? ' good' : a.rate < b.rate ? ' bad' : '' : ''}`}>{verdict}</p>
    <table>
      <thead><tr><th scope="col">Runs</th>
        <th><button type="button" onClick={() => onShow(base[0].id)}>Unchanged ×{base.length}</button></th>
        <th><button type="button" onClick={() => onShow(change[0].id)}>Your change ×{change.length}</button></th></tr></thead>
      <tbody>
        {row('Check passed', pct)}
        {row('Tool calls', (stats) => or(stats.calls, (n) => String(Math.round(n))))}
        {row('Time', (stats) => or(stats.time, seconds))}
        {row('Cost', (stats) => or(stats.cost, (n) => `$${n.toFixed(4)}`))}
        {row('Same files as original', (stats) => (stats.finished.length ? `${stats.same}/${stats.finished.length}` : '—'))}
      </tbody>
    </table>
    <p className="pg-note">Medians over finished runs. Both started from the same point with the same check{change[0].model !== base[0].model ? `; unchanged uses the original model, ${base[0].model}` : ''}.</p>
  </section>;
}

function BatchSummary({ runs, shown, onShow, onChanged }: { runs: Fork[]; shown: string | null; onShow: (id: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const { finished, checked, passed, rate, cost, calls, time, differ, same, live } = batchStats(runs);
  const stopAll = async () => {
    setBusy(true);
    try { await api().fetch(`/raytace/forks/${runs[0].id}/stop-all`, { method: 'POST', headers: MUTATE }); } finally { setBusy(false); onChanged(); }
  };
  return <section className="pg-batch">
    <header>
      <div className="pg-batch-rate">
        {rate == null ? <strong>{finished.length}/{runs.length} runs done</strong>
          : <strong className={rate === 1 ? 'good' : rate === 0 ? 'bad' : 'mixed'}>{passed}/{checked.length} passed</strong>}
        <small>{rate == null ? (runs[0].check ? 'waiting for the first check' : 'no check set, so no pass rate') : `the check, over ${checked.length} of ${runs.length} runs`}</small>
      </div>
      <dl>
        {calls != null && <div><dt>Tool calls</dt><dd>{Math.round(calls)}</dd></div>}
        {time != null && <div><dt>Time</dt><dd>{seconds(time)}</dd></div>}
        {cost != null && <div><dt>Cost</dt><dd>${cost.toFixed(4)}</dd></div>}
        {differ != null && <div><dt>Files differ</dt><dd>{Math.round(differ)}</dd></div>}
        {finished.length > 0 && <div><dt>Same files</dt><dd>{same}/{finished.length}</dd></div>}
      </dl>
      {live && <button type="button" className="rt-button" disabled={busy} onClick={stopAll}><Trash2 size={13} /> Stop all runs</button>}
    </header>
    {finished.length > 1 && <p className="pg-note">Typical run (median){cost != null ? '; cost at API prices' : ''}.
      {rate != null && rate > 0 && rate < 1 ? ' Passing some of the time means the outcome depends on luck, not just on what you changed.' : ''}</p>}
    <table className="pg-batch-runs">
      <thead><tr><th>Run</th><th>Status</th><th>Check</th><th>Tool calls</th><th>Files differ</th><th>Time</th><th>Cost</th></tr></thead>
      <tbody>{runs.map((fork) => <tr key={fork.id} className={fork.id === shown ? 'on' : ''} onClick={() => onShow(fork.id)}>
        <td><button type="button" onClick={() => onShow(fork.id)} aria-pressed={fork.id === shown}>#{fork.attempt ?? 1}</button></td>
        <td><span className={`pg-status s-${fork.status}`}>{STATUS[fork.status]}</span></td>
        <td className={fork.check ? `c-${fork.check.status}` : ''}>{fork.check ? (fork.check.status === 'passed' ? '✓ passed' : fork.check.status === 'failed' ? `✗ exit ${fork.check.exit_code}`
          : fork.check.status === 'timed_out' ? '✗ timed out' : fork.check.status === 'error' ? 'could not run' : '—') : '—'}</td>
        <td>{fork.status === 'queued' || fork.status === 'cancelled' ? '—' : fork.progress.tool_calls}</td>
        <td>{fork.comparison ? fork.comparison.changes.length : '—'}</td>
        <td>{seconds(fork.result?.duration_ms ?? null) || '—'}</td>
        <td>{fork.result?.cost_usd != null ? `$${fork.result.cost_usd.toFixed(4)}` : '—'}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}

export function PlaygroundView({ trace, stepId, removeCall, forkTraces, onStep, onOpenTrace }: {
  trace: Trace;
  /** Recorded runs of Playground forks (any prompt's). */
  forkTraces: Trace[];
  onOpenTrace: (traceId: string) => void;
  /** The model call (exchange id) to fork from. */
  stepId: string | null;
  /** A tool call whose result starts out removed ("Rerun without this output"). */
  removeCall: string | null;
  onStep: (exchangeId: string) => void;
}) {
  const requests = useMemo(() => trace.requests ?? [], [trace.requests]);
  const calls = useMemo(() => trace.callVerifications ?? [], [trace.callVerifications]);
  const requestIds = useMemo(() => new Set(requests.map((request) => request.id)), [requests]);
  const number = new Map(calls.map((call, index) => [call.call_id, index + 1]));
  const { forks, refresh } = useForks(requestIds);
  // Whether this prompt can be forked at all is known from where it ran;
  // only a forkable prompt's steps are offered, and asked about one by one.
  const place = runPlace(trace);
  const step = place.forkable && stepId && requestIds.has(stepId) ? stepId : null;
  const stepIndex = step ? requests.findIndex((request) => request.id === step) : -1;
  const preview = usePreview(step);

  // Advanced: exact tool-result edits. A call arriving with removeCall starts removed.
  const [results, setResults] = useState<Record<string, ResultEdit>>(() => (removeCall ? { [removeCall]: { mode: 'remove', text: REMOVED } } : {}));
  const [message, setMessage] = useState('');
  const [excluded, setExcluded] = useState<string[]>([]);
  const [excludeInput, setExcludeInput] = useState('');
  const [model, setModel] = useState('');
  const [minutes, setMinutes] = useState(10);
  const [repeat, setRepeat] = useState(1);
  const [withBaseline, setWithBaseline] = useState(true);
  // null until typed in: offered from the last fork of this project that had one.
  const [checkInput, setCheckInput] = useState<string | null>(null);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const layout = useRef<HTMLDivElement>(null);

  // The project's files at the fork point, to suggest what to exclude.
  useEffect(() => {
    if (!preview?.forkable || !preview.sandbox || !preview.start_snapshot) return;
    let closed = false;
    api().fetch(`/raytace/snapshots/${preview.sandbox}/files?commit=${preview.start_snapshot}`).then(async (response) => {
      const value = await response.json() as { files?: string[] };
      if (!closed && response.ok) setProjectFiles(value.files ?? []);
    }).catch(() => {});
    return () => { closed = true; };
  }, [preview]);

  // The earlier tool calls whose output shows an excluded file: the path as
  // a whole word in what the call was asked (a Read's file_path, a command),
  // with or without /workspace/. Their outputs are removed with the file.
  const readers = (path: string) => (preview?.results ?? []).filter((item) => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[\\s'"=:(])(/workspace/)?${escaped}($|[\\s'";|&)<>])`).test(item.detail);
  });
  const excludedOutputs = new Map(excluded.flatMap((path) => readers(path).map((item) => [item.call_id, path] as const)));
  function addExclusion() {
    const path = excludeInput.trim().replace(/^\/workspace\//, '').replace(/^\.\//, '');
    if (path && !excluded.includes(path)) setExcluded((prev) => [...prev, path]);
    setExcludeInput('');
  }

  async function run() {
    if (!step) return;
    setStarting(true); setError('');
    try {
      const edited = Object.fromEntries(Object.entries(results).map(([id, edit]) => [id, edit.text]));
      const removed = Object.fromEntries([...excludedOutputs.keys()].filter((id) => !(id in edited)).map((id) => [id, REMOVED]));
      const response = await api().fetch(`/raytace/forks`, { method: 'POST', headers: MUTATE, body: JSON.stringify({
        exchange_id: step, model: model || preview?.model, minutes, message, check: checkCommand, repeat, baseline: withBaseline && changes.length > 0, exclude: excluded, results: { ...removed, ...edited } }) });
      const value = await response.json() as Fork & { error?: string };
      if (!response.ok) throw new Error(value.error ?? 'The fork could not start.');
      setShown(value.id); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The fork could not start.'); }
    finally { setStarting(false); }
  }

  const active = forks.some(running);
  const checkCommand = (checkInput ?? forks.find((fork) => fork.parent === preview?.sandbox && fork.check)?.check?.command ?? '').trim();
  const stepForks = forks.filter((fork) => fork.exchange_id === step);
  // Batches from this step, newest first; a single run is a batch of one.
  const batches = [...stepForks.reduce((groups, fork) => {
    const key = fork.group ?? fork.id;
    groups.set(key, [...(groups.get(key) ?? []), fork].sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1)));
    return groups;
  }, new Map<string, Fork[]>()).values()];
  const batch = batches.find((runs) => runs.some((fork) => fork.id === shown)) ?? batches[0] ?? null;
  // Within a batch: the one picked, else the one running now, else the first.
  // An unchanged batch the server would reuse as the baseline (reusableBaseline).
  const reusable = batches.filter((runs) => runs[0].unchanged && runs[0].model === preview?.model && (runs[0].check?.command ?? '') === checkCommand
    && runs.filter((fork) => ['completed', 'failed'].includes(fork.status)).length >= repeat)
    .sort((x, y) => y.length - x.length)[0] ?? null;
  const baselineOf = (runs: Fork[] | null) => (runs?.[0].baseline ? batches.find((other) => other[0].group === runs[0].baseline) ?? null : null);
  const visible = batch?.find((fork) => fork.id === shown) ?? batch?.find((fork) => running(fork) && fork.status !== 'queued') ?? batch?.[0] ?? null;
  const chosenModel = model || preview?.model || '';
  const changes = [message.trim() && 'a message', excluded.length && `${excluded.length} file${excluded.length === 1 ? '' : 's'} excluded`,
    Object.keys(results).length && `${Object.keys(results).length} tool result${Object.keys(results).length === 1 ? '' : 's'} edited`,
    chosenModel && chosenModel !== preview?.model && chosenModel].filter(Boolean) as string[];

  return <section className="rt-view">
    <header className="rt-view-head">
      <div><span className="eyebrow">PLAYGROUND</span><h1>Rerun it from any step</h1>
        <p className="rt-muted rt-sub">{oneLine(trace.title, 120)} · {when(trace.startedAt)}</p></div>
    </header>

    <div className="pg-layout" ref={layout}>
      <nav className="pg-rounds" aria-label="Steps">
        <h2>1 · Pick a step</h2>
        <ol>{requests.map((request, index) => {
          const own = calls.filter((call) => call.exchange_id === request.id);
          const count = forks.filter((fork) => fork.exchange_id === request.id).length;
          return <li key={request.id}><button type="button" className={request.id === step ? 'on' : ''} onClick={() => onStep(request.id)} disabled={!place.forkable}>
            <span>Round trip {index + 1}{count ? <em>{count} fork{count === 1 ? '' : 's'}</em> : null}</span>
            {own.length ? own.map((call) => <code key={call.call_id}>#{number.get(call.call_id)} {call.name} {oneLine(call.proposed ?? '', 60)}</code>)
              : <small>answered</small>}
          </button></li>;
        })}</ol>
        <ResizeHandle target={layout} variable="--pg-steps" storageKey="raytace.playground-steps-width" min={220} max={760} label="Steps width" />
      </nav>

      <div className="pg-main">
        {!place.forkable && <div className="pg-unforkable" role="note"><strong>{place.where === 'mac' ? 'This run can’t be forked' : place.where === 'fork' ? 'This is a fork' : 'Not forkable yet'}</strong><p>{place.reason}</p></div>}
        {place.forkable && !step && <p className="rt-empty">Pick the step to rerun from. Everything before it stays as it was; from it on, the model decides again.</p>}
        {step && !preview && <p className="rt-empty">Checking whether this step can be forked…</p>}
        {step && preview && !preview.forkable && <p className="pg-error">{preview.reason}</p>}

        {step && preview?.forkable && <section className="pg-change">
          <h2>2 · Change what it had <small>then round trip {stepIndex + 1} onward runs again, in its own sandbox</small></h2>

          <h3>Message at this step</h3>
          <textarea className="pg-message" rows={3} value={message} maxLength={4000} aria-label="Message the model gets at this step"
            placeholder="Optional. e.g. Don't use demo/package.json, read demo2/package.json instead."
            onChange={(event) => setMessage(event.target.value)} />
          <p className="pg-note">{message.trim() ? 'The fork resumes with this as your next message.' : `Empty: it resumes with only “${preview.resume_prompt}”`}</p>

          <h3>Exclude files</h3>
          <form className="pg-file-pick" onSubmit={(event) => { event.preventDefault(); addExclusion(); }}>
            <input list="pg-project-files" value={excludeInput} placeholder="path/to/file, as in the project" aria-label="File to exclude"
              onChange={(event) => setExcludeInput(event.target.value)} />
            <datalist id="pg-project-files">{projectFiles.slice(0, 2000).map((path) => <option key={path} value={path}>{path}</option>)}</datalist>
            <button type="submit" className="rt-button" disabled={!excludeInput.trim()}>Exclude</button>
          </form>
          {excluded.length > 0 && <ul className="pg-excluded">{excluded.map((path) => {
            const earlier = readers(path);
            const known = !projectFiles.length || projectFiles.includes(path);
            return <li key={path}>
              <code>{path}</code>
              <span>{earlier.length ? `output of ${earlier.map((item) => `#${number.get(item.call_id) ?? '?'}`).join(', ')} removed · ` : ''}{known ? 'not in the fork’s project' : 'not in the project at this step'}</span>
              <button type="button" aria-label={`Stop excluding ${path}`} onClick={() => setExcluded((prev) => prev.filter((item) => item !== path))}><X size={12} /></button>
            </li>;
          })}</ul>}
          <p className="pg-note">An excluded file is taken out of the fork’s copy of the project, and anything it had already read of it is removed from what it remembers, so it can’t just read it again.</p>

          <h3>Check <small>how to tell whether it worked</small></h3>
          <input className="pg-check-input" value={checkInput ?? checkCommand} maxLength={2000} spellCheck={false} aria-label="Check command"
            placeholder="Optional. e.g. npm test, or: grep -q fetchUser src/api.ts" onChange={(event) => setCheckInput(event.target.value)} />
          <p className="pg-note">{checkCommand ? 'Runs in the fork’s project folder once Claude Code finishes. Exit code 0 passes; anything else fails.'
            : 'Empty: the fork is only compared file by file with the original.'}</p>

          <div className="pg-run-bar">
            <label>Model <select value={chosenModel} onChange={(event) => setModel(event.target.value)}>
              {[...new Set([preview.model, ...MODELS].filter(Boolean) as string[])].map((name) => <option key={name} value={name}>{name}{name === preview.model ? ' (original)' : ''}</option>)}
            </select></label>
            <label>Runs <select value={repeat} onChange={(event) => setRepeat(Number(event.target.value))}>
              {REPEATS.filter((value) => value <= (preview.limits?.max_repeat ?? Infinity)).map((value) => <option key={value} value={value}>{value === 1 ? 'once' : `${value} times`}</option>)}
            </select></label>
            <button type="button" className="pg-run-button" onClick={run} disabled={starting || active}>
              <Play size={14} /> {active ? 'A fork is running' : starting ? 'Starting…' : `${changes.length ? `Run fork · ${changes.join(', ')}` : 'Run fork unchanged'}${repeat > 1 ? ` · ×${repeat}` : ''}${withBaseline && changes.length && !reusable ? ` + unchanged ×${repeat}` : ''}`}</button>
          </div>
          {changes.length > 0 && <label className="pg-baseline-pick"><input type="checkbox" checked={withBaseline} onChange={(event) => setWithBaseline(event.target.checked)} />
            {reusable ? (() => { const stats = batchStats(reusable);
              return `Compare with the unchanged runs already done (×${reusable.length}${stats.rate != null ? `, ${stats.passed}/${stats.checked.length} passed` : ''})`; })()
              : `Also run it unchanged ×${repeat} to compare with, taking turns with your change`}</label>}
          {repeat > 1 && <p className="pg-note">Runs one after another, each from the same point{checkCommand ? ', each graded by the check' : ''}. {checkCommand ? '' : 'Without a check there is no pass rate, only how the runs compare. '}{changes.length && withBaseline ? '' : 'Tip: running it unchanged the same number of times shows how much it varies on its own.'}</p>}
          {message.trim() && excluded.length > 0 && <p className="pg-note">This run both steers it and removes files: if it ends differently, you won’t know which of the two did it.</p>}
          {error && <p role="alert" className="pg-error">{error}</p>}

          <details className="pg-advanced" open={Boolean(removeCall) || undefined}>
            <summary>Advanced</summary>
            <h3>Tool results it had seen</h3>
            {preview.results?.length ? <ul className="pg-results">{preview.results.map((item) => {
              const edit = results[item.call_id];
              const byExclusion = !edit && excludedOutputs.has(item.call_id);
              return <li key={item.call_id} className={edit ? `edited ${edit.mode}` : byExclusion ? 'edited remove' : ''}>
                <div className="pg-result-row">
                  <b>#{number.get(item.call_id) ?? '?'} {item.name}</b>
                  <code title={item.detail}>{oneLine(item.detail, 90)}</code>
                  <small>{byExclusion ? `removed with ${excludedOutputs.get(item.call_id)}` : `~${Math.round(item.chars / 4).toLocaleString()} tokens`}</small>
                  <span className="rt-actions">
                    {edit ? <button type="button" className="link-button" onClick={() => setResults(({ [item.call_id]: _, ...rest }) => rest)}><X size={12} /> Undo</button> : <>
                      {!byExclusion && <button type="button" className="link-button" onClick={() => setResults((prev) => ({ ...prev, [item.call_id]: { mode: 'remove', text: REMOVED } }))}>Remove</button>}
                      {!item.truncated && <button type="button" className="link-button" onClick={() => setResults((prev) => ({ ...prev, [item.call_id]: { mode: 'edit', text: item.output } }))}>Edit</button>}
                    </>}
                  </span>
                </div>
                {edit && <textarea aria-label={`What ${item.name} returns in the fork`} value={edit.text} rows={edit.mode === 'remove' ? 1 : 8}
                  onChange={(event) => { const text = event.target.value; setResults((prev) => ({ ...prev, [item.call_id]: { ...prev[item.call_id], text } })); }} />}
              </li>;
            })}</ul> : <p className="pg-note">No tool results before this step: it comes straight after the prompt.</p>}
            <label className="pg-limit">Safety limit <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
              {[5, 10, 20, 30].filter((value) => value <= (preview.limits?.max_minutes ?? Infinity)).map((value) => <option key={value} value={value}>{value} min</option>)}</select>
              <span className="pg-note">The fork ends when Claude Code finishes; this only stops one that runs away.</span></label>
          </details>
        </section>}

        {step && <section className="pg-runs">
          <h2>3 · Runs {batches.length > 1 && <small>{batches.length} from this step</small>}</h2>
          {batches.length > 1 && <div className="pg-run-tabs">{batches.map((runs, index) => {
            const checked = runs.filter(graded);
            const verdict = runs.length > 1 ? (checked.length ? ` · ${checked.filter((fork) => fork.check?.status === 'passed').length}/${checked.length} ✓` : '')
              : graded(runs[0]) ? ` · ${runs[0].check?.status === 'passed' ? '✓' : '✗'}` : '';
            return <button key={runs[0].id} type="button" className={runs === batch ? 'on' : ''} onClick={() => setShown(runs[0].id)}>
              <GitFork size={12} /> {batches.length - index}{runs[0].unchanged ? ' · unchanged' : ''}{runs.length > 1 ? ` · ×${runs.length}` : ''} · {runs.some(running) ? 'Running' : STATUS[runs[0].status]}{verdict}{runs.some((fork) => fork.keep) ? ' · kept' : ''}</button>;
          })}</div>}
          {batch && baselineOf(batch) && <BaselineCompare change={batch} base={baselineOf(batch)!} onShow={setShown} />}
          {batch && batch.length > 1 && <BatchSummary runs={batch} shown={visible?.id ?? null} onShow={setShown} onChanged={refresh} />}
          {visible ? <ForkRun key={visible.id} fork={visible} trace={trace} fromIndex={stepIndex} onChanged={refresh} onOpenTrace={onOpenTrace}
            forkTrace={forkTraces.filter((item) => item.forkId === visible.id).at(0) ?? null} />
            : <p className="pg-note">No forks from this step yet.</p>}
        </section>}
      </div>
    </div>
  </section>;
}
