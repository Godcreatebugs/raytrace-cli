#!/usr/bin/env python3
"""Build the pip wheels for `raytrace-cli`, one per platform.

Each wheel holds exactly what `npm publish` ships (from `npm pack`, so the
"files" list in package.json decides) plus an official Node.js build for that
platform, checked against nodejs.org's SHASUMS256.txt. pip picks the wheel
that matches the machine, so `pip install raytrace-cli` needs no Node.js.
(PyPI does not allow the name `raytrace`; the command is still `raytrace`.)

    python3 python/build_wheels.py                      # every platform, into python/dist/
    python3 python/build_wheels.py --platform darwin-arm64
    python3 python/build_wheels.py --tarball raytrace-cli-cli-0.10.0.tgz

Then: twine upload python/dist/*.whl

Needs only the Python standard library (and npm, unless --tarball is given).
Node.js downloads are cached in python/.cache/.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

NODE_VERSION = '24.22.2'

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, '.cache')

# Node.js platform -> wheel platform tag. Node 24 needs macOS 13.5 and glibc 2.28.
PLATFORMS = {
    'darwin-arm64': 'macosx_13_0_arm64',
    'darwin-x64': 'macosx_13_0_x86_64',
    'linux-x64': 'manylinux_2_28_x86_64',
    'linux-arm64': 'manylinux_2_28_aarch64',
    'win-x64': 'win_amd64',
    'win-arm64': 'win_arm64',
}

# A fixed time for every zip entry, so the same inputs build the same wheel.
STAMP = (2020, 1, 1, 0, 0, 0)


def fetch(url, dest):
    if not os.path.exists(dest):
        print(f'  downloading {url}')
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with urllib.request.urlopen(url) as response, open(dest + '.part', 'wb') as out:
            out.write(response.read())
        os.replace(dest + '.part', dest)
    return dest


def node_files(platform):
    """The node executable and Node's LICENSE for one platform, as bytes."""
    archive = f'node-v{NODE_VERSION}-{platform}.' + ('zip' if platform.startswith('win') else 'tar.gz')
    base = f'https://nodejs.org/dist/v{NODE_VERSION}'
    sums = open(fetch(f'{base}/SHASUMS256.txt', os.path.join(CACHE, f'SHASUMS256-{NODE_VERSION}.txt'))).read()
    expected = next((line.split()[0] for line in sums.splitlines() if line.endswith('  ' + archive)), None)
    if not expected:
        sys.exit(f'{archive} is not in SHASUMS256.txt for Node.js {NODE_VERSION}')
    path = fetch(f'{base}/{archive}', os.path.join(CACHE, archive))
    with open(path, 'rb') as f:
        actual = hashlib.sha256(f.read()).hexdigest()
    if actual != expected:
        os.remove(path)
        sys.exit(f'{archive}: checksum mismatch (got {actual}, want {expected}); removed the download, run again')

    top = archive.rsplit('.zip', 1)[0].rsplit('.tar.gz', 1)[0]
    if archive.endswith('.zip'):
        with zipfile.ZipFile(path) as z:
            return {'node.exe': z.read(f'{top}/node.exe'), 'LICENSE': z.read(f'{top}/LICENSE')}
    with tarfile.open(path) as t:
        return {'node': t.extractfile(f'{top}/bin/node').read(), 'LICENSE': t.extractfile(f'{top}/LICENSE').read()}


