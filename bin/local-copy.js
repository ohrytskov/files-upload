#!/usr/bin/env node

const { copyLocalEntries, listLocalDirectory } = require('../lib/local-filesystem');

function printUsage(stream = process.stdout) {
  stream.write(`Usage: node bin/local-copy.js --source <directory> --destination <directory> [options]

Copy files or directories between local paths, including Windows drives and
removable media mounted on the machine running this command.

Options:
  -s, --source <path>          Source directory
  -d, --destination <path>     Destination directory
  -e, --entry <name>           Entry to copy (repeatable; defaults to all files/directories)
      --replace-existing      Replace files that already exist at the destination
  -h, --help                  Show this help

Examples:
  node bin/local-copy.js -s "C:\\Users\\me\\Documents" -d "D:\\backup"
  node bin/local-copy.js -s "/mnt/usb/photos" -d "/data/archive" -e trip-2026
`);
}

function parseArgs(argv) {
  const options = { entries: [], overwrite: false };
  const valueOptions = new Map([
    ['-s', 'sourcePath'],
    ['--source', 'sourcePath'],
    ['-d', 'destinationPath'],
    ['--destination', 'destinationPath'],
    ['-e', 'entry']
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
