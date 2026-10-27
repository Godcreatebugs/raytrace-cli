'use client';

// Recap: what one prompt's run did and the observer's reading of why, written
// once by a stronger model from the run's step lines (proxy/run-recap.mjs) the
// first time the prompt is opened, then kept. What happened is tied to steps;
// the reasoning is a reading of the sequence, and says so.
import { useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { type Trace } from './types';
import { api } from './api';

type Sentence = { text: string; steps: number[]; confidence?: 'likely' | 'possible' | 'unclear' };
type Recap = { headline: string | null; happened: Sentence[]; reasoning: Sentence[]; flags: Sentence[]; model: string; steps_read: number; total_steps: number };
type State = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; recap: Recap } | { status: 'error'; message: string };

function useRecap(trace: Trace) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const calls = trace.callVerifications?.length ?? 0;
  // A run still going has no answer yet: its recap would be of half a story.
  const finished = Boolean(trace.answer) && calls > 0;
  useEffect(() => {
    if (!finished) { setState({ status: 'idle' }); return; }
    let closed = false;
    const set = (next: State) => { if (!closed) setState(next); };
    set({ status: 'loading' });
    void (async () => {
      try {
        const saved = await api().fetch(`/raytace/recap/${trace.id}`);
        const found = await saved.json() as { recap?: Recap | null; available?: boolean; error?: string };
        if (saved.ok && found.recap) return set({ status: 'ready', recap: found.recap });
        if (saved.ok && found.available === false) return set({ status: 'idle' });
        const written = await api().fetch('/raytace/recap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' }, body: JSON.stringify({ trace_id: trace.id }) });
        const value = await written.json() as Recap & { error?: string };
        set(written.ok ? { status: 'ready', recap: value } : { status: 'error', message: value.error ?? 'The recap could not be written.' });
      } catch { set({ status: 'error', message: 'The recap could not be loaded.' }); }
    })();
    return () => { closed = true; };
  }, [trace.id, finished, calls, attempt]);
  return { state, retry: () => setAttempt((value) => value + 1) };
}

const CONFIDENCE = { likely: 'likely', possible: 'possibly', unclear: 'unclear' } as const;

export function RunRecap({ trace, onStep }: {
  trace: Trace;
  /** Opens one step of the run, by its call id. */
  onStep?: (callId: string) => void;
}) {
  const { state, retry } = useRecap(trace);
  if (state.status === 'idle') return null;
  const calls = trace.callVerifications ?? [];
  const steps = (sentence: Sentence) => sentence.steps.length > 0 && <span className="rt-recap-steps">
    {sentence.steps.map((step) => (onStep && calls[step - 1]
      ? <button key={step} type="button" className="rt-recap-step" onClick={() => onStep(calls[step - 1].call_id)} title={`Open step ${step}`}>{step}</button>
      : <span key={step} className="rt-recap-step">{step}</span>))}
  </span>;
  return <section className="rt-recap" aria-label="Recap">
    <header><span className="eyebrow">RECAP</span>
      {state.status === 'ready' && <small>Written by {state.recap.model.split('/').pop()} from {state.recap.steps_read === state.recap.total_steps ? `all ${state.recap.total_steps}` : `${state.recap.steps_read} of ${state.recap.total_steps}`} steps</small>}</header>
    {state.status === 'loading' && <p className="rt-muted">Reading the run…</p>}
    {state.status === 'error' && <p className="rt-muted">{state.message} <button type="button" className="link-button" onClick={retry}><RotateCw size={11} /> Try again</button></p>}
    {state.status === 'ready' && <>
      {state.recap.headline && <p className="rt-recap-headline">{state.recap.headline}</p>}
      <h4>What happened</h4>
      <ol className="rt-recap-list">{state.recap.happened.map((sentence, index) => <li key={index}>{sentence.text} {steps(sentence)}</li>)}</ol>
      {state.recap.reasoning.length > 0 && <>
        <h4>Probably why <small>the observer&apos;s reading of the sequence, not a measurement</small></h4>
        <ul className="rt-recap-list">{state.recap.reasoning.map((sentence, index) => <li key={index}>
          <span className={`rt-recap-sure s-${sentence.confidence ?? 'possible'}`}>{CONFIDENCE[sentence.confidence ?? 'possible']}</span> {sentence.text} {steps(sentence)}</li>)}</ul>
      </>}
      {state.recap.flags.length > 0 && <>
        <h4>Worth checking</h4>
        <ul className="rt-recap-list rt-recap-flags">{state.recap.flags.map((sentence, index) => <li key={index}>{sentence.text} {steps(sentence)}</li>)}</ul>
      </>}
    </>}
  </section>;
}
