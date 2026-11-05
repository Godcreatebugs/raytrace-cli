-- Recording metadata is mutable; raw evidence remains append-only.
CREATE TABLE runtime_capture_streams (
 id TEXT NOT NULL PRIMARY KEY,
 sandbox_id TEXT NOT NULL REFERENCES runtime_sandboxes(id),
 body_json TEXT NOT NULL CHECK (json_valid(body_json))
);
CREATE INDEX runtime_capture_streams_sandbox ON runtime_capture_streams(sandbox_id);
CREATE TABLE runtime_capture_checkpoints (
 sandbox_id TEXT NOT NULL REFERENCES runtime_sandboxes(id),
 source_id TEXT NOT NULL,
 cursor INTEGER NOT NULL CHECK (cursor >= 0),
 body_json TEXT NOT NULL CHECK (json_valid(body_json)),
 PRIMARY KEY(sandbox_id,source_id)
);
