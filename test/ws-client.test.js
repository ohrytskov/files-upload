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
  const outputPath = path.join(root, 'hashes.txt');
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
        outputFile: outputPath,
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
    const hashManifest = fs.readFileSync(outputPath, 'utf8');
    assert.match(hashManifest, /^[a-f0-9]{64}\s{2}nested\/client\.txt\n$/);
  } finally {
    client?.stop();
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Node WebSocket client closes its socket after a fatal source read error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-client-error-'));
  let socketClosed = false;
  let fatalError = null;

  try {
    const client = new WebSocketUploaderClient({
      serverUrl: 'ws://127.0.0.1:1/ws/upload',
      sourcePath: root,
      stateFilePath: path.join(root, 'client-state.json'),
      onError: (error, details = {}) => {
        if (!details.recoverable) fatalError = error;
      }
    });
    client.stateManager.state = {
      totalFiles: 1,
      totalBytes: 1,
      uploadedFiles: 0,
      uploadedBytes: 0,
      status: 'in_progress',
      files: {
        'missing.txt': {
          relativePath: 'missing.txt',
          absolutePath: path.join(root, 'missing.txt'),
          size: 1,
          status: 'pending',
          bytesUploaded: 0
        }
      }
    };
    client.ws = { close: () => { socketClosed = true; } };

    client.sendNextChunk('missing.txt', 0);

    assert.equal(client.stopping, true);
    assert.equal(socketClosed, true);
    assert.match(fatalError.message, /ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
