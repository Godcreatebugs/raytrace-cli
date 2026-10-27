'use client';

// New sandbox from a project folder: drop it (or pick it), see exactly what
// would be uploaded and what stays on this machine, then create. Shown where
// the API can create sandboxes (the hosted dashboard); the CLI's
// `raytrace sandbox create` does the same from a terminal.
import { useRef, useState, type DragEvent } from 'react';
import { FolderUp, Upload, X } from 'lucide-react';
import { api } from './api';
import { droppedEntries, fromDrop, fromPicker, LIMITS, pack, type Project } from './project-upload';

const MIB = 1024 * 1024;
const size = (bytes: number) => bytes < MIB ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : `${(bytes / MIB).toFixed(1)} MiB`;
const cleanName = (name: string) => name.replace(/[^A-Za-z0-9._ -]/g, '-').slice(0, 100);
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

type Stage = { at: 'idle' } | { at: 'reading' } | { at: 'preview'; project: Project } | { at: 'working'; step: string } | { at: 'failed'; message: string; project?: Project };

export function NewSandbox({ onCreated }: { onCreated: (id: string) => void }) {
  const [stage, setStage] = useState<Stage>({ at: 'idle' });
  const [name, setName] = useState('');
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const show = async (reading: Promise<Project>) => {
    setStage({ at: 'reading' });
    try {
      const project = await reading;
      setName(cleanName(project.name));
      setStage({ at: 'preview', project });
    } catch { setStage({ at: 'failed', message: 'That folder could not be read.' }); }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault(); setOver(false);
    // The entries have to be taken now: the drop's data is gone once this returns.
    void show(fromDrop(droppedEntries(event.dataTransfer)));
  };

  const create = async (project: Project) => {
    const send = api().createSandbox;
    if (!send) return;
    try {
      setStage({ at: 'working', step: `Packing ${plural(project.files.length, 'file')}…` });
      const archive = await pack(project.files);
      setStage({ at: 'working', step: `Uploading ${size(archive.size)} and starting the sandbox. This can take a minute…` });
      const response = await send(name.trim(), archive);
      const data = await response.json().catch(() => ({})) as { id?: string; error?: string };
      if (!response.ok || !data.id) throw new Error(data.error || `The sandbox could not be created (HTTP ${response.status}).`);
      setStage({ at: 'idle' });
      onCreated(data.id);
    } catch (problem) {
      setStage({ at: 'failed', project, message: problem instanceof Error && problem.message !== 'Failed to fetch' ? problem.message : 'RayTrace could not be reached. Check your connection and try again.' });
    }
  };

  const project = stage.at === 'preview' ? stage.project : stage.at === 'failed' ? stage.project : undefined;
  const nameOk = /^[A-Za-z0-9._ -]{1,100}$/.test(name.trim());

  return <div className="rt-new-sandbox">
    {(stage.at === 'idle' || stage.at === 'reading' || (stage.at === 'failed' && !project)) && <div
      className={over ? 'rt-drop over' : 'rt-drop'}
      onDragOver={(event) => { event.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <FolderUp size={20} />
      <div>
        <strong>{stage.at === 'reading' ? 'Reading the folder…' : 'New sandbox: drop a project folder here'}</strong>
        <small>You will see what would be uploaded first. <code>.env</code> files, keys, <code>node_modules</code> and anything your <code>.gitignore</code> excludes stay on this machine.
          Up to {LIMITS.total / MIB} MiB, {LIMITS.file / MIB} MiB a file.</small>
        {stage.at === 'failed' && <p className="rt-problem">{stage.message}</p>}
      </div>
      <button type="button" className="rt-button" disabled={stage.at === 'reading'} onClick={() => picker.current?.click()}>Choose folder</button>
      <input ref={picker} type="file" hidden multiple {...{ webkitdirectory: '' }}
        onChange={(event) => { const list = event.target.files; if (list?.length) void show(fromPicker(list)); event.target.value = ''; }} />
    </div>}

    {project && <div className="rt-upload-preview">
      <div className="rt-upload-head">
        <label>Sandbox name<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
        <button type="button" className="rt-icon-button" aria-label="Cancel" onClick={() => setStage({ at: 'idle' })}><X size={15} /></button>
      </div>
      <dl className="rt-facts">
        <dt>Will upload</dt><dd>{plural(project.files.length, 'file')} · {size(project.total)}</dd>
        <dt>Stays here</dt><dd>
          {!project.skipped.ignored && !project.skipped.excluded && !project.skipped.secret.length && 'Nothing was left out.'}
          {project.skipped.ignored > 0 && <span>{plural(project.skipped.ignored, 'path')} ignored by .gitignore. </span>}
          {project.skipped.excluded > 0 && <span>{plural(project.skipped.excluded, 'dependency or build folder')} (node_modules, .git, dist…). </span>}
          {project.skipped.secret.length > 0 && <span>{plural(project.skipped.secret.length, 'credential file')}: <code>{project.skipped.secret.slice(0, 6).join(', ')}{project.skipped.secret.length > 6 ? ', …' : ''}</code></span>}
        </dd>
        <dt>Files</dt><dd className="rt-upload-files"><code>{project.files.slice(0, 12).map((item) => item.path).join('\n')}{project.files.length > 12 ? `\n… and ${(project.files.length - 12).toLocaleString()} more` : ''}</code></dd>
      </dl>
      {project.problems.map((problem) => <p key={problem} className="rt-problem">{problem}</p>)}
      {stage.at === 'failed' && <p className="rt-problem">{stage.message}</p>}
      <div className="rt-actions">
        <button type="button" className="rt-button primary" disabled={project.problems.length > 0 || !nameOk} onClick={() => void create(project)}><Upload size={13} /> Create sandbox</button>
        <button type="button" className="rt-button" onClick={() => setStage({ at: 'idle' })}>Cancel</button>
        {!nameOk && <small className="rt-muted">Name: letters, digits, spaces, and . _ - only.</small>}
      </div>
    </div>}

    {stage.at === 'working' && <p className="rt-upload-working">{stage.step}</p>}
  </div>;
}
