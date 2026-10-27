'use client';

// Tool calls: how the agent got from the prompt to the answer. One divider per
// round trip to the model, one row per tool call it proposed. What actually
// ran is the Sandbox view's job; each row links there. The Tool and Sandbox
// columns' labels are explained on the website (call-labels.ts).
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ArrowRight, Brain, ChevronRight, GitFork, Info, Layers, Workflow } from 'lucide-react';
import { type CallVerification, type SummaryState, type Trace, type WorkspaceSnapshot } from './types';
import { callArgs, groupSteps, groupSummary, type StepGroup } from './step-groups';
import { CATEGORY_LABEL, READING_A_TRACE, sandboxLabel, type SandboxLabel } from './call-labels';
import { money, duration, count as tokenCount } from './request-metrics';
import { buildBlocks, completionFailed, reportedResult, runPlace, sumMetric, turnSpan } from './trace-utils';
import { CommandText, span, parsed } from './execution-table';
import { RunComparison } from './run-comparison';
import { TraceGraph } from './trace-graph';
import { type SelectedStep } from './decision-lab';
import { useFileLevels } from './file-scan';
import { LevelBadge } from './initial-scan-view';
import { EMPTY_TREE, SnapshotDiff } from './snapshot-diff';


/** Per-request one-line summaries, cache first. Only runs while this view is
 * open, so browsing prompts never spends on summaries. */
function useSummaries(trace: Trace) {
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  const cancelled = useRef(false);
  const summarizeOne = useCallback(async (id: string) => {
    setSummaries((prev) => ({ ...prev, [id]: { status: 'loading' } }));
    try {
      const cached = await api().fetch(`/raytace/summaries/${id}`);
      const data = cached.ok ? await cached.json() as { summary: { text: string } | null } : null;
      if (cancelled.current) return;
      if (data?.summary?.text) { setSummaries((prev) => ({ ...prev, [id]: { status: 'ready', text: data.summary!.text } })); return; }
    } catch { /* fall through to generate */ }
    for (let attempt = 0, failures = 0; !cancelled.current && attempt < 8 && failures < 3; attempt += 1) {
      try {
        const response = await api().fetch('/raytace/summaries', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' },
          body: JSON.stringify({ exchange_id: id }),
        });
        if (response.status === 409) { await new Promise((resolve) => setTimeout(resolve, 400)); continue; }
        const data = await response.json() as { text?: string };
        if (cancelled.current) return;
        if (response.ok && data.text) { setSummaries((prev) => ({ ...prev, [id]: { status: 'ready', text: data.text! } })); return; }
      } catch { if (cancelled.current) return; }
      failures += 1; await new Promise((resolve) => setTimeout(resolve, 600 * failures));
    }
    if (!cancelled.current) setSummaries((prev) => ({ ...prev, [id]: { status: 'error' } }));
  }, []);
  const ids = (trace.requests ?? []).map((request) => request.id).join(',');
  useEffect(() => {
    cancelled.current = false;
    // Where summaries are not served (the hosted dashboard, for now), none are asked for.
    const queue = ids && api().summaries ? ids.split(',') : [];
    let cursor = 0;
    const worker = async () => { while (!cancelled.current && cursor < queue.length) { const id = queue[cursor]; cursor += 1; await summarizeOne(id); } };
    void Promise.all(Array.from({ length: 4 }, worker));
    return () => { cancelled.current = true; };
  }, [ids, summarizeOne]);
  return summaries;
}

/** What the call left changed in the project folder, from the snapshot the
 * sandbox took right after it. A file's row opens its diff — the snapshot
 * before this call against the one after it — since `+6 −3` alone does not
 * say what actually changed. */
