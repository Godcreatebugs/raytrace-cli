/**
 * Recap: what one prompt's run did, and the observer's reading of why.
 *
 * A stronger model than the ones that label single steps (the observer) reads
 * the run as a sequence of short step lines, not the transcript, and writes:
 *
 *   happened    what the run did, each sentence tied to the steps it covers
 *   reasoning   why the agent probably went that way: a reading, not a
 *               measurement, each with how sure the observer is
 *   flags       where what the agent said and what was observed disagree
 *
 *   outline     the run, compressed: the prompt, each tool call with what it
 *               asked for, what came back, what the sandbox saw of it, the
 *               files it changed, and what the agent said just before it
 *   request     one chat request for the observer; its key changes when the
 *               outline, the model or this version does
 *   parse       the answer, checked: a sentence must name steps that exist,
 *               and may not state a percentage (none was measured here)
 *
 * Pure functions; the proxy and the hosted evidence service do the I/O.
 */
import { digest } from './experiment-engine.mjs';

export const RECAP_VERSION = 1;
export const DEFAULT_OBSERVER = 'anthropic/claude-sonnet-5.5';
const MAX_STEPS = 80;
const KEEP_FIRST = 30;
const clip = (text, max) => { const line = String(text ?? '').replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

function parsed(raw) { try { return JSON.parse(raw); } catch { return null; } }

/** What the agent was told back for one call, from the trace's events. */
function reported(resultsByCall, callId) {
  const raw = resultsByCall.get(callId);
  if (!raw) return null;
  const output = typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output ?? '');
  const code = Number(output.match(/Process exited with code (\d+)/)?.[1] ?? NaN);
  const failed = Number.isFinite(code) ? code !== 0 : /^\s*(error|failed)|Rejected\(/i.test(output.slice(0, 120));
  return { state: failed ? 'failed' : 'ok', says: clip(output, 160) };
}

/** The run as the observer reads it, or null when there is nothing to recap
 * (no tool calls: the answer is the whole story). */
export function recapOutline(trace) {
  const calls = trace?.callVerifications ?? [];
  if (!calls.length) return null;
  const events = trace.events ?? [];
  const resultsByCall = new Map();
  // What the agent wrote in the response that proposed a call: its own account of why.
  const notesByExchange = new Map();
  for (const event of events) {
    if (event.title?.startsWith('Tool result:')) { const raw = parsed(event.raw); if (raw?.call_id) resultsByCall.set(raw.call_id, raw); }
    else if (event.title === 'Model answer' && event.exchange_id && event.detail) {
      notesByExchange.set(event.exchange_id, [...(notesByExchange.get(event.exchange_id) ?? []), event.detail]);
    }
  }
  const told = new Set();
  const steps = calls.map((call, index) => {
    const note = !told.has(call.exchange_id) ? (notesByExchange.get(call.exchange_id) ?? []).join(' ') : '';
    told.add(call.exchange_id);
    const changes = call.snapshot?.changed ? (call.snapshot.changes ?? []) : [];
    // Only a sandbox can contradict the agent: outside one, nothing independent watched.
    const observed = !trace.sandboxId ? undefined
      : call.kernel_confirmed || call.verified ? { ran: true, ...(call.exit_code != null ? { exit_code: call.exit_code } : {}) }
        : call.name === 'Bash' || /exec|shell/i.test(call.name) ? { ran: false } : undefined;
    return {
      step: index + 1, tool: call.name, asked: clip(call.proposed ?? call.name, 220),
      ...(note ? { agent_said_before: clip(note, 260) } : {}),
      ...(reported(resultsByCall, call.call_id) ? { agent_was_told: reported(resultsByCall, call.call_id) } : {}),
      ...(observed ? { sandbox_observed: observed } : {}),
      ...(changes.length ? { files_changed: changes.slice(0, 6).map((change) => `${change.status} ${change.path}`), ...(changes.length > 6 ? { more_files: changes.length - 6 } : {}) } : {}),
    };
  });
  // A long run keeps its start and its end; the middle is counted, not sent.
  const shown = steps.length > MAX_STEPS ? [...steps.slice(0, KEEP_FIRST), ...steps.slice(-(MAX_STEPS - KEEP_FIRST))] : steps;
  return {
    prompt: clip(trace.title, 1500), agent: trace.provider, model: trace.model, in_sandbox: Boolean(trace.sandboxId),
    steps: shown, total_steps: steps.length, ...(steps.length > MAX_STEPS ? { omitted_steps: `${KEEP_FIRST + 1}-${steps.length - (MAX_STEPS - KEEP_FIRST)}` } : {}),
    final_answer: trace.answer ? clip(trace.answer, 1200) : null,
  };
}

export const RECAP_INSTRUCTIONS = [
  'You are an observer reading the record of one run of a coding agent. Someone who did not watch the run wants to know what it did and, as far as the record shows, why.',
  'The record is JSON: the prompt, numbered steps (what the agent asked a tool to do, what it said just before, what it was told back, and, when the run was in a sandbox, what the sandbox itself observed and which files changed), and the final answer.',
  'Reply with one JSON object and nothing else:',
  '{"headline": string, "happened": [{"text": string, "steps": [number]}], "reasoning": [{"text": string, "steps": [number], "confidence": "likely" | "possible" | "unclear"}], "flags": [{"text": string, "steps": [number]}]}',
  'headline: one plain sentence, at most 25 words, saying what the run achieved or failed to achieve.',
  'happened: 3 to 7 sentences that together tell the run in order. Group steps that did one thing into one sentence. State only what the record shows. Prefer what the sandbox observed over what the agent was told or said.',
  'reasoning: 2 to 4 sentences on why the agent most probably went the way it did: what it seemed to be working toward, and what it reacted to (the prompt, something a step returned, its own earlier plan). This is your reading of the sequence, so say "probably" or "appears to" where the record does not settle it, and use "unclear" when it does not say.',
  'flags: only real disagreements in the record, such as the agent reporting success where the sandbox saw a non-zero exit, a command the sandbox never saw run, or an answer that claims something no step did. Usually empty.',
  'Every item lists the step numbers it rests on, which must be numbers from the record. Never state a percentage or a probability as a number: none was measured. Do not invent steps, files, commands or results. Plain sentences, no markdown.',
].join('\n');

/** One chat request for the observer; `key` identifies this outline, model and version. */
export function recapRequest(outline, model = DEFAULT_OBSERVER) {
  const input = JSON.stringify(outline);
  return { key: digest({ version: RECAP_VERSION, kind: 'run-recap', model, input }), payload: {
    model, max_tokens: 1100, temperature: 0.2,
    messages: [{ role: 'system', content: RECAP_INSTRUCTIONS }, { role: 'user', content: input }],
  } };
}

/** The observer's text out of a chat completion (or a Responses-style body). */
export function recapText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('');
  return (response?.output ?? []).filter((item) => item?.type === 'message').map((item) => (item.content ?? []).map((part) => part?.text ?? '').join('')).join('');
}

