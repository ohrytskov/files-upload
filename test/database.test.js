const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CloudVaultDatabase = require('../lib/database');

test('SQLite persistence stores resumable state, repository metadata, and audits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-database-'));
  const databasePath = path.join(root, 'cloudvault.sqlite');

  try {
    const database = new CloudVaultDatabase(databasePath);
    database.replaceState({
      sessionId: 'sqlite-session',
      sourcePath: 'websocket-upload',
      totalFiles: 1,
      totalBytes: 12,
      uploadedFiles: 0,
      uploadedBytes: 0,
      status: 'in_progress',
      files: {
        'nested/file.txt': {
          relativePath: 'nested/file.txt',
          size: 12,
          hashAlgorithm: 'sha256',
          hash: 'a'.repeat(64),
          status: 'pending',
          bytesUploaded: 0,
          targetMtimeMs: null,
          targetCtimeMs: null,
          targetIno: null,
          targetDev: null
        }
      }
    });
    database.upsertRepositoryFile({
      relativePath: 'nested/file.txt',
      size: 12,
      hash: 'a'.repeat(64),
      hashAlgorithm: 'sha256',
      hashStatus: 'verified',
      targetMtimeMs: null,
      targetCtimeMs: null,
      targetIno: null,
      targetDev: null
    });
    database.recordAudit({
      sessionId: 'sqlite-session',
      results: [{
        relativePath: 'nested/file.txt',
        hashAlgorithm: 'sha256',
        status: 'verified',
        match: true,
        size: 12
      }]
    });
    database.close();

    const reopened = new CloudVaultDatabase(databasePath);
    const state = reopened.readState();
    assert.equal(state.sessionId, 'sqlite-session');
    assert.equal(state.files['nested/file.txt'].targetMtimeMs, null);
    assert.equal(reopened.getRepositoryFile('nested/file.txt').hashStatus, 'verified');
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite imports a legacy JSON state file once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-database-migrate-'));
  const databasePath = path.join(root, 'cloudvault.sqlite');
  const legacyPath = path.join(root, 'server_state.json');

  try {
    fs.writeFileSync(legacyPath, JSON.stringify({
      sessionId: 'legacy-session',
      sourcePath: 'legacy',
      totalFiles: 1,
      totalBytes: 3,
      uploadedFiles: 1,
      uploadedBytes: 3,
      status: 'completed',
      files: {
        'legacy.txt': {
          relativePath: 'legacy.txt',
          size: 3,
          hashAlgorithm: 'md5',
          hash: 'b'.repeat(32),
          md5: 'b'.repeat(32),
          status: 'verified',
          bytesUploaded: 3,
          verified: true
        }
      }
    }));

    const database = new CloudVaultDatabase(databasePath, { legacyStatePath: legacyPath });
    assert.equal(database.readState().sessionId, 'legacy-session');
    assert.equal(database.readState().sourcePath, 'websocket-upload');
    assert.equal(database.readState().files['legacy.txt'].hashAlgorithm, 'md5');
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
