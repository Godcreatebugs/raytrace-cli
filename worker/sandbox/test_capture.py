"""Raw-call context and failed execs. Run: python3 -B -m unittest discover -s worker/sandbox -p 'test_*.py'"""
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import collector  # noqa: E402
import engine  # noqa: E402
import setup  # noqa: E402

HERE = Path(__file__).parent


def attempt(pid, executable, argv):
    return {'kind': 'exec_attempt', 'pid': pid, 'ppid': 1, 'executable': executable, 'argv': argv,
            'timestamp_ns': '1794866886430727989', 'process_start_ns': '1794866886430553658', 'container_id': 'c' * 64,
            'markers': {'RAYTRACE_CALL_ID': 'call_1'}}


class TraceConfig(unittest.TestCase):
    def test_a_number_only_call_has_its_enter_point_with_the_same_context(self):
        config = setup.trace_config('aarch64', (HERE / 'syscall_catalog.sql').read_text(), '/run/x.sock')
        points = {point['name']: point for point in config['trace_session']['points']}
        for number in (34, 35, 38, 45, 46, 52, 53, 276):   # mkdirat unlinkat renameat truncate ftruncate fchmod fchmodat renameat2
            enter, leave = points[f'syscall/sysno/{number}/enter'], points[f'syscall/sysno/{number}/exit']
            self.assertEqual(enter['context_fields'], leave['context_fields'])
            self.assertIn('container_id', enter['context_fields'])
            self.assertIn('group_id', enter['context_fields'])
        # Typed points carry their own context, and the exec points are as they were.
        self.assertNotIn('syscall/openat/enter', points)
        self.assertNotIn('syscall/sysno/221/enter', points)


class RawCalls(unittest.TestCase):
    def setUp(self):
        self.engine = engine.Engine(':memory:', arch='aarch64', watch=False)

    def test_the_enter_event_is_taken_and_not_queued(self):
        self.assertTrue(self.engine.accept({'kind': 'syscall_enter', 'sysno': 35, 'container_id': 'c' * 64}))
        self.assertTrue(self.engine.inbox.empty())
        self.assertTrue(self.engine.accept({'kind': 'syscall_return', 'sysno': 35, 'container_id': 'c' * 64}))
        self.assertEqual(self.engine.inbox.qsize(), 1)

    def test_a_refused_delete_with_its_process_is_an_attempt_by_that_process(self):
        box = engine.Sandbox('c' * 64)
        box.workspace, box.guarded = '/nowhere', {'config/keys.js': 'watched'}
        box.processes[41] = {'start_ns': '5', 'ppid': 1, 'name': 'rm', 'argv': ['rm', 'config/keys.js'], 'call_id': 'call_9'}
        self.engine.numbered_call(box, {'kind': 'syscall_return', 'sysno': 35, 'errno': 13, 'pid': 41, 'ppid': 1,
                                        'process_start_ns': '5', 'timestamp_ns': '100', 'cwd': '/workspace'})
        (fact,) = self.engine.facts.values()
        self.assertEqual((fact['path'], fact['effect'], fact['intent'], fact['pid'], fact['call_id']),
                         ('config/keys.js', 'attempted', 'delete', 41, 'call_9'))
        self.assertEqual(box.raw[0]['who']['pid'], 41)