/** The recap, checked against the outline; null when the answer is not usable. */
export function parseRecap(text, outline) {
  const body = String(text ?? '');
  const value = parsed(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
  if (!value || typeof value !== 'object') return null;
  const known = new Set(outline.steps.map((step) => step.step));
  const sentence = (item, max) => {
    const said = typeof item?.text === 'string' ? clip(item.text, max) : '';
    // No number here was measured, so a percentage would be made up.
    if (!said || /\d\s?%|\bpercent\b/i.test(said)) return null;
    const steps = [...new Set((Array.isArray(item.steps) ? item.steps : []).filter((step) => known.has(step)))].sort((a, b) => a - b);
    // A sentence that names steps, none of them real, rests on nothing.
    if (Array.isArray(item.steps) && item.steps.length && !steps.length) return null;
    return { text: said, steps };
  };
  const list = (items, max, limit, extra = () => ({})) => (Array.isArray(items) ? items : []).slice(0, limit)
    .map((item) => { const kept = sentence(item, max); return kept && { ...kept, ...extra(item) }; }).filter(Boolean);
  const happened = list(value.happened, 360, 8);
  if (!happened.length) return null;
  return {
    headline: typeof value.headline === 'string' && !/\d\s?%/.test(value.headline) ? clip(value.headline, 220) : null,
    happened,
    reasoning: list(value.reasoning, 420, 5, (item) => ({ confidence: ['likely', 'possible', 'unclear'].includes(item.confidence) ? item.confidence : 'possible' })),
    // A flag must point at the steps that disagree.
    flags: list(value.flags, 320, 4).filter((flag) => flag.steps.length),
    steps_read: outline.steps.length, total_steps: outline.total_steps,
  };
}
