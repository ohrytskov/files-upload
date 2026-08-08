const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { encodeChunk } = require('../lib/chunk-protocol');
const { initWebSocketServer } = require('../lib/ws-server');

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      socket.off('error', onError);
      resolve(JSON.parse(raw.toString()));
    };
    const onError = (error) => {
      socket.off('message', onMessage);
      reject(error);
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test('authenticated WebSocket upload writes, verifies, and audits a binary file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-ws-'));
  const targetPath = path.join(root, 'nested', 'file.txt');
  const content = Buffer.from('resumable websocket content');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const server = http.createServer();
  const { stateManager } = initWebSocketServer(server, root, {
    authToken: 'test-token',
    maxPayload: 1024 * 1024,
    maxChunkSize: 1024 * 1024,
    maxManifestFiles: 10,
    authTimeoutMs: 1000
  });

  let socket;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws/upload`);
    await waitForOpen(socket);

    socket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'test-token' } }));
    assert.equal((await nextMessage(socket)).type, 'AUTH_OK');

    socket.send(JSON.stringify({
      type: 'INIT_SESSION',
      payload: {
        sessionId: 'ws-test-session',
        sourcePath: '/local/source',
        files: [{
          relativePath: 'nested/file.txt',
          size: content.length,
          hashAlgorithm: 'sha256',
          hash
        }]
      }
    }));
    const ready = await nextMessage(socket);
    assert.equal(ready.type, 'SESSION_READY');
    assert.equal(ready.payload.files['nested/file.txt'].offset, 0);
    assert.equal(stateManager.state.sourcePath, 'websocket-upload');

    socket.send(JSON.stringify({
      type: 'START_FILE',
      payload: { relativePath: 'nested/file.txt', size: content.length, offset: 0 }
    }));
    assert.equal((await nextMessage(socket)).type, 'FILE_STARTED');

    socket.send(encodeChunk({ relativePath: 'nested/file.txt', offset: 0, data: content }));
    const acknowledgement = await nextMessage(socket);
    assert.equal(acknowledgement.type, 'CHUNK_ACK');
    assert.equal(acknowledgement.payload.offset, content.length);

    socket.send(JSON.stringify({
      type: 'FINISH_FILE',
      payload: { relativePath: 'nested/file.txt', clientHash: hash, hashAlgorithm: 'sha256' }
    }));
    const verified = await nextMessage(socket);
    assert.equal(verified.type, 'FILE_VERIFIED');
    assert.equal(verified.payload.serverHash, hash);
    assert.deepEqual(fs.readFileSync(targetPath), content);

    socket.send(JSON.stringify({ type: 'RUN_FULL_AUDIT' }));
    const audit = await nextMessage(socket);
    assert.equal(audit.type, 'AUDIT_COMPLETE');
    assert.equal(audit.payload.matchCount, 1);
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WebSocket upload resumes a staged multi-chunk file without corrupting offsets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-ws-resume-'));
  const content = Buffer.from('0123456789'.repeat(400));
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const server = http.createServer();
  initWebSocketServer(server, root, {
    authToken: 'resume-token',
    maxPayload: 1024 * 1024,
    maxChunkSize: 1024,
    maxManifestFiles: 10,
    authTimeoutMs: 1000
  });

  let firstSocket;
  let secondSocket;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const manifest = {
      sessionId: 'resume-session',
      sourcePath: '/local/source',
      files: [{ relativePath: 'resume.bin', size: content.length, hashAlgorithm: 'sha256', hash }]
    };

    firstSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/upload`);
    await waitForOpen(firstSocket);
    firstSocket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'resume-token' } }));
    assert.equal((await nextMessage(firstSocket)).type, 'AUTH_OK');
    firstSocket.send(JSON.stringify({ type: 'INIT_SESSION', payload: manifest }));
    assert.equal((await nextMessage(firstSocket)).payload.files['resume.bin'].offset, 0);
    firstSocket.send(JSON.stringify({ type: 'START_FILE', payload: { relativePath: 'resume.bin' } }));
    assert.equal((await nextMessage(firstSocket)).payload.offset, 0);
    firstSocket.send(encodeChunk({ relativePath: 'resume.bin', offset: 0, data: content.subarray(0, 1024) }));
    assert.equal((await nextMessage(firstSocket)).payload.offset, 1024);
    firstSocket.close();
    await new Promise(resolve => firstSocket.once('close', resolve));

    secondSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/upload`);
    await waitForOpen(secondSocket);
    secondSocket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'resume-token' } }));
    assert.equal((await nextMessage(secondSocket)).type, 'AUTH_OK');
    secondSocket.send(JSON.stringify({ type: 'INIT_SESSION', payload: manifest }));
    const ready = await nextMessage(secondSocket);
    assert.equal(ready.payload.files['resume.bin'].offset, 1024);
    secondSocket.send(JSON.stringify({ type: 'START_FILE', payload: { relativePath: 'resume.bin' } }));
    assert.equal((await nextMessage(secondSocket)).payload.offset, 1024);
    let offset = 1024;
    while (offset < content.length) {
      const nextOffset = Math.min(offset + 1024, content.length);
      secondSocket.send(encodeChunk({ relativePath: 'resume.bin', offset, data: content.subarray(offset, nextOffset) }));
      assert.equal((await nextMessage(secondSocket)).payload.offset, nextOffset);
      offset = nextOffset;
    }
    secondSocket.send(JSON.stringify({
      type: 'FINISH_FILE',
      payload: { relativePath: 'resume.bin', clientHash: hash, hashAlgorithm: 'sha256' }
    }));
    assert.equal((await nextMessage(secondSocket)).type, 'FILE_VERIFIED');
    assert.deepEqual(fs.readFileSync(path.join(root, 'resume.bin')), content);
  } finally {
    for (const socket of [firstSocket, secondSocket]) {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    }
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WebSocket upload rejects reserved internal filenames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-ws-reserved-'));
  const server = http.createServer();
  initWebSocketServer(server, root, { authToken: 'reserved-token', authTimeoutMs: 1000 });
  let socket;

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/upload`);
    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'reserved-token' } }));
    assert.equal((await nextMessage(socket)).type, 'AUTH_OK');
    socket.send(JSON.stringify({
      type: 'INIT_SESSION',
      payload: {
        sessionId: 'reserved-session',
        files: [{ relativePath: 'server_state.json', size: 0, hashAlgorithm: 'sha256', hash: '0'.repeat(64) }]
      }
    }));
    const error = await nextMessage(socket);
    assert.equal(error.type, 'ERROR');
    assert.match(error.message, /Reserved upload path/);
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
