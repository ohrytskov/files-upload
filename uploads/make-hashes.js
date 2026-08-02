const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration
const sourceDrive = 'D:\\';
const outputFile = path.join(sourceDrive, 'hashes.txt');
const folders = ['marriage', 'siemens', '!204L10', 'laptop'];

// Helper: Calculate MD5 hash using streams (Memory-efficient for large files)
function getFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', (err) => reject(err));
  });
}

// Helper: Recursively find all files in a folder
function getAllFiles(dirPath, fileList = []) {
  if (!fs.existsSync(dirPath)) return fileList;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      getAllFiles(fullPath, fileList);
    } else if (entry.isFile()) {
      fileList.push(fullPath);
    }
  }

  return fileList;
}

// Main Execution
async function main() {
  console.log(`\nGenerating MD5 hashes for folders on ${sourceDrive}...`);
  console.log(`Output file: ${outputFile}\n`);

  const hashLines = [];

  for (const folder of folders) {
    const targetPath = path.join(sourceDrive, folder);

    if (!fs.existsSync(targetPath)) {
      console.warn(`Warning: Folder not found -> ${targetPath}`);
      continue;
    }

    console.log(`Processing: ${folder}...`);
    const files = getAllFiles(targetPath);

    for (const filePath of files) {
      try {
        const hash = await getFileHash(filePath);

        // Convert Windows backslashes (\) to forward slashes (/) for Linux md5sum compatibility
        const relativePath = path.relative(sourceDrive, filePath).replace(/\\/g, '/');

        // Two spaces between hash and path (standard md5sum format)
        hashLines.push(`${hash}  ${relativePath}`);
      } catch (err) {
        console.error(`Error processing ${filePath}:`, err.message);
      }
    }
  }

  // Save as UTF-8 file to preserve Cyrillic characters
  fs.writeFileSync(outputFile, hashLines.join('\n') + '\n', 'utf8');

  console.log('\n==================================================');
  console.log(` Done! Saved ${hashLines.length} hashes to ${outputFile}`);
  console.log('==================================================');
}

main();
