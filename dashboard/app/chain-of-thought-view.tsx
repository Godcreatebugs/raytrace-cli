'use client';

// Chain of thought: why each tool call was made. For every call, the likely
// causes among what the agent could see (your request, an earlier result,
// its own earlier plan, project instructions), ranked by Jev, plus what the
// sandbox saw actually happen. Inferred from the recorded request alone --
// nothing is rerun -- and only for prompts run in the sandbox. Runs of similar
// steps (step-groups.ts) show as one card explained by their first step; the
// rest are worked out only when the group is opened.
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Attribution, type AttributionCause, type AttributionState, type CallVerification, type Trace } from './types';
import { reportedResult, runPlace } from './trace-utils';
import { CommandText } from './execution-table';
import { FilesChanged } from './tool-calls-view';
import { groupSteps, groupSummary, type StepGroup } from './step-groups';
import { api } from './api';
import { RunRecap } from './run-recap';

type StepRef = { exchange_id: string; output_index?: number };
const stepKey = (call: StepRef) => `${call.exchange_id}:${call.output_index}`;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const SHOWN_BELOW = 0.02;

const KIND_LABEL: Record<AttributionCause['kind'], string> = {
  user: 'Your request', tool_result: 'Earlier result', agent: "Agent's earlier plan",
  project: 'Project instructions', habit: 'Routine step', explore: 'Exploring',
};

/** Attributions for the given calls, cache first, a few at a time, only
 * while this view is open. Steps already worked out are not fetched again
 * when the list grows (a group opened). */
function useAttributions(calls: CallVerification[]) {
  const [states, setStates] = useState<Record<string, AttributionState>>({});
  const settled = useRef(new Set<string>());
  const loadOne = useCallback(async (call: StepRef, alive: () => boolean) => {
    const key = stepKey(call);
    const set = (state: AttributionState) => {
      if (state.status !== 'loading') settled.current.add(key);
      if (alive()) setStates((prev) => ({ ...prev, [key]: state }));
    };
    set({ status: 'loading' });
    try {
      const cached = await api().fetch(`/raytace/attribution/${encodeURIComponent(call.exchange_id)}/${call.output_index}`);
      const data = await cached.json() as { attribution?: Attribution | null; error?: string };
      if (!cached.ok) { set({ status: 'error', message: data.error ?? 'Unavailable.' }); return; }
      if (data.attribution) { set({ status: 'ready', attribution: data.attribution }); return; }
    } catch { /* fall through to generate */ }
    for (let attempt = 0, failures = 0; alive() && attempt < 12 && failures < 3; attempt += 1) {
      try {
        const response = await api().fetch('/raytace/attribution', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' },
          body: JSON.stringify({ exchange_id: call.exchange_id, output_index: call.output_index }),
        });
        if (response.status === 409) { await new Promise((resolve) => setTimeout(resolve, 700)); continue; }
        const data = await response.json() as Attribution & { error?: string };
        if (response.ok) { set({ status: 'ready', attribution: data }); return; }
        if (response.status < 500) { set({ status: 'error', message: data.error ?? 'Unavailable.' }); return; }
      } catch { if (!alive()) return; }
      failures += 1; await new Promise((resolve) => setTimeout(resolve, 800 * failures));
    }
    if (alive()) set({ status: 'error', message: 'Could not work out this step. Reopen the view to retry.' });
  }, []);
  const ids = calls.filter((call) => typeof call.output_index === 'number').map(stepKey).join(',');
  useEffect(() => {
    let live = true;
    const alive = () => live;
    // The ids carry everything a request needs, so the effect depends on them alone.
    const queue: StepRef[] = (ids ? ids.split(',') : []).filter((key) => !settled.current.has(key)).map((key) => {
      const at = key.lastIndexOf(':');
      return { exchange_id: key.slice(0, at), output_index: Number(key.slice(at + 1)) };
    });
    let cursor = 0;
    const worker = async () => { while (live && cursor < queue.length) { const call = queue[cursor]; cursor += 1; await loadOne(call, alive); } };
    void Promise.all(Array.from({ length: 4 }, worker));
    return () => { live = false; };
  }, [ids, loadOne]);
  return states;
}

