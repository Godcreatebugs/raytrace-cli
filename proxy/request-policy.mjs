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
