const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI_PATH = path.resolve(__dirname, '../bin/local-copy.js');

test('local copy CLI copies a complete directory and supports selecting an entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-copy-cli-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  try {
    fs.mkdirSync(source);
    fs.mkdirSync(destination);
    fs.mkdirSync(path.join(source, 'folder'));
    fs.writeFileSync(path.join(source, 'one.txt'), 'one');
    fs.writeFileSync(path.join(source, 'folder', 'two.txt'), 'two');

    const all = spawnSync(process.execPath, [CLI_PATH, '--source', source, '--destination', destination], {
      encoding: 'utf8'
    });
    assert.equal(all.status, 0, all.stderr);
    assert.equal(fs.readFileSync(path.join(destination, 'one.txt'), 'utf8'), 'one');
    assert.equal(fs.readFileSync(path.join(destination, 'folder', 'two.txt'), 'utf8'), 'two');

    const selectedDestination = path.join(root, 'selected');
    fs.mkdirSync(selectedDestination);
    const selected = spawnSync(process.execPath, [
      CLI_PATH,
      '-s', source,
      '-d', selectedDestination,
      '-e', 'one.txt'
    ], { encoding: 'utf8' });
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(fs.readFileSync(path.join(selectedDestination, 'one.txt'), 'utf8'), 'one');
    assert.equal(fs.existsSync(path.join(selectedDestination, 'folder')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local copy CLI reports usage when directories are missing', () => {
  const result = spawnSync(process.execPath, [CLI_PATH], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /Usage:/);
  assert.match(`${result.stdout}\n${result.stderr}`, /--replace-existing/);
});
