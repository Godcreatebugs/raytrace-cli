// A project folder dropped on (or picked in) the dashboard, turned into the
// same .tar.gz the `raytrace sandbox create` CLI uploads: nothing is read or
// sent until the user has seen what will go. What stays behind matches the
// CLI (raytrace-cli/src/sandbox.mjs): version control, dependencies and build
// output, files that usually hold credentials, and whatever the folder's own
// .gitignore files exclude. The control plane screens the upload again
// (worker/gvisor/control_api.py), with the same limits.

const MIB = 1024 * 1024;
export const LIMITS = { file: 25 * MIB, total: 200 * MIB, files: 20_000, archive: 100 * MIB };

const EXCLUDED = new Set(['.git', '.raytace', '.raytrace', '.ssh', '.aws', '.azure', '.config', 'node_modules', '.venv',
  '__pycache__', '.next', '.vinext', 'dist', 'coverage', '.wrangler', '.DS_Store']);
const SECRET_NAMES = new Set(['.npmrc', '.netrc', '.pypirc', 'credentials', 'auth.json', 'id_rsa', 'id_ed25519']);
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx)$/i;
const secret = (name: string) => name.startsWith('.env') || SECRET_EXTENSIONS.test(name) || SECRET_NAMES.has(name);

export type Picked = { path: string; file: File };
export type Project = {
  name: string;
  files: Picked[];
  total: number;
  /** Left on this machine, by reason. */
  skipped: { ignored: number; excluded: number; secret: string[] };
  /** Why this project cannot be uploaded as it is; empty when it can. */
  problems: string[];
};

// ------------------------------------------------------------- .gitignore

type Rule = { base: string; negate: boolean; dirOnly: boolean; match: RegExp };

/** One .gitignore's rules; `base` is its directory ('' for the project root). */
export function gitignoreRules(text: string, base: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    if (line.startsWith('\\')) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    // A slash anywhere but the end ties the pattern to this .gitignore's directory.
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    let body = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '*' && line[i + 1] === '*') {
        if (line[i + 2] === '/') { body += '(?:.*/)?'; i += 2; } else { body += '.*'; i += 1; }
      } else if (char === '*') body += '[^/]*';
      else if (char === '?') body += '[^/]';
      else if (char === '[') {
        const end = line.indexOf(']', i + 2);
        if (end < 0) body += '\\[';
        else { body += `[${line.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end; }
      } else body += char.replace(/[.+^${}()|\\\]]/g, '\\$&');
    }
    try { rules.push({ base, negate, dirOnly, match: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`) }); } catch { /* an unreadable pattern ignores nothing */ }
  }
  return rules;
}

/** Git's answer for one path: the last rule that matches it decides. */
function ruledOut(rules: Rule[], path: string, isDir: boolean) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.base && !path.startsWith(`${rule.base}/`)) continue;
    if (rule.match.test(rule.base ? path.slice(rule.base.length + 1) : path)) ignored = !rule.negate;
  }
  return ignored;
}

/** Ignored itself, or inside an ignored directory (which git never looks into). */
function ignoredPath(rules: Rule[], path: string) {
  const parts = path.split('/');
  for (let depth = 1; depth < parts.length; depth++) if (ruledOut(rules, parts.slice(0, depth).join('/'), true)) return true;
  return ruledOut(rules, path, false);
}

// ------------------------------------------------------------- collecting

function finish(name: string, candidates: Picked[], skipped: Project['skipped'], problems: string[]): Project {
  const files: Picked[] = []; let total = 0; const large: string[] = [];
  for (const item of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
    if (item.file.size > LIMITS.file) { large.push(`${item.path} (${(item.file.size / MIB).toFixed(0)} MiB)`); continue; }
    files.push(item); total += item.file.size;
  }
  if (large.length) problems.push(`${large.length} file${large.length === 1 ? ' is' : 's are'} over ${LIMITS.file / MIB} MiB: ${large.slice(0, 5).join(', ')}${large.length > 5 ? ', …' : ''}. Add ${large.length === 1 ? 'it' : 'them'} to .gitignore, or remove ${large.length === 1 ? 'it' : 'them'}.`);
  if (files.length > LIMITS.files) problems.push(`${files.length.toLocaleString()} files; a project may have at most ${LIMITS.files.toLocaleString()}.`);
  if (total > LIMITS.total) problems.push(`${(total / MIB).toFixed(0)} MiB in all; a project may be at most ${LIMITS.total / MIB} MiB.`);
  if (!files.length && !problems.length) problems.push('No files to upload in this folder.');
  return { name, files, total, skipped, problems };
}

const entries = (directory: FileSystemDirectoryEntry) => new Promise<FileSystemEntry[]>((resolve, reject) => {
  const reader = directory.createReader(); const all: FileSystemEntry[] = [];
  // readEntries hands over a batch at a time, and an empty one when done.
  const next = () => reader.readEntries((batch) => { if (batch.length) { all.push(...batch); next(); } else resolve(all); }, reject);
  next();
});
const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** The entries of a drop, taken while the event is live (they are gone after it). */
export function droppedEntries(transfer: DataTransfer): FileSystemEntry[] {
  return [...transfer.items].map((item) => item.webkitGetAsEntry?.() ?? null).filter((entry): entry is FileSystemEntry => entry !== null);
}

