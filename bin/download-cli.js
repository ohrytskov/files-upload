#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeHashAlgorithm } = require('../lib/hash-generator');

const PART_SUFFIX = '.cloudvault-download-part';
const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MiB

function printUsage(stream = process.stdout) {
  stream.write(`Usage: node bin/download-cli.js --file <filename> [options]

Download a file from CloudVault statefully with suspend (Ctrl+C) and resume
support using HTTP Range requests.

Options:
  -f, --file <name>            File name/path to download from server
  -d, --destination <path>     Local destination directory or file path (default: current directory)
  -s, --server <url>           CloudVault server URL (default: http://localhost:3001)
      --token <token>          Bearer token for server authentication
      --state <file>           State file path for resuming (default: .cloudvault-download-state.json)
      --chunk-size <bytes>     Chunk size in bytes (default: 2097152 / 2 MiB)
      --resume                 Resume an interrupted or suspended download
  -h, --help                   Show this help

Examples:
  node bin/download-cli.js -f "archive.zip" -d "./downloads"
  node bin/download-cli.js -f "video.mp4" -s "http://127.0.0.1:3001" --token "$CLOUDVAULT_AUTH_TOKEN"
  node bin/download-cli.js -f "dataset.bin" --resume --state "./dataset.state.json"
`);
}

function parseArgs(argv) {
  const options = {
    file: null,
    destination: '.',
    serverUrl: 'http://localhost:3001',
    token: process.env.CLOUDVAULT_AUTH_TOKEN || '',
    statePath: null,
    chunkSize: DEFAULT_CHUNK_SIZE,
    resume: false
  };

  const valueOptions = new Map([
    ['-f', 'file'],
    ['--file', 'file'],
    ['-d', 'destination'],
    ['--destination', 'destination'],
    ['-s', 'serverUrl'],
    ['--server', 'serverUrl'],
    ['--token', 'token'],
    ['--state', 'statePath'],
    ['--chunk-size', 'chunkSize']
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--resume') {
      options.resume = true;
      continue;
    }

    const opt = valueOptions.get(arg);
    if (!opt) throw new Error(`Unknown option: ${arg}`);
    const val = argv[i + 1];
    if (!val || val.startsWith('-')) throw new Error(`${arg} requires a value`);
    i += 1;
    if (opt === 'chunkSize') options.chunkSize = parseInt(val, 10);
    else options[opt] = val;
  }

  return options;
}

