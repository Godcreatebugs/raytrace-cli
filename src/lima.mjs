// Lima, which runs the Linux VM local sandboxes live in, and the checks made
// before one is created (`raytrace sandbox create --local`, `raytrace doctor`).
//
// A Lima the user installed is used when it is recent enough. Otherwise
// RayTrace downloads Lima's own release for this OS and CPU into
// ~/.raytrace/lima/<version>, after asking: no admin rights, nothing outside
// that folder. The archive is checked against the checksum pinned here, not
// one fetched beside it, so a changed release is refused. Lima keeps its VMs
// in ~/.lima either way.
//
// What cannot be downloaded is named with the command that installs it: QEMU
// on Linux (and on macOS before 13.5) comes from the system's package manager.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { paths } from './paths.mjs';
import { portInUse } from './proxy-process.mjs';

export const LIMA_VERSION = '2.2.1';
// Lima's release archives for each host, and their SHA-256 from the release's SHA256SUMS.
const RELEASES = {
  'darwin-arm64': ['Darwin-arm64', '9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e'],
  'darwin-x64': ['Darwin-x86_64', '6b776e4bc41f358e6ee01fefcc78e2eb26f11635a0fcff632234af77a566c6c4'],
  'linux-arm64': ['Linux-aarch64', 'fbcf4d127936666aa2cf6013b663c250431f2a59394757b404070f8d6a160e10'],
  'linux-x64': ['Linux-x86_64', 'b391ac7fcac2b2a5a1628107756463188ded4d18d3104a40a66a8bb6fec01bcb'],
};
// The oldest Lima of the user's own that is used; an older one is left alone and the managed one used.
const MINIMUM = [2, 0];
const MANAGED = join(paths.home, 'lima', LIMA_VERSION);
const MANAGED_LIMACTL = join(MANAGED, 'bin', 'limactl');
// What the sandbox VM forwards to this machine: the evidence viewer.
const VIEWER_PORT = 8798;

function version(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
  return match ? match.slice(1).map(Number) : null;
}
const atLeast = (have, want) => have[0] > want[0] || (have[0] === want[0] && have[1] >= want[1]);
const onPath = (name) => !spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' }).status;

/** The limactl to run, and where it came from; null when there is none yet. */
export function findLima() {
  const own = version('limactl');
  if (own && atLeast(own, MINIMUM)) return { binary: 'limactl', version: own.join('.'), source: 'installed' };
  if (existsSync(MANAGED_LIMACTL) && version(MANAGED_LIMACTL)) return { binary: MANAGED_LIMACTL, version: LIMA_VERSION, source: 'managed', old: own?.join('.') };
  return own ? { binary: null, old: own.join('.') } : null;
}

export const canDownload = () => Boolean(RELEASES[`${process.platform}-${process.arch}`]);