/** Follows each step's top cause back through earlier results until it
 * reaches something that is not a step: your request, a habit, exploring. A
 * cause inside a group of similar steps is shown as the group, and the walk
 * continues from the group's first step, which is the one that is explained. */
function chainFor(call: CallVerification, calls: CallVerification[], states: Record<string, AttributionState>, groupOf: Map<string, StepGroup>, trace: Trace) {
  const byId = new Map(calls.map((item) => [item.call_id, item]));
  const links: { label: string; callId: string | null }[] = [];
  const seen = new Set<string>();
  let current: CallVerification | undefined = call;
  while (current && !seen.has(current.call_id) && links.length < 8) {
    seen.add(current.call_id);
    const state: AttributionState | undefined = states[stepKey(current)];
    if (state?.status !== 'ready' || !state.attribution.ranked) break;
    const top: AttributionCause | undefined = state.attribution.causes[0];
    if (!top) break;
    const source: CallVerification | undefined = top.source_call_id ? byId.get(top.source_call_id) : undefined;
    if (top.kind === 'tool_result' && source) {
      const group = groupOf.get(source.call_id);
      if (group && !group.calls.some((member) => member.call_id === call.call_id)) {
        const summary = groupSummary(group, trace);
        links.unshift({ label: `${summary.range} ${summary.kind}`, callId: group.id });
        current = group.calls[0];
      } else {
        links.unshift({ label: `#${calls.indexOf(source) + 1} ${source.name}`, callId: source.call_id });
        current = source;
      }
    } else {
      links.unshift({ label: KIND_LABEL[top.kind].toLowerCase(), callId: null });
      break;
    }
  }
  return links.length > 1 || links[0]?.callId ? links : null;
}

function WhatRan({ call, trace }: { call: CallVerification; trace: Trace }) {
  const reported = reportedResult(trace.events, call.call_id);
  const parts: string[] = [];
  if (call.exec_id) {
    parts.push('The sandbox saw it run');
    if (typeof call.exit_code === 'number') parts.push(`exit ${call.exit_code}`);
    if (call.descendant_count) parts.push(`${call.descendant_count} child process${call.descendant_count === 1 ? '' : 'es'}`);
  } else if (reported.state === 'rejected') parts.push('Refused by the sandbox policy');
  else if (call.kind ? call.kind === 'command' : call.name === 'Bash') parts.push('No process was seen for it');
  else parts.push('Ran inside the agent, not as a separate process');
  if (call.snapshot?.changed) parts.push(`${call.snapshot.changes.length} file${call.snapshot.changes.length === 1 ? '' : 's'} changed`);
  const differs = call.reported_check && call.reported_check !== 'agrees';
  return <div className="rt-cot-ran">
    <span className="workspace-label">WHAT ACTUALLY RAN</span> {parts.join(' · ')}
    {differs && <p className="rt-cot-warn">The agent was told something different from what the sandbox saw ({call.reported_check === 'exit_code_differs' ? 'exit code' : 'duration'} differs). Its next steps were based on what it was told.</p>}
    {call.snapshot?.changed && <details><summary>Files changed</summary><FilesChanged snapshot={call.snapshot} sandbox={trace.sandboxId} /></details>}
  </div>;
}

