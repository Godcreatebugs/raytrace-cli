// Shared client for RayTrace's cloud API (https://api.raytracer.si;
// RAYTRACE_API_URL points elsewhere). Requests carry your `raytrace auth
// login` token; RAYTRACE_API_KEY overrides it for a server running without
// accounts (development).
import { accessToken, consumeIdleNotice, login } from './auth.mjs';
import { readConfig } from './config.mjs';
import { interactive } from './prompt.mjs';

const say = (line = '') => console.log(line);
const API = 'https://api.raytracer.si';

export const unreachable = (url) => new Error(`Cannot reach RayTrace at ${url.origin}. Check your connection; `
  + 'networks that inspect HTTPS (some company Wi-Fi) may block it.');

export class ApiError extends Error {
  constructor(message, { status = null, data = {} } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/** True when a development API key overrides the signed-in account. */
export function hasApiKeyOverride() {
  return Boolean(process.env.RAYTRACE_API_KEY || readConfig().RAYTRACE_API_KEY);
}

export async function api({ autoLogin = true } = {}) {
  const config = readConfig();
  const url = process.env.RAYTRACE_API_URL || config.RAYTRACE_API_URL || API;
  let key = process.env.RAYTRACE_API_KEY || config.RAYTRACE_API_KEY || await accessToken();
  if (!key) {
    if (!autoLogin || !interactive()) throw new Error('Not signed in. Run: raytrace auth login');
    say(consumeIdleNotice()
      ? 'You have not used RayTrace cloud for 2 days, so you need to sign in again.'
      : 'You are not signed in to RayTrace yet.');
    await login();
    key = await accessToken();
    if (!key) throw new Error('Not signed in. Run: raytrace auth login');
    say();
  }
  return { url: new URL(url), key };
}

export async function call(method, path, { body, headers = {}, autoLogin = true } = {}) {
  const { url, key } = await api({ autoLogin });
  let response;
  try {
    response = await fetch(new URL(path, url), { method, body, headers: { authorization: `Bearer ${key}`, ...headers } });
  } catch {
    throw unreachable(url);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || `HTTP ${response.status}`, { status: response.status, data });
  return data;
}
