const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('./load-env');

const SUPPORTED_HASH_ALGORITHMS = new Set(['md5', 'sha256']);
const configuredDefaultAlgorithm = String(process.env.DEFAULT_HASH_ALGORITHM || '').toLowerCase();
const DEFAULT_HASH_ALGORITHM = SUPPORTED_HASH_ALGORITHMS.has(configuredDefaultAlgorithm)
  ? configuredDefaultAlgorithm
  : 'sha256';

function normalizeHashAlgorithm(algorithm = DEFAULT_HASH_ALGORITHM) {
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
 * @param {string} [algorithm='sha256'] - Hash algorithm (`md5` or `sha256`)
 * @returns {Promise<string>} Lowercase hexadecimal hash string
 */
function getFileHash(filePath, algorithm = DEFAULT_HASH_ALGORITHM) {
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
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Target path does not exist: ${dirPath}`);
  }

  const pending = [dirPath];
  while (pending.length > 0) {
    const currentPath = pending.pop();
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      // Do not follow symlinks while building a transfer manifest. A symlink can
      // point outside the selected source tree and can also change while a
      // transfer is in progress.
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        fileList.push(fullPath);
      }
    }
  }

  return fileList;
}

/**
 * Generates hashes for all files in target path (supports Windows 11 & Linux paths).
 * @param {Object} options
 * @param {string} options.sourcePath - Target folder path (e.g. "D:\\marriage" or "/var/www/data")
 * @param {string} [options.algorithm='sha256'] - Hash algorithm (`md5` or `sha256`)
 * @param {string} [options.outputFile] - Optional output file to write standard hashes.txt
 * @param {Function} [options.onProgress] - Callback for progress updates (current, total, file, hash)
 * @returns {Promise<{ sourcePath: string, hashAlgorithm: string, totalFiles: number, totalBytes: number, files: Array<{ relativePath: string, absolutePath: string, size: number, hash: string }> }>}
 */
async function generateHashes({
  sourcePath,
  outputFile = null,
  onProgress = null,
  algorithm = DEFAULT_HASH_ALGORITHM,
  excludeFile = null
}) {
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
  } else {
    throw new Error(`Target path is not a regular file or directory: ${sourcePath}`);
  }

  if (typeof excludeFile === 'function') {
    filePaths = filePaths.filter(filePath => !excludeFile(filePath));
  }

  const files = [];
  const hashLines = [];
  let totalBytes = 0;
  let count = 0;

  for (const filePath of filePaths) {
    const fileStatBefore = fs.statSync(filePath);
    if (!fileStatBefore.isFile()) {
      throw new Error(`Source changed while scanning: ${filePath}`);
    }

    const hash = await getFileHash(filePath, hashAlgorithm);
    const fileStatAfter = fs.statSync(filePath);
    if (
      fileStatBefore.size !== fileStatAfter.size ||
      fileStatBefore.mtimeMs !== fileStatAfter.mtimeMs
    ) {
      throw new Error(`Source file changed while hashing: ${filePath}`);
    }

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
      size: fileStatAfter.size,
      sourceMtimeMs: fileStatAfter.mtimeMs,
      hashAlgorithm,
      hash,
      ...(hashAlgorithm === 'md5' ? { md5: hash } : {})
    };

    files.push(fileInfo);
    hashLines.push(`${hash}  ${relativePath}`);
    totalBytes += fileStatAfter.size;
    count++;

    if (onProgress && typeof onProgress === 'function') {
      onProgress({
        current: count,
        total: filePaths.length,
        file: relativePath,
        size: fileStatAfter.size,
        hash,
        ...(hashAlgorithm === 'md5' ? { md5: hash } : {})
      });
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
