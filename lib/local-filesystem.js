const fs = require('fs');
const path = require('path');

const WINDOWS_DRIVE_PATH = /^[a-z]:($|[\\/])/i;
const WINDOWS_UNC_PATH = /^(\\\\|\/\/)/;
const MAX_LOCAL_PATH_LENGTH = 32_760;

class LocalFilesystemError extends Error {
  constructor(message, code = 'LOCAL_FILESYSTEM_ERROR') {
    super(message);
    this.name = 'LocalFilesystemError';
    this.code = code;
  }
}

function isWindowsStylePath(value) {
  return WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value);
}

function getPathApi(value) {
  return process.platform === 'win32' || isWindowsStylePath(value)
    ? path.win32
    : path;
}

function normalizeLocalPath(input) {
  if (typeof input !== 'string' || input.trim().length === 0 || input.includes('\0')) {
    throw new LocalFilesystemError('A non-empty local path is required', 'INVALID_PATH');
  }

  const value = input.trim();
  if (value.length > MAX_LOCAL_PATH_LENGTH) {
    throw new LocalFilesystemError('The local path is too long', 'INVALID_PATH');
  }

  const pathApi = getPathApi(value);
  let normalizedInput = value;

  if (pathApi === path.win32) {
    normalizedInput = value.replace(/\//g, '\\');
    // A drive-only path is treated as the drive root. This is less surprising
    // in a file manager than Windows' drive-relative `C:` semantics.
    if (/^[a-z]:$/i.test(normalizedInput)) normalizedInput += '\\';
  } else {
    // Accept pasted Windows separators for relative paths even on POSIX hosts.
    normalizedInput = value.replace(/\\/g, '/');
  }

  return pathApi.normalize(pathApi.resolve(normalizedInput));
}

function getParentPath(localPath) {
  const pathApi = getPathApi(localPath);
  return pathApi.dirname(localPath);
}

function getPathError(error, requestedPath, operation) {
  if (error instanceof LocalFilesystemError) return error;
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    return new LocalFilesystemError(`${operation} path does not exist: ${requestedPath}`, 'NOT_FOUND');
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return new LocalFilesystemError(`Permission denied for ${operation.toLowerCase()} path: ${requestedPath}`, 'PERMISSION_DENIED');
  }
  return new LocalFilesystemError(`${operation} failed for ${requestedPath}: ${error.message}`, 'FILESYSTEM_ERROR');
}

async function ensureDirectory(inputPath, label) {
  const resolved = normalizeLocalPath(inputPath);
  let stats;
  try {
    stats = await fs.promises.lstat(resolved);
  } catch (error) {
    throw getPathError(error, resolved, label);
  }

  if (stats.isSymbolicLink()) {
    throw new LocalFilesystemError(`${label} cannot be a symbolic link`, 'SYMBOLIC_LINK');
  }
  if (!stats.isDirectory()) {
    throw new LocalFilesystemError(`${label} is not a directory: ${resolved}`, 'NOT_DIRECTORY');
  }

  return { resolved, stats };
}

function sortEntries(left, right) {
  if (left.type === 'directory' && right.type !== 'directory') return -1;
  if (left.type !== 'directory' && right.type === 'directory') return 1;
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
}

async function readEntryMetadata(directoryPath, name) {
  const entryPath = path.join(directoryPath, name);
  let stats;
  try {
    stats = await fs.promises.lstat(entryPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw getPathError(error, entryPath, 'Read');
  }

  let type = 'other';
  if (stats.isSymbolicLink()) type = 'symlink';
  else if (stats.isDirectory()) type = 'directory';
  else if (stats.isFile()) type = 'file';

  return {
    name,
    type,
    size: stats.isFile() ? stats.size : 0,
    modifiedAt: stats.mtime.toISOString()
  };
}

async function listLocalDirectory(inputPath = '.') {
  const { resolved } = await ensureDirectory(inputPath, 'Directory');
  let names;
  try {
    names = await fs.promises.readdir(resolved);
  } catch (error) {
    throw getPathError(error, resolved, 'List');
  }

  const entries = [];
  for (const name of names) {
    const metadata = await readEntryMetadata(resolved, name);
    if (metadata) entries.push(metadata);
  }
  entries.sort(sortEntries);

  return {
    path: resolved,
    parentPath: getParentPath(resolved),
    entries
  };
}

function normalizeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new LocalFilesystemError('Each copied entry must have a name', 'INVALID_ENTRY');
  }
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new LocalFilesystemError(`Invalid local entry name: ${name}`, 'INVALID_ENTRY');
  }
  return name;
}