class WhoChangedIt(unittest.TestCase):
    """engine.look(): a change goes to the process that made it, not to
    whoever opened that name before."""
    def setUp(self):
        self.now = 1000.0
        self.engine = engine.Engine(':memory:', arch='aarch64', watch=False, clock=lambda: self.now)
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.box = engine.Sandbox('c' * 64)
        self.box.workspace, self.box.ip = self.folder.name, '172.30.60.3'
        self.write('keys.js', 'one')
        self.box.guarded = {'keys.js': 'watched'}
        self.box.photos['keys.js'] = engine.photo(self.folder.name, 'keys.js')
        for pid, name in ((10, 'python3'), (20, 'sed'), (30, 'truncate')):
            self.box.processes[pid] = {'start_ns': str(pid), 'ppid': 1, 'name': name, 'argv': [name], 'call_id': f'call_{pid}'}

    def write(self, name, text):
        (Path(self.folder.name) / name).write_text(text)

    def opened(self, pid, name='keys.js', flags=engine.O_TRUNC | 1):
        self.engine.opened(self.box, {'kind': 'open', 'pathname': '/workspace/' + name, 'flags': flags, 'errno': 0, 'pid': pid,
                                      'ppid': 1, 'process_start_ns': str(pid), 'timestamp_ns': str(time.time_ns()), 'sysno': 56})

    def call(self, pid, sysno, errno=0):
        self.engine.numbered_call(self.box, {'kind': 'syscall_return', 'sysno': sysno, 'errno': errno, 'pid': pid, 'ppid': 1,
                                             'process_start_ns': str(pid), 'timestamp_ns': str(time.time_ns()), 'cwd': '/workspace'})

    def changed(self, *words):
        self.engine.noticed(self.box, 'keys.js', list(words))
        self.engine.look(self.box, 'keys.js')
        return [fact for fact in self.engine.facts.values() if fact['kind'] == 'file' and fact['effect'] not in ('read', 'opened_for_writing')]

    def earlier_writer(self):
        """Process 10 writes the file, exits, and its change is recorded."""
        self.opened(10)
        self.write('keys.js', 'two')
        self.engine.exited(self.box, {'pid': 10, 'process_start_ns': '10'})
        (fact,) = self.changed('modify', 'close_write')
        self.assertEqual((fact['pid'], fact['certainty']), (10, 'confirmed'))
        self.engine.facts.clear()
        self.now += 60

    def test_a_writer_that_exited_is_not_credited_with_a_later_change(self):
        self.earlier_writer()
        self.write('keys.js', 'three')
        (fact,) = self.changed('modify', 'close_write')
        self.assertEqual((fact['pid'], fact['certainty']), (None, 'unattributed'))

    def test_exit_brings_the_look_forward(self):
        self.opened(10)
        self.box.due.clear()
        self.engine.exited(self.box, {'pid': 10, 'process_start_ns': '10'})
        self.assertIn('keys.js', self.box.due)

    def test_a_file_moved_over_it_is_the_movers(self):
        self.earlier_writer()
        self.opened(10)                 # another process still has the name open
        self.write('keys.js', 'by sed')
        self.call(20, 38)               # renameat
        (fact,) = self.changed('moved_to', 'close_write')
        self.assertEqual((fact['pid'], fact['call_id'], fact['certainty'], fact['basis']['syscall']), (20, 'call_20', 'confirmed', 'renameat'))

    def test_truncate_is_the_truncaters(self):
        self.earlier_writer()
        self.write('keys.js', '')
        self.call(30, 45)               # truncate
        (fact,) = self.changed('modify')
        self.assertEqual((fact['effect'], fact['pid'], fact['certainty']), ('emptied', 30, 'confirmed'))

    def test_a_write_through_a_symbolic_link_or_a_hard_link(self):
        for make in (lambda: os.symlink('keys.js', Path(self.folder.name) / 'alias'),
                     lambda: os.link(Path(self.folder.name) / 'keys.js', Path(self.folder.name) / 'alias')):
            with self.subTest():
                make()
                self.opened(20, 'alias')
                (Path(self.folder.name) / 'alias').write_text('through ' + str(self.now))
                (fact,) = self.changed('modify', 'close_write')
                self.assertEqual((fact['pid'], fact['certainty'], fact['basis']['resolution'], fact['basis']['via']), (20, 'confirmed', 'link', 'alias'))
                self.engine.facts.clear()
                self.box.aliases.clear()
                os.unlink(Path(self.folder.name) / 'alias')
                self.now += 60

    def test_a_link_out_of_the_project_is_not_followed(self):
        os.symlink('/etc/hostname', Path(self.folder.name) / 'alias')
        self.opened(20, 'alias')
        self.write('keys.js', 'someone')
        (fact,) = self.changed('modify', 'close_write')
        self.assertEqual(fact['certainty'], 'unattributed')

    def test_a_folder_argument_reaches_its_files_only_for_a_file_tool(self):
        self.box.guarded = {'src/a.js': 'watched', 'src/b.js': 'watched'}
        script = {'name': 'python3', 'argv': ['python3', 'run.py', 'src']}
        self.assertEqual(self.engine.named(self.box, script, '/workspace'), [])
        self.assertEqual(self.engine.named(self.box, {'name': 'rm', 'argv': ['rm', '-r', 'src']}, '/workspace'),
                         [('src/a.js', 'argv_folder'), ('src/b.js', 'argv_folder')])
        self.assertEqual(self.engine.named(self.box, {'name': 'python3', 'argv': ['python3', 'run.py', 'src/a.js']}, '/workspace'), [('src/a.js', 'argv')])

    def test_a_connection_to_its_own_address_is_the_sandbox_talking_to_itself(self):
        event = {'kind': 'connect', 'family': 'inet', 'ip': '172.30.60.3', 'port': 18082, 'errno': 0, 'pid': 10, 'ppid': 1, 'process_start_ns': '10'}
        self.engine.connected(self.box, event)
        self.assertEqual(self.engine.facts, {})
        self.engine.db = sqlite3.connect(':memory:')
        self.engine.db.executescript(engine.SCHEMA)
        self.engine.connected(self.box, {**event, 'ip': '172.30.60.9'})   # another machine in that range
        (fact,) = self.engine.facts.values()
        self.assertEqual(fact['outcomes'], {'refused_by_policy': 1})


