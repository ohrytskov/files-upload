const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
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

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
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

test('HTTP API loads configured storage and protects hash scan endpoints', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-api-'));
  const fileContent = Buffer.from('api scan content');
  fs.writeFileSync(path.join(root, 'server.txt'), fileContent);
  fs.writeFileSync(path.join(root, 'server_state.json'), '{}');
  fs.writeFileSync(path.join(root, 'stale.cloudvault-part'), 'partial');
  const port = await getFreePort();
  const token = 'api-test-token';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      UPLOADS_DIR: root,
      HASH_SCAN_ROOT: root,
      CLOUDVAULT_AUTH_TOKEN: token
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;

    const unauthorized = await fetch(`${baseUrl}/api/hash/directories`);
    assert.equal(unauthorized.status, 401);

    const headers = { Authorization: `Bearer ${token}` };
    const directoriesResponse = await fetch(`${baseUrl}/api/hash/directories`, { headers });
    assert.equal(directoriesResponse.status, 200);
    const directories = await directoriesResponse.json();
    assert.equal(directories.directories.some(directory => directory.value === '.'), true);

    const scanResponse = await fetch(`${baseUrl}/api/hash/scan`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: '.', algorithm: 'sha256' })
    });
    assert.equal(scanResponse.status, 200);
    const scan = await scanResponse.json();
    assert.equal(scan.totalFiles, 1);
    assert.equal(scan.hashAlgorithm, 'sha256');
    assert.equal(scan.sourcePath, '.');
    assert.equal(Object.prototype.hasOwnProperty.call(scan.files[0], 'absolutePath'), false);
    assert.equal(scan.files[0].hash, crypto.createHash('sha256').update(fileContent).digest('hex'));

    const uploadContent = Buffer.from('authenticated HTTP upload');
    const uploadHash = crypto.createHash('sha256').update(uploadContent).digest('hex');
    const form = new FormData();
    form.append('algorithm', 'sha256');
    form.append('clientHashes', JSON.stringify([uploadHash]));
    form.append('files', new Blob([uploadContent]), 'http-upload.txt');
    const uploadResponse = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers,
      body: form
    });
    assert.equal(uploadResponse.status, 200);
    const upload = await uploadResponse.json();
    assert.equal(upload.files[0].hashAlgorithm, 'sha256');
    assert.equal(upload.files[0].hash, uploadHash);

    const renameResponse = await fetch(`${baseUrl}/api/files/${encodeURIComponent('http-upload.txt')}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: 'nested/renamed.txt' })
    });
    assert.equal(renameResponse.status, 200);
    assert.equal(fs.readFileSync(path.join(root, 'nested', 'renamed.txt')).toString(), uploadContent.toString());

    const deleteResponse = await fetch(`${baseUrl}/api/files/${encodeURIComponent('nested/renamed.txt')}`, {
      method: 'DELETE',
      headers
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal(fs.existsSync(path.join(root, 'nested', 'renamed.txt')), false);

    const reservedForm = new FormData();
    reservedForm.append('files', new Blob([Buffer.from('reserved')]), 'server_state.json');
    const reservedUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers,
      body: reservedForm
    });
    assert.equal(reservedUpload.status, 400);
    assert.equal(fs.readFileSync(path.join(root, 'server_state.json'), 'utf8'), '{}');

    const traversalResponse = await fetch(`${baseUrl}/api/hash/scan`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: '../' })
    });
    assert.equal(traversalResponse.status, 403);
  } finally {
    await stopServer(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
