// Story: the summary layer over one prompt's run. Ranks every proposed call
// by how consequential it was — from recorded facts only (files changed,
// exit codes, processes spawned, disagreements between what the agent was
// told and what the sandbox saw, what later steps built on) — picks the few
// key moments for a timeline, and assembles for each a short story from the
// record: what the agent could see just before, what it proposed, what
// actually happened, and what that set up next. No model is asked and
// nothing is rerun; the "why" is a reading of the sequence, labelled as such.
import type { CallCategory, CallVerification, Trace, TraceEvent } from './types';

const CATEGORY_LABEL: Record<CallCategory, string> = {
  read: 'Read', search: 'Search', write: 'Write', edit: 'Edit', delete: 'Delete / move', run: 'Run', test: 'Test',
  build: 'Build / install', git: 'Git', web: 'Web', plan: 'Plan', delegate: 'Delegate', unsure: 'Not sure',
};

type Reported = { state: 'ok' | 'failed' | 'rejected' | 'none'; code: number | null; output: string };
/** What the agent's runner said happened to one call (same reading as
 * trace-utils' reportedResult, kept local so this file stays dependency-free). */
function reportedResult(events: TraceEvent[], callId: string): Reported {
  const event = events.find((item) => {
    if (!item.title.startsWith('Tool result:')) return false;
    try { return JSON.parse(item.raw).call_id === callId; } catch { return false; }
  });
  if (!event) return { state: 'none', code: null, output: '' };
  let output = '';
  let isError = false;
  let explicitCode: number | null = null;
  try {
    const raw = JSON.parse(event.raw);
    const content = raw.output ?? raw.content;
    output = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    isError = raw.is_error === true || raw.status === 'failed';
    const codeVal = typeof raw.exit_code === 'number' ? raw.exit_code : (content && typeof content === 'object' && typeof content.exit_code === 'number' ? content.exit_code : null);
    if (typeof codeVal === 'number') explicitCode = codeVal;
  } catch { /* unreadable */ }
  if (isError) return { state: 'failed', code: explicitCode, output };
  if (explicitCode !== null) return { state: explicitCode === 0 ? 'ok' : 'failed', code: explicitCode, output };
  if (/Rejected\(/.test(output)) return { state: 'rejected', code: null, output };
  const code = Number(output.match(/Process exited with code (\d+)/)?.[1] ?? NaN);
  if (Number.isFinite(code)) return { state: code === 0 ? 'ok' : 'failed', code, output };
  return { state: /failed/i.test(output.slice(0, 80)) ? 'failed' : 'ok', code: null, output };
}

export type KeyMoment = {
  call: CallVerification;
  /** 1-based position in the run, as shown everywhere else ("step #3"). */
  step: number;
  score: number;
  reasons: string[];
  label: string;
};

export type Story = {
  /** What the agent had just seen/said before proposing this call. */
  trigger: { kind: 'request' | 'agent' | 'result'; text: string; step?: number }[];
  proposed: string;
  /** What the record shows happened, sandbox first. */
  observed: string[];
  /** Why this step matters: what it changed or set up. */
  consequence: string[];
  /** One-sentence reading of why the agent proposed it. A reading, not a measurement. */
  why: string;
};

const clip = (text: string, max: number) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

const CATEGORY_WEIGHT: Record<string, number> = {
  delete: 45, git: 40, write: 35, edit: 35, build: 30, test: 28, run: 22,
  delegate: 20, web: 10, plan: 8, read: 5, search: 5, unsure: 8,
};

// Patterns whose blast radius is large even when they exit 0.
const RISKY: [RegExp, string][] = [
  [/\brm\s+-[a-z]*[rf]/, 'Deletes files (rm -r/-f)'],
  [/\bsudo\b/, 'Runs with elevated privileges (sudo)'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, 'Pipes a download straight into a shell'],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s)/, 'Hard-to-undo git operation'],
  [/\b(drop\s+(table|database)|truncate\s+table|delete\s+from)\b/i, 'Deletes stored data'],
  [/\bkill\s+-9\b|\bmkfs\b|\bdd\s+.*of=\/dev\//, 'Can destroy processes or disks'],
  [/\b(npm|pnpm|yarn|pip|pip3|brew|apt(-get)?)\s+(install|add|i)\b/, 'Installs or changes dependencies'],
  [/\bchmod\s+(-R\s+)?[0-7]{3,4}\b|\bchown\s+-R\b/, 'Changes file permissions or ownership'],
];

