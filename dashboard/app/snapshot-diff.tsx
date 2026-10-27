'use client';

// One file's (or the whole project's) diff between two snapshots of the
// sandbox's project folder, and the patch download built on it. The server
// side is projects.py's read-only snapshot view (list | show | diff), reached
// the same way the Playground reaches it; it caps a diff at 500 KB and says
// so, which the UI must not hide.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { EMPTY_TREE, readableDiffError } from './changes-data';
import { parseDiff } from './diff-parse';

export { EMPTY_TREE };

const isCommit = (value: string) => /^[0-9a-f]{40}$/.test(value) || value.startsWith('refs/forks/');

export type SnapshotPatch = { diff: string; truncated: boolean };

/** The unified diff from one snapshot to another; one file when `path` is set. */
export async function fetchSnapshotDiff(sandbox: string, from: string, to: string, path?: string): Promise<SnapshotPatch> {
  if (!isCommit(from) || !isCommit(to)) throw new Error('This snapshot cannot be diffed.');
  const query = new URLSearchParams({ commit: from, to, ...(path ? { path } : {}) });
  const response = await api().fetch(`/raytace/snapshots/${sandbox}/diff?${query}`);
  const value = await response.json().catch(() => ({})) as { diff?: string; truncated?: boolean; error?: string };
  if (!response.ok) throw new Error(readableDiffError(value.error ?? `HTTP ${response.status}`));
  return { diff: value.diff ?? '', truncated: Boolean(value.truncated) };
}

/** Save text (a .patch) from the browser: the one way a hosted page can hand
 * files back to the machine it is being viewed on. */
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}

const lineClass = (line: string) =>
  line.startsWith('+') && !line.startsWith('+++') ? 'add'
    : line.startsWith('-') && !line.startsWith('---') ? 'del'
      : line.startsWith('@@') ? 'hunk' : '';

const MODE_KEY = 'raytace.diff-view';

/** How diffs are read: side by side (before | after) or one column.
 * Side by side unless the reader chose otherwise; remembered per browser. */
function useDiffMode(): ['split' | 'unified', (mode: 'split' | 'unified') => void] {
  const [mode, setMode] = useState<'split' | 'unified'>('split');
  useEffect(() => { try { if (localStorage.getItem(MODE_KEY) === 'unified') setMode('unified'); } catch { /* storage unavailable */ } }, []);
  const set = (next: 'split' | 'unified') => { setMode(next); try { localStorage.setItem(MODE_KEY, next); } catch { /* storage unavailable */ } };
  return [mode, set];
}

/**
 * One unified diff, read the GitHub way: before on the left, after on the
 * right, each side with its own line numbers and a replaced line beside its
 * replacement — or, one toggle away, the single column it arrived as.
 */
export function DiffText({ diff }: { diff: string }) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  const [mode, setMode] = useDiffMode();
  if (parsed.binary) return <p className="rt-files-note">A binary file: it changed, but there are no lines to show.</p>;
  if (!parsed.hunks.length) return <pre className="rt-diff">{diff || '(no difference)'}</pre>;
  return <div className="rt-diff-wrap">
    <div className="rt-diff-bar">
      <span><b className="rt-diff-add-n">+{parsed.additions}</b> <b className="rt-diff-del-n">−{parsed.deletions}</b></span>
      <span className="rt-diff-mode">
        <button type="button" aria-pressed={mode === 'split'} className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>Split</button>
        <button type="button" aria-pressed={mode === 'unified'} className={mode === 'unified' ? 'on' : ''} onClick={() => setMode('unified')}>Unified</button>
      </span>
    </div>
    {mode === 'unified'
      ? <pre className="rt-diff">{diff.split('\n').map((line, index) => <span key={index} className={lineClass(line)}>{line}{'\n'}</span>)}</pre>
      : <div className="rt-diff-scroll"><table className="rt-diff-split"><colgroup><col className="rt-diff-ln-col" /><col /><col className="rt-diff-ln-col" /><col /></colgroup><tbody>
        {parsed.hunks.map((hunk, hunkAt) => <Fragment key={hunkAt}>
          <tr className="rt-diff-hunk"><td colSpan={4}>{hunk.header}</td></tr>
          {hunk.rows.map((row, rowAt) => row.note
            ? <tr key={rowAt} className="rt-diff-note-row"><td colSpan={4}>{row.note}</td></tr>
            : <tr key={rowAt}>
              <td className={`rt-diff-ln${row.oldText != null && row.oldText !== row.newText ? ' del' : ''}`}>{row.oldNo ?? ''}</td>
              <td className={`rt-diff-code${row.oldText == null ? ' empty' : row.oldText !== row.newText ? ' del' : ''}`}>{row.oldText ?? ''}</td>
              <td className={`rt-diff-ln${row.newText != null && row.oldText !== row.newText ? ' add' : ''}`}>{row.newNo ?? ''}</td>
              <td className={`rt-diff-code${row.newText == null ? ' empty' : row.oldText !== row.newText ? ' add' : ''}`}>{row.newText ?? ''}</td>
            </tr>)}
        </Fragment>)}
      </tbody></table></div>}
  </div>;
}

/** A diff, loaded when first shown: render it only once its row is open. */
export function SnapshotDiff({ sandbox, from, to, path }: { sandbox?: string; from: string; to: string; path?: string }) {
  const [patch, setPatch] = useState<SnapshotPatch | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!sandbox) return;
    let closed = false;
    fetchSnapshotDiff(sandbox, from, to, path)
      .then((found) => { if (!closed) setPatch(found); })
      .catch((failure: Error) => { if (!closed) setError(`Could not load the diff: ${failure.message}`); });
    return () => { closed = true; };
  }, [sandbox, from, to, path]);
  if (!sandbox) return <p className="rt-files-note">No sandbox holds this snapshot, so there is no diff to load.</p>;
  if (error) return <p className="rt-files-note">{error}</p>;
  if (!patch) return <p className="rt-files-note">Loading diff…</p>;
  return <>
    {patch.diff ? <DiffText diff={patch.diff} /> : <pre className="rt-diff">(no difference)</pre>}
    {patch.truncated && <p className="rt-files-note">This diff is larger than the 500 KB the snapshot view returns, so it is cut off here — and a patch downloaded from it would be incomplete.</p>}
  </>;
}
