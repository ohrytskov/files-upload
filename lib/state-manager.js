const fs = require('fs');
const path = require('path');

class StateManager {
  /**
   * @param {string} stateFilePath - Absolute or relative path to state.json
   */
  constructor(stateFilePath = 'state.json') {
    this.stateFilePath = path.resolve(stateFilePath);
    this.state = null;
    this.saveTimer = null;
    this.saveDebounceMs = 1000;
  }

  /**
   * Loads state from disk if it exists.
   * @returns {Object|null}
   */
  loadState() {
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
    if (this.saveTimer) clearTimeout(this.saveTimer);
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
    
    // If state exists for the same sourcePath, preserve already uploaded & verified file statuses!
    const existingFiles = existing && existing.files ? existing.files : {};

    const filesState = {};
    let uploadedFilesCount = 0;
    let uploadedBytesSum = 0;

    for (const f of files) {
      const key = f.relativePath;
      const prev = existingFiles[key];

      if (prev && (prev.status === 'verified' || prev.status === 'uploaded') && prev.md5 === f.md5) {
        // Keep previously completed & matching file state for seamless resumption
        filesState[key] = {
          ...prev,
          absolutePath: f.absolutePath,
          size: f.size,
          md5: f.md5
        };
        if (prev.status === 'verified' || prev.status === 'uploaded') {
          uploadedFilesCount++;
          uploadedBytesSum += (prev.bytesUploaded || f.size);
        }
      } else {
        filesState[key] = {
          relativePath: f.relativePath,
          absolutePath: f.absolutePath,
          size: f.size,
          md5: f.md5,
          status: 'pending', // 'pending' | 'uploading' | 'uploaded' | 'verified' | 'failed'
          bytesUploaded: 0,
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

    this.saveState();
    return this.state;
  }

  /**
   * Updates state for a specific file.
   */
  updateFile(relativePath, updateObj) {
    if (!this.state || !this.state.files[relativePath]) return;

    const f = this.state.files[relativePath];
    Object.assign(f, updateObj);

    // Recalculate totals
    this.recalculateTotals();
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
        uploadedBytes += (f.bytesUploaded || f.size);
      } else {
        allCompleted = false;
        uploadedBytes += (f.bytesUploaded || 0);
      }
    }

    this.state.uploadedFiles = uploadedCount;
    this.state.uploadedBytes = uploadedBytes;
    if (allCompleted && this.state.totalFiles > 0) {
      this.state.status = 'completed';
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