function Causes({ attribution, number, onJump }: { attribution: Attribution; number: (callId: string) => number | null; onJump: (callId: string) => void }) {
  const shown = attribution.ranked ? attribution.causes.filter((cause) => (cause.probability ?? 0) >= SHOWN_BELOW) : attribution.causes;
  return <>
    {attribution.ranked && <div className="rt-cot-bar" aria-hidden="true">
      {shown.map((cause) => <span key={cause.key} className={`k-${cause.kind}`} style={{ width: percent(cause.probability ?? 0) }} title={`${percent(cause.probability ?? 0)} ${cause.reason}`} />)}
    </div>}
    {!attribution.ranked && <p className="rt-cot-note">Possible reasons, unranked{attribution.unsure_reason ? `: ${attribution.unsure_reason}` : '.'}</p>}
    <ol className="rt-cot-causes">{shown.map((cause) => {
      const step = cause.source_call_id ? number(cause.source_call_id) : null;
      return <li key={cause.key}>
        {cause.probability != null && <strong className="rt-cot-pct">{percent(cause.probability)}</strong>}
        <i className={`rt-cot-dot k-${cause.kind}`} />
        <div>
          <span>{cause.reason}</span>
          <small>
            {KIND_LABEL[cause.kind]}
            {step && <> · <button type="button" className="link-button" onClick={() => onJump(cause.source_call_id!)}>step #{step}</button></>}
          </small>
          {cause.quote && <details><summary>Evidence</summary><blockquote>{cause.quote}</blockquote></details>}
        </div>
      </li>;
    })}</ol>
  </>;
}

/** One step: its causes, how it connects back to your request, and what ran. */
function StepCard({ call, index, trace, states, chain, highlight, number, onJump }: {
  call: CallVerification; index: number; trace: Trace; states: Record<string, AttributionState>;
  chain: { label: string; callId: string | null }[] | null; highlight: boolean;
  number: (callId: string) => number | null; onJump: (callId: string) => void;
}) {
  const state = states[stepKey(call)];
  const attribution = state?.status === 'ready' ? state.attribution : null;
  return <li id={`cot-${call.call_id}`} className={`rt-cot-step${highlight ? ' rt-focus' : ''}`}>
    <div className="rt-cot-head">
      <span className="rt-cot-num">#{index + 1}</span>
      <strong>{call.name}</strong>
      <CommandText text={call.proposed || call.name} />
      {attribution?.purpose && <span className="rt-chip" title={attribution.purpose.label}>{attribution.purpose.choice.replace('_', ' ')}</span>}
      {attribution?.unsure && <span className="rt-cot-unsure" title={attribution.unsure_reason ?? ''}>Unsure</span>}
    </div>
    <Explanation state={state} number={number} onJump={onJump} />
    {chain && <p className="rt-cot-chain"><span className="workspace-label">CHAIN</span>
      {chain.map((link, position) => <span key={position}>
        {link.callId ? <button type="button" className="link-button" onClick={() => onJump(link.callId!)}>{link.label}</button> : link.label}
        {' → '}
      </span>)}
      <span>this step</span>
    </p>}
    <WhatRan call={call} trace={trace} />
  </li>;
}

function Explanation({ state, number, onJump }: { state: AttributionState | undefined; number: (callId: string) => number | null; onJump: (callId: string) => void }) {
  if (!state || state.status === 'loading') return <p className="rt-cot-note">Working out why…</p>;
  if (state.status === 'error') return <p className="rt-cot-note">{state.message}</p>;
  const { attribution } = state;
  return <>
    <Causes attribution={attribution} number={number} onJump={onJump} />
    {attribution.unsure && attribution.unsure_reason && <p className="rt-cot-note">Unsure: {attribution.unsure_reason}</p>}
  </>;
}

export function ChainOfThoughtView({ trace, focusCall }: { trace: Trace; focusCall: string | null }) {
  const place = runPlace(trace);
  const calls = place.where === 'sandbox' ? (trace.callVerifications ?? []) : [];
  const groups = groupSteps(trace, calls);
  const groupOf = new Map(groups.filter((group) => group.calls.length > 1).flatMap((group) => group.calls.map((call) => [call.call_id, group] as const)));
  // A group holding the focused call starts open; a click flips it.
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const groupOpen = (group: StepGroup) => flipped.has(group.id) !== group.calls.some((call) => call.call_id === focusCall);
  const flip = (group: StepGroup) => setFlipped((prev) => { const next = new Set(prev); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; });
  // Only what is on screen is worked out: a group's first step until it is opened.
  const wanted = groups.flatMap((group) => (group.calls.length > 1 && !groupOpen(group) ? [group.calls[0]] : group.calls));
  const states = useAttributions(wanted);
  const [highlight, setHighlight] = useState<string | null>(focusCall);
  const number = (callId: string) => { const index = calls.findIndex((call) => call.call_id === callId); return index < 0 ? null : index + 1; };
  // A step inside a collapsed group opens it; a link to the group itself
  // (its first step) scrolls to the group's card.
  const jump = (callId: string) => {
    const group = groupOf.get(callId);
    if (group && !groupOpen(group) && callId !== group.id) flip(group);
    setHighlight(callId);
    requestAnimationFrame(() => (document.getElementById(`cot-${callId}`) ?? (group ? document.getElementById(`cot-group-${group.id}`) : null))
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };
  useEffect(() => {
    if (!focusCall) return;
    const frame = requestAnimationFrame(() => document.getElementById(`cot-${focusCall}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [focusCall]);

  const head = <header className="rt-view-head">
    <div><span className="eyebrow">CHAIN OF THOUGHT</span><h1>Why the agent did each step</h1>
      <p className="rt-muted rt-cot-caption">Likely reasons inferred from what the agent could see. Not the model&apos;s private reasoning.</p></div>
  </header>;

  if (place.where !== 'sandbox') return <section className="rt-view">{head}
    <p className="rt-empty">Chain of thought is available for prompts run in the sandbox. Run Claude Code with <code>npm run dev:all -- --claude</code>.</p>
  </section>;
  if (!calls.length) return <section className="rt-view">{head}<p className="rt-empty">This prompt made no tool calls.</p></section>;

  const first = Object.values(states).find((state) => state.status === 'ready');
  const models = first?.status === 'ready' ? [first.attribution.proposer_model, first.attribution.jev_model].filter(Boolean).join(' + ') : '';
  const card = (call: CallVerification) => <StepCard key={call.call_id} call={call} index={calls.indexOf(call)} trace={trace} states={states}
    chain={chainFor(call, calls, states, groupOf, trace)} highlight={highlight === call.call_id} number={number} onJump={jump} />;

  return <section className="rt-view">
    {head}
    <RunRecap trace={trace} onStep={jump} />
    <ol className="rt-cot-steps">{groups.map((group) => {
      if (group.calls.length === 1) return card(group.calls[0]);
      const summary = groupSummary(group, trace);
      const open = groupOpen(group);
      const leader = group.calls[0];
      return <li key={group.id} id={`cot-group-${group.id}`} className={`rt-cot-step rt-cot-group${highlight && group.calls.some((call) => call.call_id === highlight) && !open ? ' rt-focus' : ''}`}>
        <div className="rt-cot-head">
          <span className="rt-cot-num">{summary.range}</span>
          <strong>{summary.label}</strong>
          <span className="rt-chip">{group.calls.length} steps</span>
          {summary.flags.map((flag) => <span key={flag} className="rt-group-flag">{flag}</span>)}
        </div>
        <p className="rt-cot-note">Why it started (step #{group.first}):</p>
        <Explanation state={states[stepKey(leader)]} number={number} onJump={jump} />
        {summary.repeated && <p className="rt-cot-note">{summary.repeated} {summary.outcome[0].toUpperCase() + summary.outcome.slice(1)}.</p>}
        <button type="button" className="link-button rt-cot-expand" onClick={() => flip(group)}>{open ? 'Hide the steps' : `Show the ${group.calls.length} steps`}</button>
        {open && <ol className="rt-cot-steps rt-cot-members">{group.calls.map(card)}</ol>}
      </li>;
    })}</ol>
    {models && <p className="rt-foot">Causes proposed and ranked by {models}. Each step is worked out once and saved.</p>}
  </section>;
}
