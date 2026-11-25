// Shared low-level /v1 HTTP client for @raytrace-cli/sdk.
// Zero runtime dependencies (Node 20+ native fetch + zlib + crypto).
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

export const DEFAULT_BASE_URL = 'https://api.raytracer.si';

const DEFAULT_EXCLUDED = new Set([
  '.git', '.raytace', '.raytrace', '.ssh', '.aws', '.azure', '.config',
  '.claude', '.codex', '.docker', '.kube', '.gnupg', 'node_modules',
  '.venv', '__pycache__', '.next', 'dist', 'coverage', '.DS_Store',
]);
// Files that usually hold credentials, never uploaded (the same rules as the
// CLI's `raytrace sandbox create`). Compared in lower case.
const SECRET_NAMES = new Set([
  '.npmrc', '.netrc', '.pypirc', '.htpasswd', '.dockercfg', 'credentials', 'credentials.json', 'credentials.ini',
  'auth.json', 'service-account.json', 'service_account.json', 'serviceaccountkey.json',
  'client_secret.json', 'client_secrets.json', 'token.json', 'id_rsa', 'id_dsa', 'id_ecdsa',
  'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', 'known_hosts',
]);
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx)$/i;

export function isSecretFile(name) {
  const lower = String(name).toLowerCase();
  return lower.startsWith('.env') || lower.startsWith('.secret') || SECRET_EXTENSIONS.test(lower) || SECRET_NAMES.has(lower);
}

export class RayTraceError extends Error {
  constructor(message, { status = 0, code = null, topupUrl = null, body = null } = {}) {
    super(message);
    this.name = 'RayTraceError';
    this.status = status;
    this.code = code;
    this.topupUrl = topupUrl;
    this.body = body;
  }
}

