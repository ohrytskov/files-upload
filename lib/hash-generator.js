const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Normalizes Windows & Linux file paths for cross-platform compatibility.
 * Replaces backslashes (\) with forward slashes (/) and removes trailing slashes.
 */
function normalizePath(inputPath) {
  if (!inputPath) return '';
  let cleaned = inputPath.trim().replace(/\\/g, '/');
  if (cleaned.length > 1 && cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

/**
 * Calculates MD5 hash for a file using Node streams (Memory efficient for large files).
 * @param {string} filePath - Absolute path to the file
 * @returns {Promise<string>} MD5 hash hex string in lowercase
 */
function getFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Recursively scans directory and gathers file list.
 * @param {string} dirPath - Directory to scan
 * @param {string[]} fileList - Accumulator array
 * @returns {string[]} List of absolute file paths
 */
function getAllFiles(dirPath, fileList = []) {
  if (!fs.existsSync(dirPath)) return fileList;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        getAllFiles(fullPath, fileList);
      } else if (entry.isFile()) {
        fileList.push(fullPath);
      }
    }
  } catch (err) {
    console.error(`Error reading directory ${dirPath}:`, err.message);
  }

  return fileList;
}

/**
 * Generates MD5 hashes for all files in target path (supports Windows 11 & Linux paths).
 * @param {Object} options
 * @param {string} options.sourcePath - Target folder path (e.g. "D:\\marriage" or "/var/www/data")
 * @param {string} [options.outputFile] - Optional output file to write standard hashes.txt
 * @param {Function} [options.onProgress] - Callback for progress updates (current, total, file, hash)
 * @returns {Promise<{ sourcePath: string, totalFiles: number, totalBytes: number, files: Array<{ relativePath: string, absolutePath: string, size: number, md5: string }> }>}
 */
async function generateHashes({ sourcePath, outputFile = null, onProgress = null }) {
  const normSource = normalizePath(sourcePath);
  
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Target path does not exist: ${sourcePath}`);
  }

  const stat = fs.statSync(sourcePath);
  let filePaths = [];

  if (stat.isFile()) {
    filePaths = [sourcePath];
  } else if (stat.isDirectory()) {
    filePaths = getAllFiles(sourcePath);
  }

  const files = [];
  const hashLines = [];
  let totalBytes = 0;
  let count = 0;

  for (const filePath of filePaths) {
    try {
      const fileStat = fs.statSync(filePath);
      const md5 = await getFileHash(filePath);
      
      // Calculate relative path normalized to forward slashes
      let relativePath;
      if (stat.isFile()) {
        relativePath = path.basename(filePath);
      } else {
        relativePath = path.relative(sourcePath, filePath).replace(/\\/g, '/');
      }

      const fileInfo = {
        relativePath,
        absolutePath: filePath,
        size: fileStat.size,
        md5
      };

      files.push(fileInfo);
      hashLines.push(`${md5}  ${relativePath}`);
      totalBytes += fileStat.size;
      count++;

      if (onProgress && typeof onProgress === 'function') {
        onProgress({
          current: count,
          total: filePaths.length,
          file: relativePath,
          size: fileStat.size,
          md5
        });
      }
    } catch (err) {
      console.error(`Error hashing ${filePath}:`, err.message);
    }
  }

  if (outputFile) {
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputFile, hashLines.join('\n') + '\n', 'utf8');
  }

  return {
    sourcePath,
    normalizedSource: normSource,
    totalFiles: files.length,
    totalBytes,
    files
  };
}

module.exports = {
  normalizePath,
  getFileHash,
  getAllFiles,
  generateHashes
};
