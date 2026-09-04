const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  copyLocalEntries,
  isWindowsStylePath,
  listLocalDirectory,
  normalizeEntryName,
  normalizeLocalPath,
  pathIsWithin
} = require('../lib/local-filesystem');

test('local path utilities accept POSIX and Windows drive syntax', () => {
  assert.equal(isWindowsStylePath('C:'), true);
  assert.equal(isWindowsStylePath('D:\\flash-drive\\photos'), true);
  assert.equal(isWindowsStylePath('\\\\server\\share'), true);
  assert.equal(isWindowsStylePath('/media/usb'), false);
  assert.equal(normalizeLocalPath('C:'), 'C:\\');
  assert.equal(normalizeLocalPath('D:/flash-drive/photos'), 'D:\\flash-drive\\photos');
  assert.equal(normalizeEntryName('photo.jpg'), 'photo.jpg');
  assert.throws(() => normalizeEntryName('../photo.jpg'), /Invalid local entry name/);
  assert.throws(() => normalizeEntryName('folder\\photo.jpg'), /Invalid local entry name/);
});

test('local directory listing returns directories first with file metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-local-list-'));
  try {
    fs.mkdirSync(path.join(root, 'folder'));
    fs.writeFileSync(path.join(root, 'file.txt'), 'local file');

    const result = await listLocalDirectory(root);
    assert.equal(result.path, path.resolve(root));
    assert.equal(result.parentPath, path.dirname(path.resolve(root)));
    assert.deepEqual(result.entries.map(entry => [entry.name, entry.type]), [
      ['folder', 'directory'],
      ['file.txt', 'file']
    ]);
    assert.equal(result.entries[1].size, 10);
    assert.match(result.entries[1].modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local copy streams files and recursively copies directories without overwriting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-local-copy-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  try {
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, 'root.txt'), 'root content');
    fs.writeFileSync(path.join(source, 'nested', 'child.txt'), 'child content');

    const result = await copyLocalEntries({
      sourcePath: source,
      destinationPath: destination,
      entries: ['root.txt', 'nested']
    });

    assert.deepEqual(result.copied, [
      { name: 'root.txt', type: 'file' },
      { name: 'nested', type: 'directory' }
    ]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.filesCopied, 2);
    assert.equal(result.directoriesCopied, 1);
    assert.equal(result.bytesCopied, Buffer.byteLength('root content') + Buffer.byteLength('child content'));
    assert.equal(fs.readFileSync(path.join(destination, 'root.txt'), 'utf8'), 'root content');
    assert.equal(fs.readFileSync(path.join(destination, 'nested', 'child.txt'), 'utf8'), 'child content');

    const conflict = await copyLocalEntries({
      sourcePath: source,
      destinationPath: destination,
      entries: ['root.txt']
    });
    assert.equal(conflict.copied.length, 0);
    assert.equal(conflict.errors[0].code, 'DESTINATION_EXISTS');
    assert.equal(fs.readFileSync(path.join(destination, 'root.txt'), 'utf8'), 'root content');

    fs.writeFileSync(path.join(source, 'root.txt'), 'updated content');
    const replaced = await copyLocalEntries({
      sourcePath: source,
      destinationPath: destination,
      entries: ['root.txt'],
      overwrite: true
    });
    assert.equal(replaced.copied.length, 1);
    assert.equal(fs.readFileSync(path.join(destination, 'root.txt'), 'utf8'), 'updated content');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local copy rejects same directories, recursive destinations, and symbolic links', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-local-safety-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  try {
    fs.mkdirSync(path.join(source, 'folder'), { recursive: true });
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, 'file.txt'), 'content');
    assert.equal(pathIsWithin(source, path.join(source, 'folder')), true);

    await assert.rejects(
      copyLocalEntries({ sourcePath: source, destinationPath: source, entries: ['file.txt'] }),
      error => error.code === 'SAME_DIRECTORY'
    );
    await assert.rejects(
      copyLocalEntries({ sourcePath: source, destinationPath: path.join(source, 'folder'), entries: ['folder'] }),
      error => error.code === 'DESTINATION_INSIDE_SOURCE'
    );
    await assert.rejects(
      copyLocalEntries({ sourcePath: source, destinationPath: source, entries: ['folder'], overwrite: true }),
      error => error.code === 'SAME_DIRECTORY'
    );

    const linkPath = path.join(source, 'link');
    fs.symlinkSync(path.join(root, 'outside'), linkPath, 'file');
    const result = await copyLocalEntries({ sourcePath: source, destinationPath: destination, entries: ['link'] });
    assert.equal(result.errors[0].code, 'SYMBOLIC_LINK');
    assert.equal(fs.existsSync(path.join(destination, 'link')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