export function FilesChanged({ snapshot, sandbox }: { snapshot: WorkspaceSnapshot; sandbox?: string }) {
  const label = { A: 'added', M: 'edited', D: 'deleted', T: 'type changed' } as Record<string, string>;
  // From the initial scan: only a file that matters is marked, so most lists stay as they were.
  const scanned = useFileLevels(sandbox);
  const [openPath, setOpenPath] = useState<string | null>(null);
  return <>
    <h4>Files changed <span className="rt-snap-id" title="Snapshot of the project folder after this call">snapshot {snapshot.commit.slice(0, 8)}</span></h4>
    {snapshot.changes.length ? <ul className="rt-files">{snapshot.changes.map((change) => <Fragment key={change.path}>
      <li>
        <button type="button" className="rt-file-toggle" aria-expanded={openPath === change.path}
          title={openPath === change.path ? 'Hide what changed in this file' : 'Show what changed in this file'}
          onClick={() => setOpenPath(openPath === change.path ? null : change.path)}>
          <ChevronRight size={12} className={`rt-caret${openPath === change.path ? ' down' : ''}`} />
          <span className={`rt-file-status s-${change.status}`}>{label[change.status] ?? change.status}</span>
          <code>{change.path}</code>
        </button>
        {(scanned.get(change.path)?.level ?? 0) >= 3 && <LevelBadge level={scanned.get(change.path)!.level}
          title={`Level ${scanned.get(change.path)!.level} of 5 in the initial scan: ${scanned.get(change.path)!.reasons.join('; ') || 'set by its owner'}`} />}
        {scanned.get(change.path)?.restricted && <span className="rt-flag" title="Its owner restricted this file: the agent was not meant to change it">restricted</span>}
        <small>{change.added == null ? 'binary' : `+${change.added} −${change.removed}`}</small>
      </li>
      {openPath === change.path && <li className="rt-file-diff"><SnapshotDiff sandbox={sandbox}
        from={snapshot.parent ?? EMPTY_TREE} to={snapshot.commit} path={change.path} /></li>}
    </Fragment>)}</ul> : <p className="rt-files-note">No files changed.</p>}
    {snapshot.too_big.length > 0 && <p className="rt-files-note">Too big to keep (over 5 MB), so the snapshot has their earlier version: {snapshot.too_big.join(', ')}</p>}
  </>;
}

function argumentsOf(trace: Trace, call: CallVerification): string {
  const args = callArgs(trace, call);
  return args ? JSON.stringify(args, null, 2) : '';
}

const GROUPING_KEY = 'raytace.group-steps';

/** Whether similar steps are folded together; remembered per browser. */
function useGrouping(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => { try { if (localStorage.getItem(GROUPING_KEY) === 'off') setOn(false); } catch { /* storage unavailable */ } }, []);
  const set = (next: boolean) => { setOn(next); try { localStorage.setItem(GROUPING_KEY, next ? 'on' : 'off'); } catch { /* storage unavailable */ } };
  return [on, set];
}

/** The file a call named in its arguments, for its sandbox label; null when it names none. */
function namedPath(trace: Trace, call: CallVerification): string | null {
  const args = callArgs(trace, call);
  const path = [args?.file_path, args?.notebook_path].find((value) => typeof value === 'string' && value);
  return typeof path === 'string' ? path : null;
}

const labelOf = (trace: Trace, call: CallVerification) => sandboxLabel(trace, call, reportedResult(trace.events, call.call_id), namedPath(trace, call));

/** A column heading that opens what its labels mean, on the website. */
function Explained({ name, section }: { name: string; section: string }) {
  return <th>{name}<a className="rt-th-help" href={`${READING_A_TRACE}#${section}`} target="_blank" rel="noreferrer" aria-label={`What the ${name} labels mean (opens in a new tab)`}><Info size={11} /></a></th>;
}

