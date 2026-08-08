#!/usr/bin/env node

const path = require('path');
const config = require('../lib/config');
const WebSocketUploaderClient = require('../lib/ws-client');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    sourcePath: null,
    serverUrl: 'ws://localhost:3000/ws/upload',
    stateFilePath: config.defaultStateFile,
    outputHashesFile: null,
    authToken: config.authToken,
    hashAlgorithm: config.defaultHashAlgorithm
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--path' || arg === '-p') {
      options.sourcePath = args[++i];
    } else if (arg === '--server' || arg === '-s') {
      options.serverUrl = args[++i];
    } else if (arg === '--state') {
      options.stateFilePath = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      options.outputHashesFile = args[++i];
    } else if (arg === '--token') {
      options.authToken = args[++i];
    } else if (arg === '--algorithm') {
      options.hashAlgorithm = args[++i];
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  if (!options.sourcePath) {
    console.log(`
==================================================
 🛠️ WebSocket Batch Uploader CLI
==================================================

Usage:
  node bin/upload-cli.js --path <TargetFolderPath> [options]

Options:
  -p, --path <path>      Target folder path (Windows 11 paths supported e.g. "D:\\folder" or Linux paths)
  -s, --server <url>     Remote/Local WebSocket server URL (default: ws://localhost:3000/ws/upload)
  -o, --output <file>    Optional path to save standard hashes.txt manifest
  --state <file>         Persistent state JSON path (default: state.json for resuming)
  --token <token>        Bearer token when server authentication is enabled
  --algorithm <name>     Hash algorithm: sha256 (default) or md5

Examples:
  node bin/upload-cli.js -p "D:\\marriage" -s "ws://my-remote-server.com:3000/ws/upload"
  node bin/upload-cli.js -p "/var/www/hello/my/files-area" -o "hashes.txt"
`);
    process.exit(1);
  }

  const client = new WebSocketUploaderClient({
    serverUrl: options.serverUrl,
    sourcePath: options.sourcePath,
    stateFilePath: options.stateFilePath,
    authToken: options.authToken,
    hashAlgorithm: options.hashAlgorithm,
    onProgress: (p) => {
      if (p.stage === 'hashing') {
        process.stdout.write(`\r🔍 Generating ${options.hashAlgorithm.toUpperCase()} [${p.current}/${p.total}]: ${p.file.slice(0, 40)}`);
      } else if (p.stage === 'uploading') {
        const speedMB = (p.speedBps / (1024 * 1024)).toFixed(2);
        const uploadedMB = (p.uploadedBytes / (1024 * 1024)).toFixed(2);
        const totalMB = (p.totalBytes / (1024 * 1024)).toFixed(2);
        const etaMin = Math.ceil(p.etaSec / 60);

        process.stdout.write(
          `\r🚀 Uploading [${p.totalUploadedFiles}/${p.totalFiles}] ${p.overallPercent}% | ${uploadedMB}/${totalMB} MB | Speed: ${speedMB} MB/s | ETA: ${etaMin}m | ${p.currentFile.slice(0, 30)}    `
        );
      }
    },
    onFileStatus: (status) => {
      if (status.status === 'verified') {
        console.log(`\n  ✅ Verified hash: ${status.relativePath} -> ${status.serverHash || status.serverMd5}`);
      } else if (status.status === 'failed') {
        console.log(`\n  ❌ Upload Failed: ${status.relativePath} -> ${status.error}`);
      }
    },
    onAuditComplete: (audit) => {
      console.log('\n==================================================');
      console.log('  🎯 Full Verification Audit Summary');
      console.log(`  Total Files Processed: ${audit.totalFiles}`);
      console.log(`  ✅ Matched Hashes: ${audit.matchCount}`);
      console.log(`  ⚠️ Mismatched Hashes: ${audit.mismatchCount}`);
      console.log(`  ❓ Missing on Server: ${audit.missingCount}`);
      console.log('==================================================\n');
      process.exit(0);
    },
    onError: (err, details = {}) => {
      if (details.recoverable) {
        console.error('\n⚠️ Temporary connection issue:', err.message);
        return;
      }
      console.error('\n❌ Fatal Error:', err.message);
      process.exitCode = 1;
    }
  });

  await client.start();
}

main();
