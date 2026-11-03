'use client';
import {CaptureHealthStatus} from './capture-health';

// Prompts: what was asked and what came back. Everything about how the agent
// got there lives in Tool calls and Sandbox, one click away.
import { useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { type Trace } from './types';
import { ActivityGraph, dayKey } from './activity-graph';
import { money } from './request-metrics';
import { sumMetric, runPlace } from './trace-utils';
import { RunRecap } from './run-recap';

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '(empty prompt)';

export function PromptsView({ traces, loaded = true, box = '', onBox, selectedId, onSelect, onOpen, onOpenStep, canOpen = () => true }: {
  traces: Trace[];
  /** Only the prompts that ran in this sandbox (its id, ?box= in the link), or all of them. */
  box?: string;
  onBox?: (box: string) => void;
  /** False until the first load answers: an empty list then means "not yet", not "none". */
  loaded?: boolean;
  selectedId: string;
  onSelect: (traceId: string) => void;
  onOpen: (view: 'calls' | 'sandbox' | 'context', traceId: string) => void;
  /** Opens one step of a prompt in Tool calls. */
  onOpenStep?: (traceId: string, callId: string) => void;
  /** Whether that view exists here (the hosted dashboard has fewer). */
  canOpen?: (view: 'calls' | 'sandbox' | 'context') => boolean;
}) {
  const [day, setDay] = useState<string | null>(null);
  const mine = box ? traces.filter((trace) => trace.sandboxId === box) : traces;
  const shown = mine.filter((trace) => !day || dayKey(trace.startedAt) === day)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return <section className="rt-view">
    <header className="rt-view-head"><div><span className="eyebrow">PROMPTS</span><h1>What you asked</h1></div></header>
    <ActivityGraph dates={mine.map((trace) => trace.startedAt)} selected={day} onSelect={setDay} />
    <div className="rt-list-head"><span className="rt-chips">
      {box && <button type="button" className="rt-chip" title="Show prompts from everywhere" onClick={() => onBox?.('')}>
        Sandbox {box} <X size={12} />
      </button>}
      {day
        ? <button type="button" className="rt-chip" onClick={() => setDay(null)}>
            {new Date(`${day}T00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} <X size={12} />
          </button>
        : !box && <span>Recent</span>}
    </span>
      <small>{shown.length} prompt{shown.length === 1 ? '' : 's'}</small>
    </div>
    {!shown.length && <p className="rt-empty">{loaded ? box ? 'No prompts from this sandbox yet. Ask Claude Code something in it and it will appear here.' : 'No prompts captured yet. Send a request through the proxy and it will appear here.' : 'Loading…'}</p>}
    <ol className="rt-prompts">
      {shown.map((trace) => {
        const open = trace.id === selectedId;
        const cost = sumMetric(trace.requests, 'cost');
        const calls = trace.callVerifications?.length ?? 0;
        const place = runPlace(trace);
        return <li key={trace.id} className={open ? 'rt-prompt open' : 'rt-prompt'}>
          <button type="button" className="rt-prompt-row" aria-expanded={open} onClick={() => onSelect(open ? '' : trace.id)}>
            <time dateTime={trace.startedAt}>{new Date(trace.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</time>
            <strong><span className={`rt-where w-${place.where}`} title={place.forkable ? 'Ran in the sandbox: can be forked in the Playground' : place.reason ?? undefined}>{place.label}</span>{firstLine(trace.title)}</strong>
            <small>{trace.model} · {calls} tool call{calls === 1 ? '' : 's'} · {money(cost, trace.requests?.some((r) => r.costEstimated))}</small>
          </button>
          {open && <div className="rt-prompt-detail">
            <CaptureHealthStatus health={trace.captureHealth}/><h3>Prompt</h3>
            <p className="rt-text">{trace.title}</p>
            <h3>Answer</h3>
            {trace.answer ? <p className="rt-text">{trace.answer}</p> : <p className="rt-muted">No final answer was captured for this prompt.</p>}
            <RunRecap trace={trace} onStep={onOpenStep && ((callId) => onOpenStep(trace.id, callId))} />
            <div className="rt-actions">
              <button type="button" className="rt-button" onClick={() => onOpen('calls', trace.id)}>Tool calls <ArrowRight size={14} /></button>
              {trace.sandboxId && canOpen('sandbox') && <button type="button" className="rt-button" onClick={() => onOpen('sandbox', trace.id)}>Sandbox evidence <ArrowRight size={14} /></button>}
              {canOpen('context') && <button type="button" className="rt-button" onClick={() => onOpen('context', trace.id)}>Context <ArrowRight size={14} /></button>}
            </div>
          </div>}
        </li>;
      })}
    </ol>
  </section>;
}
