/**
 * Browser Stateful Downloader
 * Downloads files in chunks using HTTP Range requests, with Suspend (Pause) and Resume support.
 */

export class BrowserStatefulDownloader {
  constructor({ file, authToken = '', chunkSize = 2 * 1024 * 1024, onProgress, onComplete, onError }) {
    this.file = file; // { name, relativePath, size, hash, hashAlgorithm, url }
    this.authToken = authToken;
    this.chunkSize = chunkSize;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;

    this.filename = file.relativePath || file.name;
    this.totalSize = Number(file.size) || 0;
    this.downloadedBytes = 0;
    this.chunks = []; // Array of Uint8Array chunks
    this.status = 'idle'; // 'idle' | 'downloading' | 'suspended' | 'completed' | 'failed' | 'cancelled'
    this.isPaused = false;

    this.serverHash = file.hash || null;
    this.hashAlgorithm = file.hashAlgorithm || 'sha256';

    this.abortController = null;
    this.startTime = null;
    this.transferredThisSession = 0;
  }

  getState() {
    const elapsedSec = this.startTime ? Math.max(0.001, (Date.now() - this.startTime) / 1000) : 0;
    const speedBps = this.status === 'downloading' && elapsedSec > 0
      ? this.transferredThisSession / elapsedSec
      : 0;
    const speedMB = (speedBps / (1024 * 1024)).toFixed(2);
    const remainingBytes = Math.max(0, this.totalSize - this.downloadedBytes);
    const etaSec = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : 0;
    const eta = etaSec > 0 ? `${Math.ceil(etaSec / 60)}m ${etaSec % 60}s` : (this.status === 'completed' ? 'Done' : '--');
    const percent = this.totalSize > 0
      ? Math.min(100, Math.round((this.downloadedBytes / this.totalSize) * 100))
      : 0;

    return {
      filename: this.filename,
      status: this.status,
      isPaused: this.isPaused,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalSize,
      speedMB,
      eta,
      percent
    };
  }

  emitProgress() {
    this.onProgress?.(this.getState());
  }

  async start() {
    if (this.status === 'downloading') return;
    this.status = 'downloading';
    this.isPaused = false;
    this.startTime = Date.now();
    this.transferredThisSession = 0;
    this.emitProgress();

    await this._downloadLoop();
  }

  suspend() {
    if (this.status !== 'downloading') return;
    this.isPaused = true;
    this.status = 'suspended';
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.emitProgress();
  }

  async resume() {
    if (this.status !== 'suspended') return;
    this.isPaused = false;
    this.status = 'downloading';
    this.startTime = Date.now();
    this.transferredThisSession = 0;
    this.emitProgress();

    await this._downloadLoop();
  }

  cancel() {
    this.isPaused = true;
    this.status = 'cancelled';
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.chunks = [];
    this.downloadedBytes = 0;
    this.emitProgress();
  }

  async _downloadLoop() {
    const downloadUrl = `/api/files/${encodeURIComponent(this.filename)}/download`;

    try {
      while (this.status === 'downloading' && !this.isPaused) {
        if (this.totalSize > 0 && this.downloadedBytes >= this.totalSize) {
          break;
        }

        const chunkEnd = this.totalSize > 0
          ? Math.min(this.downloadedBytes + this.chunkSize - 1, this.totalSize - 1)
          : this.downloadedBytes + this.chunkSize - 1;

        const headers = {
          Range: `bytes=${this.downloadedBytes}-${chunkEnd}`
        };
        if (this.authToken) {
          headers['Authorization'] = `Bearer ${this.authToken}`;
        }

        this.abortController = new AbortController();

        let response;
        try {
          response = await fetch(downloadUrl, {
            headers,
            signal: this.abortController.signal
          });
        } catch (fetchErr) {
          if (this.isPaused || this.status === 'suspended' || this.status === 'cancelled') {
            return;
          }
          throw fetchErr;
        }

        if (response.status !== 206 && response.status !== 200) {
          throw new Error(`Download failed with status ${response.status}`);
        }

        if (this.totalSize === 0) {
          const cr = response.headers.get('content-range');
          if (cr) {
            const total = cr.split('/')[1];
            if (total) this.totalSize = parseInt(total, 10);
          } else {
            const cl = response.headers.get('content-length');
            if (cl) this.totalSize = parseInt(cl, 10);
          }
          if (!this.serverHash) {
            this.serverHash = response.headers.get('x-file-hash');
            this.hashAlgorithm = response.headers.get('x-hash-algorithm') || 'sha256';
          }
        }

        const arrayBuffer = await response.arrayBuffer();
        const chunk = new Uint8Array(arrayBuffer);

        if (chunk.length === 0) break;

        this.chunks.push(chunk);
        this.downloadedBytes += chunk.length;
        this.transferredThisSession += chunk.length;
        this.emitProgress();

        if (this.totalSize > 0 && this.downloadedBytes >= this.totalSize) {
          break;
        }
      }

      if (this.status === 'downloading' && !this.isPaused) {
        this.status = 'completed';
        this.emitProgress();

        // Assemble Blob and trigger save
        const blob = new Blob(this.chunks, { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = this.file.name || this.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);

        this.onComplete?.(this.getState());
      }
    } catch (err) {
      if (this.status !== 'suspended' && this.status !== 'cancelled') {
        this.status = 'failed';
        this.emitProgress();
        this.onError?.(err);
      }
    }
  }
}
