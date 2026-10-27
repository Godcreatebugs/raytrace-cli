'use client';

// Story: the summary layer for one prompt. The left rail is a timeline of
// only the consequential steps (story-data.ts ranks them from recorded
// facts); the main pane tells the selected step's story — what the agent
// could see, what it proposed, what the sandbox actually saw, and what that
// set up — and singles out the run's most consequential command up top.
// The why is a reading of the record, never the model's private reasoning,
// and nothing here spends on a model or reruns anything.
import { useEffect, useState } from 'react';
import { Brain, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import { type Trace } from './types';
import { keyMoments, mostConsequential, storyFor, type KeyMoment } from './story-data';
import { CommandText } from './execution-table';
import { RunRecap } from './run-recap';

const TRIGGER_LABEL = { request: 'Your request', agent: 'The agent said, just before', result: 'What the previous step returned' } as const;

export function StoryView({ trace, focusCall, onSelect, onOpenCall, onOpenThought, onOpenSandbox }: {
  trace: Trace;
  focusCall: string | null;
  onSelect?: (callId: string) => void;
  onOpenCall?: (callId: string) => void;
  onOpenThought?: (callId: string) => void;
  onOpenSandbox?: (callId: string) => void;
}) {
  const calls = trace.callVerifications ?? [];
  const moments = keyMoments(trace);
  const top = mostConsequential(trace);
  const [picked, setPicked] = useState<string | null>(focusCall);
  useEffect(() => { if (focusCall) setPicked(focusCall); }, [focusCall]);
  const selectedId = picked && calls.some((call) => call.call_id === picked) ? picked : top?.call.call_id ?? null;
  const selected = moments.find((moment) => moment.call.call_id === selectedId)
    ?? (top && selectedId === top.call.call_id ? top : null)
    ?? moments[0] ?? null;
  const story = selected ? storyFor(trace, selected.call) : null;

  const head = <header className="rt-view-head">
    <div><span className="eyebrow">STORY</span><h1>What mattered in this run, and why</h1>
      <p className="rt-muted rt-cot-caption">A timeline of the consequential steps only. Why a step happened is a reading of what the agent could see — not its private reasoning.</p></div>
  </header>;

  if (!calls.length) return <section className="rt-view">{head}<p className="rt-empty">This prompt made no tool calls, so there is no story to rank. The final answer is the whole run.</p></section>;

  const pick = (moment: KeyMoment) => { setPicked(moment.call.call_id); onSelect?.(moment.call.call_id); };
  const isTop = (moment: KeyMoment) => top?.call.call_id === moment.call.call_id;

  return <section className="rt-view">
    {head}
    <RunRecap trace={trace} onStep={(callId) => { setPicked(callId); onSelect?.(callId); }} />
    <div className="rt-story">
      <aside className="rt-story-rail" aria-label="Timeline of key moments">
        <h2>Key moments</h2>
        <p className="rt-story-rail-note">{moments.length} of {calls.length} step{calls.length === 1 ? '' : 's'} earned a place, ranked by files changed, failures, processes spawned, and what later steps built on.</p>
        <ol className="rt-story-timeline">
          {moments.map((moment) => <li key={moment.call.call_id}>
            <button type="button" aria-label={`Step ${moment.step}: ${moment.label}`} className={`rt-story-node${selected?.call.call_id === moment.call.call_id ? ' active' : ''}`} onClick={() => pick(moment)}>
              <span className="rt-story-dot" aria-hidden />
              <span className="rt-story-node-body">
                <span className="rt-story-node-head"><span className="rt-cot-num">#{moment.step}</span>
                  {isTop(moment) && <span className="rt-story-top"><Sparkles size={11} /> Most consequential</span>}
                  <span className="rt-story-score" title="Consequence score, from the reasons listed for this step">{moment.score}</span></span>
                <span className="rt-story-node-label">{moment.label}</span>
                <span className="rt-story-node-why">{moment.reasons[1] ?? moment.reasons[0] ?? ''}</span>
              </span>
            </button>
          </li>)}
        </ol>
        <p className="rt-story-rail-note">Routine reads, searches and retries that changed nothing are in Tool calls, not here.</p>
      </aside>

      {selected && story && <article className="rt-story-main" aria-label={`Story of step ${selected.step}`}>
        {isTop(selected)
          ? <p className="rt-story-banner"><Sparkles size={13} /> The most consequential command of this run — the one later steps and the final answer most depend on.</p>
          : <p className="rt-story-banner rt-story-banner-quiet">Step #{selected.step} of {calls.length} · consequence score {selected.score}</p>}
        <h2 className="rt-story-title">Step #{selected.step}: {selected.label}</h2>
        <div className="rt-story-cmd"><CommandText text={story.proposed} /></div>

        <h3>Why it did that</h3>
        <p className="rt-story-why">{story.why}</p>
        <ul className="rt-story-list">{story.trigger.map((item, index) => <li key={index}>
          <span className="rt-story-tag">{item.step ? `${TRIGGER_LABEL[item.kind]} (#${item.step})` : TRIGGER_LABEL[item.kind]}</span> {item.text}</li>)}</ul>

        <h3>What actually happened</h3>
        <ul className="rt-story-list">{story.observed.map((line, index) => <li key={index}>{line}</li>)}</ul>

        <h3>Why it matters</h3>
        <ul className="rt-story-list">{story.consequence.map((line, index) => <li key={index}>{line}</li>)}</ul>

        <h3>What earned its place</h3>
        <div className="rt-chips">{selected.reasons.map((reason) => <span key={reason} className="rt-chip rt-story-reason">{reason}</span>)}</div>

        <div className="rt-story-actions">
          {onOpenCall && <button type="button" className="rt-button" onClick={() => onOpenCall(selected.call.call_id)}><Wrench size={12} /> Open in Tool calls</button>}
          {onOpenThought && <button type="button" className="rt-button" onClick={() => onOpenThought(selected.call.call_id)}><Brain size={12} /> Ranked causes</button>}
          {onOpenSandbox && <button type="button" className="rt-button" onClick={() => onOpenSandbox(selected.call.call_id)}><ShieldCheck size={12} /> Sandbox evidence</button>}
        </div>
        <p className="rt-foot">Ranked from recorded facts only — files changed, exit codes, processes the sandbox saw, disagreements between the agent&apos;s report and the sandbox, and what later steps reused. No model was asked to write this.</p>
      </article>}
    </div>
  </section>;
}
