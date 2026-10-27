// The one line on a graph node: what that model request did. The model-written
// summary (proxy/summaries.mjs) wins when it exists, but it is not served
// everywhere (the hosted dashboard turns summaries off, and locally they need
// OpenRouter routing), so a node must never depend on it: the request's own
// tool calls are always in the trace, with a plain-English description for
// each command (proxy/trace-view.mjs). Built from those, in run order.
import type { CallVerification, SummaryState } from './types';

const MAX_PARTS = 3;
const MAX_ITEM_CHARS = 60;
const MAX_TEXT_CHARS = 140;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function callLabel(call: CallVerification): string {
  const text = oneLine(call.description || call.proposed || call.name || 'Tool call');
  return text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS - 1)}…` : text;
}

/** Node text for one request: its model summary when ready, else what its
 * tool calls did, else why there is no summary. Never empty. */
export function requestSummaryText(calls: CallVerification[], summary?: SummaryState): string {
  if (summary?.status === 'ready' && summary.text) return summary.text;
  if (calls.length) {
    const labels = [...new Set(calls.map(callLabel))];
    const shown = labels.slice(0, MAX_PARTS);
    const text = shown.join(' · ') + (labels.length > shown.length ? ` · +${labels.length - shown.length} more` : '');
    return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text;
  }
  if (summary?.status === 'loading') return 'Summarizing…';
  if (summary?.status === 'error') return 'Summary unavailable.';
  return 'No tool calls in this request.';
}
