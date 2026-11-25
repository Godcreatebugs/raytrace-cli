"""Typed stdlib-only Python SDK for RayTrace's frozen /v1 API."""
from __future__ import annotations

from dataclasses import dataclass
import gzip
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
from typing import Any, Callable, Mapping
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_BASE_URL = 'https://api.raytracer.si'
TERMINAL_STATES = frozenset({'completed', 'cancelled', 'timed_out', 'interrupted'})
DEFAULT_EXCLUDED = frozenset({
    '.git', '.raytace', '.raytrace', '.ssh', '.aws', '.azure', '.config',
    '.claude', '.codex', '.docker', '.kube', '.gnupg', 'node_modules',
    '.venv', '__pycache__', '.next', 'dist', 'coverage', '.DS_Store',
})
# Files that usually hold credentials, never uploaded (the same rules as the
# CLI's `raytrace sandbox create`). Compared in lower case.
SECRET_NAMES = frozenset({
    '.npmrc', '.netrc', '.pypirc', '.htpasswd', '.dockercfg', 'credentials', 'credentials.json', 'credentials.ini',
    'auth.json', 'service-account.json', 'service_account.json', 'serviceaccountkey.json',
    'client_secret.json', 'client_secrets.json', 'token.json', 'id_rsa', 'id_dsa', 'id_ecdsa',
    'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', 'known_hosts',
})
SECRET_EXTENSIONS = ('.pem', '.key', '.p12', '.pfx')


def is_secret_file(name: str) -> bool:
    lower = name.lower()
    return (lower.startswith('.env') or lower.startswith('.secret')
            or lower.endswith(SECRET_EXTENSIONS) or lower in SECRET_NAMES)


class RayTraceError(RuntimeError):
    def __init__(self, message: str, *, status: int = 0, code: str | None = None,
                 topup_url: str | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.topup_url = topup_url
        self.body = body
        # Set when create(connect=True) made the sandbox but could not connect it.
        self.sandbox: Any = None


@dataclass(frozen=True)
class CommandResult:
    command_id: str
    state: str
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool = False
    output_truncated: bool = False


def build_tar_gz(files: Mapping[str, str | bytes]) -> bytes:
    """Packs `{relative_path: content}` into a normalized `.tar.gz` archive."""
    return _build_tar_gz(files)


def _build_tar_gz(files: Mapping[str, str | bytes], modes: Mapping[str, int] | None = None) -> bytes:
    if not files:
        raise ValueError('Archive must contain at least one file')
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode='w') as tar:
            for raw_path, content in files.items():
                rel = str(raw_path).lstrip('/')
                if not rel or '..' in Path(rel).parts:
                    raise ValueError(f'Invalid archive path: {raw_path}')
                data = content.encode('utf-8') if isinstance(content, str) else bytes(content)
                info = tarfile.TarInfo(rel)
                info.size = len(data)
                info.mode = modes.get(raw_path, 0o644) if modes is not None else 0o644
                info.uid = 1000
                info.gid = 1000
                tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# git transports a repository URL may use: https and ssh only, so a URL such
# as ext::<command> can never run a program.
_GIT_ENV = {'GIT_ALLOW_PROTOCOL': 'https:ssh', 'GIT_TERMINAL_PROMPT': '0'}
_GITHUB_SHORTHAND = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
_HOST_PATH = re.compile(r'^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/[^\s:]+$')
_URL = re.compile(r'^(https://\S+|ssh://\S+|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:\S+)$')


def repo_url(repo: str) -> str:
    """The clone URL for `repo`: an https or ssh URL as given, host/owner/name over https, or GitHub's owner/name."""
    value = str(repo or '').strip()
    if _GITHUB_SHORTHAND.match(value):
        return f"https://github.com/{re.sub(r'[.]git$', '', value)}.git"
    if _HOST_PATH.match(value):
        return f'https://{value}'
    if _URL.match(value):
        return value
    raise ValueError(f'Unsupported repo "{value}": use an https or ssh URL, or owner/name for GitHub')


def repo_name(repo: str) -> str:
    """The name a repository gives a sandbox: its last path segment, without .git."""
    parts = [p for p in re.split(r'[/:]', str(repo).rstrip('/')) if p]
    return re.sub(r'[.]git$', '', parts[-1]) if parts else 'sandbox'


