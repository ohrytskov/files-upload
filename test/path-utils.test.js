const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isInternalUploadFile,
  normalizeFilename,
  normalizeRelativePath,
  resolveSafePath
} = require('../lib/path-utils');

test('internal state and staging filenames are reserved', () => {
  assert.equal(isInternalUploadFile('server_state.json'), true);
  assert.equal(isInternalUploadFile('cloudvault.sqlite-journal'), true);
  assert.equal(isInternalUploadFile('nested.cloudvault-part'), true);
  assert.equal(isInternalUploadFile('.abc.cloudvault-http-part'), true);
  assert.equal(isInternalUploadFile('user.json'), false);
});

test('path utilities normalize safe relative paths', () => {
  assert.equal(normalizeRelativePath('nested\\file.txt'), 'nested/file.txt');
  assert.equal(normalizeFilename('file.txt'), 'file.txt');
  assert.equal(resolveSafePath('/tmp/uploads', 'nested/file.txt').normalized, 'nested/file.txt');
});

test('path utilities reject traversal, absolute paths, and invalid filenames', () => {
  for (const value of ['../secret.txt', '/absolute.txt', 'nested/../secret.txt', 'nested//file.txt', '.', '']) {
    assert.throws(() => normalizeRelativePath(value));
  }
  assert.throws(() => normalizeFilename('nested/file.txt'), /separators/);
});

test('path utilities reject symlinked path components', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-path-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-outside-'));
  try {
    fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
    assert.throws(() => resolveSafePath(root, 'linked/file.txt'), /Symbolic links/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
