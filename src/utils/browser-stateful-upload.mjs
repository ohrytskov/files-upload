import {
  browserUploadSessionMatches,
  clearBrowserUploadSession,
  loadBrowserUploadSession,
  saveBrowserUploadSession
} from './browser-upload-session.mjs';
import { MAX_FILE_RETRIES, UPLOAD_CHUNK_SIZE } from '../config';

const HASH_ALGORITHM = 'sha256';
const SESSION_TAKEN_OVER_CLOSE_CODE = 4001;

function encodeBinaryChunk(relativePath, offset, arrayBuffer) {
  const header = new TextEncoder().encode(JSON.stringify({
    type: 'FILE_CHUNK',
    relativePath,
    offset
  }));

  if (header.byteLength > 64 * 1024) throw new Error('Chunk metadata is too large');

  const frame = new Uint8Array(4 + header.byteLength + arrayBuffer.byteLength);
  new DataView(frame.buffer).setUint32(0, header.byteLength);
  frame.set(header, 4);
  frame.set(new Uint8Array(arrayBuffer), 4 + header.byteLength);
  return frame.buffer;
}

function serializeManifest(files) {
  return files.map(file => ({
    relativePath: file.relativePath,
    size: file.size,
    hashAlgorithm: HASH_ALGORITHM,
    hash: file.hash
  }));
}

function clampOffset(value, size) {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) return 0;
  return Math.min(Math.max(offset, 0), size);
}

function initialStats(files) {
  return {
    filesCount: 0,
    totalFiles: files.length,
    uploadedBytes: 0,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    speedMB: '0.00',
    eta: '--',
    overallPct: 0,
    activeFile: null,
    activePct: 0
  };
}

/**
 * Browser-side stateful uploader used by Commander View.
 *
 * The selected File objects stay in memory for the active page, while the
 * manifest (path, size, mtime, and SHA-256) is persisted in localStorage.
 * The server owns the resumable byte offset and verifies every completed file.
 */
export default class BrowserStatefulUpload {
  constructor({ entries, authToken = '', serverUrl, onChange, onNotify, onComplete }) {
    this.entries = entries;
    this.authToken = authToken;
    this.serverUrl = serverUrl;
    this.onChange = onChange;
    this.onNotify = onNotify;
    this.onComplete = onComplete;

    this.manifest = {
      sourcePath: 'browser-selection',
      hashAlgorithm: HASH_ALGORITHM,
      totalFiles: entries.length,
      totalBytes: entries.reduce((total, file) => total + file.size, 0),
      files: entries.map(file => ({
        ...file,
        hashAlgorithm: HASH_ALGORITHM,
        status: 'pending',
        offset: 0,
        serverHash: null,
        match: false,
        error: null
      }))
    };

    this.state = {
      status: 'Ready to upload',
      isUploading: false,
      isPaused: false,
      files: this.manifest.files,
      stats: initialStats(entries)
    };

    this.socket = null;
    this.sessionId = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.retryCounts = {};
    this.lastOffsets = {};
    this.transferredBytes = 0;
    this.startTime = null;
    this.paused = false;
    this.stopping = false;
    this.auditRequested = false;
    this.disposed = false;
  }

  getState() {
    return this.state;
  }

  notify(message, type = 'info') {
    this.onNotify?.(message, type);
  }