/** One row standing in for a run of similar calls while it is collapsed. */
function GroupRow({ group, trace, open, onToggle }: { group: StepGroup; trace: Trace; open: boolean; onToggle: () => void }) {
  const summary = groupSummary(group, trace);
  const all = group.calls.map((call) => labelOf(trace, call));
  const labels = all.map((label) => label.id);
  const count = (...ids: SandboxLabel['id'][]) => labels.filter((id) => ids.includes(id)).length;
  // Only commands can be seen running; a write is confirmed by its snapshot.
  const ran = count('ran', 'differs'); const commands = ran + count('not_seen', 'rejected');
  const changed = count('file_changed');
  const sandbox = [
    ran ? `${ran} of ${commands} ran` : '',
    count('differs') ? `⚠ ${count('differs')} differ${count('differs') === 1 ? 's' : ''}` : '',
    changed ? `${changed} file${changed === 1 ? '' : 's'} changed` : '',
    count('no_change') ? `✗ ${count('no_change')} no change` : '',
  ].filter(Boolean).join(' · ')
    // Nothing to count: say why, when every step has the same answer ("not covered", "in agent").
    || (new Set(labels).size === 1 ? all[0].text : '');
  const spans = group.calls.map((call) => parsed(call.ended_at) - parsed(call.started_at)).filter(Number.isFinite);
  return <tr className={`rt-row rt-group-row${open ? ' open' : ''}`} onClick={onToggle}>
    <td className="rt-num"><ChevronRight size={12} className="rt-caret" />{summary.range.slice(1)}</td>
    <td className="rt-tool">{summary.kind}<small className="rt-changed">{group.calls.length} steps</small></td>
    <td className="rt-cmd rt-group-label">{summary.label}{summary.flags.map((flag) => <span key={flag} className="rt-group-flag">{flag}</span>)}</td>
    <td className="rt-reported">{summary.outcome}</td>
    <td>{sandbox || '—'}</td>
    <td className="rt-time">{spans.length ? span(spans.reduce((sum, value) => sum + value, 0)) : '—'}</td>
  </tr>;
}

/** A call's sandbox label; one with evidence behind it opens that evidence. */
function Sandboxed({ label, onOpen }: { label: SandboxLabel; onOpen?: () => void }) {
  if (!label.opens || !onOpen) return <span className={`rt-ran ${label.tone}`}>{label.text}</span>;
  return <button type="button" className={`rt-ran ${label.tone} rt-ran-link`} onClick={(event) => { event.stopPropagation(); onOpen(); }}>{label.text}</button>;
}

/** "Run · Bash": what the call did, then the tool that did it. The tool alone
 * when the two say the same, or while there is no category yet. */
function ToolName({ call }: { call: CallVerification }) {
  const category = call.category ? CATEGORY_LABEL[call.category] : null;
  if (!category || category.toLowerCase() === call.name.toLowerCase()) return <>{call.name}</>;
  return <>{category}<span className="rt-tool-name"> · {call.name}</span></>;
}

