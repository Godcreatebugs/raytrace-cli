// Shared types for the captured-trace UI. Consolidated out of the old
// experiment-lab.tsx (removed) so there is one home for these instead of
// three files each importing from whichever file happened to define them.

import { type RequestMetric } from './request-metrics';

export type Origin = { trace_id: string; exchange_id: string; name: string };

export type EventKind = 'model' | 'search' | 'read' | 'edit' | 'test';
export type TraceEvent = { kind: EventKind; title: string; detail: string; time: string; raw: string; exchange_id?: string; output_index?: number };

/** One proposed tool call, whether or not its result was ever resent as
 * evidence in a later request (a call in the very last response of a trace
 * never is) — see readTraces()'s callVerifications in raytace-proxy.mjs. */
export type CallVerification = {
  call_id: string;
  exchange_id: string;
  name: string;
  /** Position of the call in its response; with exchange_id, finds its step. */
  output_index?: number;
  /** The command the model proposed, without the shell wrapper. */
  proposed?: string | null;
};

export type SummaryState = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'error' };

/** One "Model request #N" grouping in a trace's flat event list — the same
 * grouping app/page.tsx's timeline renders, reused by the graph view so the
 * two stay in lockstep instead of each re-deriving it slightly differently. */
export type TraceBlock = { exchangeId: string; number: number; completion?: TraceEvent; items: { event: TraceEvent; index: number }[] };

export type Trace = {
  requests?: RequestMetric[];
  id: string;
  provider: string;
  model: string;
  title: string;
  startedAt: string;
  /** When the turn's last response landed. */
  endedAt?: string;
  /** The turn's final answer text, when the last response had any. */
  answer?: string;
  events: TraceEvent[];
  evidence: ContextItem[];
  callVerifications?: CallVerification[];
};

/** One piece of context sent into a model request (a message, instructions,
 * or a tool result) plus what the counterfactual lab knows about it. */
export type ContextItem = {
  id: string;
  exchange_id: string;
  index: number;
  kind: string;
  label: string;
  preview: string;
  content?: string;
  /** Set on a repeat of an earlier item (the same text resent by a later
   * request): that item carries the text and details; this one only where it
   * sits (id, exchange_id, index, kind, label, call_id). */
  content_of?: string;
  intervention: string;
  later_items: number;
  call_id: string | null;
  origin: Origin | null;
  action: string | null;
  succeeded: boolean | null;
  source_call: { name: string; arguments: string } | null;
};

export type Outcome = { key: string; label: string; calls: { name: string; arguments: unknown }[]; text: string };

/** The state of one model request just before it was sent. */
export type Snapshot = {
  exchange_id: string;
  model: string;
  stream: boolean;
  input_items: number;
  tool_count: number;
  reasoning?: { effort?: string; context?: string };
  replay_reason: string | null;
  decision: Outcome | null;
};
