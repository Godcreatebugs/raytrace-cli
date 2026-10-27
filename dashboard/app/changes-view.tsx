'use client';

// Changes: what one prompt left different in the project, and the way back
// to a local checkout. Whole-prompt first (every file, its overall diff,
// one patch to download), then step by step (each call that changed files,
// with that call's own diffs). Everything here comes from the snapshots the
// sandbox took after each call; a run recorded without them says so.
import { Fragment, useState } from 'react';
import { ArrowRight, ChevronRight, Download } from 'lucide-react';
import { type Trace } from './types';
import { patchFilename, summarizeChanges } from './changes-data';
import { downloadText, fetchSnapshotDiff, SnapshotDiff } from './snapshot-diff';
import { FilesChanged } from './tool-calls-view';

const STATUS = { A: 'added', M: 'edited', D: 'deleted', T: 'type changed' } as Record<string, string>;

export function ChangesView({ trace, onOpenCall }: { trace: Trace; onOpenCall?: (callId: string) => void }) {
  const summary = summarizeChanges(trace);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const sandbox = trace.sandboxId;
  const canPatch = Boolean(sandbox && summary.base && summary.final && summary.files.length);

  async function download(path?: string) {
    if (!sandbox || !summary.base || !summary.final) return;
    setBusy(true); setNote('');
    try {
      const patch = await fetchSnapshotDiff(sandbox, summary.base, summary.final, path);
      if (!patch.diff) { setNote('That diff came back empty, so nothing was downloaded.'); return; }
      downloadText(patchFilename(trace, path), patch.diff);
      if (patch.truncated) setNote('Downloaded, but the diff was larger than the 500 KB the snapshot view returns: this patch is incomplete.');
    } catch (failure) {
      setNote(`Could not build the patch: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally { setBusy(false); }
  }

  return <section className="rt-view rt-changes">
    <header className="rt-view-head">
      <div><span className="eyebrow">CHANGES</span><h1>What this prompt changed</h1></div>
      <div className="rt-actions">
        <button type="button" className="rt-button" disabled={!canPatch || busy} onClick={() => void download()}
          title={canPatch ? 'One patch file with every change this prompt made, to apply in your local copy'
            : 'Needs a sandbox run whose file snapshots were recorded'}>
          <Download size={14} /> {busy ? 'Building patch…' : 'Download patch'}
        </button>
      </div>
    </header>

    {!sandbox ? <p className="rt-empty">This prompt did not run in a sandbox, so RayTrace holds no snapshot of the project folder to diff.</p>
      : !summary.hasSnapshots ? <p className="rt-empty">This run was recorded before file snapshots existed, so there is nothing to diff. Tool calls still shows what the agent reported.</p>
        : !summary.files.length ? <p className="rt-empty">No file changed during this prompt. The snapshots taken after its steps show the project exactly as it started.</p>
          : <>
            <dl className="rt-stats">
              <div><dt>Files changed</dt><dd>{summary.files.length}</dd></div>
              <div><dt>Lines added</dt><dd>+{summary.added}</dd></div>
              <div><dt>Lines removed</dt><dd>−{summary.removed}</dd></div>
              <div><dt>Steps that changed files</dt><dd>{summary.steps.length}</dd></div>
            </dl>
            {note && <p role="alert" className="verify-error">{note}</p>}

            <h2>Across the whole prompt</h2>
            <ul className="rt-files">{summary.files.map((file) => <Fragment key={file.path}>
              <li>
                <button type="button" className="rt-file-toggle" aria-expanded={openPath === file.path}
                  onClick={() => setOpenPath(openPath === file.path ? null : file.path)}>
                  <ChevronRight size={12} className={`rt-caret${openPath === file.path ? ' down' : ''}`} />
                  <span className={`rt-file-status s-${file.status}`}>{STATUS[file.status] ?? file.status}</span>
                  <code>{file.path}</code>
                </button>
                <small>{file.added == null ? 'binary' : `+${file.added} −${file.removed}`} · step{file.calls.length > 1 ? 's' : ''} {file.calls.map((n) => `#${n}`).join(', ')}</small>
              </li>
              {openPath === file.path && summary.base && summary.final && <li className="rt-file-diff">
                <SnapshotDiff sandbox={sandbox} from={summary.base} to={summary.final} path={file.path} />
                <button type="button" className="rt-button" disabled={busy} onClick={() => void download(file.path)}>
                  <Download size={13} /> {"Download this file's patch"}
                </button>
              </li>}
            </Fragment>)}</ul>
            {summary.tooBig.length > 0 && <p className="rt-files-note">Too big to snapshot (over 5 MB), so their changes are not in this list or the patch: {summary.tooBig.join(', ')}</p>}

            <div className="rt-changes-apply">
              <h2>Take it into your local copy</h2>
              <p>Download the patch above, put it in your project folder, and check before applying:
                {' '}<code>git apply --check {patchFilename(trace)}</code>, then <code>git apply {patchFilename(trace)}</code>.
                The patch is built from the sandbox&apos;s snapshots of this prompt only. It may not apply cleanly if your
                local copy has changed since the sandbox was created — review it like any other change.</p>
            </div>

            <div className="rt-changes-steps">
              <h2>Step by step</h2>
              {summary.steps.map(({ call, number }) => <div key={call.call_id} className="rt-changes-step">
                <p className="rt-files-note">#{number} {call.description ?? call.proposed ?? call.name}
                  {onOpenCall && <> {' '}<button type="button" className="link-button" onClick={() => onOpenCall(call.call_id)}>Open in Tool calls <ArrowRight size={12} /></button></>}
                </p>
                {call.snapshot && <FilesChanged snapshot={call.snapshot} sandbox={sandbox} />}
              </div>)}
            </div>
          </>}
  </section>;
}
