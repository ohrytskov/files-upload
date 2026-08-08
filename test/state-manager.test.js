const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const StateManager = require('../lib/state-manager');

test('state manager persists resumable progress and aggregate totals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-state-'));
  const statePath = path.join(root, 'state.json');
  try {
    const manager = new StateManager(statePath);
    manager.initSession({
      sessionId: 'test-session',
      sourcePath: '/local/source',
      files: [{
        relativePath: 'file.txt',
        absolutePath: '/local/source/file.txt',
        size: 10,
        hashAlgorithm: 'sha256',
        hash: 'a'.repeat(64)
      }]
    });

    manager.updateFile('file.txt', { status: 'uploading', bytesUploaded: 4 });
    assert.equal(manager.getSummary().uploadedBytes, 4);
    assert.equal(manager.getPendingFiles().length, 1);

    manager.updateFile('file.txt', {
      status: 'verified',
      // A completed file must count its declared size even if an old or
      // interrupted state file contains a stale partial byte count.
      bytesUploaded: 4,
      serverHash: 'a'.repeat(64),
      verified: true
    });
    assert.equal(manager.getSummary().uploadedBytes, 10);
    manager.flushSave();

    const reloaded = new StateManager(statePath);
    reloaded.loadState();
    assert.equal(reloaded.getSummary().status, 'completed');
    assert.equal(reloaded.getSummary().uploadedFiles, 1);
    assert.equal(reloaded.getSummary().uploadedBytes, 10);
    assert.equal(reloaded.getPendingFiles().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
