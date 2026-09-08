const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { ResumableUploadManager } = require('../lib/resumable-upload');
const { calculateServerHash } = require('../lib/ws-server');

test('ResumableUploadManager uploads chunks, supports suspend and resume, and verifies hash', async () => {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-resumable-'));

  try {
    const manager = new ResumableUploadManager({ uploadsDir });
    const content = Buffer.from('part 1 of file data ... part 2 of file data ... final part');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');

    const chunk1 = content.subarray(0, 20);
    const chunk2 = content.subarray(20, 40);
    const chunk3 = content.subarray(40);

    // 1. Init session
    const session = manager.initSession({
      filename: 'sample.txt',
      size: content.length,
      hashAlgorithm: 'sha256',
      expectedHash: sha256
    });

    assert.equal(session.offset, 0);
    assert.equal(session.filename, 'sample.txt');
    assert.equal(session.size, content.length);

    // 2. Write first chunk
    const res1 = manager.writeChunk(session.uploadId, 0, chunk1);
    assert.equal(res1.offset, 20);
    assert.equal(res1.completed, false);

    // 3. Suspend session
    const suspended = manager.suspendSession(session.uploadId);
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.offset, 20);

    // 4. Resume session
    const resumed = manager.resumeSession(session.uploadId);
    assert.equal(resumed.status, 'uploading');
    assert.equal(resumed.offset, 20);

    // 5. Write remaining chunks
    const res2 = manager.writeChunk(session.uploadId, 20, chunk2);
    assert.equal(res2.offset, 40);

    const res3 = manager.writeChunk(session.uploadId, 40, chunk3);
    assert.equal(res3.offset, content.length);
    assert.equal(res3.completed, true);

    // 6. Finish and verify
    function mockReserve(partPath, originalName) {
      const dest = path.join(uploadsDir, originalName);
      fs.renameSync(partPath, dest);
      return originalName;
    }

    const file = await manager.finishSession(session.uploadId, {
      calculateServerHash,
      reserveHttpUploadName: mockReserve
    });

    assert.equal(file.name, 'sample.txt');
    assert.equal(file.hash, sha256);
    assert.equal(fs.readFileSync(path.join(uploadsDir, 'sample.txt'), 'utf8'), content.toString());
  } finally {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test('ResumableUploadManager rejects hash mismatch and cleans up part file', async () => {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-mismatch-'));

  try {
    const manager = new ResumableUploadManager({ uploadsDir });
    const content = Buffer.from('correct data');
    const wrongHash = '0000000000000000000000000000000000000000000000000000000000000000';

    const session = manager.initSession({
      filename: 'mismatch.txt',
      size: content.length,
      hashAlgorithm: 'sha256',
      expectedHash: wrongHash
    });

    manager.writeChunk(session.uploadId, 0, content);

    await assert.rejects(
      manager.finishSession(session.uploadId, {
        calculateServerHash,
        reserveHttpUploadName: (p, n) => n
      }),
      err => err.code === 'CHECKSUM_MISMATCH'
    );

    const partPath = path.join(uploadsDir, `.${session.uploadId}.cloudvault-http-part`);
    assert.equal(fs.existsSync(partPath), false);
  } finally {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});
