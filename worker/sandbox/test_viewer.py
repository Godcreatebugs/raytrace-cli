import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import viewer
from viewer import event_page

class TokenTests(unittest.TestCase):
    def test_only_the_token_opens_the_viewer(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'viewer-token'
            with mock.patch.object(viewer, 'TOKEN', file):
                self.assertFalse(viewer.allowed('Bearer anything'))
                file.write_text('')
                self.assertFalse(viewer.allowed('Bearer '))
                file.write_text('right\n')
                self.assertTrue(viewer.allowed('Bearer right'))
                for header in ('', 'right', 'Bearer wrong', 'Bearer é'):
                    self.assertFalse(viewer.allowed(header))


class PaginationTests(unittest.TestCase):
    def test_container_filter_precedes_limit_and_cursor(self):
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE runtime_events(id INTEGER PRIMARY KEY,container_id TEXT,kind TEXT,body TEXT)')
        for i in range(700):
            db.execute('INSERT INTO runtime_events VALUES(?,?,?,?)',(i+1,'target' if i<4 else 'noise','exec_succeeded',json.dumps({'kind':'exec_succeeded','raw_packet_base64':'private'})))
        first=event_page(db,{'container':['target'],'limit':['2']})
        self.assertEqual([e['event_id'] for e in first['events']],[4,3])
        self.assertNotIn('raw_packet_base64',first['events'][0])
        second=event_page(db,{'container':['target'],'limit':['2'],'before':[str(first['next_before'])]})
        self.assertEqual([e['event_id'] for e in second['events']],[2,1])
        self.assertIsNone(second['next_before'])
        db.close()

    def test_since_until_scope_a_page_to_one_turn(self):
        # The UI asks for the span of a single prompt -- from the user's
        # message to the agent's answer -- so commands from other prompts in
        # the same long-lived sandbox never appear alongside them.
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE runtime_events(id INTEGER PRIMARY KEY,container_id TEXT,received_ms INTEGER,kind TEXT,body TEXT)')
        for i,ms in enumerate([1000,2000,3000,4000,5000]):
            db.execute('INSERT INTO runtime_events VALUES(?,?,?,?,?)',(i+1,'box',ms,'exec_succeeded',json.dumps({'kind':'exec_succeeded'})))
        page=event_page(db,{'container':['box'],'since':['2000'],'until':['4000']})
        self.assertEqual(sorted(e['event_id'] for e in page['events']),[2,3,4])
        # Bounds are inclusive on both ends.
        edge=event_page(db,{'container':['box'],'since':['3000'],'until':['3000']})
        self.assertEqual([e['event_id'] for e in edge['events']],[3])
        # A window combines with the tailing cursor rather than replacing it.
        tailed=event_page(db,{'container':['box'],'since':['2000'],'until':['5000'],'after':['3']})
        self.assertEqual([e['event_id'] for e in tailed['events']],[4,5])
        db.close()

    def test_after_cursor_tails_oldest_first_and_reports_more(self):
        # The proxy's gVisor forwarder polls with after=<last seen id>; it
        # must get strictly newer events, oldest first, plus a hint when a
        # page was cut short by `limit` so it can keep going.
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE runtime_events(id INTEGER PRIMARY KEY,container_id TEXT,kind TEXT,body TEXT)')
        for i in range(6):
            db.execute('INSERT INTO runtime_events VALUES(?,?,?,?)',(i+1,'target','exec_succeeded',json.dumps({'kind':'exec_succeeded'})))
        page=event_page(db,{'container':['target'],'after':['2'],'limit':['3']})
        self.assertEqual([e['event_id'] for e in page['events']],[3,4,5])
        self.assertEqual(page['next_after'],5)
        self.assertIsNone(page['next_before'])
        rest=event_page(db,{'container':['target'],'after':[str(page['next_after'])],'limit':['3']})
        self.assertEqual([e['event_id'] for e in rest['events']],[6])
        self.assertIsNone(rest['next_after'])
        # after wins over before when both are supplied
        both=event_page(db,{'container':['target'],'after':['4'],'before':['2']})
        self.assertEqual([e['event_id'] for e in both['events']],[5,6])
        db.close()

    def test_process_feed_includes_failed_execs_and_disconnects(self):
        # The forwarder needs exec_failed (a program that never started) and
        # collector_disconnected (no more exits will come) to close rows.
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE runtime_events(id INTEGER PRIMARY KEY,container_id TEXT,kind TEXT,body TEXT)')
        for i,kind in enumerate(['exec_succeeded','syscall_enter','exec_failed','process_exit','collector_disconnected']):
            db.execute('INSERT INTO runtime_events VALUES(?,?,?,?)',(i+1,'target',kind,json.dumps({'kind':kind})))
        page=event_page(db,{'container':['target'],'processes':['1']})
        self.assertEqual(sorted(e['kind'] for e in page['events']),['collector_disconnected','exec_failed','exec_succeeded','process_exit'])
        db.close()

    def test_event_page_and_coverage_latest_share_one_read_snapshot(self):
        # Regression for #157: a process_exit written by another connection
        # between SELECT runtime_events and coverage_page() must not inflate
        # coverage.latest past the events returned on this page.
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'runtime.db'
            writer = sqlite3.connect(path)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE runtime_events(id INTEGER PRIMARY KEY,container_id TEXT,received_ms INTEGER,kind TEXT,body TEXT)')
            writer.execute('INSERT INTO runtime_events VALUES(1,?,?,?,?)',
                           ('box', 1000, 'exec_succeeded', json.dumps({'kind': 'exec_succeeded', 'pid': 634})))
            writer.commit()

            reader = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
            real_coverage = viewer.coverage_page
            def race_coverage(db, query):
                # Commit a process_exit right before coverage_page() runs.
                writer.execute('INSERT INTO runtime_events VALUES(2,?,?,?,?)',
                               ('box', 1005, 'process_exit', json.dumps({'kind': 'process_exit', 'pid': 634, 'exit_code': 0})))
                writer.commit()
                return real_coverage(db, query)

            with mock.patch.object(viewer, 'coverage_page', side_effect=race_coverage):
                page = event_page(reader, {'container': ['box'], 'after': ['0'], 'processes': ['1']})
            self.assertEqual([e['event_id'] for e in page['events']], [1])
            self.assertEqual(page['coverage']['latest'], 1,
                             'coverage.latest must match the read snapshot so process_exit id=2 is not skipped')
            # The next poll after cursor=1 must still deliver process_exit id=2.
            next_page = event_page(reader, {'container': ['box'], 'after': [str(page['coverage']['latest'])], 'processes': ['1']})
            self.assertEqual([(e['event_id'], e['kind']) for e in next_page['events']], [(2, 'process_exit')])
            reader.close()
            writer.close()
