/**
 * Failure signatures: collapse repeat failures ("ENOENT /work/a/x.js",
 * "ENOENT /work/b/x.js") into one cluster, Splunk `cluster`-style.
 * Deliberately conservative (under-clusters): volatile parts only --
 * absolute directory prefixes, hex/uuids, bare numbers, quoted temp
 * names -- are normalized; the failing program, error name and file
 * basename survive, so distinct failures stay distinct.
 */
import { createHash } from 'node:crypto';

const ERRORISH = /error|failed|failure|exception|traceback|not found|no such|denied|enoent|eacces|eperm|econn|timeout|timed out|exit(?:ed)? (?:with )?code|panic|fatal|cannot|unable|invalid|syntaxerror|typeerror|referenceerror/i;

const RUNNER_HEADER = /^(wall time:|process exited with code|process running with session|chunk id:|output:$|exit code -?\d+$)/i;

function pickLine(text) {
  const all = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  // The runner's header ("Process exited with code 1") would cluster every
  // failure of a tool together; the output below it is the real signature.
  const lines = all.filter((line) => !RUNNER_HEADER.test(line));
  const pool = lines.length ? lines : all;
  if (!pool.length) return '';
  return pool.find((line) => ERRORISH.test(line)) ?? pool[0];
}

export function normalizeErrorLine(text) {
  let line = pickLine(text).toLowerCase();
  line = line
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    // Absolute paths: keep only the basename (the file that mattered).
    .replace(/(?:\/[\w.@+~-]+){2,}\/([\w.@+~-]+)/g, '<dir>/$1')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?z?)?\b/g, '<date>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|bytes|kb|mb|gb)\b/g, '<n>$1')
    .replace(/:\d+(?::\d+)?\b/g, ':<n>') // file:line:col
    .replace(/\bpid[= ]\d+\b/g, 'pid=<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return line;
}

/**
 * The cluster for one failure. `signature` is stable across runs of the
 * same failure; `label` is the human line shown for the cluster.
 * Returns null when there is no error text to sign.
 */
export function failureSignature({ errorText, exitCode = null, toolName = null } = {}) {
  const label = normalizeErrorLine(errorText);
  if (!label && exitCode == null) return null;
  const shown = exitCode != null && !/exit/.test(label) ? `exit ${String(exitCode)} · ${label}`.slice(0, 240) : (label || `exit ${String(exitCode)}`);
  const signature = createHash('sha256')
    .update(JSON.stringify([toolName ?? '', exitCode ?? '', label]))
    .digest('hex').slice(0, 16);
  return { signature, label: shown };
}
