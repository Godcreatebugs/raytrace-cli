// `raytrace report <trace-id> [--pr <n>]`: a short pull-request comment for one
// recorded prompt: the commands it ran with their exit codes, the files it
// changed, what failed and what it cost, and (with --link, for a cloud
// sandbox) a share link. Only command text and file paths go in, never tool
// output, and the text is scanned for secrets before it leaves this machine.
//
// The trace comes from this machine's evidence database, as `raytrace export`
// reads it, or from RayTrace cloud for a cloud sandbox (--sandbox rtp-…).
// Posting goes through the GitHub CLI (`gh`), signed in as you: the comment
// it made before on that pull request is updated, never another comment.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { paths } from './paths.mjs';
import { call } from './api.mjs';

const SANDBOX = /^rtp-[a-f0-9]{32}$/;
export const MARKER = '<!-- raytrace-report -->';
const DASHBOARD = process.env.RAYTRACE_DASHBOARD_URL || 'https://app.raytracer.si';
const MAX_COMMANDS = 30;
const MAX_FILES = 40;
const COMMAND_CHARS = 120;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

// What a key or token looks like. A `name=value` match keeps the name.
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-or-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];
const NAMED_SECRET = /((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"'&]{8,}/gi;

/** The text with anything that looks like a secret replaced, and how many were. */
export function redactSecrets(text) {
  let count = 0;
  let out = String(text ?? '');
  for (const pattern of SECRETS) out = out.replace(pattern, () => { count += 1; return '[REDACTED]'; });
  out = out.replace(NAMED_SECRET, (_, name) => { count += 1; return `${name}[REDACTED]`; });
  return { text: out, count };
}

const oneLine = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
// Inside a table cell: no pipes or backticks can end the cell or the code.
const cell = (text) => `<code>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;')}</code>`;

function outcome(call) {
  if (typeof call.exit_code === 'number') return { label: call.exit_code === 0 ? '✅ 0' : `❌ ${call.exit_code}`, failed: call.exit_code !== 0 };
  if (call.status === 'failed' || call.error) return { label: '❌ failed', failed: true };
  if (!call.verified) return { label: '⚪ not seen', failed: false };
  return { label: '✅ ran', failed: false };
}

/** What the comment says, worked out from a trace (proxy/trace-view.mjs). */
export function summarize(trace) {
  const calls = trace.callVerifications ?? [];
  const commands = calls.filter((c) => c.kind === 'command' && c.proposed).map((c) => ({ text: c.proposed, ...outcome(c) }));
  const files = new Map();
  for (const c of calls) {
    for (const change of c.snapshot?.changes ?? []) {
      if (typeof change?.path === 'string') files.set(change.path, { status: change.status ?? null, added: change.added ?? null, removed: change.removed ?? null });
    }
    if (c.kind === 'file' && WRITE_TOOLS.has(c.name) && typeof c.proposed === 'string' && !files.has(c.proposed)) files.set(c.proposed, { status: null });
  }
  let cost = null;
  for (const r of trace.requests ?? []) if (r.cost != null) cost = (cost ?? 0) + r.cost;
  return { commands, failed: commands.filter((c) => c.failed).length, files: [...files].map(([path, info]) => ({ path, ...info })), cost };
}

/** The comment's Markdown, secrets already removed. `link`: {url, expires} or null. */
export function formatReport(trace, { link = null, linkNote = null } = {}) {
  const { commands, failed, files, cost } = summarize(trace);
  const lines = [MARKER, '### RayTrace run report', ''];
  lines.push(`**Status:** ${trace.status ?? 'unknown'} · **Model:** ${trace.model ?? 'unknown'} · **Cost:** ${cost != null ? `$${cost.toFixed(4)}` : 'unknown'}`);
  lines.push(`**Commands:** ${commands.length} · **Failed:** ${failed} · **Files changed:** ${files.length}`);
  lines.push('');
  if (commands.length) {
    lines.push('| Exit | Command |', '| --- | --- |');
    // Failures first: they are what a reviewer needs.
    const ordered = [...commands.filter((c) => c.failed), ...commands.filter((c) => !c.failed)];
    for (const c of ordered.slice(0, MAX_COMMANDS)) lines.push(`| ${c.label} | ${cell(oneLine(c.text, COMMAND_CHARS))} |`);
    if (commands.length > MAX_COMMANDS) lines.push('', `…and ${commands.length - MAX_COMMANDS} more commands.`);
    lines.push('');
  } else lines.push('No commands were run.', '');
  if (files.length) {
    lines.push(`<details><summary>Files changed (${files.length})</summary>`, '');
    for (const f of files.slice(0, MAX_FILES)) {
      const size = f.added != null || f.removed != null ? ` +${f.added ?? 0} −${f.removed ?? 0}` : '';
      lines.push(`- ${cell(oneLine(f.path, 200))}${f.status ? ` ${f.status}` : ''}${size}`);
    }
    if (files.length > MAX_FILES) lines.push(`- …and ${files.length - MAX_FILES} more`);
    lines.push('', '</details>', '');
  }
  if (link) {
    const expires = link.expires ? ` (the link expires ${new Date(link.expires * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC)` : '';
    lines.push(`[Open this run in RayTrace](${link.url})${expires}`, '');
  } else if (linkNote) lines.push(`_${linkNote}_`, '');
  lines.push(`<sub>Trace \`${oneLine(trace.id, 80).replace(/`/g, '')}\` · recorded by RayTrace: commands as the agent ran them, exit codes as the sandbox saw them.</sub>`);
  const { text, count } = redactSecrets(lines.join('\n'));
  return count ? `${text}\n\n_${count} value${count === 1 ? '' : 's'} that looked like secrets ${count === 1 ? 'was' : 'were'} hidden._` : text;
}