/** A dropped folder, walked without entering what will not be uploaded. */
export async function fromDrop(dropped: FileSystemEntry[]): Promise<Project> {
  const skipped: Project['skipped'] = { ignored: 0, excluded: 0, secret: [] };
  if (dropped.length !== 1 || !dropped[0].isDirectory) {
    return { name: '', files: [], total: 0, skipped, problems: ['Drop one project folder (not files, and not several folders).'] };
  }
  const root = dropped[0] as FileSystemDirectoryEntry;
  const candidates: Picked[] = []; const problems: string[] = [];
  const walk = async (directory: FileSystemDirectoryEntry, base: string, inherited: Rule[]) => {
    const children = await entries(directory);
    const own = children.find((child) => child.isFile && child.name === '.gitignore') as FileSystemFileEntry | undefined;
    const rules = own ? [...inherited, ...gitignoreRules(await (await fileOf(own)).text(), base)] : inherited;
    for (const child of children) {
      const path = base ? `${base}/${child.name}` : child.name;
      if (EXCLUDED.has(child.name)) { skipped.excluded += 1; continue; }
      if (ruledOut(rules, path, child.isDirectory)) { skipped.ignored += 1; continue; }
      if (child.isDirectory) { await walk(child as FileSystemDirectoryEntry, path, rules); continue; }
      if (secret(child.name)) { skipped.secret.push(path); continue; }
      // Far past the limit there is no point reading on; finish() reports it.
      if (candidates.length > LIMITS.files * 2) continue;
      candidates.push({ path, file: await fileOf(child as FileSystemFileEntry) });
    }
  };
  try { await walk(root, '', []); } catch { problems.push('Some of this folder could not be read.'); }
  return finish(root.name, candidates, skipped, problems);
}

/** A folder from the browser's picker: every file listed, filtered afterwards. */
export async function fromPicker(list: FileList): Promise<Project> {
  const skipped: Project['skipped'] = { ignored: 0, excluded: 0, secret: [] };
  const all = [...list].map((file) => {
    const [, ...rest] = (file.webkitRelativePath || file.name).split('/');
    return { path: rest.join('/') || file.name, file };
  });
  const name = (list[0]?.webkitRelativePath || '').split('/')[0] || 'project';
  // The picker lists every file, node_modules and all: count the folders left out, not their files.
  const excluded = new Set<string>();
  const inside = all.filter((item) => {
    const parts = item.path.split('/');
    const at = parts.findIndex((part) => EXCLUDED.has(part));
    if (at < 0) return true;
    excluded.add(parts.slice(0, at + 1).join('/')); return false;
  });
  skipped.excluded = excluded.size;
  // Parents before children, so a deeper .gitignore has the later word.
  const ignores = inside.filter((item) => item.path.split('/').pop() === '.gitignore')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const rules: Rule[] = [];
  for (const item of ignores) rules.push(...gitignoreRules(await item.file.text(), item.path.split('/').slice(0, -1).join('/')));
  const candidates: Picked[] = [];
  for (const item of inside) {
    if (ignoredPath(rules, item.path)) { skipped.ignored += 1; continue; }
    if (secret(item.path.split('/').pop()!)) { skipped.secret.push(item.path); continue; }
    candidates.push(item);
  }
  return finish(name, candidates, skipped, []);
}

// ------------------------------------------------------------- packing

const encoder = new TextEncoder();

function header(name: Uint8Array, prefix: Uint8Array, size: number, mtime: number, type: string) {
  const block = new Uint8Array(512);
  const put = (text: string | Uint8Array, at: number) => block.set(typeof text === 'string' ? encoder.encode(text) : text, at);
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0';
  put(name, 0);
  put(octal(0o644, 8), 100); put(octal(1000, 8), 108); put(octal(1000, 8), 116);
  put(octal(size, 12), 124); put(octal(Math.max(0, Math.floor(mtime)), 12), 136);
  put('        ', 148); put(type, 156);
  put('ustar\0' + '00', 257); put('node', 265); put('node', 297);
  put(prefix, 345);
  let sum = 0; for (const byte of block) sum += byte;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return block;
}

/** The blocks announcing one file: a plain ustar header, or a pax record first
 * for a path the header's fixed fields cannot hold. */
function announce(path: string, size: number, mtime: number): Uint8Array[] {
  const bytes = encoder.encode(path);
  const ascii = bytes.length === path.length;
  if (ascii && bytes.length <= 100) return [header(bytes, new Uint8Array(0), size, mtime, '0')];
  if (ascii) {
    for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
      if (cut <= 155 && bytes.length - cut - 1 <= 100) return [header(bytes.slice(cut + 1), bytes.slice(0, cut), size, mtime, '0')];
    }
  }
  // " path=<path>\n" with its own total length in front, as the pax format asks.
  const body = ` path=${path}\n`; const bodyBytes = encoder.encode(body).length;
  let length = bodyBytes + String(bodyBytes).length;
  if (String(length).length !== String(bodyBytes).length) length = bodyBytes + String(length).length;
  const record = encoder.encode(`${length}${body}`);
  const padded = new Uint8Array(Math.ceil(record.length / 512) * 512); padded.set(record);
  const short = encoder.encode(path.replace(/[^\x20-\x7e]/g, '_').slice(-100));
  return [header(encoder.encode('PaxHeader'), new Uint8Array(0), record.length, mtime, 'x'), padded, header(short, new Uint8Array(0), size, mtime, '0')];
}

/** The project as a gzipped tar of regular files, as the control plane expects. */
export async function pack(files: Picked[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  for (const { path, file } of files) {
    parts.push(...announce(path, file.size, file.lastModified / 1000) as BlobPart[], file);
    const tail = file.size % 512;
    if (tail) parts.push(new Uint8Array(512 - tail));
  }
  parts.push(new Uint8Array(1024));
  // Files are read from disk only now, streamed through the compressor.
  const packed = await new Response(new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  if (packed.size > LIMITS.archive) throw new Error(`The packed project is ${(packed.size / MIB).toFixed(0)} MiB; the most allowed is ${LIMITS.archive / MIB} MiB.`);
  return packed;
}
