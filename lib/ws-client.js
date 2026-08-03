const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const StateManager = require('./state-manager');
const { generateHashes } = require('./hash-generator');

class WebSocketUploaderClient {
  /**
   * @param {Object} options
   * @param {string} options.serverUrl - WebSocket endpoint URL (e.g. "ws://localhost:3000/ws/upload")
   * @param {string} options.sourcePath - Target path on local disk (Windows 11 path or Linux path)
   * @param {string} [options.stateFilePath="state.json"] - Path to save state.json for resumption
   * @param {number} [options.chunkSize=262144] - Chunk size in bytes (default: 256 KB)
   * @param {Function} [options.onProgress] - Callback for live upload progress
   * @param {Function} [options.onFileStatus] - Callback for file level events
   * @param {Function} [options.onAuditComplete] - Callback when audit is complete
   * @param {Function} [options.onError] - Callback on error
   */
  constructor({
    serverUrl,
    sourcePath,
    stateFilePath = 'state.json',
    chunkSize = 256 * 1024,
    onProgress = null,
    onFileStatus = null,
    onAuditComplete = null,
    onError = null
  }) {
    this.serverUrl = serverUrl;
    this.sourcePath = sourcePath;
    this.chunkSize = chunkSize;
    this.onProgress = onProgress;
    this.onFileStatus = onFileStatus;
    this.onAuditComplete = onAuditComplete;
    this.onError = onError;

    this.stateManager = new StateManager(stateFilePath);
    this.ws = null;
    this.manifest = null;
    this.isPaused = false;
    this.currentUploadingFile = null;
    this.startTime = null;
    this.bytesTransferredSession = 0;
  }

  /**
   * Starts the scanning, hashing, WebSocket connection, and chunked upload process.
   */
  async start() {
    try {
      console.log(`\n==================================================`);
      console.log(` 🚀 Starting WebSocket Upload Client`);
      console.log(` 📁 Target Source Path: ${this.sourcePath}`);
      console.log(` 🌐 Remote Server URL: ${this.serverUrl}`);
      console.log(`==================================================\n`);

      // 1. Scan and hash local files
      console.log(`[Client] Scanning & generating MD5 hashes for path...`);
      this.manifest = await generateHashes({
        sourcePath: this.sourcePath,
        onProgress: (p) => {
          if (this.onProgress) {
            this.onProgress({
              stage: 'hashing',
              current: p.current,
              total: p.total,
              file: p.file,
              md5: p.md5
            });
          }
        }
      });

      console.log(`[Client] Hash generation done. Total files: ${this.manifest.totalFiles}, Total size: ${(this.manifest.totalBytes / (1024 * 1024)).toFixed(2)} MB`);

      // 2. Initialize persistent state from state.json
      this.stateManager.initSession({
        sessionId: `session_${Date.now()}`,
        sourcePath: this.sourcePath,
        files: this.manifest.files
      });

      // 3. Connect via WebSockets
      this.connectWebSocket();
    } catch (err) {
      console.error('[Client] Start error:', err.message);
      if (this.onError) this.onError(err);
    }
  }

  connectWebSocket() {
    console.log(`[Client] Connecting to WebSocket server: ${this.serverUrl}...`);
    this.ws = new WebSocket(this.serverUrl);

    this.ws.on('open', () => {
      console.log('[Client] Connected to WebSocket server successfully!');
      this.startTime = Date.now();
      
      // Initialize session on server
      this.ws.send(JSON.stringify({
        type: 'INIT_SESSION',
        payload: {
          sessionId: this.stateManager.state.sessionId,
          sourcePath: this.sourcePath,
          files: this.manifest.files
        }
      }));
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleServerMessage(msg);
      } catch (err) {
        console.error('[Client] Error parsing message from server:', err);
      }
    });

    this.ws.on('close', () => {
      console.log('[Client] WebSocket connection closed.');
      if (this.stateManager.state && this.stateManager.state.status !== 'completed' && !this.isPaused) {
        console.log('[Client] Connection lost unexpectedly. Retrying in 3 seconds...');
        setTimeout(() => this.connectWebSocket(), 3000);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[Client] WebSocket error:', err.message);
      if (this.onError) this.onError(err);
    });
  }

