// The initial scan of a sandbox's project (worker/gvisor/file_scan.py): each
// file's level from 1 to 5, what its owner set on it, the alerts raised when
// the agent changed one they watch, and what the sandbox's kernel layer saw
// the agent do (worker/gvisor/engine.py): files, connections, packages.
import { useEffect, useState } from 'react';
import { api } from './api';

export type FileScore = {
  path: string;
  /** 1 to 5: the owner's level when they set one, else the scan's. */
  level: number;
  scanned_level: number;
  edited: boolean;
  /** Imported by this many of the project's source files, directly or through others.
   * scan-v2 adds direct importers, a distance-decayed weighted score, and its percentile in this project. */
  reach: { level: number; dependents: number; of: number; direct?: number; score?: number; percentile?: number; entry?: boolean } | null;
  /** What kind of file it is, or what it does. */
  hazard: { level: number; rule: string; does?: string[] } | null;
  flags: string[];
  reasons: string[];
  /** A change to it is reported: the owner's choice, else on from level 4. */
  notify: boolean;
  notify_set: boolean;
  /** The agent may not change it. */
  restricted: boolean;
};

export type ScanSummary = { version: string; files: number; by_level: Record<string, number>; edges: number; scanned_ms: number } | { error: string };
/** How the sandbox enforces its restricted files: `read_only` are locked for every tool. */
export type Guardrails = { restricted: number; hook: boolean; read_only: string[] };
export type Scan = { id: string; name: string | null; scan: ScanSummary | null; guardrails: Guardrails | null; files: FileScore[] };

export type FileAlert = {
  id: string;
  sandbox: string;
  /** The project's name. */
  name: string | null;
  path: string;
  /** What the agent did to the file: changed it, or tried to (blocked, read, named in a command).
   * `network_refused` is a connection the sandbox's firewall refuses; its `path` is the destination. */
  kind: 'watched_changed' | 'restricted_changed' | 'new_sensitive' | 'restricted_blocked' | 'restricted_read' | 'restricted_named' | 'watched_read' | 'network_refused';
  /** Who saw it. `hook`: the sandbox's Claude Code hook, so the agent's own
   * tool said so. `kernel`: the sandbox host, whatever program did it. */
  source: 'hook' | 'kernel';
  /** The tool it used, when the hook saw the attempt; the program, when the kernel did. */
  tool: string | null;
  /** Seconds since the epoch, when the hook saw it (the sandbox's clock); null for older alerts. */
  at: number | null;
  level: number;
  status: string | null;
  added: number | null;
  removed: number | null;
  call_id: string | null;
  commit: string | null;
  /** Seconds since the epoch. */
  created: number;
  seen: boolean;
};

export const LEVEL_WORDS = ['', 'Minimal', 'Low', 'Moderate', 'High', 'Critical'];
/** What each level asks of its owner, shown where files are classified. */
export const LEVEL_ACTIONS = ['', 'Ignore', 'Routine', 'Watch', 'Review carefully', 'Lock down'];
const CHANGE = { 'content-type': 'application/json', 'x-raytace-experiment': '1' };

async function answer<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
}

export const loadScan = async (sandbox: string) =>
  answer<Scan>(await api().fetch(`/raytace/sandboxes/${sandbox}/files`, { cache: 'no-store' }), 'The initial scan could not be loaded.');

export type FileUpdate = { path: string; level?: number | null; notify?: boolean | null; restricted?: boolean };
export const saveFiles = async (sandbox: string, updates: FileUpdate[]) =>
  answer<{ guardrails: Guardrails | null; files: FileScore[] }>(await api().fetch(`/raytace/sandboxes/${sandbox}/files`,
    { method: 'POST', headers: CHANGE, body: JSON.stringify({ updates }) }), 'That change could not be saved.');

/** What a fact rests on. `confirmed`: a call was seen and the file shows its
 * effect. `attempted`: the kernel refused the call. `possible`: opened for
 * writing, and the file is as it was. `one_of`: several processes made such a
 * call at that moment. `unattributed`: the file changed and no call was seen. */