function changedPaths(call: CallVerification): string[] {
  return call.snapshot?.changed ? (call.snapshot.changes ?? []).map((change) => change.path) : [];
}

/** Later steps that mention a file this call changed, or changed it again:
 * evidence that the run built on this step rather than passing it by. */
function downstreamUses(trace: Trace, calls: CallVerification[], index: number): number {
  const paths = changedPaths(calls[index]).map(basename).filter((name) => name.length >= 3);
  if (!paths.length) return 0;
  return calls.slice(index + 1).filter((later) => {
    const text = `${later.proposed ?? ''} ${changedPaths(later).join(' ')}`;
    return paths.some((name) => text.includes(name));
  }).length;
}

/** Score one call and say, in plain words, what earned the score. */
export function scoreCall(trace: Trace, call: CallVerification, index: number, calls: CallVerification[] = trace.callVerifications ?? []): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = CATEGORY_WEIGHT[call.category ?? 'unsure'] ?? 8;
  if (call.category) reasons.push(`${CATEGORY_LABEL[call.category]} step`);
  const proposed = call.proposed ?? '';
  for (const [pattern, reason] of RISKY) if (pattern.test(proposed)) { score += 30; reasons.push(reason); }
  const changed = changedPaths(call);
  if (changed.length) { score += Math.min(30, changed.length * 10); reasons.push(`Changed ${changed.length} file${changed.length === 1 ? '' : 's'}: ${changed.slice(0, 3).map(basename).join(', ')}${changed.length > 3 ? ', …' : ''}`); }
  const reported = reportedResult(trace.events, call.call_id);
  if (reported.state === 'failed') { score += 25; reasons.push(`Failed as reported to the agent${reported.code != null ? ` (exit ${reported.code})` : ''}`); }
  if (reported.state === 'rejected') { score += 25; reasons.push('Refused by the sandbox policy'); }
  if (call.exit_code != null && call.exit_code !== 0) { score += 20; reasons.push(`Sandbox saw exit ${call.exit_code}`); }
  if (call.reported_check && call.reported_check !== 'agrees') { score += 25; reasons.push('What the agent was told differs from what the sandbox saw'); }
  const spawned = call.descendant_count ?? call.descendants?.length ?? 0;
  if (spawned > 1) { score += Math.min(15, spawned); reasons.push(`Ran ${spawned} processes underneath it`); }
  if ((reported.state === 'failed' || reported.state === 'rejected') && index + 1 < calls.length) { score += 12; reasons.push('The run changed course after this step'); }
  const uses = downstreamUses(trace, calls, index);
  if (uses) { score += Math.min(18, uses * 6); reasons.push(`${uses} later step${uses === 1 ? '' : 's'} built on what it produced`); }
  if (index === calls.length - 1 && calls.length > 1) { score += 5; reasons.push('Last step before the final answer'); }
  return { score, reasons };
}

const shortLabel = (call: CallVerification) => {
  const first = (call.proposed ?? call.name).split('\n').find((line) => line.trim())?.trim() ?? call.name;
  return clip(first, 90);
};

/** The timeline: the consequential few, in the order they happened. Reads,
 * searches and other low-impact steps are left out unless almost nothing
 * else happened. At most eight moments; the most consequential is always in. */
export function keyMoments(trace: Trace): KeyMoment[] {
  const calls = trace.callVerifications ?? [];
  const scored = calls.map((call, index) => ({ call, step: index + 1, ...scoreCall(trace, call, index, calls), label: shortLabel(call) }));
  if (!scored.length) return [];
  let kept = scored.filter((moment) => moment.score >= 28);
  if (kept.length > 8) kept = [...kept].sort((a, b) => b.score - a.score).slice(0, 8);
  if (kept.length < 3) kept = [...scored].sort((a, b) => b.score - a.score).slice(0, Math.min(5, scored.length));
  return kept.sort((a, b) => a.step - b.step);
}

