const test = require('node:test');
const assert = require('node:assert/strict');

function storageDouble() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
}

test('browser upload metadata survives reload and only resumes the same batch', async () => {
  const {
    browserUploadSessionMatches,
    clearBrowserUploadSession,
    loadBrowserUploadSession,
    saveBrowserUploadSession
  } = await import('../src/utils/browser-upload-session.mjs');
  const storage = storageDouble();
  const files = [
    {
      relativePath: 'nested/b.txt',
      size: 2,
      sourceMtimeMs: 20,
      hashAlgorithm: 'sha256',
      hash: 'b'.repeat(64)
    },
    {
      relativePath: 'a.txt',
      size: 1,
      sourceMtimeMs: 10,
      hashAlgorithm: 'sha256',
      hash: 'a'.repeat(64)
    }
  ];

  assert.equal(saveBrowserUploadSession({
    sessionId: 'browser-test-session',
    hashAlgorithm: 'sha256',
    files
  }, storage), true);

  const saved = loadBrowserUploadSession(storage);
  assert.equal(saved.sessionId, 'browser-test-session');
  assert.equal(browserUploadSessionMatches(saved, [...files].reverse(), 'sha256'), true);
  assert.equal(browserUploadSessionMatches(saved, [{ ...files[0], hash: 'c'.repeat(64) }, files[1]], 'sha256'), false);

  clearBrowserUploadSession(storage);
  assert.equal(loadBrowserUploadSession(storage), null);
});