export type Certainty = 'confirmed' | 'attempted' | 'possible' | 'one_of' | 'unattributed';
type Photo = { size: number; mtime_ns: number; inode: number; mode: number; sha256: string | null };
/** One thing the kernel layer saw, counted when the same step did it again. */
type Fact = {
  id: string;
  /** Seconds since the epoch, when it last happened. */
  at: number;
  count: number;
  first_ns: string;
  pid: number | null;
  process_start_ns: string | null;
  /** The program's name, and its command line cut short. */
  process: string | null;
  command: string | null;
  /** The tool call the program ran for, when it carried one. */
  call_id: string | null;
  /** Events were lost about then: this may not be all of it. */
  coverage?: 'gaps';
};
export type FileFact = Fact & {
  /** Null when the kernel refused a call whose file gVisor does not report. */
  path: string | null;
  guard: 'restricted' | 'watched' | 'sensitive' | null;
  effect: 'read' | 'created' | 'changed' | 'emptied' | 'appended' | 'deleted' | 'renamed' | 'permissions_changed' | 'attempted' | 'opened_for_writing';
  certainty: Certainty;
  /** What a refused call was trying to do. */
  intent?: 'read' | 'write' | 'delete' | 'rename' | 'permissions';
  to?: string;
  basis?: { syscall?: string | null; errno?: string; path_from?: 'argv' | 'argv_folder' | 'argv_text'; watcher?: string[];
    before?: Photo | null; after?: Photo | null; note?: string; candidates?: { pid: number; process: string | null }[] };
};
export type NetworkFact = Fact & {
  ip: string; port: number;
  /** Every address of that name the step connected to; `ip` is one that answered, when one did. */
  addresses?: string[];
  /** The name whose lookup answered with this address: a best match. */
  host: string | null;
  effect: 'connect' | 'listen';
  /** How many times each way: connected, attempted, refused_by_policy, failed, listening. */
  outcomes: Record<string, number>;
  errno?: string;
};
export type LookupFact = Fact & { name: string; addresses: string[]; failed?: string };
export type PackageFact = Fact & {
  manager: string; total: number;
  packages: { name: string; version: string; source?: string }[];
  /** `corroborated`: a package registry was reached about then. `reported`: the manager's records alone. */
  certainty: 'corroborated' | 'reported';
};
export type IdentityFact = Fact & { effect: 'changed' | 'attempted'; ids: number[]; basis?: { syscall?: string; errno?: string } };
/** A step that opened files in bulk: how many, and under which folders. */
export type BulkFact = Fact & { opens: number; folders: Record<string, number> };
export type Activity = { id: string; name: string | null; files: FileFact[]; network: NetworkFact[]; lookups: LookupFact[];
  packages: PackageFact[]; identity: IdentityFact[]; bulk: BulkFact[];
  /** The lists that were cut short. */
  more: string[] };

/** What the kernel layer saw a sandbox do; `since`/`until` (ms) scope it to one prompt. */
export const loadActivity = async (sandbox: string, since?: number, until?: number, signal?: AbortSignal) =>
  answer<Activity>(await api().fetch(`/raytace/sandboxes/${sandbox}/activity${since || until ? `?${since ? `since=${Math.floor(since)}` : ''}${since && until ? '&' : ''}${until ? `until=${Math.ceil(until)}` : ''}` : ''}`,
    { cache: 'no-store', signal }), 'Sandbox activity could not be loaded.');

export const loadAlerts = async (sandbox?: string) =>
  answer<{ alerts: FileAlert[]; unseen: number }>(await api().fetch(`/raytace/alerts${sandbox ? `?sandbox=${sandbox}` : ''}`, { cache: 'no-store' }), 'Alerts could not be loaded.');

/** Whether the owner is emailed about alerts. Null where there is no account to ask: the local dashboard. */
export async function loadNotify(): Promise<boolean | null> {
  try {
    const response = await api().fetch('/raytace/me', { cache: 'no-store' });
    if (!response.ok) return null;
    const me = await response.json() as { notify_email?: boolean };
    return typeof me.notify_email === 'boolean' ? me.notify_email : null;
  } catch { return null; }
}

export const saveNotify = async (email: boolean) =>
  answer<{ notify_email: boolean }>(await api().fetch('/raytace/me',
    { method: 'POST', headers: CHANGE, body: JSON.stringify({ notify_email: email }) }), 'That setting could not be saved.');

export const markSeen = async (ids: string[]) =>
  answer<{ unseen: number }>(await api().fetch('/raytace/alerts/seen', { method: 'POST', headers: CHANGE, body: JSON.stringify({ ids }) }), 'Alerts could not be marked seen.');

// One read per sandbox for every list of changed files on the page.
const levels = new Map<string, Promise<Map<string, FileScore>>>();

/** Each scanned file of a sandbox by path, for marking a changed file with its
 * level; empty until loaded, and where there is no scan. */
export function useFileLevels(sandbox: string | undefined) {
  const [files, setFiles] = useState<Map<string, FileScore>>(new Map());
  useEffect(() => {
    if (!sandbox) return;
    let closed = false;
    if (!levels.has(sandbox)) {
      levels.set(sandbox, loadScan(sandbox).then((scan) => new Map(scan.files.map((file) => [file.path, file])), () => { levels.delete(sandbox); return new Map(); }));
    }
    void levels.get(sandbox)!.then((found) => { if (!closed) setFiles(found); });
    return () => { closed = true; };
  }, [sandbox]);
  return files;
}
/** After the owner changes a file here, lists elsewhere read it again. */
export const forgetFileLevels = (sandbox: string) => { levels.delete(sandbox); };
