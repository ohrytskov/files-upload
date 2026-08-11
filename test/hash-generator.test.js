const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  generateHashes,
  getAllFiles,
  getFileHash,
  normalizeHashAlgorithm
} = require('../lib/hash-generator');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-hash-'));
}

test('hash generation scans nested files and supports both algorithms', async () => {
  const root = temporaryDirectory();
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    const alpha = Buffer.from('alpha content');
    const beta = Buffer.from([0, 1, 2, 3, 255]);
    fs.writeFileSync(path.join(root, 'alpha.txt'), alpha);
    fs.writeFileSync(path.join(root, 'nested', 'beta.bin'), beta);

    assert.equal(getAllFiles(root).length, 2);
    assert.equal(normalizeHashAlgorithm(), 'sha256');
    assert.equal(
      await getFileHash(path.join(root, 'alpha.txt'), 'md5'),
      crypto.createHash('md5').update(alpha).digest('hex')
    );

    const result = await generateHashes({ sourcePath: root, algorithm: 'sha256' });
    assert.equal(result.hashAlgorithm, 'sha256');
    assert.equal(result.totalFiles, 2);
    assert.equal(result.totalBytes, alpha.length + beta.length);
    assert.deepEqual(result.files.map(file => file.relativePath).sort(), ['alpha.txt', 'nested/beta.bin']);
    assert.equal(result.files.every(file => file.hash.length === 64), true);

    const filtered = await generateHashes({
      sourcePath: root,
      algorithm: 'sha256',
      excludeFile: filePath => filePath.endsWith('beta.bin')
    });
    assert.deepEqual(filtered.files.map(file => file.relativePath), ['alpha.txt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hash generation rejects a missing source path', async () => {
  const root = temporaryDirectory();
  try {
    await assert.rejects(
      () => generateHashes({ sourcePath: path.join(root, 'does-not-exist') }),
      /does-not-exist/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hash manifests exclude their own output file and cannot overwrite the source', async () => {
  const root = temporaryDirectory();
  try {
    const source = path.join(root, 'source.txt');
    const output = path.join(root, 'hashes.txt');
    fs.writeFileSync(source, 'manifest input');
    fs.writeFileSync(output, 'old manifest\n');

    const result = await generateHashes({ sourcePath: root, outputFile: output, algorithm: 'sha256' });
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.files.map(file => file.relativePath), ['source.txt']);
    assert.match(fs.readFileSync(output, 'utf8'), /source\.txt\n$/);

    await assert.rejects(
      () => generateHashes({ sourcePath: source, outputFile: source }),
      /must not overwrite the source file/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hash manifests reject symbolic-link and hard-link output aliases', async () => {
  const root = temporaryDirectory();
  try {
    const source = path.join(root, 'source.txt');
    const hardLink = path.join(root, 'hashes-hardlink.txt');
    fs.writeFileSync(source, 'source content');
    fs.linkSync(source, hardLink);

    await assert.rejects(
      () => generateHashes({ sourcePath: root, outputFile: hardLink }),
      /must not be a hard link/
    );

    if (process.platform !== 'win32') {
      const symbolicLink = path.join(root, 'hashes-symlink.txt');
      fs.symlinkSync(source, symbolicLink);
      await assert.rejects(
        () => generateHashes({ sourcePath: root, outputFile: symbolicLink }),
        /must not be a symbolic link/
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