class FailedExecs(unittest.TestCase):
    def setUp(self):
        self.attempts = collector.ExecAttempts()

    def test_an_attempt_no_program_follows_failed_when_the_process_exits(self):
        self.assertEqual(self.attempts.see(attempt(7, '/workspace/missing', ['/workspace/missing'])), [])
        self.assertEqual(self.attempts.see({'kind': 'exec_syscall_return', 'pid': 7, 'errno': 0}), [])
        (failed,) = self.attempts.see({'kind': 'process_exit', 'pid': 7, 'exit_code': 255})
        self.assertEqual((failed['kind'], failed['errno'], failed['argv'], failed['tried']),
                         ('exec_failed', None, ['/workspace/missing'], ['/workspace/missing']))
        self.assertEqual(failed['markers'], {'RAYTRACE_CALL_ID': 'call_1'})
        self.assertIn('inferred', failed)
        self.assertEqual(self.attempts.see({'kind': 'process_exit', 'pid': 7}), [])   # gVisor's second exit event

    def test_a_path_search_that_finds_the_program_is_no_failure(self):
        for folder in ('/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin'):
            self.assertEqual(self.attempts.see(attempt(9, folder + '/python3', ['python3', '-c', 'pass'])), [])
        self.assertEqual(self.attempts.see({'kind': 'exec_succeeded', 'pid': 9}), [])
        self.assertEqual(self.attempts.see({'kind': 'process_exit', 'pid': 9}), [])

    def test_a_path_search_that_finds_nothing_is_one_failure(self):
        for folder in ('/usr/local/bin', '/usr/bin', '/bin'):
            self.attempts.see(attempt(9, folder + '/nope', ['nope']))
        (failed,) = self.attempts.see({'kind': 'process_exit', 'pid': 9})
        self.assertEqual(failed['tried'], ['/usr/local/bin/nope', '/usr/bin/nope', '/bin/nope'])

    def test_a_failure_then_another_program_in_the_same_process(self):
        self.attempts.see(attempt(3, '/a', ['/a']))
        (failed,) = self.attempts.see(attempt(3, '/bin/b', ['/bin/b']))
        self.assertEqual(failed['argv'], ['/a'])
        self.assertEqual(self.attempts.see({'kind': 'exec_succeeded', 'pid': 3}), [])
        self.assertEqual(self.attempts.see({'kind': 'process_exit', 'pid': 3}), [])

    def test_a_failure_gvisor_reported_is_not_said_twice(self):
        self.attempts.see(attempt(4, '/a', ['/a']))
        self.assertEqual(self.attempts.see({'kind': 'exec_failed', 'pid': 4, 'errno': 14}), [])
        self.assertEqual(self.attempts.see({'kind': 'process_exit', 'pid': 4}), [])

    def test_the_failure_is_json_and_carries_no_raw_packet(self):
        self.attempts.see(attempt(5, '/a', ['/a']))
        (failed,) = self.attempts.see({'kind': 'process_exit', 'pid': 5})
        self.assertNotIn('raw_packet_base64', json.loads(json.dumps(failed)))



