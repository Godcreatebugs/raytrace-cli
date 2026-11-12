"""A stopped collector's open streams are ended by the next one (worker/sandbox/collector.py).

Run by collector-restart.test.mjs, or directly: python3 -B test/collector_restart.py"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'worker' / 'sandbox'))
from collector import Writer, init_db  # noqa: E402
from viewer import coverage_page, event_page  # noqa: E402


class CollectorRestartTests(unittest.TestCase):
    def test_stopped_collector_stream_is_ended_at_its_last_heartbeat(self):
        # systemctl restart kills the old collector's connection threads before they record a disconnect.
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'runtime.db')
            db = init_db(path)
            old = Writer(path)
            old.put('old', {'kind': 'exec_succeeded', 'container_id': 'a'})
            old.write_batch(db, [old.rows.get_nowait()], 1000)
            old.write_batch(db, [], 6000)  # its last heartbeat
            new = Writer(path)
            self.assertEqual(new.close_orphaned_streams(db), ['old'])
            stream = coverage_page(db, {'container': ['a']})['streams'][0]
            self.assertEqual((stream['ended_ms'], stream['heartbeat_ms']), (6000, 6000))
            gone = [e for e in event_page(db, {'container': ['a']})['events'] if e['kind'] == 'collector_disconnected']
            self.assertEqual(len(gone), 1)
            self.assertEqual((gone[0]['source_instance_id'], gone[0]['source_connection_id'], gone[0]['received_ms']),
                             (old.instance_id, 'old', 6000))
            self.assertEqual(gone[0]['reason'], 'collector stopped')
            # Once closed, a later start finds nothing more to close.
            self.assertEqual(Writer(path).close_orphaned_streams(db), [])
            db.close()

    def test_closing_orphans_spares_ended_own_and_unnamed_streams(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'runtime.db')
            db = init_db(path)
            old = Writer(path)
            old.put('ended', {'kind': 'exec_succeeded', 'container_id': 'a'})
            old.put('ended', {'kind': 'collector_disconnected', 'container_id': 'a'})
            old.put('greeting', {'kind': 'collector_connected'})
            old.write_batch(db, [old.rows.get_nowait() for _ in range(3)], 1000)
            new = Writer(path)
            new.put('mine', {'kind': 'exec_succeeded', 'container_id': 'b'})
            new.write_batch(db, [new.rows.get_nowait()], 2000)
            count = "SELECT COUNT(*) FROM runtime_events WHERE kind='collector_disconnected'"
            before = db.execute(count).fetchone()[0]
            already = db.execute("SELECT ended_ms FROM capture_streams WHERE id='ended'").fetchone()[0]
            self.assertIsNotNone(already)
            self.assertEqual(new.close_orphaned_streams(db), ['greeting'])
            ended = dict(db.execute('SELECT id, ended_ms FROM capture_streams').fetchall())
            self.assertEqual(ended, {'ended': already, 'greeting': 1000, 'mine': None})
            # A stream that never named a sandbox is ended without an event nobody could place.
            self.assertEqual(db.execute(count).fetchone()[0], before)
            db.close()


if __name__ == '__main__':
    unittest.main()
