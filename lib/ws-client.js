const fs = require('fs');
const WebSocket = require('ws');
const StateManager = require('./state-manager');
const { generateHashes, normalizeHashAlgorithm } = require('./hash-generator');
const { encodeChunk } = require('./chunk-protocol');
const config = require('./config');

const DEFAULT_CHUNK_SIZE = config.uploadChunkSize;
const MAX_FILE_RETRIES = config.maxFileRetries;

function getFileHash(file) {
  return file.hash || file.md5;
}

function serializeManifest(files) {
  return files.map(file => {
    const hashAlgorithm = file.hashAlgorithm || 'sha256';
    const hash = getFileHash(file);
    return {
      relativePath: file.relativePath,
      size: file.size,
      hashAlgorithm,
      hash,
      ...(hashAlgorithm === 'md5' ? { md5: hash } : {})
    };
  });
}

class WebSocketUploaderClient {
  /**
   * @param {Object} options
   * @param {string} options.serverUrl - WebSocket endpoint URL (e.g. "ws://localhost:3000/ws/upload")
   * @param {string} options.sourcePath - Target path on local disk (Windows 11 path or Linux path)
   * @param {string} [options.stateFilePath="state.json"] - Path to save state.json for resumption
   * @param {string|null} [options.outputFile=null] - Optional path for a hashes manifest
   * @param {number} [options.chunkSize=4194304] - Chunk size in bytes (default: 4 MB)
   * @param {Function} [options.onProgress] - Callback for live upload progress
   * @param {Function} [options.onFileStatus] - Callback for file level events
   * @param {Function} [options.onAuditComplete] - Callback when audit is complete
   * @param {Function} [options.onError] - Callback on error
   */
  constructor({
    serverUrl,
    sourcePath,
    stateFilePath = 'state.json',
    outputFile = null,
    authToken = config.authToken,
    hashAlgorithm = config.defaultHashAlgorithm,
    chunkSize = DEFAULT_CHUNK_SIZE,
    onProgress = null,
    onFileStatus = null,
    onAuditComplete = null,
    onError = null
  }) {
    this.serverUrl = serverUrl;
    this.sourcePath = sourcePath;
    this.outputFile = outputFile;
    this.authToken = authToken;
    this.hashAlgorithm = normalizeHashAlgorithm(hashAlgorithm);
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error('chunkSize must be a positive integer');
    }
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
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.stopping = false;
    this.auditRequested = false;
    this.auditCompleted = false;
    this.retryCounts = new Map();
    this.fileDescriptors = new Map();
  }

  /**
   * Starts the scanning, hashing, WebSocket connection, and chunked upload process.
   */
  async start() {
    try {
      this.stopping = false;
      this.auditRequested = false;
      this.auditCompleted = false;
      this.reconnectAttempts = 0;
      this.retryCounts.clear();
      this.bytesTransferredSession = 0;
      this.startTime = null;
      console.log(`\n==================================================`);
      console.log(` 🚀 Starting WebSocket Upload Client`);
      console.log(` 📁 Target Source Path: ${this.sourcePath}`);
      console.log(` 🌐 Remote Server URL: ${this.serverUrl}`);
      console.log(`==================================================\n`);

      // 1. Scan and hash local files
      console.log(`[Client] Scanning & generating ${this.hashAlgorithm.toUpperCase()} hashes for path...`);
      this.manifest = await generateHashes({
        sourcePath: this.sourcePath,
        outputFile: this.outputFile,
        algorithm: this.hashAlgorithm,
        onProgress: (p) => {
          if (this.onProgress) {
            this.onProgress({
              stage: 'hashing',
              current: p.current,
              total: p.total,
              file: p.file,
              hash: p.hash,
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
    if (this.stopping) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log(`[Client] Connecting to WebSocket server: ${this.serverUrl}...`);
    const socket = new WebSocket(this.serverUrl);
    this.ws = socket;

    socket.on('open', () => {
      if (socket !== this.ws) return;
      console.log('[Client] Connected to WebSocket server successfully!');
      if (!this.startTime) this.startTime = Date.now();

      this.reconnectAttempts = 0;
      const initializeSession = () => socket.send(JSON.stringify({
        type: 'INIT_SESSION',
        payload: {
          sessionId: this.stateManager.state.sessionId,
          sourcePath: this.sourcePath,
          files: serializeManifest(this.manifest.files)
        }
      }));

      if (this.authToken) {
        socket.send(JSON.stringify({ type: 'AUTH', payload: { token: this.authToken } }));
      } else {
        initializeSession();
      }
    });

    socket.on('message', (raw) => {
      if (socket !== this.ws) return;
      try {
        const msg = JSON.parse(raw.toString());
        this.handleServerMessage(msg).catch(err => {
          console.error('[Client] Failed to process server message:', err.message);
          this.stop();
          if (this.onError) this.onError(err, { recoverable: false });
        });
      } catch (err) {
        console.error('[Client] Error parsing message from server:', err);
      }
    });

    socket.on('close', (code, reason) => {
      if (socket !== this.ws) return;
      this.ws = null;
      this.closeFileDescriptors();
      this.stateManager.flushSave();
      console.log('[Client] WebSocket connection closed.');

      if ([1002, 1003, 1007, 1008, 1009].includes(code)) {
        this.stopping = true;
        const closeReason = reason?.toString() || `WebSocket closed with code ${code}`;
        if (this.onError) this.onError(new Error(closeReason), { recoverable: false });
        return;
      }

      if (
        this.stateManager.state &&
        (!this.auditCompleted || this.stateManager.state.status !== 'completed') &&
        !this.isPaused &&
        !this.stopping
      ) {
        if (this.auditRequested && !this.auditCompleted) this.auditRequested = false;
        this.scheduleReconnect();
      }
    });

    socket.on('error', (err) => {
      if (socket !== this.ws) return;
      console.error('[Client] WebSocket error:', err.message);
      // The close event owns reconnection. Do not turn a transient network
      // error into a fatal process exit in the CLI.
      if (this.onError) this.onError(err, { recoverable: true });
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopping || this.isPaused) return;
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(this.reconnectAttempts, 5)));
    this.reconnectAttempts += 1;
    console.log(`[Client] Retrying connection in ${Math.ceil(delay / 1000)} seconds...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  closeFileDescriptors() {
    for (const fd of this.fileDescriptors.values()) {
      try { fs.closeSync(fd); } catch (err) {}
    }
    this.fileDescriptors.clear();
  }

  closeFileDescriptor(relativePath) {
    const fd = this.fileDescriptors.get(relativePath);
    if (fd === undefined) return;
    try { fs.closeSync(fd); } catch (err) {}
    this.fileDescriptors.delete(relativePath);
  }

  validateSourceFile(fileObj) {
    const stats = fs.statSync(fileObj.absolutePath);
    if (!stats.isFile() || stats.size !== fileObj.size) {
      throw new Error(`Source file changed or disappeared: ${fileObj.relativePath}`);
    }
    if (
      Number.isFinite(fileObj.sourceMtimeMs) &&
      stats.mtimeMs !== fileObj.sourceMtimeMs
    ) {
      throw new Error(`Source file changed after hashing: ${fileObj.relativePath}`);
    }
  }

  async handleServerMessage(msg) {
    const { type, payload } = msg;

    switch (type) {
      case 'AUTH_OK': {
        this.ws?.send(JSON.stringify({
          type: 'INIT_SESSION',
          payload: {
            sessionId: this.stateManager.state.sessionId,
            sourcePath: this.sourcePath,
            files: serializeManifest(this.manifest.files)
          }
        }));
        break;
      }

      case 'ERROR': {
        const error = new Error(msg.message || 'WebSocket server error');
        this.stop();
        if (this.onError) this.onError(error, { recoverable: false });
        break;
      }

      case 'SESSION_READY': {
        const { files: serverFiles } = payload;
        console.log('[Client] Server session ready. Resuming interrupted files...');

        // Update local state based on server feedback
        for (const relPath of Object.keys(this.stateManager.state.files)) {
          const sf = serverFiles[relPath];
          const fileObj = this.stateManager.state.files[relPath];
          const rawOffset = Number(sf?.offset);
          const offset = Number.isSafeInteger(rawOffset)
            ? Math.min(Math.max(rawOffset, 0), fileObj.size)
            : 0;
          if (sf?.status === 'verified') {
            this.stateManager.updateFile(relPath, {
              status: 'verified',
              serverHash: sf.serverHash || sf.serverMd5,
              serverMd5: sf.serverMd5 || null,
              verified: true,
              bytesUploaded: fileObj.size
            });
          } else {
            this.stateManager.updateFile(relPath, {
              status: 'pending',
              bytesUploaded: offset,
              serverHash: sf?.serverHash || sf?.serverMd5 || null,
              serverMd5: sf?.serverMd5 || null,
              verified: false,
              error: null
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
        
        const previousOffset = fileObj.bytesUploaded || 0;
        this.bytesTransferredSession += Math.max(0, offset - previousOffset);
        this.stateManager.updateFile(relativePath, { bytesUploaded: offset, status: 'uploading' });

        this.reportProgress(fileObj, offset);

        if (offset >= fileObj.size) {
          // Send FINISH_FILE to request server hash calculation & verification
          this.ws.send(JSON.stringify({
            type: 'FINISH_FILE',
            payload: {
              relativePath,
              hashAlgorithm: fileObj.hashAlgorithm || this.hashAlgorithm,
              clientHash: getFileHash(fileObj),
              ...(fileObj.hashAlgorithm === 'md5' || !fileObj.hashAlgorithm ? { clientMd5: getFileHash(fileObj) } : {})
            }
          }));
        } else {
          this.sendNextChunk(relativePath, offset);
        }
        break;
      }

      case 'FILE_VERIFIED': {
        const { relativePath, serverHash, serverMd5 } = payload;
        const resolvedServerHash = serverHash || serverMd5;
        console.log(`[Client] ✅ Verified file: ${relativePath} (${(payload.hashAlgorithm || this.hashAlgorithm).toUpperCase()}: ${resolvedServerHash})`);

        this.stateManager.updateFile(relativePath, {
          status: 'verified',
          serverHash: resolvedServerHash,
          serverMd5: serverMd5 || null,
          verified: true,
          error: null
        });
        this.retryCounts.delete(relativePath);
        this.closeFileDescriptor(relativePath);

        if (this.onFileStatus) {
          this.onFileStatus({ relativePath, status: 'verified', serverHash: resolvedServerHash, serverMd5: serverMd5 || null, match: true });
        }

        // Continue to next pending file
        this.uploadNextPendingFile();
        break;
      }

      case 'FILE_ERROR': {
        const { relativePath, error, serverHash, serverMd5 } = payload;
        console.error(`[Client] ❌ Error uploading file ${relativePath}: ${error}`);

        const attempts = (this.retryCounts.get(relativePath) || 0) + 1;
        this.retryCounts.set(relativePath, attempts);
        this.closeFileDescriptor(relativePath);

        this.stateManager.updateFile(relativePath, {
          status: attempts >= MAX_FILE_RETRIES ? 'failed' : 'pending',
          serverHash: serverHash || serverMd5 || null,
          serverMd5: serverMd5 || null,
          verified: false,
          error,
          bytesUploaded: attempts >= MAX_FILE_RETRIES ? (this.stateManager.state.files[relativePath].bytesUploaded || 0) : 0
        });

        if (this.onFileStatus) {
          this.onFileStatus({ relativePath, status: 'failed', error });
        }

        if (attempts >= MAX_FILE_RETRIES) {
          this.stop();
          if (this.onError) {
            this.onError(new Error(`Giving up on ${relativePath} after ${MAX_FILE_RETRIES} attempts: ${error}`), { recoverable: false });
          }
        } else {
          console.log(`[Client] Retrying ${relativePath} (${attempts}/${MAX_FILE_RETRIES})`);
          this.uploadNextPendingFile();
        }
        break;
      }

      case 'AUDIT_COMPLETE': {
        this.stateManager.flushSave();
        console.log(`\n==================================================`);
        console.log(` 📊 Full Server Hash Audit Complete`);
        console.log(` Verified: ${payload.matchCount} | Mismatched: ${payload.mismatchCount} | Missing: ${payload.missingCount}`);
        console.log(`==================================================\n`);

        if (this.onAuditComplete) {
          this.onAuditComplete(payload);
        }
        this.auditRequested = true;
        this.auditCompleted = true;
        this.stopping = true;
        this.closeFileDescriptors();
        this.ws?.close();
        break;
      }
    }
  }

  uploadNextPendingFile(serverFilesHint = null) {
    if (this.isPaused) return;

    const pending = this.stateManager.getPendingFiles();
    if (pending.length === 0) {
      if (this.stateManager.state.status !== 'completed') {
        return;
      }
      if (this.auditRequested) return;
      this.auditRequested = true;
      console.log('\n[Client] All files uploaded and verified! Running final server hash audit...');
      this.ws?.send(JSON.stringify({ type: 'RUN_FULL_AUDIT' }));
      return;
    }

    const nextFile = pending[0];
    this.currentUploadingFile = nextFile;

    try {
      this.validateSourceFile(nextFile);
    } catch (err) {
      this.stateManager.updateFile(nextFile.relativePath, { status: 'failed', error: err.message });
      this.stop();
      if (this.onError) this.onError(err, { recoverable: false });
      return;
    }

    let offset = nextFile.bytesUploaded || 0;
    if (serverFilesHint && serverFilesHint[nextFile.relativePath]) {
      offset = serverFilesHint[nextFile.relativePath].offset || 0;
    }

    console.log(`[Client] Uploading file (${this.stateManager.state.uploadedFiles + 1}/${this.stateManager.state.totalFiles}): ${nextFile.relativePath} starting at offset ${offset}`);

    this.ws?.send(JSON.stringify({
      type: 'START_FILE',
      payload: {
        relativePath: nextFile.relativePath,
        size: nextFile.size,
        hashAlgorithm: nextFile.hashAlgorithm || this.hashAlgorithm,
        clientHash: getFileHash(nextFile),
        ...(nextFile.hashAlgorithm === 'md5' || !nextFile.hashAlgorithm ? { clientMd5: getFileHash(nextFile) } : {}),
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
      const remaining = fileObj.size - offset;
      if (remaining <= 0) {
        this.ws.send(JSON.stringify({
          type: 'FINISH_FILE',
          payload: {
            relativePath,
            hashAlgorithm: fileObj.hashAlgorithm || this.hashAlgorithm,
            clientHash: getFileHash(fileObj),
            ...(fileObj.hashAlgorithm === 'md5' || !fileObj.hashAlgorithm ? { clientMd5: getFileHash(fileObj) } : {})
          }
        }));
        return;
      }

      const buffer = Buffer.alloc(Math.min(this.chunkSize, remaining));
      let fd = this.fileDescriptors.get(relativePath);
      if (fd === undefined) {
        fd = fs.openSync(absPath, 'r');
        this.fileDescriptors.set(relativePath, fd);
      }
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length) {
        throw new Error(`Source file ended before the manifest size: ${relativePath}`);
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(encodeChunk({
        relativePath,
        offset,
        data: buffer
      }));
    } catch (err) {
      console.error(`[Client] Failed to read chunk from ${absPath}:`, err.message);
      this.closeFileDescriptor(relativePath);
      this.stateManager.updateFile(relativePath, { status: 'failed', error: err.message });
      this.stop();
      if (this.onError) this.onError(err, { recoverable: false });
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
      filePercent: currentFile.size > 0 ? Math.round((fileOffset / currentFile.size) * 100) : 100,
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    console.log('[Client] Upload paused by user.');
  }

  resume() {
    if (this.isPaused) {
      this.isPaused = false;
      console.log('[Client] Upload resumed.');
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.connectWebSocket();
      else this.uploadNextPendingFile();
    }
  }

  requestAudit() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'RUN_FULL_AUDIT' }));
    }
  }

  stop() {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeFileDescriptors();
    this.stateManager.flushSave();
    this.ws?.close();
  }
}

module.exports = WebSocketUploaderClient;