  async handleServerMessage(msg) {
    const { type, payload } = msg;

    switch (type) {
      case 'SESSION_READY': {
        const { files: serverFiles } = payload;
        console.log('[Client] Server session ready. Resuming interrupted files...');

        // Update local state based on server feedback
        for (const relPath in serverFiles) {
          const sf = serverFiles[relPath];
          if (sf.status === 'verified') {
            this.stateManager.updateFile(relPath, {
              status: 'verified',
              serverMd5: sf.serverMd5,
              verified: true,
              bytesUploaded: sf.size
            });
          }
        }

        // Begin uploading remaining pending files
        this.uploadNextPendingFile(serverFiles);
        break;
      }

      case 'FILE_STARTED': {
        const { relativePath, offset } = payload;
        this.sendNextChunk(relativePath, offset);
        break;
      }

      case 'CHUNK_ACK': {
        const { relativePath, offset } = payload;
        const fileObj = this.stateManager.state.files[relativePath];
        
        this.bytesTransferredSession += this.chunkSize;
        this.stateManager.updateFile(relativePath, { bytesUploaded: offset, status: 'uploading' });

        this.reportProgress(fileObj, offset);

        if (offset >= fileObj.size) {
          // Send FINISH_FILE to request server MD5 calculation & verification
          this.ws.send(JSON.stringify({
            type: 'FINISH_FILE',
            payload: {
              relativePath,
              clientMd5: fileObj.md5
            }
          }));
        } else {
          this.sendNextChunk(relativePath, offset);
        }
        break;
      }

      case 'FILE_VERIFIED': {
        const { relativePath, serverMd5, match } = payload;
        console.log(`[Client] ✅ Verified file: ${relativePath} (MD5: ${serverMd5})`);

        this.stateManager.updateFile(relativePath, {
          status: 'verified',
          serverMd5,
          verified: true,
          error: null
        });

        if (this.onFileStatus) {
          this.onFileStatus({ relativePath, status: 'verified', serverMd5, match: true });
        }

        // Continue to next pending file
        this.uploadNextPendingFile();
        break;
      }

      case 'FILE_ERROR': {
        const { relativePath, error, serverMd5 } = payload;
        console.error(`[Client] ❌ Error uploading file ${relativePath}: ${error}`);

        this.stateManager.updateFile(relativePath, {
          status: 'failed',
          serverMd5: serverMd5 || null,
          verified: false,
          error
        });

        if (this.onFileStatus) {
          this.onFileStatus({ relativePath, status: 'failed', error });
        }

        // Try next file
        this.uploadNextPendingFile();
        break;
      }

      case 'AUDIT_COMPLETE': {
        this.stateManager.flushSave();
        console.log(`\n==================================================`);
        console.log(` 📊 Full MD5 Server Audit Complete`);
        console.log(` Verified: ${payload.matchCount} | Mismatched: ${payload.mismatchCount} | Missing: ${payload.missingCount}`);
        console.log(`==================================================\n`);

        if (this.onAuditComplete) {
          this.onAuditComplete(payload);
        }
        break;
      }
    }
  }

  uploadNextPendingFile(serverFilesHint = null) {
    if (this.isPaused) return;

    const pending = this.stateManager.getPendingFiles();
    if (pending.length === 0) {
      console.log('\n[Client] All files uploaded and verified! Running final server MD5 audit...');
      this.ws.send(JSON.stringify({ type: 'RUN_FULL_AUDIT' }));
      return;
    }

    const nextFile = pending[0];
    this.currentUploadingFile = nextFile;

    let offset = nextFile.bytesUploaded || 0;
    if (serverFilesHint && serverFilesHint[nextFile.relativePath]) {
      offset = serverFilesHint[nextFile.relativePath].offset || 0;
    }

    console.log(`[Client] Uploading file (${this.stateManager.state.uploadedFiles + 1}/${this.stateManager.state.totalFiles}): ${nextFile.relativePath} starting at offset ${offset}`);

    this.ws.send(JSON.stringify({
      type: 'START_FILE',
      payload: {
        relativePath: nextFile.relativePath,
        size: nextFile.size,
        clientMd5: nextFile.md5,
        offset
      }
    }));
  }

  sendNextChunk(relativePath, offset) {
    if (this.isPaused) return;

    const fileObj = this.stateManager.state.files[relativePath];
    if (!fileObj) return;

    const absPath = fileObj.absolutePath;

    try {
      const buffer = Buffer.alloc(Math.min(this.chunkSize, fileObj.size - offset));
      const fd = fs.openSync(absPath, 'r');
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      fs.closeSync(fd);

      const base64Data = buffer.toString('base64');

      this.ws.send(JSON.stringify({
        type: 'FILE_CHUNK',
        payload: {
          relativePath,
          offset,
          data: base64Data
        }
      }));
    } catch (err) {
      console.error(`[Client] Failed to read chunk from ${absPath}:`, err.message);
      this.stateManager.updateFile(relativePath, { status: 'failed', error: err.message });
      this.uploadNextPendingFile();
    }
  }

  reportProgress(currentFile, fileOffset) {
    if (!this.onProgress || !this.startTime) return;

    const elapsedSec = (Date.now() - this.startTime) / 1000;
    const speedBps = elapsedSec > 0 ? (this.bytesTransferredSession / elapsedSec) : 0;
    const remainingBytes = this.stateManager.state.totalBytes - this.stateManager.state.uploadedBytes;
    const etaSec = speedBps > 0 ? (remainingBytes / speedBps) : 0;

    const summary = this.stateManager.getSummary();

    this.onProgress({
      stage: 'uploading',
      currentFile: currentFile.relativePath,
      fileOffset,
      fileSize: currentFile.size,
      filePercent: Math.round((fileOffset / currentFile.size) * 100),
      totalUploadedFiles: summary.uploadedFiles,
      totalFiles: summary.totalFiles,
      uploadedBytes: summary.uploadedBytes,
      totalBytes: summary.totalBytes,
      overallPercent: summary.progressPercent,
      speedBps,
      etaSec
    });
  }

  pause() {
    this.isPaused = true;
    console.log('[Client] Upload paused by user.');
  }

  resume() {
    if (this.isPaused) {
      this.isPaused = false;
      console.log('[Client] Upload resumed.');
      this.uploadNextPendingFile();
    }
  }

  requestAudit() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'RUN_FULL_AUDIT' }));
    }
  }
}

module.exports = WebSocketUploaderClient;