  calculateStats() {
    let uploadedBytes = 0;
    let filesCount = 0;
    let activeFile = null;

    for (const file of this.manifest.files) {
      const offset = clampOffset(file.offset, file.size);
      if (file.status === 'verified') {
        filesCount += 1;
        uploadedBytes += file.size;
      } else {
        uploadedBytes += offset;
        if (!activeFile && file.status === 'uploading') activeFile = { file, offset };
      }
    }

    const elapsedSeconds = this.startTime ? Math.max(0.001, (Date.now() - this.startTime) / 1000) : 0;
    const speedBytes = elapsedSeconds > 0 ? this.transferredBytes / elapsedSeconds : 0;
    const remainingBytes = Math.max(0, this.manifest.totalBytes - uploadedBytes);
    const etaSeconds = speedBytes > 0 ? Math.ceil(remainingBytes / speedBytes) : 0;
    const activeOffset = activeFile?.offset || 0;

    return {
      filesCount,
      totalFiles: this.manifest.totalFiles,
      uploadedBytes,
      totalBytes: this.manifest.totalBytes,
      speedMB: (speedBytes / (1024 * 1024)).toFixed(2),
      eta: etaSeconds > 0 ? `${Math.ceil(etaSeconds / 60)}m ${etaSeconds % 60}s` : 'Done',
      overallPct: this.manifest.totalBytes > 0
        ? Math.round((uploadedBytes / this.manifest.totalBytes) * 100)
        : 100,
      activeFile: activeFile?.file.relativePath || null,
      activePct: activeFile
        ? (activeFile.file.size > 0 ? Math.round((activeOffset / activeFile.file.size) * 100) : 100)
        : 0
    };
  }

  emit(patch = {}) {
    if (this.disposed) return;
    this.state = {
      ...this.state,
      ...patch,
      files: this.manifest.files,
      stats: this.calculateStats()
    };
    this.onChange?.(this.state);
  }

  setStatus(status, patch = {}) {
    this.emit({ status, ...patch });
  }

  updateFile(relativePath, patch) {
    const file = this.manifest.files.find(item => item.relativePath === relativePath);
    if (!file) return;
    Object.assign(file, patch);
    this.emit();
  }

  prepareSession() {
    const savedSession = loadBrowserUploadSession();
    const canResume = browserUploadSessionMatches(savedSession, this.manifest.files, HASH_ALGORITHM);
    this.sessionId = canResume ? savedSession.sessionId : `commander_${Date.now()}`;
    saveBrowserUploadSession({
      sessionId: this.sessionId,
      hashAlgorithm: HASH_ALGORITHM,
      files: this.manifest.files
    });
  }

  sendInit() {
    this.socket?.send(JSON.stringify({
      type: 'INIT_SESSION',
      payload: {
        sessionId: this.sessionId,
        sourcePath: 'browser-selection',
        files: serializeManifest(this.manifest.files)
      }
    }));
  }

