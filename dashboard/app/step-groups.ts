// Folds runs of near-identical tool calls into one step: six greps for the
// same names, one model response each, read as "searched 6 times". The rule
// is deliberately strict and deterministic -- consecutive calls of the same
// kind (search, read, edit, test) that share a target -- so a group never
// hides a step that did something different. Display only: the calls, their
// evidence and their attributions are unchanged underneath.
import { type CallVerification, type Trace } from './types';
import { reportedResult } from './trace-utils';

export type StepKind = 'search' | 'read' | 'edit' | 'test' | 'other';
export type Classified = { kind: StepKind; targets: string[]; display: string[]; wide: boolean };
export type StepGroup = { id: string; kind: StepKind; calls: CallVerification[]; first: number; display: string[]; wide: number };

/** The call's arguments as an object, read from its "Tool call" event. */
export function callArgs(trace: Trace, call: CallVerification): Record<string, unknown> | null {
  const event = trace.events.find((item) => item.title.startsWith('Tool call:') && item.exchange_id === call.exchange_id && item.output_index === call.output_index);
  if (!event) return null;
  try {
    const raw = JSON.parse(event.raw) as { arguments?: unknown; input?: unknown };
    let value: unknown = raw.arguments ?? raw.input ?? '';
    // Claude Code captures can carry the arguments JSON-encoded twice.
    for (let depth = 0; typeof value === 'string' && depth < 3; depth += 1) {
      try { value = JSON.parse(value); } catch { break; }
    }
    return value && typeof value === 'object' ? value as Record<string, unknown> : { command: String(value) };
  } catch { return null; }
}

