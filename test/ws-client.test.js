const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WebSocketUploaderClient = require('../lib/ws-client');
const { initWebSocketServer } = require('../lib/ws-server');

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test('Node WebSocket client uploads a source directory and completes its audit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-client-'));
  const sourceRoot = path.join(root, 'source');
  const uploadsRoot = path.join(root, 'uploads');
  const statePath = path.join(root, 'client-state.json');
  fs.mkdirSync(path.join(sourceRoot, 'nested'), { recursive: true });
  fs.mkdirSync(uploadsRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'nested', 'client.txt'), 'client integration content');

  const server = http.createServer();
  initWebSocketServer(server, uploadsRoot, {
    authToken: 'client-test-token',
    maxPayload: 1024 * 1024,
    maxChunkSize: 1024 * 1024,
    maxManifestFiles: 10
  });

  let client;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const auditComplete = new Promise((resolve, reject) => {
      client = new WebSocketUploaderClient({
        serverUrl: `ws://127.0.0.1:${port}/ws/upload`,
        sourcePath: sourceRoot,
        stateFilePath: statePath,
        authToken: 'client-test-token',
        onAuditComplete: resolve,
        onError: (error, details = {}) => {
          if (!details.recoverable) reject(error);
        }
      });
    });

    await client.start();
    const audit = await auditComplete;
    assert.equal(audit.matchCount, 1);
    assert.equal(audit.mismatchCount, 0);
    assert.equal(
      fs.readFileSync(path.join(uploadsRoot, 'nested', 'client.txt'), 'utf8'),
      'client integration content'
    );
  } finally {
    client?.stop();
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
