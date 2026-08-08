const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

test('CLI prints usage when no source path is provided', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/upload-cli.js')], {
    encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /Usage:/);
  assert.match(`${result.stdout}\n${result.stderr}`, /--algorithm/);
});