/** Shell words, honouring single and double quotes. */
function shellWords(text: string): string[] {
  return [...text.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

const basename = (path: string) => path.replace(/[`'"),;]+$/, '').split('/').filter(Boolean).pop() ?? '';
const looksLikePath = (word: string) => /\/|\.[A-Za-z0-9]{1,8}$/.test(word) && !word.startsWith('-') && !/^\d/.test(word);

/** A regex or glob as plain search terms: "effects?Text|group_?States" -> effectstext, groupstates. */
function terms(pattern: string): { targets: string[]; display: string[] } {
  const parts = pattern.replace(/\[([^\]^])[^\]]*\]/g, '$1').split(/\\\||\||\s+/)
    .map((part) => part.replace(/\\[bBdDsSwW]|[\\^$.*+?()[\]{}]/g, '').replace(/^[-_]+|[-_]+$/g, ''))
    .filter((part) => part.length >= 3);
  return { targets: parts.map((part) => part.toLowerCase().replace(/[-_]/g, '')), display: parts };
}

const SEARCH = new Set(['grep', 'egrep', 'rg', 'ag', 'ack', 'find', 'fd']);
const READ = new Set(['cat', 'head', 'tail', 'less', 'nl', 'wc']);
const TESTS = /^(?:npm (?:test|run test\S*)|pnpm (?:test|run test\S*)|yarn test\S*|node(?: \S+)* --test|pytest|vitest|jest|go test|cargo test)/;

/** Each command of a shell line, with any pipeline cut to its first stage.
 * Quote-aware, so a pattern like "a\|b" is not split at its pipe. */
function commandsOf(line: string): string[] {
  const commands: string[] = [];
  let current = ''; let quote = ''; let piped = false;
  const flush = () => { if (current.trim()) commands.push(current.trim()); current = ''; piped = false; };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\\' && quote !== "'") { if (!piped) current += char + (line[index + 1] ?? ''); index += 1; continue; }
    if (quote) { if (char === quote) quote = ''; if (!piped) current += char; continue; }
    if (char === '"' || char === "'") { quote = char; if (!piped) current += char; continue; }
    const two = line.slice(index, index + 2);
    if (two === '&&' || two === '||') { flush(); index += 1; continue; }
    if (char === ';' || char === '\n') { flush(); continue; }
    if (char === '|') { piped = true; continue; }
    if (!piped) current += char;
  }
  flush();
  return commands;
}

/** The first real command in a shell line: past `cd x &&`, `timeout N`, `sudo`, env assignments. */
function mainCommand(command: string): string[] {
  for (const segment of commandsOf(command)) {
    const words = shellWords(segment);
    while (words.length && (/^(sudo|time|nice|env)$/.test(words[0]) || /^\w+=/.test(words[0]))) words.shift();
    if (words[0] === 'timeout') words.splice(0, words[1] && /^\d/.test(words[1]) ? 2 : 1);
    if (!words.length || words[0] === 'cd' || words[0] === 'echo') continue;
    return words;
  }
  return [];
}

export function classify(call: CallVerification, args: Record<string, unknown> | null): Classified {
  const none: Classified = { kind: 'other', targets: [], display: [], wide: false };
  const str = (key: string) => (typeof args?.[key] === 'string' ? args[key] as string : '');
  const isWide = (path: string) => /^(\/|~\/?|\$HOME\/?)$/.test(path.trim());
  if (call.name === 'Grep' || call.name === 'Glob') {
    const found = terms(call.name === 'Glob' ? basename(str('pattern')) || str('pattern') : str('pattern'));
    return found.targets.length ? { kind: 'search', ...found, wide: isWide(str('path')) } : none;
  }
  if (['Read', 'NotebookRead'].includes(call.name) || ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(call.name)) {
    const file = basename(str('file_path') || str('notebook_path'));
    if (!file) return none;
    return { kind: call.name.includes('Read') ? 'read' : 'edit', targets: [file.toLowerCase()], display: [file], wide: false };
  }
  const command = str('command') || str('cmd') || (call.name === 'Bash' ? call.proposed ?? '' : '');
  if (!command) return none;
  const words = mainCommand(command);
  const program = words[0]?.split('/').pop() ?? '';
  const line = words.join(' ');
  if (TESTS.test(line)) {
    const key = line.match(TESTS)![0].replace(/ --?\S+/g, '').trim();
    return { kind: 'test', targets: [key], display: [key], wide: false };
  }
  if (SEARCH.has(program) || (program === 'git' && words[1] === 'grep') || (program === 'ls' && words.some((word) => /^-\w*R/.test(word)))) {
    const rest = words.slice(program === 'git' ? 2 : 1);
    let pattern = '';
    const paths: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index];
      if (['-e', '--regexp', '-name', '-iname', '-path', '-g', '--glob'].includes(word)) { pattern ||= rest[index + 1] ?? ''; index += 1; continue; }
      if (word.startsWith('-')) continue;
      if (!pattern && program !== 'find' && program !== 'fd' && program !== 'ls') pattern = word;
      else paths.push(word);
    }
    if (program === 'ls') pattern = paths.join(' ');
    const found = terms(pattern);
    return found.targets.length ? { kind: 'search', ...found, wide: paths.some(isWide) } : none;
  }
  const edits = /\bsed\s+-i|(?:^|\s)(?:cat|echo|printf)\b[^|]*>\s*\S|\btee\b/.test(command);
  if (edits || READ.has(program) || (program === 'sed' && words.includes('-n'))) {
    const files = [...new Set(shellWords(command.split(/<<-?\s*['"]?\w+['"]?/)[0]).filter(looksLikePath).map(basename).filter(Boolean))];
    if (!files.length) return none;
    return { kind: edits ? 'edit' : 'read', targets: files.map((file) => file.toLowerCase()), display: files, wide: false };
  }
  return none;
}

/** Two targets match when one contains the other ("effects" and "effectstext"). */
const overlaps = (a: string[], b: string[]) => a.some((x) => b.some((y) => x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))));

/**
 * Every call in order, each in exactly one group; a group of one is an
 * ordinary step. A call joins the run before it when it is the same kind (not
 * "other"), shares a target with the run, and the previous call was not
 * refused by the agent's permission policy.
 */
export function groupSteps(trace: Trace, calls: CallVerification[]): StepGroup[] {
  const groups: (StepGroup & { targets: string[] })[] = [];
  calls.forEach((call, index) => {
    const info = classify(call, callArgs(trace, call));
    const current = groups.at(-1);
    const previous = current?.calls.at(-1);
    const joins = current && info.kind !== 'other' && current.kind === info.kind && overlaps(current.targets, info.targets)
      && previous && reportedResult(trace.events, previous.call_id).state !== 'rejected';
    if (joins) {
      current.calls.push(call);
      current.targets = [...new Set([...current.targets, ...info.targets])];
      for (const word of info.display) if (!current.display.some((shown) => shown.toLowerCase() === word.toLowerCase())) current.display.push(word);
      if (info.wide) current.wide += 1;
    } else {
      groups.push({ id: call.call_id, kind: info.kind, calls: [call], first: index + 1, targets: info.targets, display: [...info.display], wide: info.wide ? 1 : 0 });
    }
  });
  return groups.map(({ targets: _targets, ...group }) => group);
}

const VERB: Record<StepKind, string> = { search: 'Searched', read: 'Read', edit: 'Edited', test: 'Ran', other: 'Ran' };
const KIND_LABEL: Record<StepKind, string> = { search: 'search', read: 'read', edit: 'edit', test: 'test', other: 'step' };

/** "#1–6", "Searched 6 times for effectsText, groupStates, …", the last
 * attempt's outcome, and anything a reader should not miss while collapsed. */
export function groupSummary(group: StepGroup, trace: Trace) {
  const count = group.calls.length;
  const shown = group.display.slice(0, 3).join(', ') + (group.display.length > 3 ? ', …' : '');
  const label = group.kind === 'search' ? `${VERB.search} ${count} times for ${shown}`
    : group.kind === 'test' ? `${VERB.test} ${shown} ${count} times`
      : `${VERB[group.kind]} ${shown} ${count} times`;
  const results = group.calls.map((call) => reportedResult(trace.events, call.call_id));
  const last = results.at(-1)!;
  const lines = last.output.trim() ? last.output.trim().split('\n').length : 0;
  const outcome = last.state === 'failed' ? 'last: failed' : last.state === 'rejected' ? 'last: refused' : lines ? `last: ${lines} line${lines === 1 ? '' : 's'}` : 'last: no output';
  const failed = results.filter((result) => result.state === 'failed').length;
  const flags = [
    group.wide ? `${group.wide} searched the whole filesystem` : '',
    failed ? `${failed} failed` : '',
  ].filter(Boolean);
  // Earlier attempts that came back empty or failed explain why it kept going.
  const earlier = results.slice(0, -1);
  const fruitless = earlier.length > 0 && earlier.every((result) => result.state === 'failed' || result.state === 'rejected' || !result.output.trim());
  const repeated = count > 1 ? `Repeated ${count - 1} time${count === 2 ? '' : 's'}${fruitless ? ' because earlier attempts found nothing or failed' : ': each retry followed the previous attempt\u2019s result'}.` : null;
  return { range: count > 1 ? `#${group.first}–${group.first + count - 1}` : `#${group.first}`, kind: KIND_LABEL[group.kind], label, outcome, flags, repeated };
}
