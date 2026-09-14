#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function printUsage(stream = process.stdout) {
  stream.write(`Usage: node bin/deploy.js [options]

Deploy CloudVault for production: validates environment, runs quality pre-checks,
builds production frontend bundle, initializes storage & SQLite state database,
and verifies production readiness.

Options:
      --skip-tests       Skip linting and automated test runs
      --skip-build       Skip frontend Vite build (use existing dist/)
      --clean            Clean dist/ directory before building
      --dry-run          Validate environment and config without building or starting
      --start            Start production server immediately after deployment
  -p, --port <port>      Override server port (default from .env or 3001)
      --host <host>      Override server host (default from .env or 127.0.0.1)
      --token <token>    Override CLOUDVAULT_AUTH_TOKEN
      --env <file>       Custom .env file path
  -h, --help             Show this help message

Examples:
  npm run deploy
  npm run deploy -- --skip-tests
  npm run deploy -- --start
  npm run deploy -- --dry-run
  node bin/deploy.js --port 8080 --start
`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const isTruthy = (val) => Boolean(val && ['1', 'true', 'yes', 'on'].includes(String(val).toLowerCase()));
  const options = {
    help: false,
    skipTests: isTruthy(process.env.DEPLOY_SKIP_TESTS),
    skipBuild: isTruthy(process.env.DEPLOY_SKIP_BUILD),
    clean: false,
    dryRun: isTruthy(process.env.DEPLOY_DRY_RUN),
    start: isTruthy(process.env.DEPLOY_START),
    port: null,
    host: null,
    token: null,
    envFile: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--skip-tests') {
      options.skipTests = true;
    } else if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--clean') {
      options.clean = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--start') {
      options.start = true;
    } else if (arg === '-p' || arg === '--port') {
      i += 1;
      const parsed = Number(argv[i]);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`Invalid port: "${argv[i]}". Port must be an integer between 1 and 65535.`);
      }
      options.port = parsed;
    } else if (arg === '--host') {
      i += 1;
      if (!argv[i]) throw new Error('Missing value for --host option.');
      options.host = argv[i];
    } else if (arg === '--token') {
      i += 1;
      options.token = argv[i] || '';
    } else if (arg === '--env') {
      i += 1;
      if (!argv[i]) throw new Error('Missing value for --env option.');
      options.envFile = argv[i];
    } else {
      throw new Error(`Unknown option: "${arg}". Use --help to view available options.`);
    }
  }

  return options;
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommand(command, args, { cwd = PROJECT_ROOT, env = process.env, dryRun = false } = {}) {
  const display = `${command} ${args.join(' ')}`;
  if (dryRun) {
    console.log(`[Deploy] 🔍 [Dry-run] Would execute: ${display}`);
    return { status: 0 };
  }
  const isWindows = process.platform === 'win32';
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env,
    shell: isWindows
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${display}`);
  }
  return result;
}

function checkNodeEnvironment() {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  const minor = parseInt(version.split('.')[1], 10);
  if (major < 20) {
    console.warn(`[Deploy] ⚠️ Node.js version v${version} detected. Node.js 20 or newer is required.`);
  }
  if (major < 22 || (major === 22 && minor < 5)) {
    console.log(`[Deploy] ℹ️ Node.js version is v${version}. Node.js 22.5+ is recommended for built-in SQLite fallback.`);
  }
}

function verifyDatabase(stateDbPath, { dryRun = false } = {}) {
  const dbDir = path.dirname(stateDbPath);
  if (!fs.existsSync(dbDir)) {
    if (!dryRun) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }
  if (dryRun) {
    console.log(`[Deploy] 🔍 [Dry-run] Would initialize/verify SQLite database at: ${stateDbPath}`);
    return;
  }

  const CloudVaultDatabase = require('../lib/database');
  const db = new CloudVaultDatabase(stateDbPath);
  try {
    const row = db.db.prepare(
      "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name IN ('metadata', 'upload_sessions', 'upload_items', 'repository_files')"
    ).get();
    if (!row || row.count < 4) {
      throw new Error(`Database schema verification failed: expected core tables, found ${row?.count || 0}.`);
    }
  } finally {
    db.close();
  }
}

function verifyBuildArtifacts(distDir) {
  const indexHtml = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`Build verification failed: missing "${indexHtml}". Run "npm run build" to compile frontend.`);
  }
  const stats = fs.statSync(indexHtml);
  if (stats.size === 0) {
    throw new Error(`Build verification failed: "${indexHtml}" is empty.`);
  }
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Build verification failed: missing assets directory "${assetsDir}".`);
  }
  const assets = fs.readdirSync(assetsDir);
  const hasJs = assets.some(file => file.endsWith('.js'));
  if (!hasJs) {
    throw new Error(`Build verification failed: no JavaScript bundle found in "${assetsDir}".`);
  }
  return { indexHtmlSize: stats.size, assetCount: assets.length };
}