function pathIsWithin(parentPath, candidatePath, pathApi = getPathApi(parentPath)) {
  const relative = pathApi.relative(parentPath, candidatePath);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

async function getEntryStat(directoryPath, name) {
  const normalizedName = normalizeEntryName(name);
  const sourcePath = path.join(directoryPath, normalizedName);
  let stats;
  try {
    stats = await fs.promises.lstat(sourcePath);
  } catch (error) {
    throw getPathError(error, sourcePath, 'Source');
  }
  return { name: normalizedName, sourcePath, stats };
}

async function copyFile(sourcePath, destinationPath, sourceStats, overwrite) {
  await fs.promises.copyFile(
    sourcePath,
    destinationPath,
    overwrite ? 0 : fs.constants.COPYFILE_EXCL
  );

  // Copying to removable media can reject metadata updates. The bytes are
  // already safely copied, so preserve timestamps on filesystems that support
  // it without making the whole operation fail when they do not.
  try {
    await fs.promises.utimes(destinationPath, sourceStats.atime, sourceStats.mtime);
  } catch (error) {
    if (!['EINVAL', 'ENOSYS', 'EPERM', 'EROFS'].includes(error.code)) throw error;
  }
}

async function copyNode(sourcePath, destinationPath, options, summary) {
  let sourceStats;
  try {
    sourceStats = await fs.promises.lstat(sourcePath);
  } catch (error) {
    throw getPathError(error, sourcePath, 'Source');
  }

  if (sourceStats.isSymbolicLink()) {
    throw new LocalFilesystemError(`Symbolic links are not copied: ${sourcePath}`, 'SYMBOLIC_LINK');
  }

  if (sourceStats.isFile()) {
    let destinationStats = null;
    try {
      destinationStats = await fs.promises.lstat(destinationPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw getPathError(error, destinationPath, 'Destination');
    }
    if (destinationStats?.isSymbolicLink()) {
      throw new LocalFilesystemError(`Symbolic-link destinations are not overwritten: ${destinationPath}`, 'SYMBOLIC_LINK');
    }
    try {
      await copyFile(sourcePath, destinationPath, sourceStats, options.overwrite);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new LocalFilesystemError(`Destination already exists: ${destinationPath}`, 'DESTINATION_EXISTS');
      }
      throw getPathError(error, destinationPath, 'Copy');
    }
    summary.filesCopied += 1;
    summary.bytesCopied += sourceStats.size;
    return 'file';
  }

  if (!sourceStats.isDirectory()) {
    throw new LocalFilesystemError(`Unsupported source entry: ${sourcePath}`, 'UNSUPPORTED_ENTRY');
  }

  let destinationStats = null;
  try {
    destinationStats = await fs.promises.lstat(destinationPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw getPathError(error, destinationPath, 'Destination');
  }

  if (destinationStats) {
    if (destinationStats.isSymbolicLink() || !destinationStats.isDirectory()) {
      throw new LocalFilesystemError(`Destination already exists and is not a directory: ${destinationPath}`, 'DESTINATION_EXISTS');
    }
    if (!options.overwrite) {
      throw new LocalFilesystemError(`Destination already exists: ${destinationPath}`, 'DESTINATION_EXISTS');
    }
  } else {
    try {
      await fs.promises.mkdir(destinationPath);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new LocalFilesystemError(`Destination already exists: ${destinationPath}`, 'DESTINATION_EXISTS');
      }
      throw getPathError(error, destinationPath, 'Create destination');
    }
    summary.directoriesCopied += 1;
  }

  let names;
  try {
    names = await fs.promises.readdir(sourcePath);
  } catch (error) {
    throw getPathError(error, sourcePath, 'Read source');
  }

  for (const name of names) {
    await copyNode(path.join(sourcePath, name), path.join(destinationPath, name), options, summary);
  }
  return 'directory';
}

async function copyLocalEntries({ sourcePath, destinationPath, entries, overwrite = false }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new LocalFilesystemError('Select at least one local entry to copy', 'INVALID_ENTRY');
  }
  if (typeof overwrite !== 'boolean') {
    throw new LocalFilesystemError('overwrite must be a boolean', 'INVALID_OPTION');
  }

  const source = await ensureDirectory(sourcePath, 'Source directory');
  const destination = await ensureDirectory(destinationPath, 'Destination directory');
  const pathApi = getPathApi(source.resolved);

  if (pathApi.normalize(source.resolved) === pathApi.normalize(destination.resolved)) {
    throw new LocalFilesystemError('Source and destination directories must be different', 'SAME_DIRECTORY');
  }

  const normalizedEntries = [...new Set(entries.map(normalizeEntryName))];
  const sourceEntries = [];
  for (const name of normalizedEntries) {
    const entry = await getEntryStat(source.resolved, name);
    const targetPath = path.join(destination.resolved, entry.name);
    if (entry.stats.isDirectory() && pathIsWithin(entry.sourcePath, targetPath, pathApi)) {
      throw new LocalFilesystemError(
        `Destination is inside the selected source directory: ${destination.resolved}`,
        'DESTINATION_INSIDE_SOURCE'
      );
    }
    sourceEntries.push(entry);
  }

  const summary = {
    sourcePath: source.resolved,
    destinationPath: destination.resolved,
    overwrite,
    copied: [],
    errors: [],
    filesCopied: 0,
    directoriesCopied: 0,
    bytesCopied: 0
  };

  for (const entry of sourceEntries) {
    const targetPath = path.join(destination.resolved, entry.name);
    try {
      const type = await copyNode(entry.sourcePath, targetPath, { overwrite }, summary);
      summary.copied.push({ name: entry.name, type });
    } catch (error) {
      summary.errors.push({
        name: entry.name,
        error: error.message,
        code: error.code || 'COPY_FAILED'
      });
    }
  }

  return summary;
}

module.exports = {
  LocalFilesystemError,
  copyLocalEntries,
  isWindowsStylePath,
  listLocalDirectory,
  normalizeEntryName,
  normalizeLocalPath,
  pathIsWithin
};
