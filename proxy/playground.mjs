/**
 * Playground forks: rerun a sandboxed Claude Code session from one step, with
 * that step's context or files changed, and compare where it ends up.
 *
 * A fork is its own sandbox (worker/sandbox/projects.py fork-*), so every path
 * in the session means what it meant originally and the project's real
 * workspace is out of reach. It starts from the snapshot the project folder
 * was at just before the forked step (workspace_snapshots), resumes Claude
 * Code from the session cut at that step (forkTranscript), and is compared
 * file by file with the original run's final snapshot. With a check command
 * (`npm test`, a script), that command then runs where the fork left the
 * project, and its exit code is the fork's pass or fail.
 *
 * Models do not answer the same way twice, so one change can be run several
 * times: a batch is that many forks sharing a `group`, queued and run one
 * after another (one fork runs at a time), each from the same snapshot.
 * A changed batch can bring a baseline: the same step run unchanged as many
 * times, with the same check, interleaved with it so both see the same
 * conditions. An unchanged batch already run that often is reused instead.
 *
 * Lifecycle: queued -> create -> run -> collect -> check (the fork's snapshot history moves into
 * the project's own, so its files outlive it) -> stop. The newest fork is
 * kept, stopped, for a day to look around in; any older one is deleted
 * unless kept on purpose. Fork records are lab_experiments rows (kind fork).
 */
import { spawn } from 'node:child_process';
import { limactl, VM } from './local-sandboxes.mjs';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { forkTranscript } from './claude-code-adapter.mjs';

export const FORK_ID = /^rtf-[a-f0-9]{32}$/;
const PROJECT_ID = /^rtp-[a-f0-9]{32}$/;
// What the resumed session is asked: `claude -p` needs a prompt, so the
// forked step is one short user message away from the original request.
export const RESUME_PROMPT = 'Continue the task from where you left off.';
const KEEP_LATEST_MS = 24 * 3_600_000;
const DEFAULT_MINUTES = 10;
// The check has a limit of its own, apart from Claude Code's: a test suite
// that hangs is a failed check, not a fork stuck forever.
const CHECK_SECONDS = 10 * 60;
export const MAX_REPEAT = 10;
const MAX_EVENTS = 400;

/** The command that runs one projects.py action in the local sandbox VM. */
export function workerCommand(action, id) {
  const args = [action, ...(id ? [id] : [])];
  return [limactl(), ['shell', '--workdir', '/', VM, 'sudo', 'python3', '/opt/raytace/projects.py', ...args]];
}

/** Runs one projects.py action in the VM with a JSON stdin; resolves with its
 * exit code and output. `onLine` sees stdout line by line as it arrives. */
export function vmAction(action, id, input, { onLine = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(...workerCommand(action, id), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let pending = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (!onLine) { stdout += text; return; }
      pending += text;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (line.trim()) onLine(line);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => { if (onLine && pending.trim()) onLine(pending); resolve({ code, stdout, stderr }); });
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    child.stdin.on('error', () => {});
    child.stdin.end(input == null ? '' : JSON.stringify(input));
  });
}

async function vmJson(action, id, input) {
  const { code, stdout, stderr } = await vmAction(action, id, input);
  if (code !== 0) throw new Error(`${action} failed: ${(stderr.trim().split('\n').at(-1) || `exit ${code}`).slice(0, 300)}`);
  return JSON.parse(stdout.trim().split('\n').at(-1) || '{}');
}

/** The snapshot the project folder was at just before a step: after the last
 * call proposed before it, or when its prompt was sent. Snapshots after a
 * later call never qualify, whatever their time.
 *
 * With neither (a session whose prompt snapshot never arrived), the first
 * snapshot after the step still knows the state just before its own call:
 * its commit when that call changed nothing, else its parent. Only used when
 * that first snapshot belongs to this step or later, so nothing that ran
 * before the step is skipped. */
export function snapshotBefore(snapshots, { priorCalls, startedAt }) {
  const prior = new Set(priorCalls);
  const started = Date.parse(startedAt ?? '');
  const eligible = snapshots.filter((snap) => (snap.call_id && prior.has(snap.call_id))
    || (snap.taken_on === 'prompt' && Number.isFinite(started) && snap.taken_at_ms <= started + 5_000));
  if (eligible.length) return eligible.at(-1);
  const first = snapshots[0];
  if (!first || (first.call_id && prior.has(first.call_id))) return null;
  const commit = first.changed ? first.parent : first.commit;
  return commit ? { ...first, commit, taken_on: 'before-first-call' } : null;
}

