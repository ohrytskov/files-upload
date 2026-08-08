const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const config = require('../lib/config');

test('project configuration loads the local .env defaults', () => {
  assert.equal(config.defaultHashAlgorithm, 'sha256');
  assert.equal(path.basename(config.uploadsDir), 'uploads');
  assert.equal(config.hashScanRoot, config.uploadsDir);
  assert.equal(typeof config.authToken, 'string');
  assert.equal(config.uploadChunkSize, config.wsMaxChunkSize);
  assert.equal(config.httpUploadMaxFiles, 20);
});
