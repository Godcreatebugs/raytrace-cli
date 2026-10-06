import { DatabaseSync } from 'node:sqlite';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Bump with a forward step in MIGRATIONS (keyed by the version it upgrades
// FROM) whenever a schema file changes. Each step must reproduce the schema
// files exactly: the structure check below still runs afterwards, so a step
// that drifts from the .sql text is refused rather than silently accepted.
export const SCHEMA_VERSION = 1;
const MIGRATIONS = {};
const modules = ['agent_intent.sql', 'shared_storage.sql', 'auxiliary.sql'];

function schemaSql() {
  return modules.map(name => {
    let sql = readFileSync(new URL(`./schema/${name}`, import.meta.url), 'utf8');
    // The agent-only script remains directly importable. The combined loader
    // owns the transaction and foreign-key PRAGMA for all modules.
    if (name === 'agent_intent.sql') {
      sql = sql.replace(/^PRAGMA foreign_keys = ON;\r?\n/m, '')
        .replace(/^BEGIN TRANSACTION;\r?\n/m, '').replace(/^COMMIT;\s*$/m, '');
    }
    return sql;
  }).join('\n');
}

function structure(db) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
}

function same(actual, expected, description) {
  // Compare values independent of object property insertion order.
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw Error(`Incompatible ${description}; refusing to overwrite existing data`);
  }
}

/** Creates a new database, or verifies an existing compatible one. */
export function initializeEvidenceDatabase(outputPath) {
  if (typeof outputPath !== 'string' || !outputPath.trim() || outputPath === ':memory:') {
    throw Error('An explicit database file path is required');
  }
  const path = existsSync(outputPath) ? realpathSync(outputPath) : resolve(outputPath);
  const sql = schemaSql();
  const reference = new DatabaseSync(':memory:');
  let db;
  try {
    reference.exec('PRAGMA foreign_keys=ON');
    reference.exec(sql);
    const expected = structure(reference);
    db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      const existing = structure(db);
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const fresh = existing.length === 0 && version === 0;
      if (fresh) db.exec(sql);
      else {
        if (!(version in MIGRATIONS) && version !== SCHEMA_VERSION) throw Error(`Incompatible schema version ${version}`);
        for (let step = version; step < SCHEMA_VERSION; step += 1) db.exec(MIGRATIONS[step]);
        same(structure(db), expected, 'schema structure');
      }
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Foreign key integrity check failed');
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
      return { path, schemaVersion: SCHEMA_VERSION, tables: expected.filter(o => o.type === 'table').length, created: fresh };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally { db?.close(); reference.close(); }
}