class EveryProjectFile(unittest.TestCase):
    """A project kept whole: what happens to any of its files is a fact, not
    only to the files on a list."""
    SID = 'rtp-' + 'a' * 32

    def setUp(self):
        self.now = 1000.0
        self.engine = engine.Engine(':memory:', arch='aarch64', watch=False, clock=lambda: self.now)
        self.folder = tempfile.TemporaryDirectory()
        self.state = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.addCleanup(self.state.cleanup)
        for name in ('CONTAINERS', 'GUARDRAILS', 'PROJECT_LIMIT'):
            self.addCleanup(setattr, engine, name, getattr(engine, name))
        engine.CONTAINERS = engine.GUARDRAILS = Path(self.state.name)
        for name, text in (('src/app.js', 'one'), ('config/payment-keys.js', 'key'), ('node_modules/x/index.js', 'x')):
            self.write(name, text)
        (Path(self.state.name) / ('c' * 64 + '.json')).write_text(json.dumps({'id': self.SID, 'workspace': self.folder.name}))
        self.box = engine.Sandbox('c' * 64)
        self.box.processes[10] = {'start_ns': '10', 'ppid': 1, 'name': 'sed', 'argv': ['sed'], 'call_id': 'call_10'}

    def write(self, name, text):
        path = Path(self.folder.name) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def opened(self, name, flags=engine.O_TRUNC | 1):
        self.engine.opened(self.box, {'kind': 'open', 'pathname': '/workspace/' + name, 'flags': flags, 'errno': 0, 'pid': 10,
                                      'ppid': 1, 'process_start_ns': '10', 'timestamp_ns': str(time.time_ns()), 'sysno': 56})

    def looked(self, name, *words, final=False):
        if words:
            self.engine.noticed(self.box, name, list(words))
        self.engine.look(self.box, name, final=final)
        return [(fact['path'], fact['effect'], fact['guard'], fact['call_id']) for fact in self.engine.facts.values() if fact['kind'] == 'file']

    def test_every_file_outside_the_skipped_folders_is_kept(self):
        self.engine.refresh(self.box)
        self.assertEqual(self.box.guarded, {'src/app.js': 'project', 'config/payment-keys.js': 'sensitive'})

    def test_the_lists_can_turn_it_off_and_a_huge_project_is_not_kept_whole(self):
        (Path(self.state.name) / (self.SID + '.json')).write_text(json.dumps({'restricted': [], 'watched': ['src/app.js'], 'project': False}))
        self.engine.refresh(self.box)
        self.assertEqual(self.box.guarded, {'src/app.js': 'watched'})
        engine.PROJECT_LIMIT = 1
        other = engine.Sandbox('c' * 64)
        (Path(self.state.name) / (self.SID + '.json')).unlink()
        self.engine.refresh(other)
        self.assertEqual(other.guarded, {})

    def test_an_edit_is_a_fact_and_a_read_is_counted(self):
        self.engine.refresh(self.box)
        self.opened('src/app.js', flags=0)
        self.assertEqual(self.looked('src/app.js'), [])
        self.opened('src/app.js')
        self.write('src/app.js', 'two')
        self.assertEqual(self.looked('src/app.js', 'modify', 'close_write'), [('src/app.js', 'changed', 'project', 'call_10')])
        # A sensitive file that was there from the start: its read is a fact too.
        self.opened('config/payment-keys.js', flags=0)
        self.assertIn(('config/payment-keys.js', 'read', 'sensitive', 'call_10'), self.looked('config/payment-keys.js'))

    def test_a_new_file_is_created_and_a_deleted_one_is_let_go(self):
        self.engine.refresh(self.box)
        self.opened('src/new.js', flags=engine.O_CREAT | 1)
        self.write('src/new.js', 'new')
        self.assertEqual(self.looked('src/new.js', 'create', 'close_write'), [('src/new.js', 'created', 'project', 'call_10')])
        (Path(self.folder.name) / 'src/new.js').unlink()
        self.assertIn(('src/new.js', 'deleted', 'project', None), self.looked('src/new.js', 'delete'))
        self.assertNotIn('src/new.js', self.box.guarded)
        self.assertNotIn('src/new.js', self.box.known)

    def test_the_temporary_file_of_a_save_leaves_no_line(self):
        self.engine.refresh(self.box)
        self.opened('src/sedAbC', flags=engine.O_CREAT | 1)
        self.write('src/sedAbC', 'two')
        os.rename(Path(self.folder.name) / 'src/sedAbC', Path(self.folder.name) / 'src/app.js')
        self.engine.numbered_call(self.box, {'kind': 'syscall_return', 'sysno': 38, 'errno': 0, 'pid': 10, 'ppid': 1,
                                             'process_start_ns': '10', 'timestamp_ns': str(time.time_ns()), 'cwd': '/workspace'})
        self.assertEqual(self.looked('src/app.js', 'moved_to'), [('src/app.js', 'changed', 'project', 'call_10')])
        self.assertEqual(len(self.looked('src/sedAbC', 'moved_from', final=True)), 1)
        self.assertNotIn('src/sedAbC', self.box.guarded)

    def test_a_file_or_a_folder_moved_in_is_kept(self):
        self.engine.refresh(self.box)
        self.write('src/moved.js', 'm')
        self.engine.appeared(self.box, 'src/moved.js', False)
        self.assertEqual(self.looked('src/moved.js', 'moved_to'), [('src/moved.js', 'created', 'project', None)])
        self.write('lib/deep/a.js', 'a')
        self.write('lib/node_modules/b.js', 'b')
        self.engine.appeared(self.box, 'lib', True)
        self.assertEqual({path for path in self.box.guarded if path.startswith('lib/')}, {'lib/deep/a.js'})
        # A kept file under a new name is the same file: no second line for it.
        os.rename(Path(self.folder.name) / 'src/app.js', Path(self.folder.name) / 'src/main.js')
        self.engine.appeared(self.box, 'src/main.js', False, 'src/app.js')
        self.assertEqual([fact for fact in self.looked('src/main.js', 'moved_to') if fact[0] == 'src/main.js'], [])

    RENAME = {'kind': 'syscall_return', 'sysno': 38, 'errno': 0, 'ppid': 1, 'cwd': '/workspace'}

    def test_a_new_file_saved_under_a_temporary_name_is_created_by_the_mover(self):
        """How an agent's Write tool saves: it writes a temporary file and
        renames it, while the snapshot hook's git renames its own index."""
        self.engine.refresh(self.box)
        self.engine.executed(self.box, {'pid': 30, 'ppid': 1, 'process_start_ns': '30', 'executable': '/usr/local/bin/node',
                                        'argv': ['node', engine.OWN_HOOK]})
        self.engine.executed(self.box, {'pid': 31, 'ppid': 30, 'process_start_ns': '31', 'executable': '/usr/bin/git', 'argv': ['git', 'add', '-A']})
        self.opened('src/new.js.tmp.1', flags=engine.O_CREAT | 1)
        self.write('src/new.js.tmp.1', 'new')
        os.rename(Path(self.folder.name) / 'src/new.js.tmp.1', Path(self.folder.name) / 'src/new.js')
        for pid in (31, 10):
            self.engine.numbered_call(self.box, {**self.RENAME, 'pid': pid, 'process_start_ns': str(pid), 'timestamp_ns': str(time.time_ns())})
        self.engine.appeared(self.box, 'src/new.js', False, 'src/new.js.tmp.1')
        self.looked('src/new.js', 'moved_to')
        (fact,) = self.engine.facts.values()
        self.assertEqual((fact['path'], fact['effect'], fact['certainty'], fact['pid']), ('src/new.js', 'created', 'confirmed', 10))

    def test_the_snapshot_hook_reading_every_file_is_counted_not_listed(self):
        self.engine.refresh(self.box)
        self.engine.executed(self.box, {'pid': 30, 'ppid': 1, 'process_start_ns': '30', 'executable': '/usr/local/bin/node',
                                        'argv': ['node', engine.OWN_HOOK]})
        self.engine.executed(self.box, {'pid': 31, 'ppid': 30, 'process_start_ns': '31', 'executable': '/usr/bin/git', 'argv': ['git', 'add', '-A']})
        read = {'kind': 'open', 'pathname': '/workspace/config/payment-keys.js', 'flags': 0, 'errno': 0, 'ppid': 30,
                'timestamp_ns': str(time.time_ns()), 'sysno': 56}
        self.engine.opened(self.box, {**read, 'pid': 31, 'process_start_ns': '31'})
        self.assertEqual([fact for fact in self.engine.facts.values() if fact['kind'] == 'file'], [])
        # Anything else named like the hook is not it, and its read is a fact.
        self.engine.executed(self.box, {'pid': 40, 'ppid': 1, 'process_start_ns': '40', 'executable': '/usr/local/bin/node',
                                        'argv': ['node', '/tmp/hook.mjs']})
        self.engine.opened(self.box, {**read, 'pid': 40, 'ppid': 1, 'process_start_ns': '40'})
        self.assertEqual([fact['pid'] for fact in self.engine.facts.values() if fact['kind'] == 'file'], [40])

    def test_the_shell_of_a_tool_call_carries_the_call_in_its_own_text(self):
        """Claude Code runs `bash -c "... eval '<command>'"`: a redirect is the shell's own write."""
        self.engine.refresh(self.box)
        self.engine.executed(self.box, {'pid': 50, 'ppid': 1, 'process_start_ns': '50', 'executable': '/bin/bash', 'argv': [
            '/bin/bash', '-c', "source /home/node/snap.sh || true && eval 'export RAYTRACE_CALL_ID=toolu_01ABC\necho hi > src/app.js' < /dev/null"]})
        self.assertEqual(self.box.processes[50]['call_id'], 'toolu_01ABC')
    def hook(self, pid, phase, call_id, path, at_ns):
        """The hook, started by the agent (pid 10), announcing a file tool's call."""
        self.engine.executed(self.box, {'pid': pid, 'ppid': 10, 'process_start_ns': str(pid), 'executable': '/usr/local/bin/node',
                                        'argv': ['node', engine.OWN_HOOK]})
        self.engine.executed(self.box, {'pid': pid + 1, 'ppid': pid, 'process_start_ns': str(pid + 1), 'executable': '/usr/bin/true',
                                        'argv': ['true', engine.TOOL_MARK, phase, 'Write', path], 'timestamp_ns': str(at_ns),
                                        'markers': {'RAYTRACE_CALL_ID': call_id}})

    def test_the_agents_own_file_tool_is_joined_to_the_call_the_hook_announced(self):
        self.engine.refresh(self.box)
        self.box.processes[10] = {'start_ns': '10', 'ppid': 1, 'name': 'claude.exe', 'argv': ['claude'], 'call_id': None}
        read = {'kind': 'open', 'pathname': '/workspace/config/payment-keys.js', 'flags': 0, 'errno': 0, 'pid': 10, 'ppid': 1,
                'process_start_ns': '10', 'sysno': 56}
        now = time.time_ns()
        # Before any call is announced, the agent's read names no call.
        self.engine.opened(self.box, {**read, 'timestamp_ns': str(now - 60_000_000_000)})
        self.hook(60, 'begin', 'toolu_read', 'config/payment-keys.js', now)
        self.engine.opened(self.box, {**read, 'timestamp_ns': str(now + 1_000_000)})
        self.hook(62, 'end', 'toolu_read', 'config/payment-keys.js', now + 2_000_000)
        # Long after the call ended, it is not that call's read.
        self.engine.opened(self.box, {**read, 'timestamp_ns': str(now + 30_000_000_000)})
        self.assertEqual({(fact['call_id'], fact.get('call_from'), fact['count']) for fact in self.engine.facts.values()},
                         {(None, None, 2), ('toolu_read', 'tool_report', 1)})
        self.engine.facts.clear()
        # A file the Write tool saves: written under another name and moved here.
        self.hook(64, 'begin', 'toolu_write', 'src/app.js', time.time_ns())
        self.write('src/app.js', 'saved by the tool')
        self.engine.numbered_call(self.box, {**self.RENAME, 'pid': 10, 'process_start_ns': '10', 'timestamp_ns': str(time.time_ns())})
        self.looked('src/app.js', 'moved_to')
        (fact,) = self.engine.facts.values()
        self.assertEqual((fact['effect'], fact['certainty'], fact['pid'], fact['call_id']), ('changed', 'confirmed', 10, 'toolu_write'))

    def test_only_the_hook_can_announce_a_call(self):
        self.engine.refresh(self.box)
        self.box.processes[10] = {'start_ns': '10', 'ppid': 1, 'name': 'claude.exe', 'argv': ['claude'], 'call_id': None}
        self.engine.executed(self.box, {'pid': 70, 'ppid': 10, 'process_start_ns': '70', 'executable': '/usr/bin/true',
                                        'argv': ['true', engine.TOOL_MARK, 'begin', 'Read', 'config/payment-keys.js'],
                                        'timestamp_ns': str(time.time_ns()), 'markers': {'RAYTRACE_CALL_ID': 'made_up'}})
        self.assertEqual(len(self.box.tools), 0)
    def test_a_file_that_came_and_went_between_two_looks_is_a_line(self):
        self.engine.refresh(self.box)
        self.opened('src/scratch.txt', flags=engine.O_CREAT | 1)
        self.assertEqual(self.looked('src/scratch.txt', 'create', 'modify', 'close_write', 'delete'),
                         [('src/scratch.txt', 'created_and_deleted', 'project', 'call_10')])
        self.assertNotIn('src/scratch.txt', self.box.guarded)
        self.assertEqual(len(self.looked('src/scratch.txt', final=True)), 1)

    def test_a_file_written_with_the_same_bytes_is_said_to_be_written(self):
        self.engine.refresh(self.box)
        self.opened('src/app.js')
        self.write('src/app.js', 'one')   # what it already held
        self.assertEqual(self.looked('src/app.js', 'modify', 'close_write'), [('src/app.js', 'rewritten', 'project', 'call_10')])
        # Opened for writing and never written: still only "possible", at the last look.
        self.engine.facts.clear()
        self.opened('config/payment-keys.js', flags=1)
        self.assertEqual(self.looked('config/payment-keys.js'), [])
        self.assertEqual(self.looked('config/payment-keys.js', final=True), [('config/payment-keys.js', 'opened_for_writing', 'sensitive', 'call_10')])

    def test_two_deletes_nobody_can_be_named_for_are_two_lines_when_minutes_apart(self):
        self.engine.refresh(self.box)
        body = {'path': 'src/app.js', 'effect': 'deleted', 'certainty': 'unattributed', 'basis': {}}
        key = ('src/app.js', 'deleted', 'unattributed')
        now = time.time_ns() // 60_000_000_000 * 60_000_000_000 + 1_000_000_000   # a second into a minute
        self.engine.fact(self.box, 'file', key, {}, dict(body), now)
        self.engine.fact(self.box, 'file', key, {}, dict(body), now + 1_000_000)
        self.engine.fact(self.box, 'file', key, {}, dict(body), now + 600_000_000_000)
        self.assertEqual(sorted(fact['count'] for fact in self.engine.facts.values()), [1, 2])

    def test_a_write_through_a_link_is_still_the_writers(self):
        os.symlink('app.js', Path(self.folder.name) / 'src/alias.js')
        self.engine.refresh(self.box)
        self.assertNotIn('src/alias.js', self.box.guarded)
        self.opened('src/alias.js', flags=engine.O_CREAT | engine.O_TRUNC | 1)
        self.assertNotIn('src/alias.js', self.box.guarded)
        self.write('src/app.js', 'through the link')
        self.looked('src/app.js', 'modify', 'close_write')
        (fact,) = self.engine.facts.values()
        self.assertEqual((fact['call_id'], fact['certainty'], fact['basis']['via']), ('call_10', 'confirmed', 'src/alias.js'))
        self.engine.facts.clear()
        os.link(Path(self.folder.name) / 'src/app.js', Path(self.folder.name) / 'src/hard.js')
        self.opened('src/hard.js', flags=engine.O_CREAT | 1)
        self.write('src/hard.js', 'through the hard link')
        self.looked('src/app.js', 'modify', 'close_write')
        (fact,) = [fact for fact in self.engine.facts.values() if fact['path'] == 'src/app.js']
        self.assertEqual((fact['call_id'], fact['basis']['via']), ('call_10', 'src/hard.js'))