# GitHub's rules for account and repository names (RayTrace's API checks the same).
_GITHUB_NAME = re.compile(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}')
_GITHUB_URL = re.compile(r'(?:https://github\.com/|ssh://git@github\.com/|git@github\.com:)?([^/\s]+/[^/\s]+?)(?:\.git)?/?',
                         re.IGNORECASE)
_GIT_REF = re.compile(r'(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}')
_GIT_COMMIT = re.compile(r'[0-9a-f]{40}|[0-9a-f]{64}')


def github_repo(repo: str | None) -> str | None:
    """owner/name for a GitHub repository given as owner/name or a github.com https or ssh URL; None for anything else."""
    found = _GITHUB_URL.fullmatch(str(repo or '').strip())
    name = found.group(1) if found else None
    if not name or not _GITHUB_NAME.fullmatch(name) or name.split('/')[1] in ('.', '..'):
        return None
    return name


def work_branch(sandbox_id: str) -> str:
    """The branch a connected sandbox works on. Its agent may push only to raytrace/<these 8 characters>/..."""
    return f'raytrace/{str(sandbox_id)[4:12]}/work'


def _quote(value: str) -> str:
    return "'" + str(value).replace("'", "'\\''") + "'"


def connect_script(repo: str, sandbox_id: str, *, ref: str | None = None, commit: str | None = None,
                   directory: str = '/workspace') -> str:
    """The shell commands that turn a sandbox's uploaded files into a clone of
    `repo`: a Git repository whose origin is GitHub (the sandbox's relay opens
    it), lined up with `commit` (when GitHub has it), else `ref`, else the
    default branch, on a branch of its own. The uploaded files stay as they
    are; a file the upload left out (a secret, say) is taken from the commit,
    so it is not committed as deleted. A folder that is already a repository
    is left alone. The same script as the TypeScript SDK's connectScript."""
    name = github_repo(repo)
    if not name:
        raise ValueError(f'Not a GitHub repository: {repo} (use owner/name)')
    if ref is not None and not _GIT_REF.fullmatch(str(ref)):
        raise ValueError(f'Not a branch or tag name: {ref}')
    if commit is not None and not _GIT_COMMIT.fullmatch(str(commit)):
        raise ValueError(f'Not a commit id: {commit}')
    fallback = _quote(ref if ref is not None else 'HEAD')
    branch = work_branch(sandbox_id)
    fetch = (f'git fetch -q --depth 1 origin {commit} 2>/dev/null || git fetch -q --depth 1 origin {fallback}' if commit
             else f'git fetch -q --depth 1 origin {fallback}')
    return '\n'.join([
        'set -e',
        f'cd {_quote(directory)}',
        'if [ -e .git ]; then echo "RayTrace: $(pwd) is already a Git repository; left as it is." >&2; exit 0; fi',
        'git -c init.defaultBranch=main init -q',
        f'git remote add origin {_quote(f"https://github.com/{name}.git")}',
        fetch,
        'git reset -q FETCH_HEAD',
        'if [ -n "$(git ls-files --deleted)" ]; then git ls-files -z --deleted | '
        'git checkout -q --pathspec-from-file=- --pathspec-file-nul; fi',
        f'git checkout -q -b {_quote(branch)}',
        f'echo {_quote(f"Connected to {name} on branch {branch}. Push with: git push -u origin {branch}")}',
    ])