/** Claude Code's stream-json events -> the progress a fork shows while running. */
export function applyRunEvent(job, event) {
  if (event?.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block?.type === 'tool_use') {
        job.progress.tool_calls += 1;
        const input = block.input ?? {};
        job.events.push({ at: new Date().toISOString(), kind: 'tool', name: block.name,
          detail: String(input.command ?? input.file_path ?? input.pattern ?? input.url ?? JSON.stringify(input)).slice(0, 300) });
      } else if (block?.type === 'text' && block.text?.trim()) {
        job.events.push({ at: new Date().toISOString(), kind: 'text', detail: block.text.trim().slice(0, 600) });
      }
    }
  } else if (event?.type === 'result') {
    job.result = { text: String(event.result ?? '').slice(0, 20_000), is_error: event.is_error === true, turns: event.num_turns ?? null,
      cost_usd: event.total_cost_usd ?? null, duration_ms: event.duration_ms ?? null };
  }
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
}

/** `db` keeps the fork records and reads the snapshots. The hosted evidence
 * service runs one Playground per organisation over a shared sandbox host,
 * and passes what that needs: `records` (the organisation's forks, already
 * loaded), `ownsSandbox` (which sandboxes' sessions it may fork), `exclusive`
 * (runs one fork at a time across every Playground on the host), tighter
 * `maxRepeat` and `maxMinutes`, and `orphans: false` (other organisations'
 * forks on the host are not this one's to report). */
