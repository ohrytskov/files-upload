const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPPORTED_HASH_ALGORITHMS = new Set(['md5', 'sha256']);

function normalizeHashAlgorithm(algorithm = 'md5') {
  const normalized = String(algorithm).toLowerCase();
  if (!SUPPORTED_HASH_ALGORITHMS.has(normalized)) {
    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }
  return normalized;
}

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
 * Calculates a file hash using Node streams (memory efficient for large files).
 * @param {string} filePath - Absolute path to the file
 * @param {string} [algorithm='md5'] - Hash algorithm (`md5` or `sha256`)
 * @returns {Promise<string>} Lowercase hexadecimal hash string
 */
function getFileHash(filePath, algorithm = 'md5') {
  const normalizedAlgorithm = normalizeHashAlgorithm(algorithm);
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(normalizedAlgorithm);
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
 * Generates hashes for all files in target path (supports Windows 11 & Linux paths).
 * @param {Object} options
 * @param {string} options.sourcePath - Target folder path (e.g. "D:\\marriage" or "/var/www/data")
 * @param {string} [options.algorithm='md5'] - Hash algorithm (`md5` or `sha256`)
 * @param {string} [options.outputFile] - Optional output file to write standard hashes.txt
 * @param {Function} [options.onProgress] - Callback for progress updates (current, total, file, hash)
 * @returns {Promise<{ sourcePath: string, hashAlgorithm: string, totalFiles: number, totalBytes: number, files: Array<{ relativePath: string, absolutePath: string, size: number, hash: string }> }>}
 */
async function generateHashes({ sourcePath, outputFile = null, onProgress = null, algorithm = 'md5' }) {
  const hashAlgorithm = normalizeHashAlgorithm(algorithm);
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
      const hash = await getFileHash(filePath, hashAlgorithm);
      
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
        hashAlgorithm,
        hash,
        ...(hashAlgorithm === 'md5' ? { md5: hash } : {})
      };

      files.push(fileInfo);
      hashLines.push(`${hash}  ${relativePath}`);
      totalBytes += fileStat.size;
      count++;

      if (onProgress && typeof onProgress === 'function') {
        onProgress({
          current: count,
          total: filePaths.length,
          file: relativePath,
          size: fileStat.size,
          hash,
          ...(hashAlgorithm === 'md5' ? { md5: hash } : {})
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
    hashAlgorithm,
    totalFiles: files.length,
    totalBytes,
    files
  };
}

module.exports = {
  SUPPORTED_HASH_ALGORITHMS,
  normalizePath,
  normalizeHashAlgorithm,
  getFileHash,
  getAllFiles,
  generateHashes
};
