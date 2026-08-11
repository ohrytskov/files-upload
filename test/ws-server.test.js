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

    socket.send(encodeChunk({ relativePath: 'nested/file.txt', offset: 0, data: Buffer.alloc(0) }));
    const emptyChunkError = await nextMessage(socket);
    assert.equal(emptyChunkError.type, 'FILE_ERROR');
    assert.match(emptyChunkError.payload.error, /Empty chunks/);

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

test('a reconnecting session takes over its previous socket without reconnect thrashing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-ws-takeover-'));
  const server = http.createServer();
  initWebSocketServer(server, root, {
    authToken: 'takeover-token',
    maxPayload: 1024 * 1024,
    maxManifestFiles: 10,
    authTimeoutMs: 1000
  });

  let firstSocket;
  let secondSocket;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const manifest = {
      sessionId: 'takeover-session',
      files: [{
        relativePath: 'takeover.txt',
        size: 0,
        hashAlgorithm: 'sha256',
        hash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex')
      }]
    };

    firstSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/upload`);
    await waitForOpen(firstSocket);
    firstSocket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'takeover-token' } }));
    assert.equal((await nextMessage(firstSocket)).type, 'AUTH_OK');
    firstSocket.send(JSON.stringify({ type: 'INIT_SESSION', payload: manifest }));
    assert.equal((await nextMessage(firstSocket)).type, 'SESSION_READY');

    const firstClose = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Previous socket was not invalidated')), 5000);
      firstSocket.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });

    secondSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/upload`);
    await waitForOpen(secondSocket);
    secondSocket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'takeover-token' } }));
    assert.equal((await nextMessage(secondSocket)).type, 'AUTH_OK');
    secondSocket.send(JSON.stringify({ type: 'INIT_SESSION', payload: manifest }));
    assert.equal((await nextMessage(secondSocket)).type, 'SESSION_READY');

    assert.deepEqual(await firstClose, {
      code: 4001,
      reason: 'Session taken over by reconnecting client'
    });
  } finally {
    for (const socket of [firstSocket, secondSocket]) {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    }
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WebSocket replacement keeps the existing final file until verification', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-ws-replace-'));
  const oldContent = Buffer.from('old published content');
  const newContent = Buffer.from('new published content');
  const targetPath = path.join(root, 'replace.txt');
  fs.writeFileSync(targetPath, oldContent);
  const hash = crypto.createHash('sha256').update(newContent).digest('hex');
  const server = http.createServer();
  initWebSocketServer(server, root, {
    authToken: 'replace-token',
    maxPayload: 1024 * 1024,
    maxChunkSize: 1024 * 1024,
    maxManifestFiles: 10,
    authTimeoutMs: 1000
  });

  let firstSocket;
  let secondSocket;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const manifest = {
      sessionId: 'replace-session',
      files: [{ relativePath: 'replace.txt', size: newContent.length, hashAlgorithm: 'sha256', hash }]
    };

    firstSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/upload`);
    await waitForOpen(firstSocket);
    firstSocket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'replace-token' } }));
    assert.equal((await nextMessage(firstSocket)).type, 'AUTH_OK');
    firstSocket.send(JSON.stringify({ type: 'INIT_SESSION', payload: manifest }));
    const ready = await nextMessage(firstSocket);
    assert.equal(ready.payload.files['replace.txt'].offset, 0);
    assert.deepEqual(fs.readFileSync(targetPath), oldContent);

    firstSocket.close();
    await new Promise(resolve => firstSocket.once('close', resolve));
    assert.deepEqual(fs.readFileSync(targetPath), oldContent);

    secondSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/upload`);
    await waitForOpen(secondSocket);
    secondSocket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'replace-token' } }));
    assert.equal((await nextMessage(secondSocket)).type, 'AUTH_OK');
    secondSocket.send(JSON.stringify({ type: 'INIT_SESSION', payload: manifest }));
    assert.equal((await nextMessage(secondSocket)).payload.files['replace.txt'].offset, 0);
    secondSocket.send(JSON.stringify({ type: 'START_FILE', payload: { relativePath: 'replace.txt' } }));
    assert.equal((await nextMessage(secondSocket)).type, 'FILE_STARTED');
    secondSocket.send(encodeChunk({ relativePath: 'replace.txt', offset: 0, data: newContent }));
    assert.equal((await nextMessage(secondSocket)).type, 'CHUNK_ACK');
    secondSocket.send(JSON.stringify({
      type: 'FINISH_FILE',
      payload: { relativePath: 'replace.txt', clientHash: hash, hashAlgorithm: 'sha256' }
    }));
    assert.equal((await nextMessage(secondSocket)).type, 'FILE_VERIFIED');
    assert.deepEqual(fs.readFileSync(targetPath), newContent);
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

test('WebSocket upload rejects file and directory path collisions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-ws-path-conflict-'));
  const server = http.createServer();
  initWebSocketServer(server, root, { authToken: 'path-token', authTimeoutMs: 1000 });
  let socket;

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/upload`);
    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'path-token' } }));
    assert.equal((await nextMessage(socket)).type, 'AUTH_OK');
    socket.send(JSON.stringify({
      type: 'INIT_SESSION',
      payload: {
        sessionId: 'path-conflict-session',
        files: [
          { relativePath: 'folder/file.txt', size: 0, hashAlgorithm: 'sha256', hash: '0'.repeat(64) },
          { relativePath: 'folder', size: 0, hashAlgorithm: 'sha256', hash: '0'.repeat(64) }
        ]
      }
    }));
    const error = await nextMessage(socket);
    assert.equal(error.type, 'ERROR');
    assert.match(error.message, /conflicts with a directory path/);
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WebSocket upload protects a custom SQLite database inside the uploads directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-ws-database-'));
  const server = http.createServer();
  initWebSocketServer(server, root, {
    authToken: 'database-token',
    databasePath: path.join(root, 'private.sqlite'),
    authTimeoutMs: 1000
  });
  let socket;

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/upload`);
    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'database-token' } }));
    assert.equal((await nextMessage(socket)).type, 'AUTH_OK');
    socket.send(JSON.stringify({
      type: 'INIT_SESSION',
      payload: {
        sessionId: 'database-session',
        files: [{ relativePath: 'private.sqlite', size: 0, hashAlgorithm: 'sha256', hash: '0'.repeat(64) }]
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

test('WebSocket upload closes a client that exceeds the message queue limit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-ws-queue-'));
  const existingContent = Buffer.alloc(2 * 1024 * 1024, 7);
  const existingPath = path.join(root, 'queued.bin');
  fs.writeFileSync(existingPath, existingContent);
  const server = http.createServer();
  initWebSocketServer(server, root, {
    authToken: 'queue-token',
    maxPayload: 4 * 1024 * 1024,
    maxQueuedMessages: 1,
    maxManifestFiles: 10,
    authTimeoutMs: 1000
  });
  let socket;

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/upload`);
    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: 'AUTH', payload: { token: 'queue-token' } }));
    assert.equal((await nextMessage(socket)).type, 'AUTH_OK');

    const manifest = {
      sessionId: 'queue-session',
      files: [{
        relativePath: 'queued.bin',
        size: existingContent.length,
        hashAlgorithm: 'sha256',
        hash: '0'.repeat(64)
      }]
    };
    const closeCode = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket queue limit did not close the client')), 5000);
      socket.once('close', code => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    const message = JSON.stringify({ type: 'INIT_SESSION', payload: manifest });
    for (let index = 0; index < 32; index += 1) socket.send(message);
    assert.equal(await closeCode, 1008);
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
