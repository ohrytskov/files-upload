const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DOWNLOAD_CLI = path.resolve(__dirname, '../bin/download-cli.js');

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

test('stateful download endpoint supports HTTP Range requests and resume', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-download-test-'));
  const uploadsDir = path.join(root, 'uploads');
  fs.mkdirSync(uploadsDir);

  const fileContent = '0123456789abcdefghijklmnopqrstuvwxyz';
  fs.writeFileSync(path.join(uploadsDir, 'test-download.txt'), fileContent);

  const port = await getFreePort();
  const token = 'download-test-token';
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
    const headers = { Authorization: `Bearer ${token}` };

    // 1. Unauthorized request
    const unauthorized = await fetch(`${baseUrl}/api/files/test-download.txt/download`);
    assert.equal(unauthorized.status, 401);

    // 2. Full download
    const fullRes = await fetch(`${baseUrl}/api/files/test-download.txt/download`, { headers });
    assert.equal(fullRes.status, 200);
    assert.equal(fullRes.headers.get('accept-ranges'), 'bytes');
    assert.equal(fullRes.headers.get('content-length'), String(fileContent.length));
    assert.equal(await fullRes.text(), fileContent);

    // 3. First chunk: bytes 0-9
    const chunk1Res = await fetch(`${baseUrl}/api/files/test-download.txt/download`, {
      headers: { ...headers, Range: 'bytes=0-9' }
    });
    assert.equal(chunk1Res.status, 206);
    assert.equal(chunk1Res.headers.get('content-range'), `bytes 0-9/${fileContent.length}`);
    assert.equal(chunk1Res.headers.get('content-length'), '10');
    assert.equal(await chunk1Res.text(), fileContent.slice(0, 10));

    // 4. Second chunk (resuming from byte 10): bytes 10-
    const chunk2Res = await fetch(`${baseUrl}/api/files/test-download.txt/download`, {
      headers: { ...headers, Range: 'bytes=10-' }
    });
    assert.equal(chunk2Res.status, 206);
    assert.equal(chunk2Res.headers.get('content-range'), `bytes 10-${fileContent.length - 1}/${fileContent.length}`);
    assert.equal(await chunk2Res.text(), fileContent.slice(10));

    // 5. Out of bounds range
    const badRange = await fetch(`${baseUrl}/api/files/test-download.txt/download`, {
      headers: { ...headers, Range: 'bytes=999-1000' }
    });
    assert.equal(badRange.status, 416);

    // 6. Test download CLI tool
    const downloadDestDir = path.join(root, 'cli-downloads');
    fs.mkdirSync(downloadDestDir);

    const cliResult = spawnSync(process.execPath, [
      DOWNLOAD_CLI,
      '--file', 'test-download.txt',
      '--destination', downloadDestDir,
      '--server', baseUrl,
      '--token', token,
      '--chunk-size', '8'
    ], { encoding: 'utf8' });

    assert.equal(cliResult.status, 0, cliResult.stderr);
    const downloadedFile = path.join(downloadDestDir, 'test-download.txt');
    assert.equal(fs.existsSync(downloadedFile), true);
    assert.equal(fs.readFileSync(downloadedFile, 'utf8'), fileContent);
  } finally {
    await stopServer(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