def archive_from_repo(repo: str, *, ref: str | None = None) -> bytes:
    """Clones `repo` (shallow; `ref` is a branch or tag) into a temporary folder,
    packs it like archive_from_directory, then deletes the clone. Uses the git on
    this machine and its credentials; it never waits for a password prompt."""
    tmp = tempfile.mkdtemp(prefix='raytrace-repo-')
    try:
        target = os.path.join(tmp, 'repo')
        args = ['git', 'clone', '--depth', '1', '--quiet']
        if ref:
            args += ['--branch', str(ref)]
        args += ['--', repo_url(repo), target]
        try:
            subprocess.run(args, check=True, capture_output=True, text=True, timeout=300,
                           env={**os.environ, **_GIT_ENV})
        except FileNotFoundError:
            raise RuntimeError('Creating a sandbox from a repo needs git installed on this machine') from None
        except subprocess.CalledProcessError as error:
            raise RuntimeError(f'Could not clone {repo}: {(error.stderr or "").strip()}') from None
        return archive_from_directory(target)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def archive_from_directory(directory: str | os.PathLike[str]) -> bytes:
    root = Path(directory).resolve()
    files: dict[str, bytes] = {}
    modes: dict[str, int] = {}
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if (any(part in DEFAULT_EXCLUDED for part in rel.parts) or path.is_symlink() or not path.is_file()
                or is_secret_file(path.name)):
            continue
        file_stat = path.stat()
        if file_stat.st_size > 25 * 1024 * 1024:
            raise ValueError(f'Project file {rel.as_posix()} exceeds the 25 MiB size limit')
        files[rel.as_posix()] = path.read_bytes()
        modes[rel.as_posix()] = file_stat.st_mode & 0o777
    return _build_tar_gz(files, modes)


class _Transport:
    def __init__(self, api_key: str, base_url: str, transport: Callable[..., tuple[int, Any]] | None = None):
        self.api_key = api_key
        self.base_url = base_url.rstrip('/')
        self._custom = transport

    def request(self, method: str, path: str, *, headers: dict[str, str] | None = None,
                body: Any = None, timeout: float = 120.0) -> tuple[int, Any]:
        req_headers = {'Authorization': f'Bearer {self.api_key}', 'User-Agent': 'raytrace-python-sdk/0.2.10',
                       **(headers or {})}
        raw_body: bytes | None
        if body is None:
            raw_body = None
        elif isinstance(body, (bytes, bytearray)):
            raw_body = bytes(body)
        else:
            req_headers.setdefault('Content-Type', 'application/json')
            raw_body = json.dumps(body).encode('utf-8')
        url = f'{self.base_url}{path if path.startswith("/") else "/" + path}'
        if self._custom is not None:
            status, data = self._custom(method, url, req_headers, raw_body)
        else:
            req = urllib.request.Request(url, method=method, data=raw_body, headers=req_headers)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    status = resp.status
                    raw = resp.read()
                    data = json.loads(raw) if raw else None
            except urllib.error.HTTPError as err:
                status = err.code
                raw = err.read()
                try:
                    data = json.loads(raw) if raw else {'error': str(err)}
                except ValueError:
                    data = {'error': raw.decode('utf-8', 'replace') or str(err)}
        if not 200 <= status < 300:
            msg = data.get('error') if isinstance(data, dict) else f'RayTrace API error (HTTP {status})'
            raise RayTraceError(
                msg or f'HTTP {status}',
                status=status,
                code=data.get('code') if isinstance(data, dict) else None,
                topup_url=data.get('topup_url') if isinstance(data, dict) else None,
                body=data,
            )
        return status, data


class SandboxRepos:
    """The GitHub repositories a sandbox's git may open (through its relay, with the org's GitHub App)."""

    def __init__(self, transport: _Transport, sandbox_id: str):
        self._t = transport
        self._path = f'/v1/sandboxes/{urllib.parse.quote(sandbox_id)}/repos'

    def list(self) -> list[str]:
        _, data = self._t.request('GET', self._path)
        return list((data or {}).get('repos') or [])

    def set(self, repos: list[str]) -> list[str]:
        """Replaces the whole list; [] takes them all off. Each must be one the org's GitHub App is installed on."""
        if isinstance(repos, (str, bytes)) or not isinstance(repos, (list, tuple)):
            raise TypeError('repos.set takes a list of GitHub repositories (owner/name)')
        names = []
        for repo in repos:
            name = github_repo(repo)
            if not name:
                raise ValueError(f'Not a GitHub repository: {repo} (use owner/name)')
            names.append(name)
        _, data = self._t.request('PUT', self._path, body={'repos': names})
        return list((data or {}).get('repos') or [])


