const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes('Server running')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      if (code !== null && !output.includes('Server running')) {
        clearTimeout(timer);
        reject(new Error(`Server exited with ${code}: ${output}`));
      }
    });
  });
}

function stopServer(child) {
  if (child.exitCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
  return new Promise(resolve => child.once('exit', resolve));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

test('HTTP resumable upload API supports chunking, suspend, resume, and completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-resumable-api-'));
  const uploadsDir = path.join(root, 'uploads');
  fs.mkdirSync(uploadsDir);

  const port = await getFreePort();
  const token = 'resumable-api-token';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      UPLOADS_DIR: uploadsDir,
      HASH_SCAN_ROOT: uploadsDir,
      STATE_DB_PATH: path.join(root, 'state.sqlite'),
      CLOUDVAULT_AUTH_TOKEN: token
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      Authorization: `Bearer ${token}`
    };

    const fileData = Buffer.from('chunk1-data-chunk2-data-chunk3-data');
    const expectedHash = crypto.createHash('sha256').update(fileData).digest('hex');

    // 1. Init
    const initRes = await fetch(`${baseUrl}/api/upload/resumable/init`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'my-resumable.txt',
        size: fileData.length,
        hashAlgorithm: 'sha256',
        expectedHash
      })
    });
    assert.equal(initRes.status, 200);
    const session = await initRes.json();
    assert.equal(session.filename, 'my-resumable.txt');
    assert.equal(session.size, fileData.length);
    assert.equal(session.offset, 0);

    // 2. Upload Chunk 1
    const chunk1 = fileData.subarray(0, 12);
    const chunk1Res = await fetch(`${baseUrl}/api/upload/resumable/${session.uploadId}`, {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'Upload-Offset': '0'
      },
      body: chunk1
    });
    assert.equal(chunk1Res.status, 200);
    const chunk1Data = await chunk1Res.json();
    assert.equal(chunk1Data.offset, 12);

    // 3. Suspend
    const suspendRes = await fetch(`${baseUrl}/api/upload/resumable/${session.uploadId}/suspend`, {
      method: 'POST',
      headers
    });
    assert.equal(suspendRes.status, 200);
    const suspendData = await suspendRes.json();
    assert.equal(suspendData.status, 'suspended');

    // 4. Resume
    const resumeRes = await fetch(`${baseUrl}/api/upload/resumable/${session.uploadId}/resume`, {
      method: 'POST',
      headers
    });
    assert.equal(resumeRes.status, 200);
    const resumeData = await resumeRes.json();
    assert.equal(resumeData.status, 'uploading');
    assert.equal(resumeData.offset, 12);

    // 5. Upload Chunk 2 & 3
    const chunk2 = fileData.subarray(12);
    const chunk2Res = await fetch(`${baseUrl}/api/upload/resumable/${session.uploadId}`, {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'Upload-Offset': '12'
      },
      body: chunk2
    });
    assert.equal(chunk2Res.status, 200);
    const chunk2Data = await chunk2Res.json();
    assert.equal(chunk2Data.offset, fileData.length);
    assert.equal(chunk2Data.completed, true);

    // 6. Finish
    const finishRes = await fetch(`${baseUrl}/api/upload/resumable/${session.uploadId}/finish`, {
      method: 'POST',
      headers
    });
    assert.equal(finishRes.status, 200);
    const finishData = await finishRes.json();
    assert.equal(finishData.file.name, 'my-resumable.txt');
    assert.equal(finishData.file.hash, expectedHash);

    assert.equal(fs.readFileSync(path.join(uploadsDir, 'my-resumable.txt'), 'utf8'), fileData.toString());
  } finally {
    await stopServer(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
