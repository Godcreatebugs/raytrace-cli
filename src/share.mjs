// `raytrace share`: create, list, and revoke share links for recorded traces.
// Shares are time-limited links on https://app.raytracer.si/share/<token>.
import { call, ApiError } from './api.mjs';
import { liveSandboxes } from './sandbox.mjs';

const DASHBOARD = process.env.RAYTRACE_DASHBOARD_URL || 'https://app.raytracer.si';
const say = (line = '') => console.log(line);

export function formatTimeLeft(expiresEpoch) {
  const leftSec = Math.round(expiresEpoch - Date.now() / 1000);
  if (leftSec <= 0) return 'expired';
  const min = Math.round(leftSec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.round(min / 60);
  return `${hr} h`;
}

export async function sharePrompt(traceId, { sandboxId, allowFork = false } = {}) {
  if (!traceId || !traceId.trim()) {
    throw new Error('Trace ID is required. Usage: raytrace share <trace-id> [--sandbox <id>] [--fork]');
  }
  const cleanTrace = traceId.trim();

  let targetSandbox = sandboxId?.trim();
  if (!targetSandbox) {
    const sandboxes = await liveSandboxes();
    if (sandboxes.length === 1) {
      targetSandbox = sandboxes[0].id;
    } else if (sandboxes.length === 0) {
      throw new Error('No live cloud sandboxes found. Create one first with: raytrace sandbox create');
    } else {
      throw new Error(`More than one cloud sandbox found. Specify which one with --sandbox <id>:\n  ${sandboxes.map((s) => `${s.id} (${s.name})`).join('\n  ')}`);
    }
  }

  const result = await call('POST', '/v1/shares', {
    body: {
      trace_id: cleanTrace,
      sandbox_id: targetSandbox,
      allow_fork: Boolean(allowFork),
    },
  });

  const fullUrl = `${DASHBOARD}${result.url}`;
  const share = result.share;
  say('Share link created:');
  say(`  ${fullUrl}`);
  say();
  say(`- Prompt: ${share.trace_id}`);
  say(`- Sandbox: ${share.sandbox_id}`);
  say(`- Forking: ${share.allow_fork ? 'allowed' : 'view only'}`);
  say(`- Expires in: ${formatTimeLeft(share.expires)}`);
  return { ...result, fullUrl };
}

export async function listShares() {
  const result = await call('GET', '/v1/shares');
  const shares = result.shares ?? [];
  const tier = result.tier === 'enterprise' ? 'Team & Enterprise' : 'Individual';
  say(`Active share links (${shares.length} of ${result.limit} on ${tier}):`);
  if (!shares.length) {
    say('  No active share links. Share a prompt with: raytrace share <trace-id>');
    return result;
  }
  say();
  for (const s of shares) {
    const views = s.views?.length ?? 0;
    const viewStr = views === 1 ? '1 view' : `${views} views`;
    say(`- ${s.trace_id}: ${formatTimeLeft(s.expires)} remaining · ${s.allow_fork ? 'fork allowed' : 'view only'} · ${viewStr}`);
    say(`  Link: ${DASHBOARD}/share/${s.id}`);
    say(`  ID:   ${s.id}`);
  }
  say();
  say('Revoke a link at any time: raytrace share --revoke <id>');
  return result;
}

export async function revokeShare(shareId) {
  if (!shareId || !shareId.trim()) {
    throw new Error('Share ID is required. Usage: raytrace share --revoke <id>');
  }
  const cleanId = shareId.trim();
  await call('POST', `/v1/shares/${cleanId}/revoke`);
  say(`Revoked share link ${cleanId}.`);
  return { revoked: cleanId };
}
