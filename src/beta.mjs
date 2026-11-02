// `raytrace --code <code>`: redeem a single-use beta code handed out by
// RayTrace. Sign-in (`raytrace auth login`) is a prerequisite — this command
// never starts a sign-in flow and never sends the code anywhere until a
// signed-in account is known. The backend is the source of truth: on a
// successful redeem it deletes the code irreversibly and binds a $10
// OpenRouter credit (hard 3-day limit) to the signed-in account. Nothing
// about the code or entitlement is stored on this machine.
import { accessToken, consumeIdleNotice } from './auth.mjs';
import { call, hasApiKeyOverride } from './api.mjs';

const say = (line = '') => console.log(line);

export const normalizeBetaCode = (code) => String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');

// Codes are minted only in the backend repo (raytrace:
// worker/gvisor/mint_beta_codes.py), which stores SHA-256 hashes of the
// normalized code in `beta_codes` and deletes the row on redemption. The
// shared contract: RTB-XXXX-XXXX-XXXX (Crockford Base32), normalized as
// above, 3-day expiry. This CLI only presents a code; it never mints one.

export function formatCreditDeadline(iso, now = Date.now()) {
  if (!iso) return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const label = when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ms = when.getTime() - now;
  if (ms <= 0) return `${label} (expired)`;
  const hours = Math.round(ms / 3_600_000);
  return `${label} (about ${hours <= 1 ? '1 hour' : `${hours} hours`} left)`;
}

/** Signed-in check that never starts a login flow and never touches a code. */
export async function ensureSignedIn(getToken = accessToken) {
  if (hasApiKeyOverride()) return;
  const token = await getToken();
  if (!token) {
    throw new Error(consumeIdleNotice()
      ? 'You have not used RayTrace cloud for 2 days, so you need to sign in again. Run: raytrace auth login, then re-run: raytrace --code <your-code>'
      : 'Not signed in. Run: raytrace auth login, then re-run: raytrace --code <your-code>');
  }
}

export async function betaStatus(apiCall = call) {
  return apiCall('GET', '/v1/beta/status', { autoLogin: false });
}

function redeemError(error) {
  switch (error?.status) {
    case 401: return new Error('Not signed in. Run: raytrace auth login, then re-run: raytrace --code <your-code>');
    case 422: return new Error("That code isn't valid. Check it and try again, or ask RayTrace for a new one.");
    case 410: return new Error('That code has expired (codes must be redeemed within 3 days). Ask RayTrace for a new one.');
    case 409: return new Error('This account already has beta credit, so this code was not used. '
      + 'It can still be given to someone else until it expires.');
    case 429: return new Error('Too many code attempts. Wait a while and try again.');
    default: return null;
  }
}

export async function redeemBetaCode(rawCode, { ensure = ensureSignedIn, apiCall = call, log = say } = {}) {
  const code = normalizeBetaCode(rawCode);
  if (!code) throw new Error('Usage: raytrace --code <code>');
  // Prerequisite first: an unauthenticated attempt must not consume,
  // validate, or delete the code on the backend.
  await ensure();
  let data;
  try {
    data = await apiCall('POST', '/v1/beta/redeem', {
      body: JSON.stringify({ code }),
      headers: { 'content-type': 'application/json' },
      autoLogin: false,
    });
  } catch (error) {
    const mapped = redeemError(error);
    if (mapped) throw mapped;
    // The code is deleted on success, so a lost response looks like a
    // failure here while the entitlement already exists. Check before
    // reporting failure; the entitlement is what the user needs.
    try {
      const status = await betaStatus(apiCall);
      if (status?.entitled) {
        log("You're already good for beta testing: this account has its beta credit.");
        if (status.credit_expires_at) log(`Use it by ${formatCreditDeadline(status.credit_expires_at)}: raytrace sandbox create`);
        return status;
      }
    } catch { /* fall through to the original error */ }
    throw error;
  }
  const credit = data?.credit_usd ?? 10;
  log(`You're good for beta testing: $${credit} of Claude Code credit (via OpenRouter) is on this account.`);
  log('Your account now shows as Beta in the RayTrace dashboard.');
  if (data?.credit_expires_at) {
    log(`Hard limit: create your sandbox and use the credit by ${formatCreditDeadline(data.credit_expires_at)}. Unused credit expires.`);
  }
  log('Next, from a Git repository:  raytrace sandbox create');
  return data;
}