/** Lima's release for this machine, downloaded, checked and unpacked into ~/.raytrace/lima. */
export async function downloadLima(say) {
  const [name, sha256] = RELEASES[`${process.platform}-${process.arch}`];
  const url = `https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/lima-${LIMA_VERSION}-${name}.tar.gz`;
  say(`Downloading Lima ${LIMA_VERSION} for ${name}...`);
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(300_000) }); } catch (error) {
    throw new Error(`Could not download Lima (${error.message}). Check your connection, or install Lima yourself: https://lima-vm.io/docs/installation/`);
  }
  if (!response.ok) throw new Error(`Could not download Lima: HTTP ${response.status} from ${url}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== sha256) {
    throw new Error(`The Lima download did not match its pinned checksum, so it was not used. Install Lima yourself: https://lima-vm.io/docs/installation/`);
  }
  // Unpacked beside the final folder and moved over, so a half-unpacked one is never used.
  const staging = `${MANAGED}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const file = join(staging, 'lima.tar.gz');
  writeFileSync(file, archive);
  const unpacked = spawnSync('tar', ['-xzf', file, '-C', staging], { encoding: 'utf8' });
  if (unpacked.status !== 0) throw new Error(`Could not unpack Lima: ${unpacked.stderr || unpacked.error?.message}`);
  rmSync(file);
  rmSync(MANAGED, { recursive: true, force: true });
  renameSync(staging, MANAGED);
  if (!version(MANAGED_LIMACTL)) throw new Error(`The downloaded Lima does not run on this machine (${MANAGED_LIMACTL}).`);
  say(`Lima ${LIMA_VERSION} is in ${MANAGED}`);
  return { binary: MANAGED_LIMACTL, version: LIMA_VERSION, source: 'managed' };
}

function macVersion() {
  const shown = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  return shown.split('.').map(Number);
}
const qemu = () => (process.arch === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64');

/**
 * What stands between this machine and a local sandbox, as rows of
 * {ok: true | false | null (a warning), label, detail, fix?}. Lima itself is
 * reported, not fetched: create offers the download.
 */
export async function checks({ vmRunning = false, runInVm = null } = {}) {
  const rows = [];
  const row = (ok, label, detail, fix) => rows.push({ ok, label, detail, fix });
  const platform = process.platform;

  if (platform === 'win32') row(null, 'platform', 'Windows: local sandboxes are experimental here (Lima on Windows is)');
  else if (platform !== 'darwin' && platform !== 'linux') row(false, 'platform', `${platform} is not supported for local sandboxes`);

  const lima = findLima();
  if (lima?.binary) row(true, 'lima', `${lima.version} (${lima.source === 'managed' ? `downloaded by RayTrace, ${MANAGED}` : 'installed'})`);
  else if (canDownload()) {
    row(null, 'lima', `${lima?.old ? `${lima.old} is older than ${MINIMUM.join('.')}` : 'not installed'}; RayTrace downloads Lima ${LIMA_VERSION} on the first \`raytrace sandbox create --local\``);
  } else {
    row(false, 'lima', lima?.old ? `${lima.old} is older than ${MINIMUM.join('.')}` : 'not installed', 'install Lima: https://lima-vm.io/docs/installation/');
  }

  if (platform === 'darwin') {
    const [major, minor = 0] = macVersion();
    // Lima uses Apple's own virtualization (vz) from macOS 13.5; before that, QEMU.
    if (major > 13 || (major === 13 && minor >= 5)) row(true, 'virtualization', `macOS ${major}.${minor}: Apple Virtualization, nothing to install`);
    else if (onPath(qemu())) row(true, 'virtualization', `macOS ${major}.${minor}: QEMU`);
    else row(false, 'virtualization', `macOS ${major}.${minor} needs QEMU for the VM`, 'brew install qemu');
  } else if (platform === 'linux') {
    row(onPath(qemu()) ? true : false, 'qemu', onPath(qemu()) ? qemu() : `${qemu()} not found`,
      'install QEMU: sudo apt install qemu-system   (Fedora: sudo dnf install qemu-kvm; Arch: sudo pacman -S qemu-full)');
    if (!existsSync('/dev/kvm')) row(null, 'kvm', 'no /dev/kvm: the VM will be very slow (turn on virtualization, or nested virtualization in a VM)');
    else {
      try { accessSync('/dev/kvm', constants.R_OK | constants.W_OK); row(true, 'kvm', '/dev/kvm'); }
      catch { row(false, 'kvm', 'no access to /dev/kvm', 'sudo usermod -aG kvm $USER, then log out and in again'); }
    }
  }

  // The VM forwards the evidence viewer here; while it runs, the port is its own.
  if (!vmRunning && await portInUse(VIEWER_PORT)) {
    row(false, 'port 8798', 'in use; the evidence viewer needs it', 'stop what holds it (another Lima VM? limactl list)');
  }
  const gib = totalmem() / 1024 ** 3;
  if (gib < 8) row(null, 'memory', `${gib.toFixed(0)} GiB; the VM takes 4 GiB while it runs`);

  if (vmRunning && typeof runInVm === 'function') {
    try {
      const docker = runInVm(['docker', 'info', '--format', '{{json .Runtimes}}'], { check: false });
      if (docker?.status === 0) {
        row(true, 'docker (in VM)', 'responding');
        const hasGvisor = typeof docker.stdout === 'string' && docker.stdout.includes('raytace-gvisor');
        row(hasGvisor ? true : false, 'raytace-gvisor', hasGvisor ? 'runtime registered' : 'runtime missing from Docker', 'run setup in VM');
      } else {
        row(false, 'docker (in VM)', 'not responding or daemon down', 'sudo systemctl restart docker in VM');
      }

      const runsc = runInVm(['/usr/local/bin/runsc', '--version'], { check: false });
      row(runsc?.status === 0 ? true : false, 'runsc (in VM)', runsc?.status === 0 ? String(runsc.stdout).trim().split('\n')[0] : 'missing from /usr/local/bin/runsc');

      for (const svc of ['collector', 'viewer', 'dns']) {
        const active = runInVm(['systemctl', 'is-active', `raytace-${svc}`], { check: false });
        const isOk = active?.status === 0 && String(active.stdout).trim() === 'active';
        row(isOk ? true : false, `raytace-${svc}`, isOk ? 'active' : `inactive (${String(active?.stdout ?? '').trim() || 'failed'})`, `sudo systemctl restart raytace-${svc}`);
      }

      const sock = runInVm(['test', '-S', '/run/raytace/events.sock'], { check: false });
      row(sock?.status === 0 ? true : false, 'collector socket', sock?.status === 0 ? '/run/raytace/events.sock exists' : 'missing /run/raytace/events.sock');
    } catch (err) {
      row(false, 'vm diagnostics', `could not inspect VM: ${err.message}`);
    }
  }

  return rows;
}
