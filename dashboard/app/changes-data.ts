// What one prompt changed, gathered from the snapshot taken after each of
// its tool calls: every file it touched, in which steps, and the snapshot
// range the whole-prompt diff (and patch) runs over. Pure data work, kept
// apart from the view so it can be tested like story-data.ts.
import type { CallVerification, Trace } from './types';

/** Git's empty tree: the "before" of a first snapshot, which has no parent. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type ChangedFile = {
  path: string;
  /** The last thing that happened to it (A added, M edited, D deleted, T type). */
  status: string;
  /** Lines added/removed summed over the steps that touched it; null = binary. */
  added: number | null;
  removed: number | null;
  /** 1-based tool-call numbers that changed it, in order. */
  calls: number[];
};

export type PromptChanges = {
  /** Files touched, in the order they were first touched. */
  files: ChangedFile[];
  /** Steps that changed at least one file, with their 1-based numbers. */
  steps: { call: CallVerification; number: number }[];
  /** The snapshot the prompt started from and the last one it took: the
   * whole-prompt diff runs base -> final. Null when no snapshot was taken. */
  base: string | null;
  final: string | null;
  /** Any snapshot was recorded for this prompt at all. */
  hasSnapshots: boolean;
  /** Files the snapshots could not keep (over 5 MB): their changes are invisible. */
  tooBig: string[];
  added: number;
  removed: number;
};

export function summarizeChanges(trace: Trace): PromptChanges {
  const calls = trace.callVerifications ?? [];
  const files = new Map<string, ChangedFile>();
  const steps: PromptChanges['steps'] = [];
  const snapshots = calls.flatMap((call) => (call.snapshot ? [call.snapshot] : []));
  const tooBig = new Set<string>();
  calls.forEach((call, index) => {
    const snapshot = call.snapshot;
    if (!snapshot) return;
    for (const path of snapshot.too_big ?? []) tooBig.add(path);
    if (snapshot.changed && snapshot.changes.length) steps.push({ call, number: index + 1 });
    for (const change of snapshot.changes) {
      const found = files.get(change.path) ?? { path: change.path, status: change.status, added: 0, removed: 0, calls: [] };
      found.status = change.status;
      if (change.added == null || found.added == null) { found.added = null; found.removed = null; }
      else { found.added += change.added; found.removed = (found.removed ?? 0) + (change.removed ?? 0); }
      if (!found.calls.includes(index + 1)) found.calls.push(index + 1);
      files.set(change.path, found);
    }
  });
  const list = [...files.values()];
  return {
    files: list,
    steps,
    base: snapshots.length ? (snapshots[0].parent ?? EMPTY_TREE) : null,
    final: snapshots.at(-1)?.commit ?? null,
    hasSnapshots: snapshots.length > 0,
    tooBig: [...tooBig],
    added: list.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: list.reduce((sum, file) => sum + (file.removed ?? 0), 0),
  };
}

/** A snapshot read's failure as a sentence a person can act on. The host's
 * raw failure names its own machinery (`subprocess.CalledProcessError:
 * Command '['docker', 'exec', …`); no reader of a diff can do anything with
 * that, so it becomes what it means. A message already in words is kept. */
export function readableDiffError(message: string): string {
  return /CalledProcessError|Command \[|docker|snapshot failed|exec:/i.test(message)
    ? 'The sandbox holding these snapshots could not be reached to read them. Check it under Sandboxes, then try again.'
    : message;
}

/** The download's name: which prompt's changes these are, at a glance. */
export const patchFilename = (trace: Trace, path?: string) =>
  `raytrace-${trace.id.slice(0, 8)}${path ? `-${path.split('/').at(-1)}` : ''}.patch`;