  connect() {
    if (this.disposed || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    let socket;
    try {
      socket = new WebSocket(this.serverUrl.trim());
    } catch (error) {
      this.stopping = true;
      this.setStatus('Invalid WebSocket URL', { isUploading: false });
      this.notify('The WebSocket URL is invalid. Use a ws:// or wss:// URL.', 'error');
      return;
    }

    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopping || this.disposed) {
        socket.close();
        return;
      }

      this.startTime = this.startTime || Date.now();
      this.setStatus('Uploading...', { isUploading: true, isPaused: false });
      if (this.authToken) {
        socket.send(JSON.stringify({ type: 'AUTH', payload: { token: this.authToken } }));
      } else {
        this.sendInit();
      }
    };

    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try {
        this.handleMessage(JSON.parse(event.data));
      } catch (error) {
        this.notify('Received an invalid message from the upload server.', 'error');
      }
    };

    socket.onerror = () => {
      if (this.socket === socket) this.setStatus('Connection error', { isUploading: false });
    };

    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.socket = null;

      if ([1002, 1003, 1007, 1008, 1009, SESSION_TAKEN_OVER_CLOSE_CODE].includes(event.code)) {
        this.stopping = true;
        this.setStatus('Connection rejected by server', { isUploading: false });
        this.notify(event.reason || `WebSocket closed with code ${event.code}.`, 'error');
        return;
      }

      if (!this.stopping && !this.paused && !this.disposed) this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopping || this.paused || this.disposed) return;
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(this.reconnectAttempts, 5)));
    this.reconnectAttempts += 1;
    this.setStatus(`Connection lost; retrying in ${Math.ceil(delay / 1000)}s...`, { isUploading: false });
    this.notify(`Connection lost; retrying in ${Math.ceil(delay / 1000)}s...`, 'warning');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  handleMessage(message) {
    const { type, payload } = message;

    if (type === 'AUTH_OK') {
      this.sendInit();
      return;
    }

    if (type === 'SESSION_READY') {
      const serverFiles = payload?.files || {};
      for (const file of this.manifest.files) {
        const serverFile = serverFiles[file.relativePath];
        const offset = clampOffset(serverFile?.offset, file.size);
        Object.assign(file, {
          offset,
          status: serverFile?.status === 'verified' ? 'verified' : 'pending',
          serverHash: serverFile?.serverHash || null,
          match: serverFile?.status === 'verified',
          error: null
        });
        this.lastOffsets[file.relativePath] = offset;
      }
      this.emit({ isUploading: true });
      this.uploadNextFile();
      return;
    }

    if (type === 'ERROR') {
      this.stopping = true;
      this.setStatus(message.message || 'Upload error', { isUploading: false });
      this.notify(message.message || 'Stateful upload failed.', 'error');
      this.socket?.close();
      return;
    }

    if (type === 'FILE_STARTED') {
      const relativePath = payload?.relativePath;
      const offset = clampOffset(payload?.offset, this.getFile(relativePath)?.size || 0);
      this.updateFile(relativePath, { status: 'uploading', offset, error: null });
      this.sendChunk(relativePath, offset);
      return;
    }

    if (type === 'CHUNK_ACK') {
      const relativePath = payload?.relativePath;
      const file = this.getFile(relativePath);
      if (!file) return;
      const offset = clampOffset(payload?.offset, file.size);
      const previousOffset = this.lastOffsets[relativePath] || 0;
      this.transferredBytes += Math.max(0, offset - previousOffset);
      this.lastOffsets[relativePath] = offset;
      this.updateFile(relativePath, { status: 'uploading', offset });
      if (offset >= file.size) this.finishFile(file);
      else this.sendChunk(relativePath, offset);
      return;
    }

    if (type === 'FILE_VERIFIED') {
      const relativePath = payload?.relativePath;
      const file = this.getFile(relativePath);
      if (!file) return;
      this.retryCounts[relativePath] = 0;
      this.updateFile(relativePath, {
        status: 'verified',
        offset: file.size,
        serverHash: payload.serverHash || null,
        match: true,
        error: null
      });
      this.uploadNextFile();
      return;
    }

    if (type === 'FILE_ERROR') {
      const relativePath = payload?.relativePath;
      const attempts = (this.retryCounts[relativePath] || 0) + 1;
      this.retryCounts[relativePath] = attempts;
      const file = this.getFile(relativePath);
      if (file) {
        this.updateFile(relativePath, {
          status: attempts >= MAX_FILE_RETRIES ? 'failed' : 'pending',
          offset: attempts >= MAX_FILE_RETRIES ? file.offset : 0,
          serverHash: payload?.serverHash || null,
          match: false,
          error: payload?.error || 'Upload failed'
        });
      }

      if (attempts >= MAX_FILE_RETRIES) {
        this.stopping = true;
        this.setStatus(`Upload failed: ${relativePath}`, { isUploading: false });
        this.notify(payload?.error || `Upload failed for ${relativePath}`, 'error');
        this.socket?.close();
      } else {
        this.notify(payload?.error || `Retrying ${relativePath}...`, 'warning');
        this.uploadNextFile();
      }
      return;
    }

    if (type === 'AUDIT_COMPLETE') {
      const matchCount = Number(payload?.matchCount) || 0;
      const mismatchCount = Number(payload?.mismatchCount) || 0;
      const missingCount = Number(payload?.missingCount) || 0;
      const expectedFiles = this.manifest.files.length;
      const verified = matchCount === expectedFiles && mismatchCount === 0 && missingCount === 0;

      for (const result of payload?.auditResults || []) {
        const file = this.getFile(result.relativePath);
        if (file) {
          Object.assign(file, {
            status: result.match ? 'verified' : 'failed',
            serverHash: result.serverHash || null,
            match: Boolean(result.match),
            error: result.error || null
          });
        }
      }

      if (verified) clearBrowserUploadSession();
      this.stopping = true;
      this.setStatus(
        verified ? 'Completed & verified' : `Audit failed: ${mismatchCount} mismatch(es), ${missingCount} missing`,
        { isUploading: false, isPaused: false }
      );
      this.notify(
        verified
          ? 'Stateful upload completed and all files were verified with SHA-256.'
          : `Upload finished with ${mismatchCount} mismatch(es) and ${missingCount} missing file(s).`,
        verified ? 'success' : 'error'
      );
      this.onComplete?.({ verified, payload });
      this.socket?.close();
    }
  }

  getFile(relativePath) {
    return this.manifest.files.find(file => file.relativePath === relativePath);
  }

  uploadNextFile() {
    if (this.paused || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.manifest.files.some(file => file.status === 'failed')) {
      this.stopping = true;
      this.setStatus('Transfer stopped because one or more files failed', { isUploading: false });
      return;
    }

    const pending = this.manifest.files.find(file => file.status === 'pending' || file.status === 'uploading');
    if (!pending) {
      if (this.auditRequested) return;
      this.auditRequested = true;
      this.setStatus('Comparing all uploaded files with SHA-256...', { isUploading: true });
      this.socket.send(JSON.stringify({ type: 'RUN_FULL_AUDIT' }));
      return;
    }

    this.updateFile(pending.relativePath, { status: 'uploading' });
    this.socket.send(JSON.stringify({
      type: 'START_FILE',
      payload: {
        relativePath: pending.relativePath,
        size: pending.size,
        hashAlgorithm: HASH_ALGORITHM,
        clientHash: pending.hash,
        offset: pending.offset || 0
      }
    }));
  }

  finishFile(file) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'FINISH_FILE',
      payload: {
        relativePath: file.relativePath,
        hashAlgorithm: HASH_ALGORITHM,
        clientHash: file.hash
      }
    }));
  }

  async sendChunk(relativePath, offset) {
    const socket = this.socket;
    const fileItem = this.getFile(relativePath);
    if (!socket || socket.readyState !== WebSocket.OPEN || this.paused || !fileItem?.file) return;

    try {
      const end = Math.min(offset + UPLOAD_CHUNK_SIZE, fileItem.size);
      if (end <= offset) {
        this.finishFile(fileItem);
        return;
      }

      const buffer = await fileItem.file.slice(offset, end).arrayBuffer();
      if (this.paused || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(encodeBinaryChunk(relativePath, offset, buffer));
    } catch (error) {
      this.stopping = true;
      this.setStatus(`Failed to read ${relativePath}`, { isUploading: false });
      this.notify(`Failed to read ${relativePath}: ${error.message}`, 'error');
      socket.close();
    }
  }

  start() {
    if (this.disposed) return;
    if (this.manifest.files.length === 0) {
      this.setStatus('Waiting for files', { isUploading: false });
      this.notify('Select local files before starting the stateful upload.', 'warning');
      return;
    }
    if (!this.serverUrl?.trim()) {
      this.setStatus('Waiting for server URL', { isUploading: false });
      this.notify('Enter a WebSocket server URL before starting the upload.', 'warning');
      return;
    }
    if (this.paused && this.socket?.readyState === WebSocket.OPEN) {
      this.resume();
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.uploadNextFile();
      return;
    }

    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.prepareSession();
    this.stopping = false;
    this.paused = false;
    this.auditRequested = false;
    this.retryCounts = {};
    this.reconnectAttempts = 0;
    this.transferredBytes = 0;
    this.startTime = Date.now();
    this.setStatus('Connecting...', { isUploading: false, isPaused: false });
    this.connect();
  }

  pause() {
    if (!this.socket || !this.state.isUploading) {
      this.notify('There is no active Commander upload to pause.', 'info');
      return;
    }
    this.paused = true;
    this.setStatus('Paused', { isPaused: true, isUploading: true });
  }

  resume() {
    if (!this.manifest.files.length) return;
    this.paused = false;
    this.stopping = false;
    this.setStatus('Uploading...', { isPaused: false, isUploading: true });
    if (this.socket?.readyState === WebSocket.OPEN) this.uploadNextFile();
    else this.connect();
  }

  dispose() {
    this.disposed = true;
    this.stopping = true;
    this.paused = false;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}
