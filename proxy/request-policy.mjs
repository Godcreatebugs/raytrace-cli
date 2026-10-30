import { createHash, timingSafeEqual } from 'node:crypto';

/** Browser requests must satisfy the same policy before any local API or
 * provider route runs. A CORS denial alone does not stop a simple POST from
 * spending the proxy's configured provider key. */
export function trustedOrigin(origin, allowedOrigins = new Set()) {
  if (!origin) return true; // Native CLI clients do not send Origin.
  if (allowedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export function trustedRequest(req, allowedOrigins = new Set()) {
  return trustedOrigin(req.headers.origin, allowedOrigins)
    && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host || '');
}

const digest = (value) => createHash('sha256').update(String(value)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

/** What the dashboard's browser holds in place of the token itself. */
export const sessionFor = (token) => digest(`dashboard:${token}`).toString('hex');
export const sessionCookie = (port) => `raytrace_session_${port}`;

/** A client that read the token file: the CLI, the hook, `raytrace codex`. */
export function hasToken(req, token) {
  const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  return Boolean(given) && same(given, token);
}

/** The dashboard, in a browser `raytrace open` signed in. Cookies are shared
 * between the ports of a host, so a page on another localhost port sends this
 * one too: it counts only from this origin, and only on the local API
 * (hasToken, not this, guards the provider routes). */
export function hasSession(req, token, port) {
  const { origin, host, cookie } = req.headers;
  if (origin && origin !== `http://${host}`) return false;
  const name = `${sessionCookie(port)}=`;
  const value = (cookie || '').split(/;\s*/).find((part) => part.startsWith(name))?.slice(name.length);
  return Boolean(value) && same(value, sessionFor(token));
}
