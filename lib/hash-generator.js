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

async function getAllFilesAsync(dirPath, fileList = []) {
  try {
    await fs.promises.access(dirPath);
  } catch (error) {
    throw new Error(`Target path does not exist: ${dirPath}`);
  }

  const pending = [dirPath];
  let visitedEntries = 0;
  while (pending.length > 0) {
    const currentPath = pending.pop();
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      visitedEntries += 1;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        fileList.push(fullPath);
      }

      if (visitedEntries % 128 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }

  return fileList;
}

function sameFileIdentity(left, right) {
  return left && right &&
    Number.isFinite(Number(left.dev)) &&
    Number.isFinite(Number(left.ino)) &&
    Number(left.dev) === Number(right.dev) &&
    Number(left.ino) === Number(right.ino);
}

async function getExistingOutputStat(outputFile) {
  try {
    return await fs.promises.lstat(outputFile);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
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
  const resolvedOutputFile = outputFile ? path.resolve(outputFile) : null;

  let stat;
  try {
    stat = await fs.promises.stat(sourcePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Target path does not exist: ${sourcePath}`);
    }
    throw error;
  }
  let filePaths = [];

  if (stat.isFile()) {
    if (resolvedOutputFile && path.resolve(sourcePath) === resolvedOutputFile) {
      throw new Error('outputFile must not overwrite the source file');
    }
    filePaths = [sourcePath];
  } else if (stat.isDirectory()) {
    if (resolvedOutputFile && path.resolve(sourcePath) === resolvedOutputFile) {
      throw new Error('outputFile must not overwrite the source directory');
    }
    filePaths = await getAllFilesAsync(sourcePath);
  } else {
    throw new Error(`Target path is not a regular file or directory: ${sourcePath}`);
  }

  let outputStat = null;
  if (resolvedOutputFile) {
    outputStat = await getExistingOutputStat(outputFile);
    if (outputStat?.isSymbolicLink()) {
      throw new Error('outputFile must not be a symbolic link');
    }
    if (outputStat && !outputStat.isFile()) {
      throw new Error('outputFile must be a regular file');
    }
    if (outputStat && sameFileIdentity(outputStat, stat)) {
      throw new Error('outputFile must not overwrite the source file');
    }
    if (outputStat && Number(outputStat.nlink) > 1) {
      throw new Error('outputFile must not be a hard link');
    }
  }

  // A manifest written inside the scanned directory is an output artifact,
  // not an input file. Excluding an existing artifact also keeps repeated
  // scans deterministic instead of hashing the previous manifest into itself.
  if (resolvedOutputFile) {
    filePaths = filePaths.filter(filePath => path.resolve(filePath) !== resolvedOutputFile);
  }

  if (typeof excludeFile === 'function') {
    filePaths = filePaths.filter(filePath => !excludeFile(filePath));
  }
  filePaths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

  const files = [];
  const hashLines = [];
  let totalBytes = 0;
  let count = 0;

  for (const filePath of filePaths) {
    const fileStatBefore = await fs.promises.stat(filePath);
    if (!fileStatBefore.isFile()) {
      throw new Error(`Source changed while scanning: ${filePath}`);
    }

    const hash = await getFileHash(filePath, hashAlgorithm);
    const fileStatAfter = await fs.promises.stat(filePath);
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
    await fs.promises.mkdir(outputDir, { recursive: true });
    await fs.promises.writeFile(outputFile, hashLines.join('\n') + '\n', 'utf8');
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
  getAllFilesAsync,
  generateHashes
};