function writeOctal(buf, offset, length, value) {
  const str = Math.max(0, value).toString(8).padStart(length - 1, '0');
  buf.write(str.slice(-(length - 1)), offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

/**
 * Pure-JS POSIX ustar + gzip builder (no external tar binary or npm packages).
 * Accepts a map of relative POSIX paths -> string | Uint8Array | Buffer.
 */
export function buildTarGz(files) {
  return buildTarGzWithModes(files);
}

function buildTarGzWithModes(files, modes = new Map()) {
  const chunks = [];
  const entries = Object.entries(files || {});
  if (!entries.length) {
    throw new Error('Archive must contain at least one file');
  }
  for (const [rawPath, content] of entries) {
    const rel = String(rawPath).replace(/^\/+/, '');
    if (!rel || rel.split(/[\\/]/).includes('..') || Buffer.byteLength(rel, 'utf8') > 99) {
      throw new Error(`Invalid archive file path: ${rawPath}`);
    }
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const header = Buffer.alloc(512, 0);
    header.write(rel, 0, 100, 'utf8');
    writeOctal(header, 100, 8, modes.get(rawPath) ?? 0o644);
    writeOctal(header, 108, 8, 1000);
    writeOctal(header, 116, 8, 1000);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(0x20, 148, 156); // checksum placeholder spaces
    header[156] = 0x30; // '0' regular file
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i];
    const chk = sum.toString(8).padStart(6, '0');
    header.write(chk, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header);
    if (data.length > 0) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}

// git transports a repository URL may use: https and ssh only, so a URL such
// as ext::<command> can never run a program.
const GIT_ENV = { GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_TERMINAL_PROMPT: '0' };

/** The clone URL for `repo`: an https or ssh URL as given, `host/owner/name` over https, or GitHub's `owner/name`. */
export function repoUrl(repo) {
  const value = String(repo || '').trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return `https://github.com/${value.replace(/\.git$/, '')}.git`;
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\/[^\s:]+$/.test(value)) return `https://${value}`;
  if (/^https:\/\/[^\s]+$/.test(value) || /^ssh:\/\/[^\s]+$/.test(value) || /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/.test(value)) return value;
  throw new Error(`Unsupported repo "${value}": use an https or ssh URL, or owner/name for GitHub`);
}

/** The name a repository gives a sandbox: its last path segment, without .git. */
export function repoName(repo) {
  return String(repo).replace(/\/+$/, '').split(/[/:]/).filter(Boolean).pop().replace(/\.git$/, '') || 'sandbox';
}

// GitHub's rules for account and repository names (RayTrace's API checks the same).
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_URL = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)?([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i;

/** `owner/name` for a GitHub repository given as owner/name or a github.com https or ssh URL; null for anything else. */
export function githubRepo(repo) {
  const name = GITHUB_URL.exec(String(repo ?? '').trim())?.[1];
  if (!name || !GITHUB_NAME.test(name) || ['.', '..'].includes(name.split('/')[1])) return null;
  return name;
}

/** The branch a connected sandbox works on. Its agent may push only to raytrace/<these 8 characters>/... */
export function workBranch(sandboxId) {
  return `raytrace/${String(sandboxId).slice(4, 12)}/work`;
}

const GIT_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * The shell commands that turn a sandbox's uploaded files into a clone of
 * `repo`: a Git repository whose origin is GitHub (the sandbox's relay opens
 * it), lined up with `commit` (when GitHub has it), else `ref`, else the
 * default branch, on a branch of its own. The uploaded files stay as they are;
 * a file the upload left out (a secret, say) is taken from the commit, so it
 * is not committed as deleted. A folder that is already a repository is left alone.
 */
export function connectScript({ repo, sandboxId, ref = undefined, commit = undefined, dir = '/workspace' }) {
  const name = githubRepo(repo);
  if (!name) throw new Error(`Not a GitHub repository: ${repo} (use owner/name)`);
  if (ref !== undefined && !GIT_REF.test(String(ref))) throw new Error(`Not a branch or tag name: ${ref}`);
  if (commit !== undefined && !GIT_COMMIT.test(String(commit))) throw new Error(`Not a commit id: ${commit}`);
  const fallback = quote(ref ?? 'HEAD');
  const branch = workBranch(sandboxId);
  return [
    'set -e',
    `cd ${quote(dir)}`,
    `if [ -e .git ]; then echo "RayTrace: $(pwd) is already a Git repository; left as it is." >&2; exit 0; fi`,
    'git -c init.defaultBranch=main init -q',
    `git remote add origin ${quote(`https://github.com/${name}.git`)}`,
    commit ? `git fetch -q --depth 1 origin ${commit} 2>/dev/null || git fetch -q --depth 1 origin ${fallback}`
      : `git fetch -q --depth 1 origin ${fallback}`,
    'git reset -q FETCH_HEAD',
    'if [ -n "$(git ls-files --deleted)" ]; then git ls-files -z --deleted | git checkout -q --pathspec-from-file=- --pathspec-file-nul; fi',
    `git checkout -q -b ${quote(branch)}`,
    `echo ${quote(`Connected to ${name} on branch ${branch}. Push with: git push -u origin ${branch}`)}`,
  ].join('\n');
}

/**
 * Clones `repo` (shallow; `ref` is a branch or tag) into a temporary folder and
 * packs it like archiveFromDirectory, then deletes the clone. Uses the git on
 * this machine and its credentials, so private repositories work wherever
 * `git clone` does; it never waits for a password prompt.
 */
export async function archiveFromRepo(repo, { ref = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'raytrace-repo-'));
  try {
    const args = ['clone', '--depth', '1', '--quiet'];
    if (ref) args.push('--branch', String(ref));
    args.push('--', repoUrl(repo), join(dir, 'repo'));
    try {
      await promisify(execFile)('git', args, { env: { ...process.env, ...GIT_ENV }, timeout: 300_000, maxBuffer: 1 << 20 });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Creating a sandbox from a repo needs git installed on this machine');
      throw new Error(`Could not clone ${repo}: ${String(error.stderr || error.message).trim()}`);
    }
    return archiveFromDirectory(join(dir, 'repo'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function archiveFromDirectory(dirPath) {
  const files = Object.create(null);
  const modes = new Map();
  function walk(absDir, relPrefix) {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (DEFAULT_EXCLUDED.has(entry.name)) continue;
      const abs = join(absDir, entry.name);
      const rel = relPrefix ? posix.join(relPrefix, entry.name) : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && !isSecretFile(entry.name)) {
        const st = statSync(abs);
        if (st.size > 25 * 1024 * 1024) {
          throw new Error(`Project file ${rel} exceeds the 25 MiB size limit`);
        }
        files[rel] = readFileSync(abs);
        modes.set(rel, st.mode & 0o777);
      }
    }
  }
  walk(dirPath, '');
  return buildTarGzWithModes(files, modes);
}

export class RayTraceClient {
  constructor({ apiKey = process.env.RAYTRACE_API_KEY, baseUrl = process.env.RAYTRACE_API_URL || DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) {
      throw new Error('RayTrace API key is required (pass { apiKey } or set RAYTRACE_API_KEY)');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('A Fetch API implementation is required');
    }
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  async request(method, path, { headers = {}, body = undefined } = {}) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const reqHeaders = {
      Authorization: `Bearer ${this.apiKey}`,
      ...headers,
    };
    let reqBody = body;
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
      reqHeaders['Content-Type'] = 'application/json';
      reqBody = JSON.stringify(body);
    }
    const response = await this.fetch(url, { method, headers: reqHeaders, body: reqBody });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
    }
    if (!response.ok) {
      throw new RayTraceError(
        (parsed && parsed.error) || `RayTrace API error (HTTP ${response.status})`,
        {
          status: response.status,
          code: (parsed && parsed.code) || null,
          topupUrl: (parsed && parsed.topup_url) || null,
          body: parsed,
        },
      );
    }
    return { status: response.status, data: parsed };
  }
}