export function ToolCallsView({ trace, traces, focusCall, onOpenSandbox, onOpenContext, onOpenThought, onOpenPlayground }: {
  trace: Trace;
  traces: Trace[];
  focusCall: string | null;
  onOpenSandbox?: (callId?: string) => void;
  onOpenContext?: (step: SelectedStep) => void;
  /** Why this call was made (Chain of thought); sandbox prompts only. */
  onOpenThought?: (callId: string) => void;
  /** Fork from a model call, optionally with one earlier call's output removed. */
  onOpenPlayground?: (exchangeId: string, removeCall?: string) => void;
}) {
  const [graph, setGraph] = useState(false);
  const [open, setOpen] = useState<string | null>(focusCall);
  // A "file changed" label opens its row at the files the call changed.
  const [filesOf, setFilesOf] = useState<string | null>(null);
  useEffect(() => {
    if (!filesOf) return;
    const frame = requestAnimationFrame(() => { document.getElementById(`files-${filesOf}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); setFilesOf(null); });
    return () => cancelAnimationFrame(frame);
  }, [filesOf]);
  const summaries = useSummaries(trace);
  const blocks = buildBlocks(trace.events);
  const calls = trace.callVerifications ?? [];
  // Runs of similar calls (six greps for the same names) fold into one row.
  // A group holding the focused call starts open; a click flips it.
  const [grouping, setGrouping] = useGrouping();
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const groups = grouping ? groupSteps(trace, calls) : [];
  const groupOf = new Map(groups.filter((group) => group.calls.length > 1).flatMap((group) => group.calls.map((call) => [call.call_id, group] as const)));
  const groupOpen = (group: StepGroup) => flipped.has(group.id) !== group.calls.some((call) => call.call_id === focusCall);
  const flip = (group: StepGroup) => setFlipped((prev) => { const next = new Set(prev); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; });
  const hiddenInGroup = (call: CallVerification) => { const group = groupOf.get(call.call_id); return Boolean(group && !groupOpen(group)); };
  const number = new Map(calls.map((call, index) => [call.call_id, index + 1]));
  // Only a Claude Code session run in the sandbox can be forked; the
  // Playground's preview says why when a step of one still cannot.
  const forkable = runPlace(trace).forkable && Boolean(onOpenPlayground);
  const inSandbox = runPlace(trace).where === 'sandbox';
  const requestIds = (trace.requests ?? []).map((request) => request.id);
  const nextRequest = (exchangeId: string) => requestIds[requestIds.indexOf(exchangeId) + 1];
  const requests = trace.requests ?? [];
  const models = [...new Set(requests.map((request) => request.model))];
  const stats: [string, string][] = [
    ['Round trips', String(requests.length)],
    ['Tool calls', String(calls.length)],
    ['Cost', money(sumMetric(requests, 'cost'), requests.some((r) => r.costEstimated))],
    ['Time', duration(turnSpan(requests))],
    ['Tokens in / out', `${tokenCount(sumMetric(requests, 'input'))} / ${tokenCount(sumMetric(requests, 'output'))}`],
    [models.length > 1 ? 'Models' : 'Model', models.join(', ') || trace.model],
  ];

  useEffect(() => {
    if (!focusCall) return;
    const frame = requestAnimationFrame(() => document.getElementById(`call-${focusCall}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [focusCall]);

  return <section className="rt-view">
    <header className="rt-view-head">
      <div><span className="eyebrow">TOOL CALLS</span><h1>How the agent got there</h1></div>
      <div className="rt-actions">
        <RunComparison traces={traces} currentId={trace.id} />
        {!graph && <label className="rt-toggle" title="Fold runs of similar steps, such as repeated searches for the same thing, into one row">
          <input type="checkbox" checked={grouping} onChange={(event) => setGrouping(event.target.checked)} /> Group similar steps
        </label>}
        <button type="button" className={`visualize-button ${graph ? 'active' : ''}`} onClick={() => setGraph(!graph)}><Workflow size={14} /> {graph ? 'Back to list' : 'Graph'}</button>
        {trace.sandboxId && onOpenSandbox && <button type="button" className="rt-button" onClick={() => onOpenSandbox()}>Sandbox evidence <ArrowRight size={14} /></button>}
      </div>
    </header>
    <dl className="rt-stats">{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>

    {graph ? <TraceGraph trace={trace} blocks={blocks} summaries={summaries} onSelectStep={() => setGraph(false)} /> :
      <div className="rt-table-wrap"><table className="rt-table rt-calls">
        <thead><tr><th>#</th><Explained name="Tool" section="tool-categories" /><th>Command</th><th>Agent reported</th><Explained name="Sandbox" section="sandbox-labels" /><th>Ran for</th></tr></thead>
        <tbody>
          {blocks.map((block) => {
            const metric = requests.find((request) => request.id === block.exchangeId);
            const summary = summaries[block.exchangeId];
            const failed = block.completion ? completionFailed(block.completion) : null;
            const own = calls.filter((call) => call.exchange_id === block.exchangeId);
            const answered = block.items.some(({ event }) => event.title === 'Model answer');
            // A round trip whose calls are all folded into a collapsed group
            // (and do not start it) is skipped, divider and all.
            if (own.length && own.every((call) => hiddenInGroup(call) && groupOf.get(call.call_id)!.id !== call.call_id)) return null;
            return <Fragment key={block.exchangeId}>
              <tr className="rt-trip"><td colSpan={6}>
                <span>Round trip {block.number}</span>
                {summary?.status === 'ready' && <em>{summary.text}</em>}
                <small>{metric ? `${money(metric.cost, metric.costEstimated)} · ${duration(metric.durationMs)}` : ''}{failed ? ' · failed' : ''}{answered && !own.length ? ' · answered' : ''}</small>
              </td></tr>
              {own.map((call) => {
                const reported = reportedResult(trace.events, call.call_id);
                const label = sandboxLabel(trace, call, reported, namedPath(trace, call));
                const openEvidence = label.opens === 'files' ? () => { setOpen(call.call_id); setFilesOf(call.call_id); }
                  : onOpenSandbox && (() => onOpenSandbox(call.call_id));
                const expanded = open === call.call_id;
                const started = parsed(call.started_at); const ended = parsed(call.ended_at);
                const step: SelectedStep = { exchange_id: call.exchange_id, output_index: call.output_index, title: `#${number.get(call.call_id)} ${call.name}`, detail: call.proposed ?? call.name };
                const group = groupOf.get(call.call_id);
                const groupRow = group && group.id === call.call_id
                  ? <GroupRow group={group} trace={trace} open={groupOpen(group)} onToggle={() => flip(group)} /> : null;
                if (group && !groupOpen(group)) return <Fragment key={call.call_id}>{groupRow}</Fragment>;
                return <Fragment key={call.call_id}>
                  {groupRow}
                  <tr id={`call-${call.call_id}`} className={`rt-row${expanded ? ' open' : ''}${focusCall === call.call_id ? ' rt-focus' : ''}${group ? ' rt-in-group' : ''}`}
                    onClick={() => setOpen(expanded ? null : call.call_id)}>
                    <td className="rt-num"><ChevronRight size={12} className="rt-caret" />{number.get(call.call_id)}</td>
                    <td className="rt-tool"><ToolName call={call} />{call.snapshot?.changed && <small className="rt-changed" title="Files this call changed">{call.snapshot.changes.length} file{call.snapshot.changes.length === 1 ? '' : 's'}</small>}</td>
                    <td className="rt-cmd">{call.description
                      ? <><span className="rt-plain">{call.description}</span><span className="rt-cmd-raw" title={call.proposed ?? undefined}><CommandText text={call.proposed || call.name} /></span></>
                      : <CommandText text={call.proposed || call.name} />}</td>
                    <td className={`rt-reported ${reported.state}`}>{reported.state === 'none' ? '—' : reported.state === 'rejected' ? 'rejected' : reported.code != null ? `exit ${reported.code}` : reported.state}</td>
                    <td><Sandboxed label={label} onOpen={openEvidence} /></td>
                    <td className="rt-time">{Number.isFinite(started) && Number.isFinite(ended) ? span(ended - started) : '—'}</td>
                  </tr>
                  {expanded && <tr className="rt-expand"><td colSpan={6}>
                    <h4>Arguments</h4><pre>{argumentsOf(trace, call)}</pre>
                    <h4>Output the agent got back</h4><pre>{reported.output.trim() || '(no result captured)'}</pre>
                    {call.snapshot && <div id={`files-${call.call_id}`}><FilesChanged snapshot={call.snapshot} sandbox={trace.sandboxId} /></div>}
                    <div className="rt-actions">
                      {call.exec_id && onOpenSandbox && <button type="button" className="rt-button" onClick={() => onOpenSandbox(call.call_id)}>Show in sandbox <ArrowRight size={14} /></button>}
                      {onOpenContext && <button type="button" className="rt-button" onClick={() => onOpenContext(step)}><Layers size={14} /> What it had in context</button>}
                      {inSandbox && onOpenThought && <button type="button" className="rt-button" onClick={() => onOpenThought(call.call_id)}><Brain size={14} /> Why?</button>}
                      {forkable && <button type="button" className="rt-button" title="Rerun from the model call that made this tool call"
                        onClick={() => onOpenPlayground?.(call.exchange_id)}><GitFork size={14} /> Fork from here</button>}
                      {forkable && nextRequest(call.exchange_id) && <button type="button" className="rt-button" title="Rerun the next step as if this call had returned nothing"
                        onClick={() => onOpenPlayground?.(nextRequest(call.exchange_id), call.call_id)}><GitFork size={14} /> Rerun without this output</button>}
                    </div>
                  </td></tr>}
                </Fragment>;
              })}
            </Fragment>;
          })}
        </tbody>
      </table></div>}
  </section>;
}
