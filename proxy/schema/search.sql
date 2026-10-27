-- Derived search index (schema version 6): one denormalized, searchable
-- event per tool call, per turn and per proxy error, with the failure
-- outcome decided at index time (proxy/search.mjs) from the agent's own
-- report and, when present, the sandbox-observed process exit. These rows
-- are derived, never evidence: they can be dropped and rebuilt from the
-- agent-intent and runtime tables at any time (evidence-store reindex).
-- No foreign keys, so a rebuild never fights the evidence it derives from.
-- Only post-redaction payload text is indexed, capped per event.
CREATE TABLE search_events (
 id TEXT NOT NULL PRIMARY KEY,
 kind TEXT NOT NULL CHECK (kind IN ('call','turn','proxy_error')),
 ts_ms INTEGER NOT NULL CHECK (typeof(ts_ms)='integer'),
 session_id TEXT,
 session_external TEXT,
 turn_id TEXT,
 exchange_id TEXT,
 call_id TEXT,
 external_call_id TEXT,
 output_index INTEGER CHECK (output_index IS NULL OR typeof(output_index)='integer'),
 agent TEXT,
 model TEXT,
 provider TEXT,
 tool_name TEXT,
 category TEXT,
 outcome TEXT NOT NULL CHECK (outcome IN ('failed','ok','unknown')),
 outcome_reported TEXT NOT NULL CHECK (outcome_reported IN ('failed','ok','unknown')),
 outcome_observed TEXT NOT NULL CHECK (outcome_observed IN ('failed','ok','unknown')),
 reported_check TEXT,
 exit_code INTEGER CHECK (exit_code IS NULL OR typeof(exit_code)='integer'),
 http_status INTEGER CHECK (http_status IS NULL OR typeof(http_status)='integer'),
 error_text TEXT,
 failure_signature TEXT,
 signature_label TEXT,
 command_text TEXT,
 file_paths TEXT,
 prompt_text TEXT,
 args_text TEXT,
 result_text TEXT,
 duration_ms INTEGER CHECK (duration_ms IS NULL OR typeof(duration_ms)='integer'),
 indexed_at_ms INTEGER NOT NULL CHECK (typeof(indexed_at_ms)='integer')
);
CREATE INDEX search_events_time ON search_events(ts_ms DESC);
CREATE INDEX search_events_outcome_time ON search_events(outcome, ts_ms DESC);
CREATE INDEX search_events_tool_time ON search_events(tool_name, ts_ms DESC);
CREATE INDEX search_events_signature ON search_events(failure_signature, ts_ms DESC);
CREATE INDEX search_events_turn ON search_events(turn_id, ts_ms);
CREATE INDEX search_events_exchange ON search_events(exchange_id);
CREATE INDEX search_events_call ON search_events(call_id);
CREATE VIRTUAL TABLE search_fts USING fts5(
 prompt_text, command_text, error_text, args_text, result_text, file_paths, tool_name,
 content='search_events', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER search_events_ai AFTER INSERT ON search_events BEGIN
 INSERT INTO search_fts(rowid, prompt_text, command_text, error_text, args_text, result_text, file_paths, tool_name)
 VALUES (new.rowid, new.prompt_text, new.command_text, new.error_text, new.args_text, new.result_text, new.file_paths, new.tool_name);
END;
CREATE TRIGGER search_events_ad AFTER DELETE ON search_events BEGIN
 INSERT INTO search_fts(search_fts, rowid, prompt_text, command_text, error_text, args_text, result_text, file_paths, tool_name)
 VALUES ('delete', old.rowid, old.prompt_text, old.command_text, old.error_text, old.args_text, old.result_text, old.file_paths, old.tool_name);
END;
CREATE TRIGGER search_events_au AFTER UPDATE ON search_events BEGIN
 INSERT INTO search_fts(search_fts, rowid, prompt_text, command_text, error_text, args_text, result_text, file_paths, tool_name)
 VALUES ('delete', old.rowid, old.prompt_text, old.command_text, old.error_text, old.args_text, old.result_text, old.file_paths, old.tool_name);
 INSERT INTO search_fts(rowid, prompt_text, command_text, error_text, args_text, result_text, file_paths, tool_name)
 VALUES (new.rowid, new.prompt_text, new.command_text, new.error_text, new.args_text, new.result_text, new.file_paths, new.tool_name);
END;
