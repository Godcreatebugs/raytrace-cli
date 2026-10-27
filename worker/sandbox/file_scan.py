"""The initial scan: how dangerous each file of an uploaded project is to
change, from 1 (ignore) to 5 (lock down). control_api.create() runs it on
the screened archive.

A file's level is the higher of two independent answers, and both are kept
with the words that explain them:

    reach    weighted blast radius in the import graph. Direct dependents
             count most; each extra hop decays, and entry or already
             sensitive dependents count more. Files are then banded by
             percentile within their own project, with absolute floors so
             a tiny project cannot manufacture a top level from two or
             three mutual imports.
    hazard   sensitivity, from both the path and what the code does.
             Secrets, migrations, deploy and destructive database work
             can be 5; credential, token, encryption, permission and
             payment operations can be 4; environment, subprocess,
             deletion and server code are 3. A Watch-level file with no
             like-named test is lifted to Review carefully, never to 5.

Tests, documentation, examples, assets and generated files are held at 2 or
below whatever imports them. Nothing here calls a model or runs project code.
The level is only a proposal: the dashboard lets its owner move any file.
"""
import bisect
import io
import json
import posixpath
import re
import tarfile
import time

VERSION = 'scan-v2'
REACH_DECAY = 0.55
MAX_READ = 1024 * 1024        # larger files are scored by path alone
MAX_MARKED = 256 * 1024       # how far into a file hazard markers are looked for
LARGE_LINES = 800

JS = ('.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts')
PY = ('.py',)
SHELL = ('.sh', '.bash', '.zsh')
ASSETS = ('png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'avif', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot',
          'mp3', 'mp4', 'webm', 'mov', 'wav', 'pdf', 'zip', 'gz')
SETTINGS = '{json,yaml,yml,toml,ini,env,txt,cfg,conf,properties}'


def _pattern(glob):
    """A glob as a regular expression over a whole project path. Without a
    slash it names a file in any folder; `re:` gives the expression itself."""
    if glob.startswith('re:'):
        return glob[3:]
    out, i = '', 0
    while i < len(glob):
        if glob.startswith('**/', i):
            out, i = out + '(?:.*/)?', i + 3
        elif glob.startswith('**', i):
            out, i = out + '.*', i + 2
        elif glob[i] == '*':
            out, i = out + '[^/]*', i + 1
        elif glob[i] == '{':
            end = glob.index('}', i)
            out, i = out + '(?:' + '|'.join(map(re.escape, glob[i + 1:end].split(','))) + ')', end + 1
        else:
            out, i = out + re.escape(glob[i]), i + 1
    return out if '/' in glob else '(?:.*/)?' + out


def _rules(table):
    return [(level, words, re.compile('|'.join(f'(?:{_pattern(g)})' for g in globs), re.I)) for level, words, globs in table]


