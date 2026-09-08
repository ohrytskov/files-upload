const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  LocalFilesystemError,
  ensureDirectory,
  getPathApi,
  normalizeEntryName,
  pathIsWithin
} = require('./local-filesystem');

class CopySuspendedError extends Error {
  constructor(message = 'Copy operation suspended') {
    super(message);
    this.name = 'CopySuspendedError';
    this.code = 'COPY_SUSPENDED';
  }
}

class CopyCancelledError extends Error {
  constructor(message = 'Copy operation cancelled') {
    super(message);
    this.name = 'CopyCancelledError';
    this.code = 'COPY_CANCELLED';
  }
}

const PART_SUFFIX = '.cloudvault-copy-part';
const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB

async function copyFileChunked(sourcePath, destinationPath, sourceStats, options = {}) {
  const {
    overwrite = false,
    chunkSize = DEFAULT_CHUNK_SIZE,
    isSuspended = null,
    isCancelled = null,
    onProgress = null
  } = options;

  let destinationStats = null;
  try {
    destinationStats = await fs.promises.lstat(destinationPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (destinationStats?.isSymbolicLink()) {
    throw new LocalFilesystemError(`Symbolic-link destinations are not overwritten: ${destinationPath}`, 'SYMBOLIC_LINK');
  }
  if (destinationStats && !overwrite) {
    throw new LocalFilesystemError(`Destination already exists: ${destinationPath}`, 'DESTINATION_EXISTS');
  }

  const partPath = `${destinationPath}${PART_SUFFIX}`;
  let startOffset = 0;

  try {
    const partStat = fs.lstatSync(partPath);
    if (partStat.isFile()) {
      if (partStat.size <= sourceStats.size) {
        startOffset = partStat.size;
      } else {
        try { fs.unlinkSync(partPath); } catch (e) {}
        startOffset = 0;
      }
    }
  } catch (e) {
    startOffset = 0;
  }

  if (startOffset > 0 && onProgress) {
    onProgress(0, startOffset, sourceStats.size);
  }

  if (sourceStats.size === 0) {
    fs.writeFileSync(partPath, Buffer.alloc(0));
  } else if (startOffset < sourceStats.size) {
    const sourceFd = fs.openSync(sourcePath, 'r');
    const destFd = fs.openSync(partPath, startOffset === 0 ? 'w' : 'r+');
    const buffer = Buffer.alloc(chunkSize);
    let currentOffset = startOffset;

    try {
      while (currentOffset < sourceStats.size) {
        if (isCancelled?.()) {
          throw new CopyCancelledError();
        }
        if (isSuspended?.()) {
          throw new CopySuspendedError();
        }

        const toRead = Math.min(chunkSize, sourceStats.size - currentOffset);
        const bytesRead = fs.readSync(sourceFd, buffer, 0, toRead, currentOffset);
        if (bytesRead === 0) break;

        fs.writeSync(destFd, buffer, 0, bytesRead, currentOffset);
        currentOffset += bytesRead;

        if (onProgress) {
          onProgress(bytesRead, currentOffset, sourceStats.size);
        }
      }

      fs.fsyncSync(destFd);
    } finally {
      try { fs.closeSync(sourceFd); } catch (e) {}
      try { fs.closeSync(destFd); } catch (e) {}
    }
  }

  if (overwrite && destinationStats) {
    fs.renameSync(partPath, destinationPath);
  } else {
    try {
      fs.linkSync(partPath, destinationPath);
      fs.unlinkSync(partPath);
    } catch (linkError) {
      fs.renameSync(partPath, destinationPath);
    }
  }

  try {
    await fs.promises.utimes(destinationPath, sourceStats.atime, sourceStats.mtime);
  } catch (error) {
    if (!['EINVAL', 'ENOSYS', 'EPERM', 'EROFS'].includes(error.code)) throw error;
  }
}

class CopyJob {
  constructor({ id, sourcePath, destinationPath, entries, overwrite = false }) {
    this.id = id || `copy_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.sourcePath = sourcePath;
    this.destinationPath = destinationPath;
    this.requestedEntries = entries;
    this.overwrite = Boolean(overwrite);

    this.status = 'idle';
    this.suspended = false;
    this.cancelled = false;
    this.error = null;

    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.completedAt = null;

    this.files = [];
    this.currentFileIndex = 0;
    this.currentFile = null;
    this.currentFileOffset = 0;
    this.currentFileSize = 0;

    this.filesCopied = 0;
    this.directoriesCopied = 0;
    this.totalFiles = 0;
    this.bytesCopied = 0;
    this.totalBytes = 0;
    this.copied = [];
    this.errors = [];

    this.startTime = null;
    this.lastTransferredBytes = 0;
    this.speedBps = 0;
    this.etaSec = 0;
    this._runPromise = null;
  }

  getState() {
    const elapsedSec = this.startTime ? Math.max(0.001, (Date.now() - this.startTime) / 1000) : 0;
    const speedBps = this.status === 'running' && elapsedSec > 0
      ? Math.round(this.lastTransferredBytes / elapsedSec)
      : (this.status === 'completed' ? 0 : this.speedBps);
    const remainingBytes = Math.max(0, this.totalBytes - this.bytesCopied);
    const etaSec = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : 0;

    return {
      id: this.id,
      sourcePath: this.sourcePath,
      destinationPath: this.destinationPath,
      entries: this.requestedEntries,
      overwrite: this.overwrite,
      status: this.status,
      suspended: this.suspended,
      error: this.error,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      completedAt: this.completedAt,
      filesCopied: this.filesCopied,
      directoriesCopied: this.directoriesCopied,
      totalFiles: this.totalFiles,
      bytesCopied: this.bytesCopied,
      totalBytes: this.totalBytes,
      speedBps,
      speedMB: (speedBps / (1024 * 1024)).toFixed(2),
      etaSec,
      eta: etaSec > 0 ? `${Math.ceil(etaSec / 60)}m ${etaSec % 60}s` : (this.status === 'completed' ? 'Done' : '--'),
      overallPercent: this.totalBytes > 0
        ? Math.min(100, Math.round((this.bytesCopied / this.totalBytes) * 100))
        : (this.status === 'completed' ? 100 : 0),
      currentFile: this.currentFile,
      currentFileOffset: this.currentFileOffset,
      currentFileSize: this.currentFileSize,
      filePercent: this.currentFileSize > 0
        ? Math.min(100, Math.round((this.currentFileOffset / this.currentFileSize) * 100))
        : 0,
      copied: this.copied,
      errors: this.errors
    };
  }

  async _scanEntries() {
    const source = await ensureDirectory(this.sourcePath, 'Source directory');
    const destination = await ensureDirectory(this.destinationPath, 'Destination directory');
    const pathApi = getPathApi(source.resolved);

    if (pathApi.normalize(source.resolved) === pathApi.normalize(destination.resolved)) {
      throw new LocalFilesystemError('Source and destination directories must be different', 'SAME_DIRECTORY');
    }

    const normalizedNames = [...new Set(this.requestedEntries.map(normalizeEntryName))];
    const items = [];
    let totalBytes = 0;
    let totalFiles = 0;

    const pending = [];
    for (const name of normalizedNames) {
      const entrySource = path.join(source.resolved, name);
      const entryTarget = path.join(destination.resolved, name);
      let stats;
      try {
        stats = await fs.promises.lstat(entrySource);
      } catch (err) {
        this.errors.push({ name, error: err.message, code: err.code || 'SOURCE_NOT_FOUND' });
        continue;
      }

      if (stats.isDirectory() && pathIsWithin(entrySource, entryTarget, pathApi)) {
        throw new LocalFilesystemError(`Destination is inside the selected source directory: ${destination.resolved}`, 'DESTINATION_INSIDE_SOURCE');
      }

      pending.push({
        name,
        sourcePath: entrySource,
        targetPath: entryTarget,
        isRootEntry: true
      });
    }

    while (pending.length > 0) {
      const current = pending.shift();
      let stats;
      try {
        stats = await fs.promises.lstat(current.sourcePath);
      } catch (err) {
        this.errors.push({ name: current.name, error: err.message, code: err.code || 'READ_ERROR' });
        continue;
      }

      if (stats.isSymbolicLink()) {
        this.errors.push({
          name: current.name,
          error: `Symbolic links are not copied: ${current.sourcePath}`,
          code: 'SYMBOLIC_LINK'
        });
        continue;
      }

      if (stats.isFile()) {
        totalBytes += stats.size;
        totalFiles += 1;
        items.push({
          type: 'file',
          name: current.name,
          sourcePath: current.sourcePath,
          targetPath: current.targetPath,
          size: stats.size,
          mtime: stats.mtime,
          atime: stats.atime,
          isRootEntry: current.isRootEntry,
          status: 'pending',
          bytesCopied: 0
        });
      } else if (stats.isDirectory()) {
        items.push({
          type: 'directory',
          name: current.name,
          sourcePath: current.sourcePath,
          targetPath: current.targetPath,
          isRootEntry: current.isRootEntry,
          status: 'pending'
        });

        let childNames;
        try {
          childNames = await fs.promises.readdir(current.sourcePath);
        } catch (err) {
          this.errors.push({ name: current.name, error: err.message, code: err.code || 'READ_ERROR' });
          continue;
        }

        for (const child of childNames) {
          pending.push({
            name: path.join(current.name, child),
            sourcePath: path.join(current.sourcePath, child),
            targetPath: path.join(current.targetPath, child),
            isRootEntry: false
          });
        }
      }
    }

    this.files = items;
    this.totalFiles = totalFiles;
    this.totalBytes = totalBytes;
  }

  async start() {
    if (this.status === 'running') return this._runPromise;
    if (this.status === 'completed' || this.status === 'cancelled') return this.getState();

    this.status = 'running';
    this.suspended = false;
    this.cancelled = false;
    this.startTime = Date.now();
    this.lastTransferredBytes = 0;
    this.updatedAt = new Date().toISOString();

    this._runPromise = this._run();
    return this._runPromise;
  }

  async _run() {
    try {
      if (this.files.length === 0) {
        await this._scanEntries();
      }

      while (this.currentFileIndex < this.files.length) {
        if (this.cancelled) {
          this.status = 'cancelled';
          this.updatedAt = new Date().toISOString();
          return this.getState();
        }
        if (this.suspended) {
          this.status = 'suspended';
          this.updatedAt = new Date().toISOString();
          return this.getState();
        }

        const item = this.files[this.currentFileIndex];
        this.currentFile = item.name;

        if (item.type === 'directory') {
          await this._copyDirectoryItem(item);
          this.currentFileIndex += 1;
          continue;
        }

        if (item.type === 'file') {
          this.currentFileSize = item.size;
          this.currentFileOffset = item.bytesCopied;

          let previousOffset = item.bytesCopied;
          try {
            await copyFileChunked(item.sourcePath, item.targetPath, item, {
              overwrite: this.overwrite,
              isSuspended: () => this.suspended,
              isCancelled: () => this.cancelled,
              onProgress: (bytesRead, currentOffset, fileSize) => {
                const delta = Math.max(0, currentOffset - previousOffset);
                previousOffset = currentOffset;
                this.bytesCopied += delta;
                this.lastTransferredBytes += delta;
                this.currentFileOffset = currentOffset;
                item.bytesCopied = currentOffset;
                this.updatedAt = new Date().toISOString();
              }
            });

            item.status = 'completed';
            this.filesCopied += 1;
            if (item.isRootEntry) {
              this.copied.push({ name: item.name, type: 'file' });
            }
            this.currentFileIndex += 1;
            this.currentFileOffset = 0;
            this.currentFileSize = 0;
          } catch (err) {
            if (err instanceof CopySuspendedError) {
              this.status = 'suspended';
              this.updatedAt = new Date().toISOString();
              return this.getState();
            }
            if (err instanceof CopyCancelledError) {
              this._cleanCurrentPart(item.targetPath);
              this.status = 'cancelled';
              this.updatedAt = new Date().toISOString();
              return this.getState();
            }

            item.status = 'failed';
            this.errors.push({
              name: item.name,
              error: err.message,
              code: err.code || 'COPY_FAILED'
            });
            this.currentFileIndex += 1;
          }
        }
      }

      this.status = this.errors.length > 0 && this.filesCopied === 0 ? 'failed' : 'completed';
      this.completedAt = new Date().toISOString();
      this.updatedAt = this.completedAt;
      this.currentFile = null;
      return this.getState();
    } catch (fatalError) {
      this.status = 'failed';
      this.error = fatalError.message;
      this.updatedAt = new Date().toISOString();
      throw fatalError;
    }
  }

  async _copyDirectoryItem(item) {
    let destinationStats = null;
    try {
      destinationStats = await fs.promises.lstat(item.targetPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (destinationStats) {
      if (destinationStats.isSymbolicLink() || !destinationStats.isDirectory()) {
        throw new LocalFilesystemError(`Destination already exists and is not a directory: ${item.targetPath}`, 'DESTINATION_EXISTS');
      }
      if (!this.overwrite) {
        this.errors.push({
          name: item.name,
          error: `Destination already exists: ${item.targetPath}`,
          code: 'DESTINATION_EXISTS'
        });
        return;
      }
    } else {
      try {
        await fs.promises.mkdir(item.targetPath, { recursive: true });
        this.directoriesCopied += 1;
        if (item.isRootEntry) {
          this.copied.push({ name: item.name, type: 'directory' });
        }
      } catch (mkdirErr) {
        this.errors.push({
          name: item.name,
          error: mkdirErr.message,
          code: mkdirErr.code || 'MKDIR_FAILED'
        });
      }
    }
  }

  _cleanCurrentPart(targetPath) {
    try {
      const partPath = `${targetPath}${PART_SUFFIX}`;
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    } catch (e) {}
  }

  suspend() {
    if (this.status !== 'running') return this.getState();
    this.suspended = true;
    this.updatedAt = new Date().toISOString();
    return this.getState();
  }

  resume() {
    if (this.status !== 'suspended') return this.getState();
    this.suspended = false;
    this.status = 'running';
    this.startTime = Date.now();
    this.lastTransferredBytes = 0;
    this.updatedAt = new Date().toISOString();
    this._runPromise = this._run();
    return this._runPromise;
  }

  cancel() {
    if (this.status === 'completed') return this.getState();
    this.cancelled = true;
    this.status = 'cancelled';
    this.updatedAt = new Date().toISOString();
    if (this.currentFile && this.files[this.currentFileIndex]) {
      this._cleanCurrentPart(this.files[this.currentFileIndex].targetPath);
    }
    return this.getState();
  }
}

class LocalCopyManager {
  constructor() {
    this.jobs = new Map();
  }

  createJob(options) {
    const job = new CopyJob(options);
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id) {
    return this.jobs.get(id) || null;
  }

  listJobs() {
    return Array.from(this.jobs.values()).map(j => j.getState());
  }

  deleteJob(id) {
    const job = this.jobs.get(id);
    if (job) {
      if (job.status === 'running') job.cancel();
      this.jobs.delete(id);
      return true;
    }
    return false;
  }
}

const defaultCopyManager = new LocalCopyManager();

module.exports = {
  CopySuspendedError,
  CopyCancelledError,
  CopyJob,
  LocalCopyManager,
  copyManager: defaultCopyManager,
  copyFileChunked,
  PART_SUFFIX
};
