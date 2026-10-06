'use client';

// Tool calls: how the agent got from the prompt to the answer. One divider per
// round trip to the model, one row per tool call it proposed.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Layers, Workflow } from 'lucide-react';
import { type CallVerification, type SummaryState, type Trace } from './types';
import { callArgs, groupSteps, groupSummary, type StepGroup } from './step-groups';
import { money, duration, count as tokenCount } from './request-metrics';
import { buildBlocks, completionFailed, reportedResult, sumMetric, turnSpan } from './trace-utils';
import { CommandText } from './command-text';
import { RunComparison } from './run-comparison';
import { TraceGraph } from './trace-graph';
import { type SelectedStep } from './decision-lab';

const PROXY_BASE = '';

/** Per-request one-line summaries, cache first. Only runs while this view is
 * open, so browsing prompts never spends on summaries. */
function useSummaries(trace: Trace) {
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  const cancelled = useRef(false);
  const summarizeOne = useCallback(async (id: string) => {
    setSummaries((prev) => ({ ...prev, [id]: { status: 'loading' } }));
    try {
      const cached = await fetch(`${PROXY_BASE}/raytace/summaries/${id}`);
      const data = cached.ok ? await cached.json() as { summary: { text: string } | null } : null;
      if (cancelled.current) return;
      if (data?.summary?.text) { setSummaries((prev) => ({ ...prev, [id]: { status: 'ready', text: data.summary!.text } })); return; }
    } catch { /* fall through to generate */ }
    for (let attempt = 0, failures = 0; !cancelled.current && attempt < 8 && failures < 3; attempt += 1) {
      try {
        const response = await fetch(`${PROXY_BASE}/raytace/summaries`, {
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
    const queue = ids ? ids.split(',') : [];
    let cursor = 0;
    const worker = async () => { while (!cancelled.current && cursor < queue.length) { const id = queue[cursor]; cursor += 1; await summarizeOne(id); } };
    void Promise.all(Array.from({ length: 4 }, worker));
    return () => { cancelled.current = true; };
  }, [ids, summarizeOne]);
  return summaries;
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

/** One row standing in for a run of similar calls while it is collapsed. */
function GroupRow({ group, trace, open, onToggle }: { group: StepGroup; trace: Trace; open: boolean; onToggle: () => void }) {
  const summary = groupSummary(group, trace);
  return <tr className={`rt-row rt-group-row${open ? ' open' : ''}`} onClick={onToggle}>
    <td className="rt-num"><ChevronRight size={12} className="rt-caret" />{summary.range.slice(1)}</td>
    <td className="rt-tool">{summary.kind}<small className="rt-changed">{group.calls.length} steps</small></td>
    <td className="rt-cmd rt-group-label">{summary.label}{summary.flags.map((flag) => <span key={flag} className="rt-group-flag">{flag}</span>)}</td>
    <td className="rt-reported">{summary.outcome}</td>
  </tr>;
}

export function ToolCallsView({ trace, traces, focusCall, onOpenContext }: {
  trace: Trace;
  traces: Trace[];
  focusCall: string | null;
  onOpenContext: (step: SelectedStep) => void;
}) {
  const [graph, setGraph] = useState(false);
  const [open, setOpen] = useState<string | null>(focusCall);
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
      </div>
    </header>
    <dl className="rt-stats">{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>

    {graph ? <TraceGraph trace={trace} blocks={blocks} summaries={summaries} onSelectStep={() => setGraph(false)} /> :
      <div className="rt-table-wrap"><table className="rt-table rt-calls">
        <thead><tr><th>#</th><th>Tool</th><th>Command</th><th>Agent reported</th></tr></thead>
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
              <tr className="rt-trip"><td colSpan={4}>
                <span>Round trip {block.number}</span>
                {summary?.status === 'ready' && <em>{summary.text}</em>}
                <small>{metric ? `${money(metric.cost, metric.costEstimated)} · ${duration(metric.durationMs)}` : ''}{failed ? ' · failed' : ''}{answered && !own.length ? ' · answered' : ''}</small>
              </td></tr>
              {own.map((call) => {
                const reported = reportedResult(trace.events, call.call_id);
                const expanded = open === call.call_id;
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
                    <td className="rt-tool">{call.name}</td>
                    <td className="rt-cmd"><CommandText text={call.proposed || call.name} /></td>
                    <td className={`rt-reported ${reported.state}`}>{reported.state === 'none' ? '—' : reported.state === 'rejected' ? 'rejected' : reported.code != null ? `exit ${reported.code}` : reported.state}</td>
                  </tr>
                  {expanded && <tr className="rt-expand"><td colSpan={4}>
                    <h4>Arguments</h4><pre>{argumentsOf(trace, call)}</pre>
                    <h4>Output the agent got back</h4><pre>{reported.output.trim() || '(no result captured)'}</pre>
                    <div className="rt-actions">
                      <button type="button" className="rt-button" onClick={() => onOpenContext(step)}><Layers size={14} /> What it had in context</button>
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
