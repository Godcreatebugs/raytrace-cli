// The two labels each tool call carries in Tool calls: its category (what
// kind of step it was) and its sandbox label (what independent evidence there
// is for it). What each one means is written once, on the website's "Reading
// a trace" page, which the column headers link to.
import { type CallCategory, type CallVerification, type Trace } from './types';
import { type Reported } from './trace-utils';

export const READING_A_TRACE = 'https://raytracer.si/reading-a-trace.html';

export const CATEGORY_LABEL: Record<CallCategory, string> = {
  read: 'Read', search: 'Search', write: 'Write', edit: 'Edit', delete: 'Delete / move', run: 'Run', test: 'Test',
  build: 'Build / install', git: 'Git', web: 'Web', plan: 'Plan', delegate: 'Delegate', unsure: 'Not sure',
};

export type SandboxLabel = {
  id: 'ran' | 'differs' | 'rejected' | 'not_seen' | 'file_changed' | 'no_change' | 'in_agent' | 'not_covered';
  text: string;
  tone: 'ok' | 'warn' | 'fail' | 'none';
  /** Where the label's evidence is: the process in Sandbox evidence, or the call's Files changed. */
  opens?: 'sandbox' | 'files';
};

const LABELS: Record<SandboxLabel['id'], SandboxLabel> = {
  ran: { id: 'ran', text: '✓ ran', tone: 'ok', opens: 'sandbox' },
  differs: { id: 'differs', text: '⚠ ran, differs', tone: 'warn', opens: 'sandbox' },
  rejected: { id: 'rejected', text: '✗ rejected', tone: 'fail' },
  not_seen: { id: 'not_seen', text: '— not seen', tone: 'none' },
  file_changed: { id: 'file_changed', text: '✓ file changed', tone: 'ok', opens: 'files' },
  no_change: { id: 'no_change', text: '✗ no change', tone: 'fail', opens: 'files' },
  in_agent: { id: 'in_agent', text: 'in agent', tone: 'none' },
  not_covered: { id: 'not_covered', text: 'not covered', tone: 'none' },
};

/** Tools that change files from inside the agent, starting no program. */
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
/** The folder the sandbox snapshots after each call (the hook's RAYTRACE_WORKSPACE). */
const WORKSPACE = '/workspace';

/** Whether anything watched this run: a RayTrace sandbox, or a process seen for any of its calls. */
export function sandboxCaptured(trace: Trace): boolean {
  return Boolean(trace.sandboxId) || (trace.callVerifications ?? []).some((call) => call.exec_id);
}

/**
 * The Sandbox column's label for one call. Every branch compares recorded
 * facts (a process, an exit code, a snapshot of the project folder); none is
 * a model's reading.
 *
 * A write is confirmed by the snapshot taken after it, not by a process.
 * Calls made in one round trip can run at once and be snapshotted one after
 * another, so a file counts as changed when any snapshot of that round trip
 * lists it. `path` is the file the call named, when its arguments name one.
 */
export function sandboxLabel(trace: Trace, call: CallVerification, reported: Reported, path: string | null): SandboxLabel {
  if (call.exec_id) return call.reported_check && call.reported_check !== 'agrees' ? LABELS.differs : LABELS.ran;
  if (reported.state === 'rejected') return LABELS.rejected;
  const captured = sandboxCaptured(trace);
  if (call.kind !== 'file' && call.kind !== 'agent') return captured ? LABELS.not_seen : LABELS.not_covered;
  if (!WRITERS.has(call.name)) return LABELS.in_agent;
  if (!captured || !call.snapshot) return LABELS.not_covered;
  if (path === null) return call.snapshot.changed ? LABELS.file_changed : reported.state === 'ok' ? LABELS.no_change : LABELS.in_agent;
  if (path.startsWith('/') && path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`)) return LABELS.not_covered;
  const relative = path.startsWith(`${WORKSPACE}/`) ? path.slice(WORKSPACE.length + 1) : path.replace(/^\.\//, '');
  const same = (other: string) => other === relative || other.endsWith(`/${relative}`);
  const together = (trace.callVerifications ?? []).filter((other) => other.exchange_id === call.exchange_id && other.snapshot);
  if (together.some((other) => other.snapshot!.changes.some((change) => same(change.path)))) return LABELS.file_changed;
  if (together.some((other) => other.snapshot!.too_big.some(same))) return LABELS.not_covered;
  return reported.state === 'ok' ? LABELS.no_change : LABELS.in_agent;
}