def npm_package(tarball):
    """{path: (bytes, mode)} for the files npm publishes."""
    if not tarball:
        out = tempfile.mkdtemp()
        print('  npm run build, npm pack')
        # The build first, on its own: run as npm pack's prepack, its output would land in the JSON.
        subprocess.run(['npm', 'run', 'build'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        result = subprocess.run(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', out], cwd=ROOT,
                                check=True, stdout=subprocess.PIPE, text=True)
        tarball = os.path.join(out, json.loads(result.stdout)[0]['filename'])
    files = {}
    with tarfile.open(tarball) as t:
        for member in t.getmembers():
            if member.isfile() and member.name.startswith('package/'):
                files[member.name[len('package/'):]] = (t.extractfile(member).read(), member.mode)
    return files


def pep440(version):
    """npm's 0.11.0-beta.1 is pip's 0.11.0b1; a plain x.y.z stays as it is."""
    match = re.fullmatch(r'(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.?(\d+))?', version)
    if not match:
        sys.exit(f'cannot turn npm version {version} into a pip version')
    release, pre, number = match.groups()
    return release + ({'alpha': 'a', 'beta': 'b', 'rc': 'rc'}[pre] + number if pre else '')


def record_line(name, data):
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
    return f'{name},sha256={digest},{len(data)}'


def build(platform, package, version, readme, out_dir):
    tag = f'py3-none-{PLATFORMS[platform]}'
    dist_info = f'raytrace_cli-{version}.dist-info'
    entries = []  # (name, bytes, mode)

    for name in ('__init__.py', '__main__.py'):
        with open(os.path.join(HERE, 'raytrace', name), 'rb') as f:
            entries.append((f'raytrace/{name}', f.read(), 0o644))
    for name, (data, mode) in sorted(package.items()):
        entries.append((f'raytrace/app/{name}', data, 0o755 if mode & 0o111 else 0o644))
    for name, data in node_files(platform).items():
        entries.append((f'raytrace/node/{name}', data, 0o755 if name.startswith('node') else 0o644))

    metadata = '\n'.join([
        'Metadata-Version: 2.1',
        'Name: raytrace-cli',
        f'Version: {version}',
        'Summary: See what your coding agent did: traces, tool calls, cost and step-by-step evidence for Claude Code and Codex.',
        'Home-page: https://raytracer.si',
        'License: MIT',
        'Requires-Python: >=3.8',
        'Classifier: License :: OSI Approved :: MIT License',
        'Classifier: Environment :: Console',
        'Description-Content-Type: text/markdown',
        '',
        readme,
    ])
    wheel = f'Wheel-Version: 1.0\nGenerator: raytrace build_wheels.py\nRoot-Is-Purelib: false\nTag: {tag}\n'
    entry_points = '[console_scripts]\nraytrace = raytrace.__main__:main\n'
    with open(os.path.join(ROOT, 'LICENSE'), 'rb') as f:
        license_text = f.read()
    entries += [
        (f'{dist_info}/METADATA', metadata.encode(), 0o644),
        (f'{dist_info}/WHEEL', wheel.encode(), 0o644),
        (f'{dist_info}/entry_points.txt', entry_points.encode(), 0o644),
        (f'{dist_info}/LICENSE', license_text, 0o644),
    ]

    path = os.path.join(out_dir, f'raytrace_cli-{version}-{tag}.whl')
    record = [record_line(name, data) for name, data, _ in entries] + [f'{dist_info}/RECORD,,']
    entries.append((f'{dist_info}/RECORD', ('\n'.join(record) + '\n').encode(), 0o644))
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name, STAMP)
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    print(f'  {os.path.relpath(path, ROOT)}  {os.path.getsize(path) / 1e6:.0f} MB')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--platform', action='append', choices=sorted(PLATFORMS), help='only this platform (repeatable)')
    parser.add_argument('--tarball', help='an existing npm pack .tgz instead of running npm pack')
    parser.add_argument('--out', default=os.path.join(HERE, 'dist'))
    args = parser.parse_args()

    package = npm_package(args.tarball)
    version = pep440(json.loads(package['package.json'][0])['version'])
    with open(os.path.join(HERE, 'README.md'), encoding='utf8') as f:
        readme = f.read()
    os.makedirs(args.out, exist_ok=True)
    print(f'raytrace {version} with Node.js {NODE_VERSION}')
    for platform in args.platform or PLATFORMS:
        build(platform, package, version, readme, args.out)


if __name__ == '__main__':
    main()
