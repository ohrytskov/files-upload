const fs = require('fs');
const path = require('path');

// better-sqlite3 is the preferred driver, but its prebuilt binaries are tied
// to the libc/toolchain used to publish them. Node 22.5+ also ships a native
// SQLite API, which gives installations on older Linux hosts a zero-build
// fallback instead of failing while the server starts.
let BetterSqliteDatabase;
let NodeSqliteDatabase;
let betterSqliteLoadError;
let nodeSqliteLoadError;
let nodeSqliteLoadAttempted = false;
try {
  BetterSqliteDatabase = require('better-sqlite3');
} catch (error) {
  betterSqliteLoadError = error;
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upload_sessions (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    session_id TEXT NOT NULL UNIQUE,
    source_path TEXT NOT NULL DEFAULT '',
    total_files INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    uploaded_files INTEGER NOT NULL DEFAULT 0,
    uploaded_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upload_items (
    session_slot INTEGER NOT NULL DEFAULT 1,
    relative_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    hash_algorithm TEXT NOT NULL,
    hash TEXT NOT NULL,
    md5 TEXT,
    status TEXT NOT NULL,
    bytes_uploaded INTEGER NOT NULL DEFAULT 0,
    server_hash TEXT,
    server_md5 TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    source_mtime_ms REAL,
    target_mtime_ms REAL,
    target_ctime_ms REAL,
    target_ino INTEGER,
    target_dev INTEGER,
    PRIMARY KEY (session_slot, relative_path),
    FOREIGN KEY (session_slot) REFERENCES upload_sessions(slot) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS repository_files (
    relative_path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    hash TEXT,
    hash_algorithm TEXT,
    md5 TEXT,
    hash_status TEXT NOT NULL,
    created_at_ms REAL,
    modified_at_ms REAL,
    target_mtime_ms REAL,
    target_ctime_ms REAL,
    target_ino INTEGER,
    target_dev INTEGER,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    algorithm TEXT,
    status TEXT NOT NULL,
    total_files INTEGER NOT NULL,
    match_count INTEGER NOT NULL,
    mismatch_count INTEGER NOT NULL,
    missing_count INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_run_id INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    hash_algorithm TEXT NOT NULL,
    client_hash TEXT,
    server_hash TEXT,
    status TEXT NOT NULL,
    size INTEGER,
    match INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_audit_results_run
    ON audit_results(audit_run_id);
`;

function asNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function asInteger(value, fallback = 0) {
  return Number.isSafeInteger(Number(value)) ? Number(value) : fallback;
}

function toDbItem(file) {
  return {
    relativePath: file.relativePath,
    size: asInteger(file.size),
    hashAlgorithm: file.hashAlgorithm || (file.md5 ? 'md5' : 'sha256'),
    hash: file.hash || file.md5 || '',
    md5: file.md5 || null,
    status: file.status || 'pending',
    bytesUploaded: asInteger(file.bytesUploaded),
    serverHash: file.serverHash || null,
    serverMd5: file.serverMd5 || null,
    verified: file.verified ? 1 : 0,
    error: file.error || null,
    sourceMtimeMs: asNullableNumber(file.sourceMtimeMs),
    targetMtimeMs: asNullableNumber(file.targetMtimeMs),
    targetCtimeMs: asNullableNumber(file.targetCtimeMs),
    targetIno: asNullableNumber(file.targetIno),
    targetDev: asNullableNumber(file.targetDev)
  };
}

function fromDbItem(row) {
  return {
    relativePath: row.relative_path,
    size: Number(row.size),
    hashAlgorithm: row.hash_algorithm,
    hash: row.hash,
    md5: row.md5 || null,
    status: row.status,
    bytesUploaded: Number(row.bytes_uploaded),
    serverHash: row.server_hash || null,
    serverMd5: row.server_md5 || null,
    verified: Boolean(row.verified),
    error: row.error || null,
    sourceMtimeMs: row.source_mtime_ms === null ? undefined : Number(row.source_mtime_ms),
    targetMtimeMs: row.target_mtime_ms === null ? null : Number(row.target_mtime_ms),
    targetCtimeMs: row.target_ctime_ms === null ? null : Number(row.target_ctime_ms),
    targetIno: row.target_ino === null ? null : Number(row.target_ino),
    targetDev: row.target_dev === null ? null : Number(row.target_dev)
  };
}

function createDatabaseAdapter(database, driver) {
  if (driver === 'better-sqlite3') return database;

  return {
    exec(sql) {
      return database.exec(sql);
    },
    pragma(sql) {
      return database.exec(`PRAGMA ${sql}`);
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      statement.setAllowBareNamedParameters?.(true);
      return statement;
    },
    transaction(callback) {
      return (...args) => {
        database.exec('BEGIN');
        try {
          const result = callback(...args);
          database.exec('COMMIT');
          return result;
        } catch (error) {
          try { database.exec('ROLLBACK'); } catch (rollbackError) {}
          throw error;
        }
      };
    },
    close() {
      return database.close();
    }
  };
}

function openDatabase(databasePath) {
  if (BetterSqliteDatabase) {
    try {
      return {
        database: new BetterSqliteDatabase(databasePath),
        driver: 'better-sqlite3'
      };
    } catch (error) {
      betterSqliteLoadError = error;
    }
  }

  if (!nodeSqliteLoadAttempted) {
    nodeSqliteLoadAttempted = true;
    try {
      ({ DatabaseSync: NodeSqliteDatabase } = require('node:sqlite'));
    } catch (error) {
      nodeSqliteLoadError = error;
    }
  }

  if (NodeSqliteDatabase) {
    return {
      database: new NodeSqliteDatabase(databasePath),
      driver: 'node:sqlite'
    };
  }

  const error = new Error('No usable SQLite driver is available. Install better-sqlite3 or use Node.js 22.5+ with node:sqlite.');
  error.cause = betterSqliteLoadError || nodeSqliteLoadError;
  throw error;
}

class CloudVaultDatabase {
  constructor(databasePath, { legacyStatePath = null } = {}) {
    this.databasePath = path.resolve(databasePath);
    const resolvedLegacyStatePath = legacyStatePath ? path.resolve(legacyStatePath) : null;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const openedDatabase = openDatabase(this.databasePath);
    this.db = createDatabaseAdapter(openedDatabase.database, openedDatabase.driver);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.prepareStatements();
    this.migrateLegacyState(resolvedLegacyStatePath);
  }

  prepareStatements() {
    this.selectSession = this.db.prepare(`SELECT * FROM upload_sessions WHERE slot = 1`);
    this.selectItems = this.db.prepare(`
      SELECT * FROM upload_items WHERE session_slot = 1 ORDER BY relative_path
    `);
    this.insertSession = this.db.prepare(`
      INSERT INTO upload_sessions (
        slot, session_id, source_path, total_files, total_bytes,
        uploaded_files, uploaded_bytes, status, created_at, updated_at
      ) VALUES (1, @sessionId, @sourcePath, @totalFiles, @totalBytes,
        @uploadedFiles, @uploadedBytes, @status, @createdAt, @updatedAt)
    `);
    this.updateSession = this.db.prepare(`
      UPDATE upload_sessions SET
        session_id = @sessionId,
        source_path = @sourcePath,
        total_files = @totalFiles,
        total_bytes = @totalBytes,
        uploaded_files = @uploadedFiles,
        uploaded_bytes = @uploadedBytes,
        status = @status,
        created_at = @createdAt,
        updated_at = @updatedAt
      WHERE slot = 1
    `);
    this.insertItem = this.db.prepare(`
      INSERT INTO upload_items (
        session_slot, relative_path, size, hash_algorithm, hash, md5,
        status, bytes_uploaded, server_hash, server_md5, verified, error,
        source_mtime_ms, target_mtime_ms, target_ctime_ms, target_ino, target_dev
      ) VALUES (1, @relativePath, @size, @hashAlgorithm, @hash, @md5,
        @status, @bytesUploaded, @serverHash, @serverMd5, @verified, @error,
        @sourceMtimeMs, @targetMtimeMs, @targetCtimeMs, @targetIno, @targetDev)
    `);
    this.updateItem = this.db.prepare(`
      UPDATE upload_items SET
        size = @size,
        hash_algorithm = @hashAlgorithm,
        hash = @hash,
        md5 = @md5,
        status = @status,
        bytes_uploaded = @bytesUploaded,
        server_hash = @serverHash,
        server_md5 = @serverMd5,
        verified = @verified,
        error = @error,
        source_mtime_ms = @sourceMtimeMs,
        target_mtime_ms = @targetMtimeMs,
        target_ctime_ms = @targetCtimeMs,
        target_ino = @targetIno,
        target_dev = @targetDev
      WHERE session_slot = 1 AND relative_path = @relativePath
    `);
    this.deleteItem = this.db.prepare(`
      DELETE FROM upload_items WHERE session_slot = 1 AND relative_path = ?
    `);
    this.selectRepositoryFile = this.db.prepare(`
      SELECT * FROM repository_files WHERE relative_path = ?
    `);
    this.upsertRepositoryFileStatement = this.db.prepare(`
      INSERT INTO repository_files (
        relative_path, size, hash, hash_algorithm, md5, hash_status,
        created_at_ms, modified_at_ms, target_mtime_ms, target_ctime_ms,
        target_ino, target_dev, updated_at
      ) VALUES (
        @relativePath, @size, @hash, @hashAlgorithm, @md5, @hashStatus,
        @createdAtMs, @modifiedAtMs, @targetMtimeMs, @targetCtimeMs,
        @targetIno, @targetDev, @updatedAt
      ) ON CONFLICT(relative_path) DO UPDATE SET
        size = excluded.size,
        hash = excluded.hash,
        hash_algorithm = excluded.hash_algorithm,
        md5 = excluded.md5,
        hash_status = excluded.hash_status,
        created_at_ms = excluded.created_at_ms,
        modified_at_ms = excluded.modified_at_ms,
        target_mtime_ms = excluded.target_mtime_ms,
        target_ctime_ms = excluded.target_ctime_ms,
        target_ino = excluded.target_ino,
        target_dev = excluded.target_dev,
        updated_at = excluded.updated_at
    `);
    this.deleteRepositoryFileStatement = this.db.prepare(`
      DELETE FROM repository_files WHERE relative_path = ?
    `);
    this.renameRepositoryFileStatement = this.db.prepare(`
      UPDATE repository_files SET relative_path = ?, updated_at = ?
      WHERE relative_path = ?
    `);
  }

  migrateLegacyState(legacyStatePath) {
    if (!legacyStatePath || this.getMetadata('legacy_state_migrated') === '1') return;

    if (!fs.existsSync(legacyStatePath)) {
      this.setMetadata('legacy_state_migrated', '1');
      return;
    }

    let legacyState = null;
    try {
      legacyState = JSON.parse(fs.readFileSync(legacyStatePath, 'utf8'));
    } catch (error) {
      console.error(`[Database] Failed to migrate ${legacyStatePath}:`, error.message);
      // Leave the marker unset so an operator can repair the legacy file and
      // retry the migration on the next start.
      return;
    }

    if (legacyState?.sessionId && legacyState.files && typeof legacyState.files === 'object') {
      const files = Object.fromEntries(Object.entries(legacyState.files).map(([key, file]) => [
        key,
        { ...file, relativePath: file.relativePath || key }
      ]));
      this.replaceState({ ...legacyState, sourcePath: 'websocket-upload', files });
    }
    this.setMetadata('legacy_state_migrated', '1');
  }

  getMetadata(key) {
    return this.db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key)?.value || null;
  }

  setMetadata(key, value) {
    this.db.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  readState() {
    const session = this.selectSession.get();
    if (!session) return null;

    const files = {};
    for (const row of this.selectItems.all()) {
      files[row.relative_path] = fromDbItem(row);
    }

    return {
      sessionId: session.session_id,
      sourcePath: session.source_path,
      totalFiles: Number(session.total_files),
      totalBytes: Number(session.total_bytes),
      uploadedFiles: Number(session.uploaded_files),
      uploadedBytes: Number(session.uploaded_bytes),
      status: session.status,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      files
    };
  }

  replaceState(state) {
    const files = Object.values(state.files || {});
    const transaction = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM upload_sessions WHERE slot = 1`).run();
      this.insertSession.run({
        sessionId: String(state.sessionId || `session_${Date.now()}`),
        sourcePath: String(state.sourcePath || ''),
        totalFiles: asInteger(state.totalFiles, files.length),
        totalBytes: asInteger(state.totalBytes),
        uploadedFiles: asInteger(state.uploadedFiles),
        uploadedBytes: asInteger(state.uploadedBytes),
        status: state.status || 'in_progress',
        createdAt: state.createdAt || new Date().toISOString(),
        updatedAt: state.updatedAt || new Date().toISOString()
      });
      for (const file of files) this.insertItem.run(toDbItem(file));
    });
    transaction();
  }

  saveState(state, dirtyFiles = null) {
    if (!state) return;
    const files = dirtyFiles ? [...dirtyFiles] : Object.keys(state.files || {});
    const transaction = this.db.transaction(() => {
      const sessionParams = {
        sessionId: String(state.sessionId || `session_${Date.now()}`),
        sourcePath: String(state.sourcePath || ''),
        totalFiles: asInteger(state.totalFiles),
        totalBytes: asInteger(state.totalBytes),
        uploadedFiles: asInteger(state.uploadedFiles),
        uploadedBytes: asInteger(state.uploadedBytes),
        status: state.status || 'in_progress',
        createdAt: state.createdAt || new Date().toISOString(),
        updatedAt: state.updatedAt || new Date().toISOString()
      };
      if (this.selectSession.get()) this.updateSession.run(sessionParams);
      else this.insertSession.run(sessionParams);

      for (const relativePath of files) {
        const file = state.files?.[relativePath];
        if (!file) {
          this.deleteItem.run(relativePath);
          continue;
        }
        const item = toDbItem(file);
        const result = this.updateItem.run(item);
        if (result.changes === 0) this.insertItem.run(item);
      }
    });
    transaction();
  }

  getRepositoryFile(relativePath) {
    const row = this.selectRepositoryFile.get(relativePath);
    if (!row) return null;
    return {
      relativePath: row.relative_path,
      size: Number(row.size),
      hash: row.hash || null,
      hashAlgorithm: row.hash_algorithm || null,
      md5: row.md5 || null,
      hashStatus: row.hash_status,
      createdAtMs: asNullableNumber(row.created_at_ms),
      modifiedAtMs: asNullableNumber(row.modified_at_ms),
      targetMtimeMs: asNullableNumber(row.target_mtime_ms),
      targetCtimeMs: asNullableNumber(row.target_ctime_ms),
      targetIno: asNullableNumber(row.target_ino),
      targetDev: asNullableNumber(row.target_dev),
      updatedAt: row.updated_at
    };
  }

  upsertRepositoryFile(file) {
    this.upsertRepositoryFileStatement.run({
      relativePath: file.relativePath,
      size: asInteger(file.size),
      hash: file.hash || null,
      hashAlgorithm: file.hashAlgorithm || null,
      md5: file.md5 || null,
      hashStatus: file.hashStatus || 'unknown',
      createdAtMs: asNullableNumber(file.createdAtMs),
      modifiedAtMs: asNullableNumber(file.modifiedAtMs),
      targetMtimeMs: asNullableNumber(file.targetMtimeMs),
      targetCtimeMs: asNullableNumber(file.targetCtimeMs),
      targetIno: asNullableNumber(file.targetIno),
      targetDev: asNullableNumber(file.targetDev),
      updatedAt: new Date().toISOString()
    });
  }

  deleteRepositoryFile(relativePath) {
    this.deleteRepositoryFileStatement.run(relativePath);
  }

  renameRepositoryFile(oldPath, newPath) {
    const transaction = this.db.transaction(() => {
      const record = this.selectRepositoryFile.get(oldPath);
      if (!record) return;
      this.renameRepositoryFileStatement.run(newPath, new Date().toISOString(), oldPath);
    });
    transaction();
  }

  recordAudit({ sessionId, algorithm, status = 'complete', startedAt, completedAt, results }) {
    const auditResults = Array.isArray(results) ? results : [];
    const counts = auditResults.reduce((summary, result) => {
      if (result.status === 'verified' || result.status === 'match') summary.matchCount += 1;
      else if (result.status === 'missing') summary.missingCount += 1;
      else summary.mismatchCount += 1;
      return summary;
    }, { matchCount: 0, mismatchCount: 0, missingCount: 0 });

    const insertRun = this.db.prepare(`
      INSERT INTO audit_runs (
        session_id, algorithm, status, total_files, match_count,
        mismatch_count, missing_count, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertResult = this.db.prepare(`
      INSERT INTO audit_results (
        audit_run_id, relative_path, hash_algorithm, client_hash,
        server_hash, status, size, match, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.db.transaction(() => {
      const run = insertRun.run(
        sessionId || null,
        algorithm || null,
        status,
        auditResults.length,
        counts.matchCount,
        counts.mismatchCount,
        counts.missingCount,
        startedAt || new Date().toISOString(),
        completedAt || new Date().toISOString()
      );
      for (const result of auditResults) {
        insertResult.run(
          run.lastInsertRowid,
          result.relativePath,
          result.hashAlgorithm || algorithm || 'sha256',
          result.clientHash || null,
          result.serverHash || null,
          result.status || 'mismatch',
          Number.isSafeInteger(Number(result.size)) ? Number(result.size) : null,
          result.match ? 1 : 0,
          result.error || null
        );
      }
    });
    transaction();
  }

  close() {
    this.db.close();
  }
}

module.exports = CloudVaultDatabase;
