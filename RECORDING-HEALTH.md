# Run comparison and recording health

Comparison reads the selected saved traces. It makes no model calls. The detail
endpoint is `GET /raytace/traces?trace=<id>` (forwarded through the existing hosted
route). It returns at most 2,000 exchanges and marks truncated or still-running
captures as unavailable in full. Hosted reads retain session-owner filtering.

The first recorded difference checks the full starting prompt and request
settings, captured context, aligned calls, returned results, and recorded exits.
It is a difference in captured order, not a claim about what caused a failure.
Reported and independently observed exits remain separate. Only captured file
read results describe file contents; snapshot IDs do not establish content
changes. Missing results, previews, ambiguous repeats, and truncated captures
remain visible limitations. Alignment retains its 250,000-cell limit.

The comparison panel cancels old selection requests. Selected details are loaded
on selection and can be refreshed explicitly; large detail responses are not
downloaded every five seconds.

## Recording status

The collector commits stream metadata and a heartbeat roughly every five
seconds through its existing writer. Heartbeats do not add raw event rows.
Connections remain unassigned until an event identifies their container.

Live status and selected-run status are independent:

- Reporting: recent committed heartbeat and forwarding caught up.
- Catching up: recorded source events remain to be forwarded.
- Not reporting: heartbeat older than 15 seconds or viewer unavailable.
- Stream ended: the source connection closed; this does not certify delivery.
- Gaps detected: scoped drop/error markers overlap the selected interval.
- No gaps reported: a known stream covers the interval, forwarding reached its
  end, and no scoped gap was reported. This does not mean 100% complete.
- Unknown: required coverage, clock mapping, or source metadata is missing.
- No sandbox recording: host runs have no independent sandbox evidence.

Current outages do not downgrade already-forwarded historical intervals. Source
instance and connection IDs namespace event identities. Checkpoints advance
after event writes succeed. Retried events are deduplicated. Discovery resumes a
saved checkpoint or starts from source history, rather than skipping to the tip.

## Migration and rollout

Local evidence migrates from schema 6 to 7. Hosted evidence migrates from schema
4 to 5, preserving organization-scoped access. Metadata is included in evidence
imports and removed during sandbox deletion and retention cleanup. Schema-6
uploads are migrated in a private temporary copy, leaving the upload unchanged.
Imports preserve historical metadata but cannot claim a live connection.
Older recordings without metadata stay unknown.

Deploy readers and migrations first, then the collector/forwarder, then the UI.
Older collectors remain readable with unknown health. Updating the collector can
interrupt its active connections: restart active sandboxes to establish fresh
recording connections. The CLI proxy API is now 5 so older background proxies
are replaced when the updated CLI starts.

## Verification

Run the proxy, comparison, importer, and Python collector/viewer tests. The
optional real Postgres test uses a disposable database:

```sh
RAYTRACE_CAPTURE_TEST_DATABASE_URL='<test database URL>' node --test worker/gvisor/capture-health-pg.test.mjs
```

It verifies organization isolation, source-ID reuse, SQLite metadata import, and
deletion. Do not point this integration test at production.

Protocol and UI references: [gVisor delivery protocol](https://github.com/google/gvisor/blob/master/pkg/sentry/seccheck/sinks/remote/README.md),
[React effect cleanup](https://react.dev/learn/synchronizing-with-effects).