class Sandbox:
    def __init__(self, transport: _Transport, info: dict[str, Any]):
        self._t = transport
        self.id: str = info['id']
        self.info: dict[str, Any] = dict(info)
        self.repos = SandboxRepos(transport, self.id)
        # Set by create(connect=True): {'repo', 'branch', 'output'}.
        self.git: dict[str, str] | None = None

    @property
    def status(self) -> str:
        return str(self.info.get('status') or '')

    @property
    def size(self) -> str:
        return str(self.info.get('size') or 'small')

    def exec(self, command: str, *, timeout_seconds: int = 120, poll_interval: float = 0.25,
             request_id: str | None = None) -> CommandResult:
        req_id = request_id or f'req_{uuid.uuid4().hex[:24]}'
        _, job = self._t.request(
            'POST', f'/v1/sandboxes/{urllib.parse.quote(self.id)}/commands',
            body={'command': command, 'timeout_seconds': timeout_seconds, 'request_id': req_id},
        )
        while job.get('state') not in TERMINAL_STATES or job.get('recovery_pending'):
            time.sleep(poll_interval)
            _, job = self._t.request(
                'GET',
                f'/v1/sandboxes/{urllib.parse.quote(self.id)}/commands/{urllib.parse.quote(job["command_id"])}',
            )
        return CommandResult(
            command_id=job['command_id'],
            state=job['state'],
            exit_code=job.get('exit_code'),
            stdout=job.get('stdout') or '',
            stderr=job.get('stderr') or '',
            timed_out=bool(job.get('timed_out')),
            output_truncated=bool(job.get('output_truncated')),
        )

    def connect_repo(self, repo: str, *, ref: str | None = None, commit: str | None = None,
                     timeout_seconds: int = 300, poll_interval: float = 0.25) -> dict[str, str]:
        """Connects this sandbox to a GitHub repository: attaches it (keeping any
        already attached), then makes /workspace a clone of it on the branch the
        agent may push to (work_branch). `commit` lines the files up with that
        commit when GitHub has it, else `ref`, else the default branch."""
        name = github_repo(repo)
        if not name:
            raise ValueError(f'Not a GitHub repository: {repo} (use owner/name)')
        script = connect_script(name, self.id, ref=ref, commit=commit)
        attached = self.repos.list()
        if name.lower() not in (other.lower() for other in attached):
            self.repos.set([*attached, name])
        result = self.exec(script, timeout_seconds=timeout_seconds, poll_interval=poll_interval)
        if result.exit_code != 0:
            why = result.stderr.strip() or result.stdout.strip() or f'the setup command ended {result.state}'
            raise RayTraceError(f'Could not connect {self.id} to {name}: {why}', body=result)
        return {'repo': name, 'branch': work_branch(self.id), 'output': result.stdout}

    def start(self, *, size: str | None = None, wait_for_restore: bool = True,
              poll_interval: float = 0.5) -> dict[str, Any]:
        body = {'size': size} if size else {}
        status, data = self._t.request('POST', f'/v1/sandboxes/{urllib.parse.quote(self.id)}/start', body=body)
        if isinstance(data, dict):
            self.info.update(data)
        if status == 202 and isinstance(data, dict) and data.get('restoring') and wait_for_restore:
            while True:
                time.sleep(poll_interval)
                _, items = self._t.request('GET', '/v1/sandboxes')
                current = next((x for x in (items or []) if x.get('id') == self.id), None)
                if not current:
                    raise RayTraceError(f'Sandbox {self.id} disappeared while restoring', status=404)
                self.info = current
                if current.get('restore_error'):
                    raise RayTraceError(f"Archive restore failed: {current['restore_error']}", status=500, body=current)
                if not current.get('restoring') and current.get('status') in ('running', 'archived'):
                    break
        return self.info

    def stop(self) -> dict[str, Any]:
        _, data = self._t.request('POST', f'/v1/sandboxes/{urllib.parse.quote(self.id)}/stop')
        if isinstance(data, dict):
            self.info.update(data)
        return self.info

    def keep_alive(self, minutes: int | float) -> dict[str, Any]:
        _, data = self._t.request('POST', f'/v1/sandboxes/{urllib.parse.quote(self.id)}/keep-alive',
                                  body={'minutes': minutes})
        return data

    def destroy(self, *, keep_traces: bool = False) -> dict[str, Any]:
        qs = '?keep_traces=1' if keep_traces else ''
        _, data = self._t.request('DELETE', f'/v1/sandboxes/{urllib.parse.quote(self.id)}{qs}')
        self.info['status'] = 'deleted'
        return data