# The first that matches is the most a file can be.
CEILINGS = _rules([
    (1, 'editor and linter settings', ['.gitignore', '.gitattributes', '.editorconfig', '.prettierrc*', '.prettierignore',
                                       '.oxfmtrc*', '.oxlintrc*', '.eslintrc*', '.eslintignore', 'eslint.config.*',
                                       '.npmignore', '.DS_Store']),
    (2, 'test', ['*.test.*', '*.spec.*', '*_test.py', '*_test.go', 'test_*.py', 'conftest.py', '**/__tests__/**', '**/test/**',
                 '**/tests/**', '**/e2e/**', '**/fixtures/**', '**/__mocks__/**']),
    (2, 'documentation', ['*.md', '*.mdx', '*.rst', '**/docs/**', 'LICENSE*', 'CHANGELOG*', 'NOTICE*',
                          r're:(?:.*/)?(?!(?:requirements|constraints)[^/]*\.txt$|CMakeLists\.txt$)[^/]*\.txt']),
    (2, 'example', ['**/examples/**', '**/example/**', '**/samples/**']),
    (2, 'generated file', ['*.min.js', '*.min.css', '*.map', '*.snap', '*.tsbuildinfo', '**/dist/**', '**/build/**']),
    (2, 'static asset', ['*.{' + ','.join(ASSETS) + '}']),
])
# The highest that matches is the least a file can be.
FLOORS = _rules([
    (5, 'holds secrets or credentials', [r're:(?:.*/)?\.env(?:\.(?!(?:example|sample|template|dist|defaults)$)[^/]*)?',
                                          '*.{pem,key,p12,pfx,keystore,jks}', 'id_rsa*', 'id_ed25519*', 'credentials',
                                          'credentials.*', '*secret*.' + SETTINGS, '*credentials*.' + SETTINGS,
                                          'service-account*.json', '.npmrc', '.netrc', '.pypirc']),
    (5, 'database migration', ['**/migrations/**', '**/migrate/**', '**/alembic/versions/**']),
    (5, 'deploy or CI configuration', ['Dockerfile', 'Dockerfile.*', '*.dockerfile', 'docker-compose*.{yml,yaml}',
                                       'compose.{yml,yaml}', 'vercel.{json,ts}', 'fly.toml', 'netlify.toml', 'render.yaml',
                                       'Procfile', 'serverless.{yml,yaml}', 'cloudbuild.{yml,yaml}', 'app.yaml',
                                       'wrangler.{toml,json,jsonc}', '**/k8s/**', '**/kubernetes/**', '**/helm/**',
                                       '**/.github/workflows/*', '.gitlab-ci.yml', '**/.circleci/**', 'Jenkinsfile',
                                       '*.tf', '*.tfvars']),
    (4, 'dependency manifest or lockfile', ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                                            'yarn.lock', 'bun.lock', 'bun.lockb', 'pyproject.toml', 'requirements*.txt',
                                            'poetry.lock', 'uv.lock', 'Pipfile', 'Pipfile.lock', 'go.mod', 'go.sum',
                                            'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock', 'composer.{json,lock}',
                                            'pom.xml', 'build.gradle*']),
    (4, 'database schema', ['*.sql', '*.prisma', '*.graphql', '*.gql', '*.proto', '**/schema/**']),
    (4, 'build configuration', ['next.config.*', 'vite.config.*', 'tsconfig*.json', 'jsconfig.json', 'webpack*.{js,ts,cjs,mjs}',
                                'babel.config.*', '.babelrc*', 'rollup.config.*', 'esbuild.*', 'tailwind.config.*',
                                'postcss.config.*', 'turbo.json', 'nx.json', 'Makefile', 'setup.py', 'setup.cfg']),
    (4, 'authentication code', ['**/auth/**', r're:(?:.*/)?[^/]*(?:auth(?!or)|login|session|passw|permission)[^/]*\.[a-z]{2,4}']),
    (4, 'payments code', ['**/payment/**', '**/payments/**', '**/billing/**', '*stripe*.*', '*billing*.*', '*payment*.*']),
    (4, 'database access', ['**/db/**', '**/database/**', '**/models/**', '**/prisma/**']),
    (3, 'configuration', ['middleware.*', '**/config/**', '*.config.*', 'config.*', 'settings.py',
                          '.env.{example,sample,template,dist,defaults}']),
    (3, 'script', ['*.{sh,bash,zsh}', '**/scripts/**', '**/bin/**']),
])
# What a source file does, wherever it lives. A single dangerous operation
# makes the whole file sensitive: the guardrails this feeds are per file.
CONTENT_MARKERS = [(level, words, re.compile(expression, re.M)) for level, words, expression in [
    (5, 'contains credential material', r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk_live_[A-Za-z0-9]|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|"private_key"\s*:\s*"-----BEGIN'),
    (5, 'creates or rotates credentials', r'(?i)\bgenerateKeyPair(?:Sync)?\(|\bcreatePrivateKey\(|\bgenerate_key_pair\b|create_service_account_key|\brotate[A-Za-z0-9_]*\(?.{0,40}(?:credential|secret|api[_ ]?key)'),
    (5, 'destroys database data', r'(?i)\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b'),
    (4, 'verifies credentials or signatures', r'\bbcrypt\.compare|\bargon2\.verify|\bcheckpw\(|\bverify_password\b|\bcheck_password_hash\b|\bcompare_digest\(|\bverifySignature\b'),
    (4, 'signs or verifies tokens', r'\bjwt\.(?:sign|verify)\b|\bSignJWT\b|\bjwtVerify\b|\bjsonwebtoken\b'),
    (4, 'encrypts or decrypts data', r'\bcreateCipheriv\(|\bcreateDecipheriv\(|crypto\.subtle\.(?:encrypt|decrypt)\b|\bFernet\(|\bAES\.new\('),
    (4, 'charges or refunds payments', r'paymentIntents\.create|charges\.create|refunds\.create|checkout\.sessions\.create'),
    (4, 'checks permissions', r'\brequireAdmin\b|\bhasPermission\(|\bcheckPermission\b|\bpermission_required\b|\blogin_required\b'),
    (4, 'changes database tables', r'(?i)\bALTER\s+TABLE\b|\bDELETE\s+FROM\b'),
    (4, 'uses a security or payments library', r'''(?:\bfrom|\brequire\(|\bimport)\s*['"](?:stripe|bcrypt|bcryptjs|argon2|jsonwebtoken|jose|passport)['"]|^\s*(?:import|from)\s+(?:stripe|bcrypt|argon2|jwt|passlib)\b'''),
    (3, 'reads environment variables', r'process\.env\b|os\.environ\b|os\.getenv\('),
    (3, 'starts other programs', r'child_process|\bexecSync\(|\bspawn(?:Sync)?\(|\bsubprocess\.|os\.system\('),
    (3, 'deletes files', r'\brmSync\(|\bfs\.rm\(|\bunlinkSync\(|shutil\.rmtree\(|os\.remove\(|\brm -r'),
    (3, 'serves network requests', r'\bcreateServer\(|\.listen\(|\bapp\.run\(|serve_forever\(|uvicorn\.run\('),
]]
MARKERS = CONTENT_MARKERS
# Named so by convention: the program starts here.
ENTRY = re.compile(r'(?:src/)?(?:index|main|server|app|cli)\.(?:[cm]?[jt]sx?)|(?:main|manage|app|wsgi|asgi|__main__)\.py')
FRAMEWORK_ROOT = re.compile(r'(?:src/)?(?:app/(?:layout|page)|pages/(?:_app|_document|index)|middleware)\.[jt]sx?')
# Loaded by a framework, by a test runner or by hand, so nothing importing them means nothing.
FRAMEWORK_LOADED = re.compile(r'(?:.*/)?(?:(?:app|pages)/.*|[^/]*\.config\.[^/]*|[^/]*\.d\.ts)')
JS_IMPORTS = re.compile(r'''(?:\bimport|\bexport)\s[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]'''
                        r'''|\bimport\s*['"]([^'"\n]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)''')
PY_FROM = re.compile(r'^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([^\n#]*)', re.M)
PY_IMPORT = re.compile(r'^[ \t]*import[ \t]+([^\n#]+)', re.M)
TEST_STEM = re.compile(r'^(?:test_)?(.+?)(?:[._-](?:test|spec))?$')


def rules_level(path):
    """What the path alone says: (level or None, the words for it, 'ceiling' | 'floor' | None).
    Also how a file the agent creates later is scored, before anything imports it."""
    for level, words, pattern in CEILINGS:
        if pattern.fullmatch(path):
            return level, words, 'ceiling'
    best = None
    for level, words, pattern in FLOORS:
        if (best is None or level > best[0]) and pattern.fullmatch(path):
            best = (level, words, 'floor')
    return best or (None, None, None)


def _weighted_dependents(path, importers, weights):
    """(counted dependents, direct counted importers, weighted score).

    Breadth-first from the file through its importers. Shortest distance is
    what counts: direct dependents contribute their full dependent weight,
    each further hop is discounted by REACH_DECAY. Held files (tests, docs)
    are followed through but contribute nothing, matching the old count.
    """
    seen = {path: 0}
    queue = [path]
    counted = direct = 0
    score = 0.0
    for current in queue:
        distance = seen[current] + 1
        for importer in sorted(importers.get(current, ())):
            if importer in seen:
                continue
            seen[importer] = distance
            queue.append(importer)
            weight = weights.get(importer, 1.0)
            if weight:
                counted += 1
                direct += distance == 1
                score += weight * REACH_DECAY ** (distance - 1)
    return counted, direct, score


def _reach_level(score, percentile, direct, dependents, counted):
    """Reach band from a weighted score's percentile in this project.

    Percentiles spread even a tightly coupled project out; the absolute
    floors keep a handful of mutual imports from reaching the top bands.
    """
    if not dependents:
        return 1
    if percentile >= 97 and counted >= 10 and direct >= 3 and score >= 6:
        return 5
    if percentile >= 85 and counted >= 5 and (direct >= 2 or score >= 2.5):
        return 4
    if percentile >= 55 and (dependents >= 2 or score >= 1):
        return 3
    return 2


def _loose_json(text):
    """tsconfig.json and its kind allow comments and trailing commas."""
    try:
        return json.loads(text)
    except ValueError:
        try:
            return json.loads(re.sub(r',(\s*[}\]])', r'\1', re.sub(r'^\s*//.*$|/\*.*?\*/', '', text, flags=re.M | re.S)))
        except ValueError:
            return None


class _Resolver:
    """Turns what a file imports into the project files it means."""

    def __init__(self, paths, texts):
        self.paths = set(paths)
        # Folder -> (base folder, [(prefix, wildcard?, [target prefixes])]) from each tsconfig/jsconfig.
        self.aliases = {}
        for path in paths:
            if posixpath.basename(path) in ('tsconfig.json', 'jsconfig.json') and path in texts:
                options = (_loose_json(texts[path]) or {}).get('compilerOptions') or {}
                folder = posixpath.dirname(path)
                base = posixpath.normpath(posixpath.join(folder, options.get('baseUrl') or '.'))
                mapped = []
                for key, targets in (options.get('paths') or {}).items():
                    if isinstance(targets, list):
                        mapped.append((key.rstrip('*'), key.endswith('*'), [str(t).rstrip('*') for t in targets]))
                self.aliases[folder] = ('' if base == '.' else base, 'baseUrl' in options, mapped)

    def _file(self, target):
        target = posixpath.normpath(target)
        if target.startswith('..'):
            return None
        if target in self.paths:
            return target
        stem, extension = posixpath.splitext(target)
        # TypeScript is imported by the name it compiles to: ./store.js is store.ts.
        swapped = {'.js': ('.ts', '.tsx'), '.mjs': ('.mts',), '.cjs': ('.cts',), '.jsx': ('.tsx',)}.get(extension, ())
        for candidate in [stem + e for e in swapped] + [target + e for e in JS] + [f'{target}/index{e}' for e in JS]:
            if candidate in self.paths:
                return candidate
        return None

    def javascript(self, importer, name):
        folder = posixpath.dirname(importer)
        if name.startswith('.'):
            return self._file(posixpath.join(folder, name))
        if name.startswith('/'):
            return None
        # The nearest tsconfig above the importer decides what a bare name means.
        while True:
            if folder in self.aliases:
                base, has_base, mapped = self.aliases[folder]
                for prefix, wildcard, targets in mapped:
                    if name.startswith(prefix) if wildcard else name == prefix:
                        for target in targets:
                            found = self._file(posixpath.join(base, target + (name[len(prefix):] if wildcard else '')))
                            if found:
                                return found
                if has_base and (found := self._file(posixpath.join(base, name))):
                    return found
            if not folder:
                break
            folder = posixpath.dirname(folder)
        if name[:2] in ('@/', '~/'):
            return self._file(name[2:]) or self._file('src/' + name[2:])
        return None

    def _module(self, base, dotted):
        target = posixpath.normpath(posixpath.join(base, *dotted.split('.'))) if dotted else posixpath.normpath(base or '.')
        if target.startswith('..'):
            return None
        target = '' if target == '.' else target
        for candidate in (target + '.py', posixpath.join(target, '__init__.py')):
            if candidate in self.paths:
                return candidate
        return None

    def python(self, importer, dots, module, names):
        """Every project file `from <dots><module> import <names>` (or `import <module>`) loads."""
        folder = posixpath.dirname(importer)
        if dots:
            bases = [posixpath.normpath(posixpath.join(folder, *['..'] * (len(dots) - 1)))]
        else:
            # A script imports its neighbours by bare name; a package is imported from the root or src/.
            bases, at = [], folder
            while True:
                bases.append(at)
                if not at:
                    break
                at = posixpath.dirname(at)
            bases.append('src')
        found = []
        for base in bases:
            base = '' if base == '.' else base
            hit = self._module(base, module) if module else None
            # `from package import module` names a file too.
            parts = [self._module(base, '.'.join(filter(None, [module, name]))) for name in names]
            if hit or any(parts):
                found += [p for p in [hit, *parts] if p]
                break
        return found


def _imports(path, text, resolver):
    if path.endswith(JS):
        for match in JS_IMPORTS.finditer(text):
            target = resolver.javascript(path, match.group(1) or match.group(2) or match.group(3))
            if target:
                yield target
    elif path.endswith(PY):
        for dots, module, rest in PY_FROM.findall(text):
            names = [n.split(' as ')[0].strip() for n in rest.rstrip('\\ ').split(',')]
            yield from resolver.python(path, dots, module, [n for n in names if n.isidentifier()])
        for rest in PY_IMPORT.findall(text):
            for name in rest.split(','):
                name = name.split(' as ')[0].strip()
                if re.fullmatch(r'[\w.]+', name):
                    yield from resolver.python(path, '', name, [])


def _entry_points(paths, texts, resolver):
    """Files a manifest or a Dockerfile starts, and those named as the start by convention."""
    found = {}
    roots = {posixpath.dirname(p) for p in paths if posixpath.basename(p) in ('package.json', 'pyproject.toml')} | {''}
    for path in paths:
        folder, name = posixpath.split(path)
        in_root = next((path[len(root):].lstrip('/') for root in roots if not root or path.startswith(root + '/')
                        if ENTRY.fullmatch(path[len(root):].lstrip('/')) or FRAMEWORK_ROOT.fullmatch(path[len(root):].lstrip('/'))), None)
        if in_root:
            found.setdefault(path, 'where the program starts')
        if path not in texts:
            continue
        words = []
        if name == 'package.json':
            manifest = _loose_json(texts[path]) or {}
            binaries = manifest.get('bin')
            words += [manifest.get('main'), manifest.get('module')]
            words += list(binaries.values()) if isinstance(binaries, dict) else [binaries]
            for command in (manifest.get('scripts') or {}).values():
                words += re.split(r'[\s"\'=]+', str(command))
            reason = 'started by package.json'
        elif name.lower().startswith('dockerfile') or name.lower().endswith('.dockerfile'):
            for line in re.findall(r'^\s*(?:CMD|ENTRYPOINT)\s+(.*)$', texts[path], re.M | re.I):
                words += re.split(r'[\s"\',\[\]]+', line)
            reason = 'started by the Dockerfile'
        for word in words:
            if isinstance(word, str) and re.search(r'\.(?:[cm]?[jt]sx?|py|sh)$', word):
                target = resolver._file(posixpath.join(folder, word)) or resolver._file(word.lstrip('/'))
                if target:
                    found.setdefault(target, reason)
    return found


def scan(members):
    """`members`: (path, size, read) for each project file, where read() gives
    its bytes. Returns {'summary': ..., 'files': [one entry per file, most
    dangerous first]}."""
    started = time.monotonic()
    sizes, texts = {}, {}
    for path, size, read in members:
        sizes[path] = size
        name = posixpath.basename(path).lower()
        readable = path.endswith(JS + PY + SHELL + ('.sql',)) or name in ('package.json', 'tsconfig.json', 'jsconfig.json') \
            or name.startswith('dockerfile') or name.endswith('.dockerfile')
        if readable and size <= MAX_READ:
            texts[path] = read().decode('utf-8', 'replace')
    paths = sorted(sizes)
    ruled = {path: rules_level(path) for path in paths}
    held = {path for path in paths if ruled[path][2] == 'ceiling'}
    source = [path for path in paths if path.endswith(JS + PY)]
    counted = {'js': sum(1 for p in source if p.endswith(JS) and p not in held),
               'py': sum(1 for p in source if p.endswith(PY) and p not in held)}

    resolver = _Resolver(paths, texts)
    importers = {}  # file -> the files that import it
    edges = 0
    for path in source:
        if path in texts:
            for target in set(_imports(path, texts[path], resolver)):
                if target != path:
                    importers.setdefault(target, set()).add(path)
                    edges += 1
    entries = _entry_points(paths, texts, resolver)
    # A dependent's vote: entry points most, then files whose own path already
    # marks them sensitive. Held files (tests, docs) are followed, not counted.
    weights = {path: 0.0 if path in held else 1.5 if path in entries else 1.25
               if ruled[path][2] == 'floor' and (ruled[path][0] or 0) >= 4 else 1.0
               for path in paths}
    group_of = lambda path: 'py' if path.endswith(PY) else 'js'
    metrics = {}
    for path in importers:
        count, direct, score = _weighted_dependents(path, importers, weights)
        metrics[path] = {'dependents': count, 'direct': direct, 'score': score}
    for group in ('js', 'py'):
        scores = sorted(m['score'] for path, m in metrics.items() if group_of(path) == group and m['dependents'])
        for path, metric in metrics.items():
            if group_of(path) != group:
                continue
            metric['percentile'] = 100 if len(scores) <= 1 else round(
                100 * bisect.bisect_left(scores, metric['score']) / (len(scores) - 1))
    tested = {TEST_STEM.match(posixpath.basename(p).split('.')[0]).group(1) for p in paths if ruled[p][1] == 'test'}

    files, by_level = [], {level: 0 for level in range(1, 6)}
    for path in paths:
        rule_level, rule_words, rule_kind = ruled[path]
        text = texts.get(path)
        group = 'py' if path.endswith(PY) else 'js'
        reasons, flags, reach, hazard = [], [], None, None
        level = 1
        metric = metrics.get(path)
        if metric:
            count = metric['dependents']
            others = max(counted[group] - (path in source and path not in held), 1)
            reach = {'level': _reach_level(metric['score'], metric.get('percentile', 0), metric['direct'], count, counted[group]),
                     'dependents': count, 'of': others, 'direct': metric['direct'],
                     'score': round(metric['score'], 3), 'percentile': metric.get('percentile', 0)}
            if count:
                reasons.append(f'{count} of {others} source files depend on this'
                               + (f", {metric['direct']} directly" if metric['direct'] else ''))
        if path in entries:
            reach = {**(reach or {'dependents': 0, 'direct': 0, 'score': 0, 'percentile': 0,
                                   'of': max(counted[group] - 1, 1)}),
                     'level': max(4, (reach or {}).get('level', 1)), 'entry': True}
            reasons.insert(0, entries[path])
        elif starter := next((i for i in sorted(importers.get(path, ())) if i in entries), None):
            # One step from the start: few files import it, and the program does not come up without it.
            reach = {**reach, 'level': max(3, reach['level'])}
            reasons.append(f'loaded at startup by {starter}')
        if reach:
            level = reach['level']
        marked = []
        if text is not None and path.endswith(JS + PY + SHELL + ('.sql',)) and rule_kind != 'ceiling':
            found = [(marker_level, words) for marker_level, words, pattern in CONTENT_MARKERS
                     if pattern.search(text, 0, MAX_MARKED)]
            marked = list(dict.fromkeys(words for _, words in found))
            if found:
                content_level, content_words = max(found, key=lambda item: item[0])
                if not hazard and rule_kind != 'floor':
                    hazard = {'level': content_level, 'rule': content_words}
                elif rule_kind == 'floor' and content_level > rule_level:
                    hazard = {'level': content_level, 'rule': content_words}
        if rule_kind == 'floor':
            hazard = hazard if hazard and hazard['level'] > rule_level else {'level': rule_level, 'rule': rule_words}
        if hazard:
            if marked:
                hazard = {**hazard, 'does': marked}
            level = max(level, hazard['level'])
            reasons.append(hazard['rule'])
            reasons += [words for words in dict.fromkeys([rule_words] if rule_kind == 'floor' else []) if words != hazard['rule']]
            reasons += [words for words in marked if words not in reasons]
        if rule_kind == 'ceiling':
            level = min(level, rule_level)
            reasons.append(rule_words)
        untested = bool(path in source and path not in held and tested
                        and posixpath.basename(path).split('.')[0] not in tested)
        # Untested can turn Watch into Review carefully, but never creates a
        # Lock down on its own: most production files have no like-named test.
        if untested and reach and reach['level'] == 3 and rule_kind != 'ceiling' and level == 3:
            level = 4
            reasons.append('widely used and no like-named test covers it')
        if path in source and path not in held:
            if untested:
                flags.append('untested')
            if edges >= 10 and path not in importers and path not in entries and not FRAMEWORK_LOADED.fullmatch(path) \
                    and (text is None or '__main__' not in text):
                flags.append('unreferenced')
        if text is not None and text.count('\n') > LARGE_LINES:
            flags.append('large')
        by_level[level] += 1
        files.append({'path': path, 'level': level, 'reach': reach, 'hazard': hazard, 'flags': flags, 'reasons': reasons})
    files.sort(key=lambda f: (-f['level'], -((f['reach'] or {}).get('score', 0)),
                              -((f['reach'] or {}).get('dependents', 0)), f['path']))
    return {'files': files, 'summary': {'version': VERSION, 'files': len(files), 'by_level': by_level, 'edges': edges,
                                        'source_files': counted, 'scanned_ms': round((time.monotonic() - started) * 1000)}}


def scan_archive(data):
    """scan() over a project .tar.gz as control_api.screened() leaves it."""
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = [item for item in archive if item.isfile()]
        return scan((item.name, item.size, lambda item=item: archive.extractfile(item).read()) for item in members)


def created_entry(path):
    """The entry for a file that appeared after the scan: scored by its path alone."""
    level, words, kind = rules_level(path)
    return {'path': path, 'level': level or 1, 'reach': None, 'flags': ['created'],
            'hazard': {'level': level, 'rule': words} if kind == 'floor' else None,
            'reasons': ['created after the initial scan'] + ([words] if words else [])}
