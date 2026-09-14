const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseArgs,
  verifyBuildArtifacts,
  verifyServerEntry
} = require('../bin/deploy');

const CLI_PATH = path.resolve(__dirname, '../bin/deploy.js');

test('deploy CLI prints usage with --help and -h', () => {
  const resultHelp = spawnSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' });
  assert.equal(resultHelp.status, 0);
  assert.match(resultHelp.stdout, /Usage: node bin\/deploy\.js/);
  assert.match(resultHelp.stdout, /--skip-tests/);
  assert.match(resultHelp.stdout, /--dry-run/);

  const resultH = spawnSync(process.execPath, [CLI_PATH, '-h'], { encoding: 'utf8' });
  assert.equal(resultH.status, 0);
  assert.match(resultH.stdout, /Usage: node bin\/deploy\.js/);
});

test('deploy CLI parses command line options correctly', () => {
  const options = parseArgs([
    '--skip-tests',
    '--skip-build',
    '--clean',
    '--dry-run',
    '--start',
    '--port', '4000',
    '--host', '0.0.0.0',
    '--token', 'secret123',
    '--env', '.env.custom'
  ]);

  assert.equal(options.skipTests, true);
  assert.equal(options.skipBuild, true);
  assert.equal(options.clean, true);
  assert.equal(options.dryRun, true);
  assert.equal(options.start, true);
  assert.equal(options.port, 4000);
  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.token, 'secret123');
  assert.equal(options.envFile, '.env.custom');
});

test('deploy CLI rejects invalid port', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--port', 'invalid'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /Invalid port/);
});

test('deploy CLI rejects unknown option', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--nonexistent-flag'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /Unknown option/);
});

test('deploy CLI executes dry-run validation with --dry-run and --skip-tests', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--dry-run', '--skip-tests'], {
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN VALIDATED/);
  assert.match(result.stdout, /CloudVault Deployment Complete/);
});

test('verifyBuildArtifacts validates dist directory and detects missing files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
  try {
    assert.throws(() => verifyBuildArtifacts(tempDir), /missing ".*index\.html"/);

    const indexHtml = path.join(tempDir, 'index.html');
    fs.writeFileSync(indexHtml, '');
    assert.throws(() => verifyBuildArtifacts(tempDir), /is empty/);

    fs.writeFileSync(indexHtml, '<!DOCTYPE html><html><body>Test</body></html>');
    assert.throws(() => verifyBuildArtifacts(tempDir), /missing assets directory/);

    const assetsDir = path.join(tempDir, 'assets');
    fs.mkdirSync(assetsDir);
    assert.throws(() => verifyBuildArtifacts(tempDir), /no JavaScript bundle found/);

    fs.writeFileSync(path.join(assetsDir, 'bundle.js'), 'console.log("ok");');
    const verified = verifyBuildArtifacts(tempDir);
    assert.equal(verified.assetCount, 1);
    assert.ok(verified.indexHtmlSize > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('verifyServerEntry validates server.js syntax', () => {
  const serverPath = path.resolve(__dirname, '../server.js');
  assert.doesNotThrow(() => verifyServerEntry(serverPath));
});
