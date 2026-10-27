/**
 * Where the dashboard's views get their data. Locally that is the RayTrace
 * proxy on this machine; the hosted dashboard (cloud-dashboard/) points the
 * same views at api.raytracer.si with the signed-in user's token instead, and
 * turns off what the cloud does not serve yet.
 */
export type Api = {
  /** fetch() for a proxy path such as /raytace/traces?scope=history. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Model-written summaries of each request (they spend on a model). */
  summaries: boolean;
  /** Context's "Test it": one step rerun with part of its context changed. Local only. */
  reruns: boolean;
  /** Creates a sandbox from a packed project (.tar.gz), where the API can: the
   * hosted dashboard. Unset locally, where sandboxes come from the CLI. */
  createSandbox?: (name: string, archive: Blob) => Promise<Response>;
};

const PROXY_BASE = 'http://127.0.0.1:8797';
let current: Api = {
  fetch: (path, init) => fetch(`${PROXY_BASE}${path}`, init),
  summaries: true,
  reruns: true,
};

export const api = (): Api => current;
export function configureApi(next: Partial<Api>) { current = { ...current, ...next }; }
