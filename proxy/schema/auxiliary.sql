-- Features built on top of the evidence, not evidence themselves: the lab's
-- experiment jobs, cached model-written summaries and explanations, and
-- proxy errors. Loaded last by init-evidence-db.mjs.
--
-- exchange_id columns name an agent_exchanges.id but are not foreign keys:
-- these rows are caches and job documents that must still save when the
-- exchange they mention was never captured (a replay, an expired snapshot).

CREATE TABLE lab_experiments (
 id TEXT NOT NULL PRIMARY KEY,
 exchange_id TEXT,
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms)='integer'),
 status TEXT,
 kind TEXT,
 model TEXT,
 -- The full job document; still the source of truth for the lab.
 body_json TEXT NOT NULL CHECK (json_valid(body_json))
);
CREATE INDEX lab_experiments_time ON lab_experiments(created_at_ms DESC);

CREATE TABLE exchange_summaries (
 key TEXT NOT NULL PRIMARY KEY,
 exchange_id TEXT,
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms)='integer'),
 body_json TEXT NOT NULL CHECK (json_valid(body_json))
);
CREATE INDEX exchange_summaries_exchange ON exchange_summaries(exchange_id, created_at_ms);

CREATE TABLE step_explanations (
 key TEXT NOT NULL PRIMARY KEY,
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms)='integer'),
 body_json TEXT NOT NULL CHECK (json_valid(body_json))
);

-- Model-written sentences for sandbox commands the deterministic rules in
-- exec-narrative.mjs could not describe, keyed by a digest of the command so
-- the same command is paid for once. Rule-derived sentences are never cached.
CREATE TABLE command_descriptions (
 key TEXT NOT NULL PRIMARY KEY,
 command TEXT NOT NULL,
 description TEXT NOT NULL,
 model TEXT,
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms)='integer')
);

-- Jev (TypeSafe) severity and step labels for the commands one tool call ran,
-- keyed by a digest of the exact state sent, so the same call is paid for
-- once. body_json keeps the raw answers next to the combined levels, so a
-- level can always be traced back to the rule or probability behind it.
-- Added in schema version 3 (see MIGRATIONS in init-evidence-db.mjs).
CREATE TABLE call_assessments (
 key TEXT NOT NULL PRIMARY KEY,
 call_id TEXT,
 model TEXT,
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms)='integer'),
 body_json TEXT NOT NULL CHECK (json_valid(body_json))
);
CREATE INDEX call_assessments_call ON call_assessments(call_id, created_at_ms);

-- Where the project folder stood after a tool call (or when a prompt was
-- sent) in a sandboxed Claude Code session: a commit in the sandbox's own
-- snapshot history (worker/gvisor/claude-hook.mjs), and the files that call
-- changed. Written by a hook beside the agent, not above it, so it is a lab
-- tool for putting the folder back, not evidence of what ran. changes_json
-- holds {changes: [{path, status, added, removed}], too_big: [path]}; a file
-- in too_big kept its previous version. Added in schema version 4.
CREATE TABLE workspace_snapshots (
 id TEXT NOT NULL PRIMARY KEY,
 session_id TEXT NOT NULL,
 agent_session_id TEXT,
 taken_on TEXT NOT NULL CHECK (taken_on IN ('prompt','tool')),
 call_id TEXT,
 commit_sha TEXT NOT NULL,
 parent_sha TEXT,
 changed INTEGER NOT NULL CHECK (changed IN (0,1)),
 taken_at_ms INTEGER NOT NULL CHECK (typeof(taken_at_ms)='integer'),
 changes_json TEXT NOT NULL CHECK (json_valid(changes_json))
);
CREATE INDEX workspace_snapshots_session ON workspace_snapshots(session_id, taken_at_ms);
CREATE INDEX workspace_snapshots_call ON workspace_snapshots(call_id);

CREATE TABLE proxy_errors (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 trace_id TEXT,
 occurred_at_ms INTEGER CHECK (occurred_at_ms IS NULL OR typeof(occurred_at_ms)='integer'),
 provider TEXT,
 route TEXT,
 error TEXT,
 cause_json TEXT CHECK (cause_json IS NULL OR json_valid(cause_json))
);