function verifyServerEntry(serverPath) {
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Server entrypoint not found at: ${serverPath}`);
  }
  const result = spawnSync(process.execPath, ['--check', serverPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Server syntax validation failed:\n${result.stderr || result.stdout}`);
  }
}

async function deploy(options = {}) {
  const startTime = Date.now();
  console.log('\n==================================================');
  console.log(' 🚀 CloudVault Production Deployment');
  console.log('==================================================\n');

  // 1. Prerequisites and environment
  checkNodeEnvironment();

  if (options.envFile) {
    const dotenv = require('dotenv');
    const resolvedEnv = path.resolve(options.envFile);
    if (!fs.existsSync(resolvedEnv)) {
      throw new Error(`Specified environment file does not exist: "${resolvedEnv}"`);
    }
    dotenv.config({ path: resolvedEnv });
    console.log(`[Deploy] 📄 Loaded custom environment from: ${resolvedEnv}`);
  } else {
    const envPath = path.join(PROJECT_ROOT, '.env');
    const envExamplePath = path.join(PROJECT_ROOT, '.env.example');
    if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
      if (!options.dryRun) {
        fs.copyFileSync(envExamplePath, envPath);
        console.log('[Deploy] ℹ️ Initialized .env from .env.example.');
      } else {
        console.log('[Deploy] 🔍 [Dry-run] Would copy .env.example to .env.');
      }
    }
  }

  // Load config
  const config = require('../lib/config');
  const effectiveHost = options.host || config.host;
  const effectivePort = options.port || config.port;
  const effectiveToken = options.token !== null ? options.token : config.authToken;
  const effectiveUploadsDir = config.uploadsDir;
  const effectiveStateDb = config.stateDbPath;
  const distDir = path.join(PROJECT_ROOT, 'dist');
  const serverPath = path.join(PROJECT_ROOT, 'server.js');

  console.log(`[Deploy] 🌐 Target: http://${effectiveHost}:${effectivePort}`);
  console.log(`[Deploy] 📁 Uploads Directory: ${effectiveUploadsDir}`);
  console.log(`[Deploy] 💾 State Database: ${effectiveStateDb}`);

  // Security check
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(effectiveHost);
  if (!isLoopback && !effectiveToken) {
    console.warn('\n[Deploy] ⚠️ WARNING: Server host is not loopback and CLOUDVAULT_AUTH_TOKEN is not set.');
    console.warn('[Deploy] ⚠️ For production security, configure CLOUDVAULT_AUTH_TOKEN in your environment.\n');
  }

  // Storage directory setup
  if (!fs.existsSync(effectiveUploadsDir)) {
    if (!options.dryRun) {
      fs.mkdirSync(effectiveUploadsDir, { recursive: true });
      console.log(`[Deploy] 📁 Created uploads directory: ${effectiveUploadsDir}`);
    } else {
      console.log(`[Deploy] 🔍 [Dry-run] Would create uploads directory: ${effectiveUploadsDir}`);
    }
  }
  if (!options.dryRun) {
    try {
      fs.accessSync(effectiveUploadsDir, fs.constants.W_OK);
    } catch (err) {
      throw new Error(`Uploads directory "${effectiveUploadsDir}" is not writable: ${err.message}`);
    }
  }

  // 2. Database verification
  console.log('[Deploy] 🗄️ Checking SQLite database...');
  verifyDatabase(effectiveStateDb, { dryRun: options.dryRun });
  console.log('[Deploy] ✅ SQLite state database initialized & verified.');

  // 3. Quality Pre-checks (Tests & Lint)
  if (options.skipTests) {
    console.log('[Deploy] ⏩ Skipping tests (--skip-tests).');
  } else {
    console.log('[Deploy] 🧪 Running pre-deployment validation suite...');
    const npmCmd = getNpmCommand();

    console.log('[Deploy] 🔍 Running linter (npm run lint)...');
    runCommand(npmCmd, ['run', 'lint'], { dryRun: options.dryRun });

    console.log('[Deploy] 🧪 Running backend tests (npm test)...');
    runCommand(npmCmd, ['test'], { dryRun: options.dryRun });

    console.log('[Deploy] 🧪 Running frontend tests (npm run test:frontend)...');
    runCommand(npmCmd, ['run', 'test:frontend'], { dryRun: options.dryRun });

    console.log('[Deploy] ✅ All pre-deployment tests passed.');
  }

  // 4. Build frontend
  if (options.skipBuild) {
    console.log('[Deploy] ⏩ Skipping frontend build (--skip-build).');
  } else {
    if (options.clean && fs.existsSync(distDir)) {
      if (!options.dryRun) {
        fs.rmSync(distDir, { recursive: true, force: true });
        console.log('[Deploy] 🧹 Cleaned previous dist/ directory.');
      } else {
        console.log('[Deploy] 🔍 [Dry-run] Would clean previous dist/ directory.');
      }
    }

    console.log('[Deploy] 🔨 Building production frontend bundle (npm run build)...');
    const npmCmd = getNpmCommand();
    runCommand(npmCmd, ['run', 'build'], { dryRun: options.dryRun });
  }

  // Verify build artifacts (unless dry-run and not built yet)
  if (!options.dryRun || fs.existsSync(distDir)) {
    const buildInfo = verifyBuildArtifacts(distDir);
    console.log(`[Deploy] ✅ Frontend bundle verified (index.html: ${buildInfo.indexHtmlSize} bytes, ${buildInfo.assetCount} assets).`);
  }

  // 5. Server entrypoint check
  verifyServerEntry(serverPath);
  console.log('[Deploy] ✅ Server entrypoint syntax verified.');

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  // 6. Summary
  console.log('\n==================================================');
  console.log(` 🚀 CloudVault Deployment Complete (${durationSec}s)`);
  console.log('==================================================');
  console.log(` Status:      ${options.dryRun ? 'DRY RUN VALIDATED' : 'READY FOR PRODUCTION'}`);
  console.log(` Host:        ${effectiveHost}`);
  console.log(` Port:        ${effectivePort}`);
  console.log(` URL:         http://${effectiveHost}:${effectivePort}`);
  console.log(` Uploads:     ${effectiveUploadsDir}`);
  console.log(` State DB:    ${effectiveStateDb}`);
  console.log(` Auth:        ${effectiveToken ? 'Enabled (Protected)' : 'None (Open access)'}`);
  console.log(` Frontend:    ${distDir} (verified)`);
  console.log('==================================================\n');

  if (options.start) {
    if (options.dryRun) {
      console.log(`[Deploy] 🔍 [Dry-run] Would start server: node server.js on http://${effectiveHost}:${effectivePort}`);
      return;
    }
    console.log(`[Deploy] ⚡ Starting CloudVault server on http://${effectiveHost}:${effectivePort} ...\n`);
    const serverProcess = spawn(process.execPath, [serverPath], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(effectivePort),
        HOST: effectiveHost,
        NODE_ENV: 'production',
        ...(effectiveToken ? { CLOUDVAULT_AUTH_TOKEN: effectiveToken } : {})
      }
    });

    const onSignal = (sig) => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill(sig);
      }
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    return new Promise((resolve, reject) => {
      serverProcess.on('error', reject);
      serverProcess.on('exit', (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
        } else if (code !== 0 && code !== null) {
          process.exit(code);
        } else {
          resolve();
        }
      });
    });
  }

  console.log('To start the production server:');
  console.log('  npm start');
  console.log('  # or re-run with --start:');
  console.log('  npm run deploy -- --start\n');
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      process.exit(0);
    }
    await deploy(options);
  } catch (err) {
    console.error(`\n[Deploy] ❌ Deployment failed: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  printUsage,
  parseArgs,
  runCommand,
  checkNodeEnvironment,
  verifyDatabase,
  verifyBuildArtifacts,
  verifyServerEntry,
  deploy
};

if (require.main === module) {
  main();
}
