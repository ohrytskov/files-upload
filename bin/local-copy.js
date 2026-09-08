#!/usr/bin/env node

const fs = require('fs');
const { copyLocalEntries, listLocalDirectory } = require('../lib/local-filesystem');
const { CopyJob } = require('../lib/copy-manager');

function printUsage(stream = process.stdout) {
  stream.write(`Usage: node bin/local-copy.js --source <directory> --destination <directory> [options]

Copy files or directories between local paths, including Windows drives and
removable media mounted on the machine running this command. Supports stateful
copy with suspend (pause via Ctrl+C) and resumption.

Options:
  -s, --source <path>          Source directory
  -d, --destination <path>     Destination directory
  -e, --entry <name>           Entry to copy (repeatable; defaults to all files/directories)
      --replace-existing      Replace files that already exist at the destination
      --state <file>          State file path for tracking and resuming (e.g. state.json)
      --resume                Resume an interrupted or suspended copy from state file
      --stateful              Enable stateful chunked copy with suspend/resume support
  -h, --help                  Show this help

Examples:
  node bin/local-copy.js -s "C:\\Users\\me\\Documents" -d "D:\\backup"
  node bin/local-copy.js -s "/mnt/usb/photos" -d "/data/archive" -e trip-2026
  node bin/local-copy.js -s "/data" -d "/backup" --state copy-state.json
  node bin/local-copy.js --resume --state copy-state.json
`);
}

function parseArgs(argv) {
  const options = { entries: [], overwrite: false, statePath: null, resume: false, stateful: false };
  const valueOptions = new Map([
    ['-s', 'sourcePath'],
    ['--source', 'sourcePath'],
    ['-d', 'destinationPath'],
    ['--destination', 'destinationPath'],
    ['-e', 'entry'],
    ['--state', 'statePath']
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') {
      options.help = true;
      continue;
    }
    if (argument === '--replace-existing' || argument === '--overwrite') {
      options.overwrite = true;
      continue;
    }
    if (argument === '--resume') {
      options.resume = true;
      continue;
    }
    if (argument === '--stateful') {
      options.stateful = true;
      continue;
    }

    const option = valueOptions.get(argument);
    if (!option) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value`);
    index += 1;
    if (option === 'entry') options.entries.push(value);
    else options[option] = value;
  }

  return options;
}

async function runStatefulCopy(options) {
  const statePath = options.statePath || '.cloudvault-copy-state.json';
  let savedState = null;

  if (options.resume && fs.existsSync(statePath)) {
    try {
      savedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      options.sourcePath = options.sourcePath || savedState.sourcePath;
      options.destinationPath = options.destinationPath || savedState.destinationPath;
      options.entries = options.entries.length > 0 ? options.entries : savedState.entries;
      options.overwrite = options.overwrite || savedState.overwrite;
      console.log(`[Copy] Resuming copy job ${savedState.id || ''} from ${statePath}...`);
    } catch (err) {
      console.error(`[Copy] Failed to read state file: ${err.message}`);
    }
  }

  const job = new CopyJob({
    sourcePath: options.sourcePath,
    destinationPath: options.destinationPath,
    entries: options.entries,
    overwrite: options.overwrite
  });

  let suspended = false;
  const sigintHandler = () => {
    if (suspended) process.exit(1);
    suspended = true;
    job.suspend();
    const state = job.getState();
    try {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      console.log(`\n⏸️  Copy suspended! State saved to ${statePath}.`);
      console.log(`To resume, run: node bin/local-copy.js --resume --state "${statePath}"`);
    } catch (e) {
      console.error(`\nFailed to save state: ${e.message}`);
    }
    process.exit(0);
  };

  process.once('SIGINT', sigintHandler);

  const progressInterval = setInterval(() => {
    const s = job.getState();
    if (s.status === 'running') {
      const mb = (s.bytesCopied / (1024 * 1024)).toFixed(2);
      const totalMb = (s.totalBytes / (1024 * 1024)).toFixed(2);
      process.stdout.write(
        `\r🚀 [${s.filesCopied}/${s.totalFiles} files] ${s.overallPercent}% | ${mb}/${totalMb} MB | Speed: ${s.speedMB} MB/s | ETA: ${s.eta} | ${s.currentFile ? s.currentFile.slice(0, 25) : ''}   `
      );
    }
  }, 250);

  try {
    const finalState = await job.start();
    clearInterval(progressInterval);
    process.removeListener('SIGINT', sigintHandler);

    if (finalState.status === 'completed') {
      if (fs.existsSync(statePath)) {
        try { fs.unlinkSync(statePath); } catch (e) {}
      }
      console.log(`\n✅ Copy completed successfully!`);
      console.log(`Copied ${finalState.filesCopied} file(s), ${finalState.directoriesCopied} director${finalState.directoriesCopied === 1 ? 'y' : 'ies'} and ${finalState.bytesCopied} byte(s).`);
      for (const item of finalState.copied) console.log(`  ✓ ${item.name}`);
      for (const item of finalState.errors) console.error(`  ✗ ${item.name}: ${item.error}`);
      if (finalState.errors.length > 0) process.exitCode = 1;
    }
  } catch (error) {
    clearInterval(progressInterval);
    process.removeListener('SIGINT', sigintHandler);
    console.error(`\n❌ Copy failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printUsage(process.stderr);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  if (options.resume && options.statePath && (!options.sourcePath || !options.destinationPath)) {
    try {
      const state = JSON.parse(fs.readFileSync(options.statePath, 'utf8'));
      options.sourcePath = options.sourcePath || state.sourcePath;
      options.destinationPath = options.destinationPath || state.destinationPath;
      options.entries = options.entries?.length ? options.entries : state.entries;
      options.overwrite = options.overwrite || state.overwrite;
    } catch (err) {
      console.error(`Failed to read state file: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!options.sourcePath || !options.destinationPath) {
    printUsage(process.stderr);
    process.exitCode = 1;
    return;
  }

  try {
    let entries = options.entries;
    if (entries.length === 0) {
      const listing = await listLocalDirectory(options.sourcePath);
      entries = listing.entries
        .filter(entry => entry.type === 'file' || entry.type === 'directory')
        .map(entry => entry.name);
      options.entries = entries;
    }

    if (options.stateful || options.statePath || options.resume) {
      await runStatefulCopy(options);
      return;
    }

    const result = await copyLocalEntries({
      sourcePath: options.sourcePath,
      destinationPath: options.destinationPath,
      entries,
      overwrite: options.overwrite
    });

    console.log(`Copied ${result.filesCopied} file(s), ${result.directoriesCopied} director${result.directoriesCopied === 1 ? 'y' : 'ies'} and ${result.bytesCopied} byte(s).`);
    for (const item of result.copied) console.log(`  ✓ ${item.name}`);
    for (const item of result.errors) console.error(`  ✗ ${item.name}: ${item.error}`);
    if (result.errors.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