export function startPlayground({ db, transcriptsDir, hookSource, log = console.log, records = null, ownsSandbox = null, exclusive = null,
  maxRepeat = MAX_REPEAT, maxMinutes = 30, orphans = true }) {
  const forks = new Map((records ?? db.loadExperiments(500)).filter((job) => job.kind === 'fork').map((job) => [job.id, job]));
  const controllers = new Map();
  // Forks of a batch waiting their turn, with what they are run from. Only
  // in memory: a restart interrupts them (recover), like a running one.
  const queue = [];
  const save = (job) => { job.updated_at = new Date().toISOString(); db.saveExperiment(job); };

  /** Which sandboxed session a recorded step belongs to, cut at that step. */
  async function locate(exchangeId, results) {
    for (const sandbox of (await readdir(transcriptsDir).catch(() => [])).filter((name) => PROJECT_ID.test(name))) {
      if (ownsSandbox && !(await ownsSandbox(sandbox))) continue;
      for (const file of (await readdir(join(transcriptsDir, sandbox))).filter((name) => name.endsWith('.jsonl'))) {
        const cut = forkTranscript(await readFile(join(transcriptsDir, sandbox, file), 'utf8'), { spanId: exchangeId, results });
        if (cut) return { sandbox, ...cut };
      }
    }
    return null;
  }

  /** What forking a step involves, before running anything: whether it can
   * be forked (and why not), the tool results the model had seen by then
   * (what can be edited), the model, and the snapshot it would start from. */
  async function preview(exchangeId) {
    const found = await locate(exchangeId, {});
    if (!found) return { forkable: false, reason: 'Only steps of a Claude Code session run in the sandbox can be forked.' };
    const snapshots = await db.snapshotsForAgentSession({ sessionId: found.sandbox, agentSessionId: found.session });
    const start = snapshotBefore(snapshots, found);
    const calls = new Map();
    for (const line of found.text.split('\n')) {
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      if (entry.isSidechain) continue;
      for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
        if (entry.type === 'assistant' && block?.type === 'tool_use') {
          const input = block.input ?? {};
          calls.set(block.id, { call_id: block.id, name: block.name, detail: String(input.command ?? input.file_path ?? input.pattern ?? input.url ?? JSON.stringify(input)).slice(0, 400), output: null });
        } else if (entry.type === 'user' && block?.type === 'tool_result' && calls.has(block.tool_use_id)) {
          const content = block.content;
          calls.get(block.tool_use_id).output = typeof content === 'string' ? content
            : Array.isArray(content) ? content.map((part) => (part?.type === 'text' ? part.text : part?.type === 'image' ? '[image]' : '')).join('\n') : '';
        }
      }
    }
    const LIMIT = 100_000;
    return { forkable: Boolean(start), reason: start ? null : 'This run was recorded before snapshots existed, so the project cannot be put back as it was.',
      sandbox: found.sandbox, session: found.session, model: found.model, start_snapshot: start?.commit ?? null,
      original_final: snapshots.at(-1)?.commit ?? null, resume_prompt: RESUME_PROMPT,
      results: [...calls.values()].filter((call) => call.output != null).map((call) => ({ ...call,
        chars: call.output.length, truncated: call.output.length > LIMIT, output: call.output.slice(0, LIMIT) })) };
  }

  /** Read-only snapshot views (projects.py snapshot): list | show | diff. */
  function snapshot(project, request) {
    if (!PROJECT_ID.test(project)) return Promise.reject(new Error('Invalid project sandbox.'));
    return vmJson('snapshot', project, request);
  }

  async function create(config) {
    const results = config.results && typeof config.results === 'object' ? config.results : {};
    const files = config.files && typeof config.files === 'object' ? config.files : {};
    const workspacePath = (path) => typeof path === 'string' && path && !path.startsWith('/') && !path.split('/').includes('..') && path.length <= 1024;
    for (const [path, text] of Object.entries(files)) {
      if (typeof text !== 'string' || !workspacePath(path)) throw new Error(`Invalid file edit: ${path}`);
    }
    // Excluded files are taken out of the fork's project (their earlier
    // outputs arrive as `results` edits); a message replaces the neutral
    // resume prompt as what the model is told at the forked step.
    const exclude = Array.isArray(config.exclude) ? config.exclude : [];
    if (exclude.length > 200 || !exclude.every(workspacePath)) throw new Error('Invalid excluded file.');
    const message = typeof config.message === 'string' ? config.message.trim() : '';
    if (message.length > 4000) throw new Error('The message must be under 4000 characters.');
    const command = typeof config.check === 'string' ? config.check.trim() : '';
    if (command.length > 2000) throw new Error('The check command must be under 2000 characters.');
    if (controllers.size || queue.length) throw new Error('A fork is already running. Wait for it or delete it first.');
    const repeat = Math.min(maxRepeat, Math.max(1, Math.trunc(Number(config.repeat)) || 1));
    const found = await locate(config.exchange_id, results);
    if (!found) throw new Error('That step is not from a sandboxed Claude Code session, so it cannot be forked.');
    if (found.missing.length) throw new Error(`No result to edit for call(s) before this step: ${found.missing.join(', ')}`);
    const snapshots = await db.snapshotsForAgentSession({ sessionId: found.sandbox, agentSessionId: found.session });
    const start = snapshotBefore(snapshots, found);
    if (!start) throw new Error('No snapshot of the project before this step: the run was recorded before snapshots existed.');
    const minutes = Math.min(maxMinutes, Math.max(1, Number(config.minutes) || DEFAULT_MINUTES));
    const model = typeof config.model === 'string' && config.model ? config.model : found.model;
    const unchanged = !Object.keys(results).length && !Object.keys(files).length && !exclude.length && !message && model === found.model;
    const created_at = new Date().toISOString();
    const batch = ({ transcript, prompt, edits, model: batchModel, unchanged: isUnchanged, baseline = null }) => {
      const group = `rtg-${randomBytes(16).toString('hex')}`;
      return Array.from({ length: repeat }, (_, index) => ({ id: `rtf-${randomBytes(16).toString('hex')}`, kind: 'fork',
        status: 'queued', created_at, group, attempt: index + 1, attempts: repeat, unchanged: isUnchanged, baseline, exchange_id: config.exchange_id,
        parent: found.sandbox, session: found.session, model: batchModel, prompt: prompt || RESUME_PROMPT, message: prompt || null, minutes,
        start_snapshot: start.commit, original_final: snapshots.at(-1)?.commit ?? start.commit, edits, keep: false,
        progress: { tool_calls: 0 }, events: [], result: null, comparison: null, error: null,
        check: command ? { command, status: 'pending', exit_code: null, output: '', duration_ms: null } : null, _input: { transcript } }));
    };
    let base = [];
    let baseline = null;
    if (config.baseline === true && !unchanged) {
      baseline = reusableBaseline({ exchangeId: config.exchange_id, model: found.model, command, runs: repeat });
      if (!baseline) {
        // The unchanged transcript: no tool result edited.
        const plain = await locate(config.exchange_id, {});
        base = batch({ transcript: plain.text, prompt: '', edits: { results: [], files: [], excluded: [] }, model: found.model, unchanged: true });
        baseline = base[0].group;
      }
    }
    const jobs = batch({ transcript: found.text, prompt: message, edits: { results: Object.keys(results), files: Object.keys(files), excluded: exclude },
      model, unchanged, baseline });
    // Change and baseline alternate, so neither gets all the early (or late) runs.
    for (const [index, job] of jobs.entries()) for (const item of [job, base[index]].filter(Boolean)) {
      const { _input, ...record } = item;
      forks.set(record.id, record); save(record);
      queue.push({ job: record, input: { ..._input, files: record.unchanged ? {} : files, exclude: record.unchanged ? [] : exclude } });
    }
    next();
    return forks.get(jobs[0].id);
  }

  /** An unchanged batch from this step, with this model and check, that
   * already has at least `runs` finished runs: a baseline to compare with. */
  function reusableBaseline({ exchangeId, model, command, runs }) {
    const groups = new Map();
    for (const job of forks.values()) {
      if (!job.unchanged || !job.group || job.exchange_id !== exchangeId || job.model !== model || (job.check?.command ?? '') !== command) continue;
      if (['completed', 'failed'].includes(job.status)) groups.set(job.group, (groups.get(job.group) ?? 0) + 1);
    }
    let best = null;
    for (const [group, count] of groups) if (count >= runs && (!best || count > best.count)) best = { group, count };
    return best?.group ?? null;
  }

  /** Starts the next queued fork, once none is running. */
  function next() {
    if (controllers.size || !queue.length) return;
    const { job, input } = queue.shift();
    job.status = 'creating'; save(job);
    const controller = new AbortController();
    controllers.set(job.id, controller);
    // On a shared host the fork waits its turn; one deleted meanwhile never starts.
    const start = () => (controller.signal.aborted ? undefined : run(job, input, controller));
    void Promise.resolve(exclusive ? exclusive(start) : start()).catch(() => {}).finally(() => { controllers.delete(job.id); next(); });
  }

  async function run(job, { transcript, files, exclude }, controller) {
    const deadline = setTimeout(() => { job.timed_out = true; controller.abort(); }, job.minutes * 60_000);
    try {
      await vmJson('fork-create', job.id, { parent: job.parent, commit: job.start_snapshot, session: job.session, transcript, files, delete: exclude, hook: hookSource() });
      job.status = 'running'; save(job);
      log(`[raytace][playground] ${job.id.slice(0, 12)} forked ${job.parent.slice(0, 12)} at snapshot ${job.start_snapshot.slice(0, 8)}; running ${job.model}`);
      let lastSave = 0;
      const { code, stderr } = await vmAction('fork-run', job.id, { session: job.session, model: job.model, prompt: job.prompt }, {
        signal: controller.signal,
        onLine: (line) => {
          try { applyRunEvent(job, JSON.parse(line)); } catch { return; }
          if (Date.now() - lastSave > 1500) { lastSave = Date.now(); save(job); }
        },
      });
      clearTimeout(deadline);
      if (code !== 0 && !job.result) job.error = job.timed_out ? `Stopped after ${job.minutes} minutes.` : (stderr.trim().split('\n').at(-1) || `Claude Code exited with ${code}`).slice(0, 300);
      job.status = 'collecting'; save(job);
      // The Stop hook's last transcript send runs as Claude Code exits.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const collected = await vmJson('fork-collect', job.id, { original: job.original_final });
      job.comparison = { original: job.original_final, fork: collected.final, changes: collected.changes ?? [],
        same_files: collected.final ? (collected.changes ?? []).length === 0 : null };
      // Checked even when Claude Code failed or ran out of time: what it left
      // behind is still what gets graded.
      if (job.check && !(controller.signal.aborted && !job.timed_out)) {
        // Claude Code's time limit aborted the run's controller; the check
        // gets a fresh one, which deleting the fork still stops.
        if (controller.signal.aborted) { controller = new AbortController(); controllers.set(job.id, controller); }
        await check(job, controller);
      }
      job.status = job.error ? 'failed' : 'completed';
    } catch (error) {
      job.status = 'failed'; job.error = String(error.message ?? error).slice(0, 400);
    } finally {
      clearTimeout(deadline);
      // Never reached the check: the fork could not start, or was deleted.
      if (job.check?.status === 'pending') job.check.status = 'skipped';
      save(job);
      await vmJson('fork-stop', job.id, null).catch(() => {});
      await retire(job.id);
      log(`[raytace][playground] ${job.id.slice(0, 12)} ${job.status}${job.comparison ? `, ${job.comparison.changes.length} file(s) differ from the original` : ''}${job.check ? `, check ${job.check.status}` : ''}${job.error ? `: ${job.error}` : ''}`);
    }
  }

  /** Runs the fork's check command in its sandbox; exit 0 passes. */
  async function check(job, controller) {
    job.status = 'checking'; job.check.status = 'running'; save(job);
    const started = Date.now();
    try {
      const { code, stdout, stderr } = await vmAction('fork-check', job.id, { command: job.check.command, seconds: CHECK_SECONDS }, { signal: controller.signal });
      if (code !== 0) throw new Error((stderr.trim().split('\n').at(-1) || `exit ${code}`).slice(0, 300));
      const outcome = JSON.parse(stdout.trim().split('\n').at(-1) || '{}');
      Object.assign(job.check, { exit_code: outcome.exit_code, output: outcome.output ?? '',
        status: outcome.timed_out ? 'timed_out' : outcome.exit_code === 0 ? 'passed' : 'failed' });
    } catch (error) {
      // The check could not run at all: neither a pass nor a fail.
      Object.assign(job.check, { status: 'error', output: String(error.message ?? error).slice(0, 400) });
    } finally {
      job.check.duration_ms = Date.now() - started;
    }
  }

  async function remove(id) {
    const job = forks.get(id);
    if (!job || !FORK_ID.test(id)) throw new Error('Fork not found.');
    const waiting = queue.findIndex((item) => item.job.id === id);
    if (waiting !== -1) {
      // Never started: there is no sandbox to delete.
      queue.splice(waiting, 1);
      job.status = 'cancelled'; job.deleted_at = new Date().toISOString();
      if (job.check) job.check.status = 'skipped';
      save(job); return job;
    }
    controllers.get(id)?.abort();
    await vmJson('fork-delete', id, null).catch((error) => { if (!/No such|not found|Invalid sandbox/i.test(error.message)) throw error; });
    job.deleted_at = new Date().toISOString(); save(job);
    return job;
  }

  /** Stops a whole batch and a baseline started with it: the queued forks
   * are cancelled, the running one deleted. */
  async function stopGroup(id) {
    const fork = forks.get(id);
    if (!fork?.group) return remove(id);
    // With its baseline, or the change a baseline was started with: stopping
    // one half leaves nothing to compare the other with.
    const groups = new Set([fork.group, fork.baseline].filter(Boolean));
    for (const job of forks.values()) if (job.baseline === fork.group && (queue.some((entry) => entry.job === job) || controllers.has(job.id))) groups.add(job.group);
    for (const item of queue.filter((entry) => groups.has(entry.job.group))) await remove(item.job.id);
    for (const job of forks.values()) if (groups.has(job.group) && controllers.has(job.id)) await remove(job.id);
    return forks.get(id);
  }

  /** Keeps the newest fork (and any kept on purpose); deletes the rest, and
   * the newest too once it is a day old. */
  async function retire(newest = null) {
    const now = Date.now();
    for (const job of forks.values()) {
      if (job.deleted_at || job.keep || job.status === 'queued' || controllers.has(job.id)) continue;
      const stale = job.id !== newest && (newest || now - Date.parse(job.created_at) > KEEP_LATEST_MS);
      if (stale) await remove(job.id).catch((error) => log(`[raytace][playground] could not delete ${job.id.slice(0, 12)}: ${error.message}`));
    }
  }

  /** After a restart: a fork that was mid-run cannot be followed any more. */
  async function recover() {
    for (const job of forks.values()) {
      if (['queued', 'creating', 'running', 'collecting', 'checking'].includes(job.status) && !controllers.has(job.id)) {
        if (job.status === 'queued') job.deleted_at = new Date().toISOString(); // never had a sandbox
        job.error = job.status === 'queued' ? 'RayTrace restarted before this run started.' : 'RayTrace restarted while this fork was running.';
        job.status = 'interrupted';
        if (job.check && ['pending', 'running'].includes(job.check.status)) job.check.status = 'error';
        save(job);
      }
    }
    // Fork sandboxes this database has no record of: reported, never deleted,
    // since another RayTrace (a test run, another checkout) may own them.
    const { code, stdout } = orphans ? await vmAction('list', null, null).catch(() => ({ code: 1 })) : { code: 1 };
    if (code === 0) {
      for (const box of JSON.parse(stdout || '[]')) {
        if (FORK_ID.test(box.id) && !forks.has(box.id)) {
          log(`[raytace][playground] fork sandbox ${box.id} is not in this RayTrace's records; delete it with: `
            + workerCommand('fork-delete', box.id).flat().join(' '));
        }
      }
    }
    await retire();
  }

  return {
    create, remove, stopGroup, recover, preview, snapshot,
    get: (id) => forks.get(id) ?? null,
    list: () => [...forks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || (a.attempt ?? 1) - (b.attempt ?? 1)).slice(0, 100),
    keep(id, value = true) {
      const job = forks.get(id); if (!job) throw new Error('Fork not found.');
      job.keep = value === true; save(job); return job;
    },
    /** The fork a sandboxed hook says it is, if it really forks that project. */
    forkOf(forkId, parent) { const job = forks.get(forkId); return job && job.parent === parent && !job.deleted_at ? job : null; },
  };
}
