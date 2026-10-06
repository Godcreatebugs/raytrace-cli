-- Features built on top of the evidence, not evidence themselves: the lab's
-- experiment jobs, cached model-written summaries and explanations, and
-- proxy errors. Loaded last by init-evidence-db.mjs.
--
-- exchange_id columns name an agent_exchanges.id but are not foreign keys:
-- these rows are caches and job documents that must still save when the
-- exchange they mention was never captured (a replay of an expired capture).

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

CREATE TABLE proxy_errors (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 trace_id TEXT,
 occurred_at_ms INTEGER CHECK (occurred_at_ms IS NULL OR typeof(occurred_at_ms)='integer'),
 provider TEXT,
 route TEXT,
 error TEXT,
 cause_json TEXT CHECK (cause_json IS NULL OR json_valid(cause_json))
);