function computeFileHash(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const normAlgo = normalizeHashAlgorithm(algorithm);
    const hash = crypto.createHash(normAlgo);
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    printUsage(process.stderr);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  const defaultStateFile = `.cloudvault-download-${options.file ? path.basename(options.file) : 'file'}.state.json`;
  const statePath = options.statePath || defaultStateFile;

  if (options.resume && fs.existsSync(statePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      options.file = options.file || saved.file;
      options.destination = options.destination === '.' ? (saved.destination || '.') : options.destination;
      options.serverUrl = options.serverUrl === 'http://localhost:3001' ? (saved.serverUrl || options.serverUrl) : options.serverUrl;
    } catch (e) {
      console.error(`Failed to read state file: ${e.message}`);
    }
  }

  if (!options.file) {
    printUsage(process.stderr);
    process.exitCode = 1;
    return;
  }

  let destPath = path.resolve(options.destination);
  if (fs.existsSync(destPath) && fs.lstatSync(destPath).isDirectory()) {
    destPath = path.join(destPath, path.basename(options.file));
  }

  const partPath = `${destPath}${PART_SUFFIX}`;
  const baseServer = options.serverUrl.replace(/\/+$/, '');
  const downloadUrl = `${baseServer}/api/files/${encodeURIComponent(options.file)}/download`;

  const headers = {};
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  console.log(`==================================================`);
  console.log(` 📥 Stateful File Downloader`);
  console.log(` 🌐 Server URL: ${downloadUrl}`);
  console.log(` 💾 Target: ${destPath}`);
  console.log(`==================================================`);

  // Step 1: Probe file info
  let totalSize = 0;
  let serverHash = null;
  let hashAlgorithm = 'sha256';

  try {
    const probeRes = await fetch(downloadUrl, {
      method: 'HEAD',
      headers
    });

    if (!probeRes.ok && probeRes.status !== 405) {
      // Try GET with range 0-0
      const getProbe = await fetch(downloadUrl, {
        headers: { ...headers, Range: 'bytes=0-0' }
      });
      if (!getProbe.ok) {
        throw new Error(`Server returned HTTP ${getProbe.status}: ${getProbe.statusText}`);
      }
      const cr = getProbe.headers.get('content-range');
      if (cr) {
        const total = cr.split('/')[1];
        if (total) totalSize = parseInt(total, 10);
      }
      serverHash = getProbe.headers.get('x-file-hash');
      hashAlgorithm = getProbe.headers.get('x-hash-algorithm') || 'sha256';
    } else {
      const len = probeRes.headers.get('content-length') || probeRes.headers.get('x-total-size');
      if (len) totalSize = parseInt(len, 10);
      serverHash = probeRes.headers.get('x-file-hash');
      hashAlgorithm = probeRes.headers.get('x-hash-algorithm') || 'sha256';
    }
  } catch (err) {
    console.error(`Failed to connect to server: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let startOffset = 0;
  if (fs.existsSync(partPath)) {
    const partStat = fs.statSync(partPath);
    if (totalSize > 0 && partStat.size <= totalSize) {
      startOffset = partStat.size;
      console.log(`[Resume] Found existing partial download at offset ${startOffset} bytes.`);
    } else if (totalSize > 0 && partStat.size > totalSize) {
      fs.unlinkSync(partPath);
      startOffset = 0;
    }
  }

  let currentOffset = startOffset;
  let isSuspended = false;
  let bytesDownloadedSession = 0;
  const startTime = Date.now();

  const sigintHandler = () => {
    if (isSuspended) process.exit(1);
    isSuspended = true;
    const state = {
      file: options.file,
      destination: destPath,
      serverUrl: options.serverUrl,
      totalSize,
      downloadedBytes: currentOffset,
      serverHash,
      hashAlgorithm,
      updatedAt: new Date().toISOString()
    };
    try {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      console.log(`\n\n⏸️  Download suspended! Saved state to ${statePath}.`);
      console.log(`To resume, run: node bin/download-cli.js -f "${options.file}" -d "${destPath}" --resume --state "${statePath}"\n`);
    } catch (e) {
      console.error(`\nFailed to save state: ${e.message}`);
    }
    process.exit(0);
  };

  process.once('SIGINT', sigintHandler);

  // Download loop
  const destFd = fs.openSync(partPath, startOffset === 0 ? 'w' : 'r+');

  try {
    while (totalSize === 0 || currentOffset < totalSize) {
      if (isSuspended) break;

      const chunkEnd = totalSize > 0
        ? Math.min(currentOffset + options.chunkSize - 1, totalSize - 1)
        : currentOffset + options.chunkSize - 1;

      const chunkHeaders = {
        ...headers,
        Range: `bytes=${currentOffset}-${chunkEnd}`
      };

      const res = await fetch(downloadUrl, { headers: chunkHeaders });
      if (res.status !== 206 && res.status !== 200) {
        throw new Error(`Server returned status ${res.status} while fetching bytes ${currentOffset}-${chunkEnd}`);
      }

      if (totalSize === 0) {
        const cr = res.headers.get('content-range');
        if (cr) {
          const total = cr.split('/')[1];
          if (total) totalSize = parseInt(total, 10);
        } else {
          const cl = res.headers.get('content-length');
          if (cl) totalSize = parseInt(cl, 10);
        }
        if (!serverHash) serverHash = res.headers.get('x-file-hash');
      }

      const arrayBuffer = await res.arrayBuffer();
      const chunkBuffer = Buffer.from(arrayBuffer);

      if (chunkBuffer.length === 0) break;

      fs.writeSync(destFd, chunkBuffer, 0, chunkBuffer.length, currentOffset);
      currentOffset += chunkBuffer.length;
      bytesDownloadedSession += chunkBuffer.length;

      const elapsedSec = Math.max(0.001, (Date.now() - startTime) / 1000);
      const speedBps = bytesDownloadedSession / elapsedSec;
      const speedMB = (speedBps / (1024 * 1024)).toFixed(2);
      const remainingBytes = Math.max(0, totalSize - currentOffset);
      const etaSec = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : 0;
      const eta = etaSec > 0 ? `${Math.ceil(etaSec / 60)}m ${etaSec % 60}s` : 'Done';
      const pct = totalSize > 0 ? Math.round((currentOffset / totalSize) * 100) : '--';
      const mb = (currentOffset / (1024 * 1024)).toFixed(2);
      const totMb = (totalSize / (1024 * 1024)).toFixed(2);

      process.stdout.write(`\r📥 Downloading: ${pct}% | ${mb}/${totMb} MB | Speed: ${speedMB} MB/s | ETA: ${eta}    `);

      if (totalSize > 0 && currentOffset >= totalSize) break;
    }

    fs.fsyncSync(destFd);
  } finally {
    try { fs.closeSync(destFd); } catch (e) {}
    process.removeListener('SIGINT', sigintHandler);
  }

  if (isSuspended) return;

  console.log(`\n\n🔍 Verifying downloaded file integrity...`);
  if (serverHash) {
    try {
      const localHash = await computeFileHash(partPath, hashAlgorithm);
      if (localHash.toLowerCase() !== serverHash.toLowerCase()) {
        console.error(`❌ Checksum mismatch: expected ${serverHash}, calculated ${localHash}`);
        process.exitCode = 1;
        return;
      }
      console.log(`✅ ${hashAlgorithm.toUpperCase()} checksum verified: ${localHash}`);
    } catch (hashErr) {
      console.warn(`⚠️ Could not compute hash: ${hashErr.message}`);
    }
  }

  // Atomically finalize
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.renameSync(partPath, destPath);

  if (fs.existsSync(statePath)) {
    try { fs.unlinkSync(statePath); } catch (e) {}
  }

  console.log(`🎉 Download complete: ${destPath}`);
}

main();