class PackageLedger(unittest.TestCase):
    """Issue #153: packages ledger catches get-pip, python -m pip, custom
    workspace venvs from argv, and container-ephemeral venvs like /tmp/venv."""
    def setUp(self):
        self.now = 2000.0
        self.engine = engine.Engine(':memory:', arch='aarch64', watch=False, clock=lambda: self.now)
        self.workspace = tempfile.TemporaryDirectory()
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.addCleanup(self.home.cleanup)
        self.box = engine.Sandbox('c' * 64)
        self.box.workspace = self.workspace.name
        self.box.home = self.home.name
        self.box.packages = {}

    def _make_dist_info(self, root, rel_site, name, version):
        dist = Path(root) / rel_site / f'{name}-{version}.dist-info'
        dist.mkdir(parents=True, exist_ok=True)
        (dist / 'METADATA').write_text(f'Name: {name}\nVersion: {version}\n')

    def test_is_package_manager_recognizes_pip_get_pip_and_extra_flags(self):
        self.assertTrue(engine.is_package_manager(['python3', '-I', '/tmp/getpip/get-pip.py', '-q']))
        self.assertTrue(engine.is_package_manager(['/tmp/venv/bin/python', '-m', 'pip', 'install', 'pytest']))
        self.assertTrue(engine.is_package_manager(['/tmp/venv/bin/python', '-I', '-u', '-X', 'utf8', '-m', 'pip', 'install', 'pytest']))
        self.assertTrue(engine.is_package_manager(['/tmp/venv/bin/pip3.11', 'install', 'pytest']))
        self.assertTrue(engine.is_package_manager(['python3', '-m', 'ensurepip']))
        self.assertFalse(engine.is_package_manager(['python3', 'app.py']))
        self.assertEqual(engine.package_prefixes(['/tmp/venv/bin/python', '-m', 'pip', 'install', 'pytest']), ['/tmp/venv'])
        self.assertEqual(engine.package_prefixes(['python3', '-m', 'pip', 'install', '--target', '/workspace/vendor', 'pytest']), ['/workspace/vendor'])

    def test_workspace_venv_install_still_detected(self):
        self._make_dist_info(self.workspace.name, '.venv/lib/python3.11/site-packages', 'tabulate', '0.10.0')
        self.box.processes[50] = {'start_ns': '50', 'ppid': 1, 'name': 'python3.11',
                                  'argv': ['/workspace/.venv/bin/python', '-m', 'pip', 'install', '-q', 'tabulate'],
                                  'call_id': 'call_ws'}
        self.engine.exited(self.box, {'pid': 50, 'process_start_ns': '50'})
        self.assertIsNotNone(self.box.package_due)
        self.engine.packages(self.box)
        facts = [f for f in self.engine.facts.values() if f['kind'] == 'package']
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]['call_id'], 'call_ws')
        self.assertEqual(facts[0]['packages'], [{'name': 'tabulate', 'version': '0.10.0'}])

    def test_custom_venv_prefix_from_argv_is_scanned(self):
        self._make_dist_info(self.workspace.name, 'custom-env/lib/python3.11/site-packages', 'requests', '2.32.0')
        # Without the argv prefix, installed() wouldn't scan /workspace/custom-env.
        self.assertEqual(engine.installed(self.workspace.name, self.home.name), {})
        self.assertIn(('pip', 'requests', '2.32.0'),
                      engine.installed(self.workspace.name, self.home.name, extra_prefixes=['/workspace/custom-env']))
        self.box.processes[51] = {'start_ns': '51', 'ppid': 1, 'name': 'python3.11',
                                  'argv': ['/workspace/custom-env/bin/python', '-m', 'pip', 'install', 'requests'],
                                  'call_id': 'call_custom'}
        self.engine.exited(self.box, {'pid': 51, 'process_start_ns': '51'})
        self.assertIn('/workspace/custom-env', self.box.package_prefixes)
        self.engine.packages(self.box)
        facts = [f for f in self.engine.facts.values() if f['kind'] == 'package']
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]['packages'], [{'name': 'requests', 'version': '2.32.0'}])

    def test_tmp_venv_install_observed_from_dist_info_opens(self):
        # /tmp/venv is inside the container's ephemeral fs (not bind-mounted on the host).
        # Observing writes to *.dist-info/METADATA catches both get-pip and pip install there.
        self.box.processes[60] = {'start_ns': '60', 'ppid': 1, 'name': 'python3.11',
                                  'argv': ['/tmp/venv/bin/python', '-I', '/tmp/getpip/get-pip.py', '-q'],
                                  'call_id': 'call_getpip'}
        self.engine.opened(self.box, {'kind': 'open', 'pathname': '/tmp/venv/lib/python3.11/site-packages/pip-26.3.dist-info/METADATA',
                                      'flags': engine.O_CREAT | engine.O_TRUNC | 1, 'errno': 0, 'pid': 60, 'ppid': 1,
                                      'process_start_ns': '60', 'timestamp_ns': '1000', 'sysno': 56})
        self.engine.exited(self.box, {'pid': 60, 'process_start_ns': '60'})
        self.assertIsNotNone(self.box.package_due)
        self.engine.packages(self.box)

        self.box.processes[61] = {'start_ns': '61', 'ppid': 1, 'name': 'python3.11',
                                  'argv': ['/tmp/venv/bin/python', '-m', 'pip', 'install', 'pytest'],
                                  'call_id': 'call_pytest'}
        self.engine.opened(self.box, {'kind': 'open', 'pathname': '/tmp/venv/lib/python3.11/site-packages/pytest-9.2.0.dist-info/METADATA',
                                      'flags': engine.O_CREAT | engine.O_TRUNC | 1, 'errno': 0, 'pid': 61, 'ppid': 1,
                                      'process_start_ns': '61', 'timestamp_ns': '2000', 'sysno': 56})
        self.engine.exited(self.box, {'pid': 61, 'process_start_ns': '61'})
        self.engine.packages(self.box)

        self.box.processes[62] = {'start_ns': '62', 'ppid': 1, 'name': 'python3.11',
                                  'argv': ['/tmp/venv2/bin/python', '-m', 'pip', 'install', '-q', 'markdown'],
                                  'call_id': 'call_md'}
        self.engine.opened(self.box, {'kind': 'open', 'pathname': '/tmp/venv2/lib/python3.11/site-packages/markdown-3.11.4.dist-info/METADATA',
                                      'flags': engine.O_CREAT | engine.O_TRUNC | 1, 'errno': 0, 'pid': 62, 'ppid': 1,
                                      'process_start_ns': '62', 'timestamp_ns': '3000', 'sysno': 56})
        self.engine.exited(self.box, {'pid': 62, 'process_start_ns': '62'})
        self.engine.packages(self.box)

        by_call = {f['call_id']: f['packages'] for f in self.engine.facts.values() if f['kind'] == 'package'}
        self.assertEqual(by_call['call_getpip'], [{'name': 'pip', 'version': '26.3'}])
        self.assertEqual(by_call['call_pytest'], [{'name': 'pytest', 'version': '9.2.0'}])
        self.assertEqual(by_call['call_md'], [{'name': 'markdown', 'version': '3.11.4'}])

    def test_workspace_and_open_observation_deduplicate_same_package(self):
        self._make_dist_info(self.workspace.name, '.venv/lib/python3.11/site-packages', 'tabulate', '0.10.0')
        self.box.processes[70] = {'start_ns': '70', 'ppid': 1, 'name': 'python3.11',
                                  'argv': ['/workspace/.venv/bin/python', '-m', 'pip', 'install', 'tabulate'],
                                  'call_id': 'call_dedup'}
        self.engine.opened(self.box, {'kind': 'open', 'pathname': '/workspace/.venv/lib/python3.11/site-packages/tabulate-0.10.0.dist-info/METADATA',
                                      'flags': engine.O_CREAT | engine.O_TRUNC | 1, 'errno': 0, 'pid': 70, 'ppid': 1,
                                      'process_start_ns': '70', 'timestamp_ns': '4000', 'sysno': 56})
        self.engine.exited(self.box, {'pid': 70, 'process_start_ns': '70'})
        self.engine.packages(self.box)
        facts = [f for f in self.engine.facts.values() if f['kind'] == 'package']
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]['total'], 1)
        self.assertEqual(facts[0]['packages'], [{'name': 'tabulate', 'version': '0.10.0'}])


if __name__ == '__main__':
    unittest.main()