async function localTrace(traceId) {
  if (!existsSync(paths.database)) return null;
  const { openEvidenceStore } = await import('../proxy/evidence-store.mjs');
  const { readTraces } = await import('../proxy/trace-view.mjs');
  const store = openEvidenceStore(paths.database, { readOnly: true });
  try {
    return (await readTraces(store, { turnId: traceId, includeHistory: true, evidence: true })).find((t) => t.id === traceId) ?? null;
  } finally { store.close(); }
}

async function cloudTrace(traceId, sandbox, api) {
  const data = await api('GET', `/v1/evidence/traces?sandbox=${sandbox}&scope=history&evidence=1`);
  return (data.traces ?? []).find((t) => t.id === traceId) ?? null;
}

/** A share link, or why there is none: the link is only ever extra. */
async function shareLink(trace, api) {
  if (!SANDBOX.test(trace.sandboxId ?? '')) return { link: null, note: 'No share link: this run was in a local sandbox.' };
  try {
    const made = await api('POST', '/v1/shares', { body: JSON.stringify({ trace_id: trace.id, sandbox_id: trace.sandboxId, allow_fork: false }),
      headers: { 'content-type': 'application/json' } });
    return { link: { url: new URL(made.url, DASHBOARD).href, expires: made.share?.expires ?? null }, note: null };
  } catch (error) {
    if (error?.data?.code === 'share_limit') return { link: null, note: 'No share link: your plan\'s share links are all in use.' };
    return { link: null, note: `No share link: ${oneLine(error?.message, 120)}.` };
  }
}

function gh(args, input) {
  const run = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (run.error?.code === 'ENOENT') throw Object.assign(new Error('GitHub CLI (gh) not found'), { code: 'ENOENT' });
  if (run.status !== 0) throw new Error(`gh ${args[0]} failed: ${oneLine(run.stderr || run.stdout, 300)}`);
  return run.stdout;
}

/** Posts the report on pull request `pr`, or updates the one this user posted there before. */
export function postComment(pr, body, run = gh) {
  const login = run(['api', 'user', '--jq', '.login']).trim();
  const pages = JSON.parse(run(['api', `repos/{owner}/{repo}/issues/${pr}/comments`, '--paginate', '--slurp']) || '[]');
  const mine = pages.flat().filter((c) => c?.user?.login === login && String(c.body ?? '').startsWith(MARKER)).at(-1);
  const payload = JSON.stringify({ body });
  if (mine) run(['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${mine.id}`, '--input', '-', '--silent'], payload);
  else run(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${pr}/comments`, '--input', '-', '--silent'], payload);
  return mine ? 'updated' : 'created';
}

export async function reportCommand(traceId, { pr = null, sandbox = null, link = false, dryRun = false } = {},
  { loadLocal = localTrace, api = call, post = postComment, say = console.log } = {}) {
  const id = String(traceId ?? '').trim();
  if (!id) throw new Error('Trace ID is required. Usage: raytrace report <trace-id> [--pr <number>] [--sandbox <rtp-id>] [--link] [--dry-run]');
  if (sandbox != null && !SANDBOX.test(sandbox)) throw new Error(`Not a cloud sandbox id: ${sandbox}. It looks like rtp- and 32 letters and digits.`);
  if (pr != null && !/^[1-9]\d{0,9}$/.test(String(pr))) throw new Error(`Not a pull request number: ${pr}`);
  const trace = (await loadLocal(id)) ?? (sandbox ? await cloudTrace(id, sandbox, api) : null);
  if (!trace) throw new Error(sandbox ? `Trace not found in sandbox ${sandbox}: ${id}` : `Trace not found on this machine: ${id}. For a cloud sandbox, add --sandbox <rtp-id>.`);
  // A link uses up one of the plan's share links, so only on request, and never on a dry run.
  const shared = link && !dryRun ? await shareLink(trace, api) : { link: null, note: null };
  const body = formatReport(trace, { link: shared.link, linkNote: shared.note });
  if (!pr || dryRun) { say(body); return { body, posted: null }; }
  try {
    const posted = post(pr, body);
    say(`Report ${posted} on pull request #${pr}.`);
    return { body, posted };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    say('The GitHub CLI (gh) is not installed, so nothing was posted. Here is the comment to paste:\n');
    say(body);
    return { body, posted: null };
  }
}
