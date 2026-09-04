const test = require('node:test');
const assert = require('node:assert/strict');
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

function stopServer(child) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: null });
  child.kill('SIGTERM');
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
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

test('authenticated local API lists and copies between arbitrary directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-local-api-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const port = await getFreePort();
  const token = 'local-api-test-token';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      UPLOADS_DIR: path.join(root, 'uploads'),
      HASH_SCAN_ROOT: path.join(root, 'uploads'),
      STATE_DB_PATH: path.join(root, 'state.sqlite'),
      CLOUDVAULT_AUTH_TOKEN: token
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, 'copy.txt'), 'copy me');
    fs.writeFileSync(path.join(source, 'nested', 'child.txt'), 'child');

    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${token}` };

    const unauthorized = await fetch(`${baseUrl}/api/local/list?path=${encodeURIComponent(source)}`);
    assert.equal(unauthorized.status, 401);

    const listingResponse = await fetch(`${baseUrl}/api/local/list?path=${encodeURIComponent(source)}`, { headers });
    assert.equal(listingResponse.status, 200);
    const listing = await listingResponse.json();
    assert.equal(listing.path, path.resolve(source));
    assert.equal(listing.parentPath, path.dirname(path.resolve(source)));
    assert.deepEqual(listing.entries.map(entry => [entry.name, entry.type]), [
      ['nested', 'directory'],
      ['copy.txt', 'file']
    ]);

    const copyResponse = await fetch(`${baseUrl}/api/local/copy`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: source, destinationPath: destination, entries: ['copy.txt', 'nested'] })
    });
    assert.equal(copyResponse.status, 200);
    const copy = await copyResponse.json();
    assert.equal(copy.errors.length, 0);
    assert.equal(copy.filesCopied, 2);
    assert.equal(fs.readFileSync(path.join(destination, 'copy.txt'), 'utf8'), 'copy me');
    assert.equal(fs.readFileSync(path.join(destination, 'nested', 'child.txt'), 'utf8'), 'child');

    const conflictResponse = await fetch(`${baseUrl}/api/local/copy`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: source, destinationPath: destination, entries: ['copy.txt'] })
    });
    assert.equal(conflictResponse.status, 200);
    const conflict = await conflictResponse.json();
    assert.equal(conflict.errors[0].code, 'DESTINATION_EXISTS');

    const invalidResponse = await fetch(`${baseUrl}/api/local/copy`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: source, destinationPath: destination, entries: ['../outside'] })
    });
    assert.equal(invalidResponse.status, 400);
  } finally {
    const stopped = await stopServer(child);
    assert.equal(stopped.code, 0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
