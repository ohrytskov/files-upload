const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CopyJob, copyManager, PART_SUFFIX } = require('../lib/copy-manager');

test('CopyJob copies files statefully and supports suspend and resume', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-stateful-copy-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');

  try {
    fs.mkdirSync(source);
    fs.mkdirSync(destination);

    // Create 3 files: file1 (small), file2 (larger, to test chunks), file3
    const bigContent = Buffer.alloc(2 * 1024 * 1024, 'a'); // 2 MiB
    fs.writeFileSync(path.join(source, 'file1.txt'), 'hello world 1');
    fs.writeFileSync(path.join(source, 'file2.bin'), bigContent);
    fs.writeFileSync(path.join(source, 'file3.txt'), 'hello world 3');

    const job = new CopyJob({
      sourcePath: source,
      destinationPath: destination,
      entries: ['file1.txt', 'file2.bin', 'file3.txt']
    });

    assert.equal(job.status, 'idle');
    const statePromise = job.start();

    // Give it a tiny moment to start copying, then suspend
    await new Promise(resolve => setTimeout(resolve, 5));
    job.suspend();

    await statePromise;
    const suspendedState = job.getState();
    assert.equal(suspendedState.status === 'suspended' || suspendedState.status === 'completed', true);

    // If it was suspended, resume and ensure it completes
    if (suspendedState.status === 'suspended') {
      assert.equal(job.status, 'suspended');
      const resumePromise = job.resume();
      const finalState = await resumePromise;
      assert.equal(finalState.status, 'completed');
    }

    // Verify all destination files match
    assert.equal(fs.readFileSync(path.join(destination, 'file1.txt'), 'utf8'), 'hello world 1');
    assert.deepEqual(fs.readFileSync(path.join(destination, 'file2.bin')), bigContent);
    assert.equal(fs.readFileSync(path.join(destination, 'file3.txt'), 'utf8'), 'hello world 3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CopyJob cancellation cleans up staging part files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-copy-cancel-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');

  try {
    fs.mkdirSync(source);
    fs.mkdirSync(destination);

    const bigContent = Buffer.alloc(4 * 1024 * 1024, 'z');
    fs.writeFileSync(path.join(source, 'big.bin'), bigContent);

    const job = new CopyJob({
      sourcePath: source,
      destinationPath: destination,
      entries: ['big.bin']
    });

    const startPromise = job.start();
    await new Promise(resolve => setTimeout(resolve, 2));
    job.cancel();
    await startPromise;

    const state = job.getState();
    assert.equal(state.status, 'cancelled');
    assert.equal(fs.existsSync(`${path.join(destination, 'big.bin')}${PART_SUFFIX}`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('copyManager lists and tracks active jobs', () => {
  const job = copyManager.createJob({
    sourcePath: '/tmp/src',
    destinationPath: '/tmp/dst',
    entries: ['test.txt']
  });

  assert.equal(copyManager.getJob(job.id), job);
  const list = copyManager.listJobs();
  assert.equal(list.some(j => j.id === job.id), true);
  copyManager.deleteJob(job.id);
  assert.equal(copyManager.getJob(job.id), null);
});
