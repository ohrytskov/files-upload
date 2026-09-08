const fs = require('fs');
const path = require('path');

const PART_SUFFIX = '.cloudvault-part';
const INTERNAL_FILENAMES = new Set([
  'server_state.json',
  'server_state.json.tmp',
  'cloudvault.sqlite',
  'cloudvault.sqlite-wal',
  'cloudvault.sqlite-shm',
  'cloudvault.sqlite-journal'
]);
const INTERNAL_SUFFIXES = [
  PART_SUFFIX,
  '.cloudvault-http-part',
  '.cloudvault-copy-part',
  '.cloudvault-download-part'
];

function isInternalUploadFile(filename) {
  if (typeof filename !== 'string') return false;
  const normalized = filename.toLowerCase();
  return INTERNAL_FILENAMES.has(normalized) ||
    INTERNAL_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

function normalizeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
    throw new Error('A non-empty relative path is required');
  }

  const normalized = relativePath.trim().replace(/\\/g, '/');
  if (
    !normalized ||
    normalized === '.' ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized)
  ) {
    throw new Error('Path must be relative to the uploads directory');
  }

  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Path contains an invalid segment');
  }

  return segments.join('/');
}

function resolveSafePath(baseDir, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, ...normalized.split('/'));

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Path escapes the uploads directory');
  }

  // A lexically safe path can still escape through a symlink in the existing
  // directory tree. Reject symlinked components before callers read, rename,
  // delete, or write the path.
  let current = root;
  try {
    if (fs.lstatSync(root).isSymbolicLink()) {
      throw new Error('Symbolic links are not allowed');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error('Symbolic links are not allowed');
      }
    } catch (err) {
      if (err.code === 'ENOENT') break;
      throw err;
    }
  }

  return { normalized, resolved };
}

function normalizeFilename(filename) {
  const normalized = normalizeRelativePath(filename);
  if (normalized.includes('/')) {
    throw new Error('Filename must not contain path separators');
  }
  return normalized;
}

module.exports = {
  isInternalUploadFile,
  normalizeRelativePath,
  normalizeFilename,
  resolveSafePath
};