class _SandboxesResource:
    def __init__(self, transport: _Transport):
        self._t = transport

    def list(self) -> list[Sandbox]:
        _, items = self._t.request('GET', '/v1/sandboxes')
        return [Sandbox(self._t, item) for item in (items or [])]

    def get(self, sandbox_id: str) -> Sandbox:
        for sb in self.list():
            if sb.id == sandbox_id:
                return sb
        raise RayTraceError(f'Sandbox not found: {sandbox_id}', status=404)

    def create(self, *, name: str | None = None, size: str = 'small', archive: bytes | None = None,
               files: Mapping[str, str | bytes] | None = None, directory: str | os.PathLike[str] | None = None,
               repo: str | None = None, ref: str | None = None, connect: bool = False,
               idempotency_key: str | None = None) -> Sandbox:
        """With connect=True and `repo` a GitHub repository: after the upload,
        attach it and make /workspace a clone of it on the branch the agent may
        push to (see Sandbox.connect_repo). With `directory` or `files`, those
        are what is uploaded and `repo` is only what it is connected to."""
        if connect:
            # Checked before anything is uploaded: connect_script raises on a ref it would not run.
            if not github_repo(repo):
                raise ValueError('connect needs repo: a GitHub repository, as owner/name')
            connect_script(repo, '', ref=ref)
        payload = archive
        if payload is None:
            if files is not None:
                payload = build_tar_gz(files)
            elif directory is not None:
                payload = archive_from_directory(directory)
            elif repo is not None:
                payload = archive_from_repo(repo, ref=ref)
            else:
                raise ValueError('Provide one of archive, files, directory, or repo')
        derived = name or (repo_name(repo) if repo else 'sandbox')
        clean_name = re.sub(r'[^A-Za-z0-9._ -]', '-', derived)[:100] or 'sandbox'
        headers = {
            'Content-Type': 'application/gzip',
            'X-RayTrace-Name': clean_name,
            'X-RayTrace-Size': size,
        }
        if idempotency_key:
            headers['Idempotency-Key'] = idempotency_key
        _, data = self._t.request('POST', '/v1/sandboxes', headers=headers, body=payload)
        sandbox = Sandbox(self._t, data)
        if connect:
            try:
                sandbox.git = sandbox.connect_repo(repo, ref=ref)
            except (RayTraceError, ValueError, OSError) as error:
                # The sandbox exists either way: say so, and hand it over to retry or destroy.
                status = error.status if isinstance(error, RayTraceError) else 0
                failed = RayTraceError(f'Sandbox {sandbox.id} was created, but '
                                       + re.sub(r'^Could not', 'could not', str(error)), status=status,
                                       code=getattr(error, 'code', None),
                                       topup_url=getattr(error, 'topup_url', None),
                                       body=getattr(error, 'body', None))
                failed.sandbox = sandbox
                raise failed from error
        return sandbox


class _UsageResource:
    def __init__(self, transport: _Transport):
        self._t = transport

    def get(self, *, days: int = 30) -> dict[str, Any]:
        _, data = self._t.request('GET', f'/v1/usage?days={int(days)}')
        return data


class _ApiKeysResource:
    def __init__(self, transport: _Transport):
        self._t = transport

    def create(self, name: str) -> dict[str, Any]:
        _, data = self._t.request('POST', '/v1/api-keys', body={'name': name})
        return data

    def list(self) -> list[dict[str, Any]]:
        _, data = self._t.request('GET', '/v1/api-keys')
        return (data or {}).get('keys', [])

    def revoke(self, key_id: str) -> dict[str, Any]:
        _, data = self._t.request('DELETE', f'/v1/api-keys/{urllib.parse.quote(key_id)}')
        return data


class RayTrace:
    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 transport: Callable[..., tuple[int, Any]] | None = None):
        key = api_key or os.environ.get('RAYTRACE_API_KEY')
        if not key:
            raise ValueError('RayTrace API key is required (pass api_key= or set RAYTRACE_API_KEY)')
        url = base_url or os.environ.get('RAYTRACE_API_URL') or DEFAULT_BASE_URL
        self._t = _Transport(key, url, transport=transport)
        self.sandboxes = _SandboxesResource(self._t)
        self.usage = _UsageResource(self._t)
        self.api_keys = _ApiKeysResource(self._t)
