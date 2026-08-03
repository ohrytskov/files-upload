const path = require('path');

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
  normalizeRelativePath,
  normalizeFilename,
  resolveSafePath
};
