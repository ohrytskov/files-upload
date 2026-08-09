const fs = require('fs');
const path = require('path');
require('./load-env');
const config = require('./config');
const CloudVaultDatabase = require('./database');

const DEFAULT_HASH_ALGORITHM = String(process.env.DEFAULT_HASH_ALGORITHM || 'sha256').toLowerCase() === 'md5'
  ? 'md5'
  : 'sha256';

function getFileHash(file) {
  return file.hash || file.md5 || null;
}

function getHashAlgorithm(file) {
  return file.hashAlgorithm || (file.md5 ? 'md5' : DEFAULT_HASH_ALGORITHM);
}

function isCompleteStatus(status) {
  return status === 'uploaded' || status === 'verified';
}

function getUploadedBytes(file) {
  const bytesUploaded = Number.isFinite(file.bytesUploaded) ? Math.max(0, file.bytesUploaded) : 0;
  if (isCompleteStatus(file.status)) return Number.isFinite(file.size) ? Math.max(0, file.size) : bytesUploaded;
  return bytesUploaded;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

class StateManager {
  /**
   * @param {string} stateFilePath - Absolute or relative path to state.json
   * @param {Object} options
   * @param {string} [options.databasePath] - Use SQLite persistence when provided
   */
  constructor(stateFilePath = 'state.json', options = {}) {
    this.stateFilePath = path.resolve(stateFilePath);
    this.database = options.databasePath
      ? new CloudVaultDatabase(options.databasePath, { legacyStatePath: this.stateFilePath })
      : null;
    this.state = null;
    this.saveTimer = null;
    this.saveDebounceMs = config.stateSaveDebounceMs;
    this.dirtyFiles = new Set();
  }

  /**
   * Loads state from disk if it exists.
   * @returns {Object|null}
   */
  loadState() {
    if (this.database) {
      this.state = this.database.readState();
      this.dirtyFiles.clear();
      return this.state;
    }

    if (fs.existsSync(this.stateFilePath)) {
      try {
        const data = fs.readFileSync(this.stateFilePath, 'utf8');
        this.state = JSON.parse(data);
        return this.state;
      } catch (err) {
        console.error(`[StateManager] Failed to parse ${this.stateFilePath}:`, err.message);
      }
    }
    return null;
  }

  /**
   * Saves state atomically to disk.
   */
  saveState() {
    if (!this.state) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.database) {
      try {
        this.state.updatedAt = new Date().toISOString();
        this.database.saveState(this.state, this.dirtyFiles);
        this.dirtyFiles.clear();
      } catch (err) {
        console.error(`[StateManager] Error writing SQLite state to ${this.database.databasePath}:`, err.message);
      }
      return;
    }

    try {
      this.state.updatedAt = new Date().toISOString();
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write to temp file then rename for atomic write
      const tempPath = `${this.stateFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (err) {
      console.error(`[StateManager] Error writing state to ${this.stateFilePath}:`, err.message);
    }
  }

  scheduleSave() {
    // Throttle checkpoint writes instead of debouncing them. A busy upload can
    // produce a chunk more frequently than the debounce interval; a pure
    // debounce would then never persist progress until the transfer pauses.
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveState();
    }, this.saveDebounceMs);
    this.saveTimer.unref?.();
  }

  flushSave() {
    this.saveState();
  }

  /**
   * Initializes a new session or merges into existing state if target matches.
   * @param {Object} params
   * @param {string} params.sessionId
   * @param {string} params.sourcePath
   * @param {Array} params.files - Array of file objects from hash-generator
   */
  initSession({ sessionId, sourcePath, files }) {
    const existing = this.loadState();
    const sameSource = Boolean(existing && existing.sourcePath === sourcePath);
    // Only preserve completion state for the same logical source. The server
    // can still inspect existing target files by hash, but a different source
    // must not inherit a client's progress metadata accidentally.
    const existingFiles = sameSource && existing.files ? existing.files : Object.create(null);

    const filesState = Object.create(null);
    let uploadedFilesCount = 0;
    let uploadedBytesSum = 0;

    for (const f of files) {
      const key = f.relativePath;
      const prev = hasOwn(existingFiles, key) ? existingFiles[key] : null;
      const hash = getFileHash(f);
      const hashAlgorithm = getHashAlgorithm(f);
      const previousHash = prev && getFileHash(prev);
      const previousAlgorithm = prev && getHashAlgorithm(prev);

      if (
        prev &&
        (prev.status === 'verified' || prev.status === 'uploaded') &&
        previousHash === hash &&
        previousAlgorithm === hashAlgorithm
      ) {
        // Keep previously completed & matching file state for seamless resumption
        filesState[key] = {
          ...prev,
          absolutePath: f.absolutePath,
          size: f.size,
          sourceMtimeMs: f.sourceMtimeMs,
          hashAlgorithm,
          hash,
          ...(hashAlgorithm === 'md5' ? { md5: hash } : { md5: null })
        };
        if (prev.status === 'verified' || prev.status === 'uploaded') {
          uploadedFilesCount++;
          uploadedBytesSum += getUploadedBytes({ ...prev, size: f.size });
        }
      } else {
        filesState[key] = {
          relativePath: f.relativePath,
          absolutePath: f.absolutePath,
          size: f.size,
          hashAlgorithm,
          hash,
          ...(hashAlgorithm === 'md5' ? { md5: hash } : { md5: null }),
          status: 'pending', // 'pending' | 'uploading' | 'uploaded' | 'verified' | 'failed'
          bytesUploaded: 0,
          serverHash: null,
          serverMd5: null,
          verified: false,
          error: null
        };
      }
    }

    const totalBytes = files.reduce((acc, curr) => acc + curr.size, 0);

    this.state = {
      sessionId: sessionId || (existing ? existing.sessionId : `session_${Date.now()}`),
      sourcePath,
      totalFiles: files.length,
      totalBytes,
      uploadedFiles: uploadedFilesCount,
      uploadedBytes: uploadedBytesSum,
      status: uploadedFilesCount === files.length ? 'completed' : 'in_progress',
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files: filesState
    };

    if (this.database) {
      this.state.updatedAt = new Date().toISOString();
      this.database.replaceState(this.state);
      this.dirtyFiles.clear();
    } else {
      this.saveState();
    }
    return this.state;
  }

  /**
   * Updates state for a specific file.
   */
  updateFile(relativePath, updateObj) {
    if (!this.state?.files || !hasOwn(this.state.files, relativePath)) return;

    const f = this.state.files[relativePath];
    const oldCompleted = isCompleteStatus(f.status);
    const oldUploadedBytes = getUploadedBytes(f);
    Object.assign(f, updateObj);
    this.dirtyFiles.add(relativePath);

    // Update aggregate counters incrementally. Re-scanning the entire manifest
    // for every 256 KB/4 MB chunk makes a large transfer O(files * chunks).
    const newCompleted = isCompleteStatus(f.status);
    const newUploadedBytes = getUploadedBytes(f);
    this.state.uploadedFiles = Math.max(
      0,
      (Number.isFinite(this.state.uploadedFiles) ? this.state.uploadedFiles : 0) +
      Number(newCompleted) - Number(oldCompleted)
    );
    this.state.uploadedBytes = Math.max(
      0,
      (Number.isFinite(this.state.uploadedBytes) ? this.state.uploadedBytes : 0) +
      newUploadedBytes - oldUploadedBytes
    );

    const allCompleted = this.state.totalFiles > 0 && this.state.uploadedFiles >= this.state.totalFiles;
    if (allCompleted) this.state.status = 'completed';
    else if (this.state.status === 'completed') this.state.status = 'in_progress';

    this.scheduleSave();
  }

  /**
   * Recalculates total stats.
   */
  recalculateTotals() {
    if (!this.state || !this.state.files) return;

    let uploadedCount = 0;
    let uploadedBytes = 0;
    let allCompleted = true;

    for (const key in this.state.files) {
      const f = this.state.files[key];
      if (f.status === 'uploaded' || f.status === 'verified') {
        uploadedCount++;
        uploadedBytes += getUploadedBytes(f);
      } else {
        allCompleted = false;
        uploadedBytes += getUploadedBytes(f);
      }
    }

    this.state.uploadedFiles = uploadedCount;
    this.state.uploadedBytes = uploadedBytes;
    if (allCompleted && this.state.totalFiles > 0) {
      this.state.status = 'completed';
    } else if (this.state.status === 'completed') {
      this.state.status = 'in_progress';
    }
  }

  /**
   * Returns list of pending or interrupted files that need uploading.
   */
  getPendingFiles() {
    if (!this.state || !this.state.files) return [];
    return Object.values(this.state.files).filter(
      f => f.status === 'pending' || f.status === 'uploading' || f.status === 'failed'
    );
  }

  renameTrackedFile(oldRelativePath, newRelativePath) {
    if (!this.state?.files || !hasOwn(this.state.files, oldRelativePath)) return false;
    if (hasOwn(this.state.files, newRelativePath)) return false;

    const file = this.state.files[oldRelativePath];
    delete this.state.files[oldRelativePath];
    file.relativePath = newRelativePath;
    this.state.files[newRelativePath] = file;
    this.dirtyFiles.add(oldRelativePath);
    this.dirtyFiles.add(newRelativePath);
    this.scheduleSave();
    return true;
  }

  markTrackedFileDeleted(relativePath, error = 'File deleted from repository') {
    if (!this.state?.files || !hasOwn(this.state.files, relativePath)) return false;
    this.updateFile(relativePath, {
      status: 'failed',
      bytesUploaded: 0,
      serverHash: null,
      serverMd5: null,
      verified: false,
      error
    });
    return true;
  }

  getRepositoryFile(relativePath) {
    return this.database?.getRepositoryFile(relativePath) || null;
  }

  upsertRepositoryFile(file) {
    this.database?.upsertRepositoryFile(file);
  }

  deleteRepositoryFile(relativePath) {
    this.database?.deleteRepositoryFile(relativePath);
  }

  renameRepositoryFile(oldRelativePath, newRelativePath) {
    this.database?.renameRepositoryFile(oldRelativePath, newRelativePath);
  }

  recordAudit(audit) {
    this.database?.recordAudit(audit);
  }

  close() {
    this.flushSave();
    this.database?.close();
  }

  /**
   * Gets state summary.
   */
  getSummary() {
    if (!this.state) return null;
    return {
      sessionId: this.state.sessionId,
      sourcePath: this.state.sourcePath,
      totalFiles: this.state.totalFiles,
      totalBytes: this.state.totalBytes,
      uploadedFiles: this.state.uploadedFiles,
      uploadedBytes: this.state.uploadedBytes,
      progressPercent: this.state.totalBytes > 0 
        ? Math.round((this.state.uploadedBytes / this.state.totalBytes) * 100)
        : 0,
      status: this.state.status
    };
  }
}

module.exports = StateManager;
