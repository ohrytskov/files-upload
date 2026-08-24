const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const config = require('../lib/config');

test('project configuration loads the local .env defaults', () => {
  assert.equal(config.defaultHashAlgorithm, 'sha256');
  assert.equal(path.basename(config.uploadsDir), 'uploads');
  assert.equal(config.hashScanRoot, config.uploadsDir);
  assert.equal(typeof config.authToken, 'string');
  assert.equal(config.uploadChunkSize, config.wsMaxChunkSize);
  assert.equal(config.httpUploadMaxFiles, 20);
  assert.equal(config.wsMaxQueuedMessages, 16);
});

test('environment template is runnable on loopback by default', () => {
  const example = fs.readFileSync(path.resolve(__dirname, '..', '.env.example'), 'utf8');
  assert.match(example, /^PORT=3001$/m);
  assert.match(example, /^HOST=127\.0\.0\.1$/m);
  assert.doesNotMatch(example, /^\+PORT=/m);
});