/** The single most consequential call of the run, or null when it made none. */
export function mostConsequential(trace: Trace): KeyMoment | null {
  const calls = trace.callVerifications ?? [];
  if (!calls.length) return null;
  return calls.map((call, index) => ({ call, step: index + 1, ...scoreCall(trace, call, index, calls), label: shortLabel(call) }))
    .sort((a, b) => b.score - a.score || a.step - b.step)[0];
}

/** The story of one call, from the record alone. */
export function storyFor(trace: Trace, call: CallVerification): Story {
  const calls = trace.callVerifications ?? [];
  const index = calls.findIndex((item) => item.call_id === call.call_id);
  const step = index + 1;
  const trigger: Story['trigger'] = [];
  // What the agent itself said in the response that proposed this call.
  const said = trace.events.filter((event) => event.title === 'Model answer' && event.exchange_id === call.exchange_id && event.detail?.trim())
    .map((event) => event.detail).join(' ');
  if (said) trigger.push({ kind: 'agent', text: clip(said, 300) });
  // What the previous call handed back, when there was one worth quoting.
  const previous = index > 0 ? calls[index - 1] : null;
  const prevResult = previous ? reportedResult(trace.events, previous.call_id) : null;
  if (previous && prevResult && (prevResult.state !== 'ok' || prevResult.output.trim())) {
    trigger.push({ kind: 'result', step: index, text: clip(prevResult.output, 260) || `Step #${index} ${prevResult.state}` });
  }
  if (!trigger.length) trigger.push({ kind: 'request', text: clip(trace.title, 300) });

  const reported = reportedResult(trace.events, call.call_id);
  const observed: string[] = [];
  if (call.exec_id || call.kernel_confirmed) observed.push(`The sandbox saw it run${call.exit_code != null ? ` · exit ${call.exit_code}` : ''}${(call.descendant_count ?? 0) > 0 ? ` · ${call.descendant_count} child process${call.descendant_count === 1 ? '' : 'es'}` : ''}.`);
  else if (call.snapshot) observed.push(call.snapshot.changed ? `The sandbox's snapshot after it shows ${call.snapshot.changes.length} file change${call.snapshot.changes.length === 1 ? '' : 's'}.` : 'The sandbox\'s snapshot after it shows no file change.');
  else if (reported.state === 'rejected') observed.push('The sandbox policy refused it; it never ran.');
  else if (trace.sandboxId) observed.push('The sandbox saw no process for this call. Missing evidence is not proof it did not run.');
  if (reported.state !== 'none') observed.push(`The agent was told: ${reported.state}${reported.code != null ? ` (exit ${reported.code})` : ''}${reported.output.trim() ? ` — ${clip(reported.output, 180)}` : ''}`);
  if (call.reported_check && call.reported_check !== 'agrees') observed.push('That report differs from what the sandbox observed — worth checking before trusting either.');
  if (!observed.length) observed.push('No independent observation was recorded for this call.');

  const changed = changedPaths(call);
  const consequence: string[] = [];
  if (changed.length) consequence.push(`Changed ${changed.map((path) => `\`${path}\``).join(', ')}.`);
  const uses = index >= 0 ? downstreamUses(trace, calls, index) : 0;
  if (uses) consequence.push(`${uses} later step${uses === 1 ? '' : 's'} worked on what this produced, so later results depend on it.`);
  const next = index >= 0 ? calls[index + 1] : undefined;
  if (next) consequence.push(`The next step (#${step + 1}) was: ${shortLabel(next)}.`);
  else if (trace.answer) consequence.push(`After this, the agent answered: ${clip(trace.answer, 220)}`);
  if (!consequence.length) consequence.push('Nothing later in the record depends on it directly.');

  const why = prevResult && (prevResult.state === 'failed' || prevResult.state === 'rejected')
    ? `Step #${index} had just ${prevResult.state === 'rejected' ? 'been refused' : 'failed'} as the agent heard it, so this reads as a reaction to that result rather than a planned first move.`
    : said
      ? `The agent said, just before proposing it: “${clip(said, 180)}” That is its own account, not private reasoning.`
      : index <= 0
        ? 'This follows directly from your request; the agent had seen nothing else yet.'
        : `Nothing the agent said at the time explains it beyond the sequence: it follows step #${index} and your original request.`;

  return { trigger, proposed: call.proposed ?? call.name, observed, consequence, why };
}
