import { hashFile } from './md5';

/**
 * Browser Stateful Uploader
 * Uploads files in chunks using HTTP Resumable endpoints, with Suspend (Pause) and Resume support.
 */
export class BrowserStatefulUploader {
  constructor({
    files,
    authToken = '',
    chunkSize = 2 * 1024 * 1024,
    hashAlgorithm = 'sha256',
    onProgress,
    onFileComplete,
    onComplete,
    onError
  }) {
    this.fileList = Array.from(files);
    this.authToken = authToken;
    this.chunkSize = chunkSize;
    this.hashAlgorithm = hashAlgorithm;
    this.onProgress = onProgress;
    this.onFileComplete = onFileComplete;
    this.onComplete = onComplete;
    this.onError = onError;

    this.totalFiles = this.fileList.length;
    this.totalBytes = this.fileList.reduce((acc, f) => acc + f.size, 0);
    this.filesUploaded = 0;
    this.bytesUploaded = 0;

    this.currentFileIndex = 0;
    this.currentFile = null;
    this.currentFileOffset = 0;
    this.currentFileSize = 0;
    this.currentUploadId = null;

    this.status = 'idle'; // 'idle' | 'hashing' | 'uploading' | 'suspended' | 'completed' | 'failed' | 'cancelled'
    this.isPaused = false;
    this.abortController = null;

    this.startTime = null;
    this.transferredThisSession = 0;
  }

  getState() {
    const elapsedSec = this.startTime ? Math.max(0.001, (Date.now() - this.startTime) / 1000) : 0;
    const speedBps = this.status === 'uploading' && elapsedSec > 0
      ? this.transferredThisSession / elapsedSec
      : 0;
    const speedMB = (speedBps / (1024 * 1024)).toFixed(2);
    const remainingBytes = Math.max(0, this.totalBytes - this.bytesUploaded);
    const etaSec = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : 0;
    const eta = etaSec > 0 ? `${Math.ceil(etaSec / 60)}m ${etaSec % 60}s` : (this.status === 'completed' ? 'Done' : '--');
    const overallPercent = this.totalBytes > 0
      ? Math.min(100, Math.round((this.bytesUploaded / this.totalBytes) * 100))
      : (this.status === 'completed' ? 100 : 0);

    return {
      status: this.status,
      isPaused: this.isPaused,
      currentFileName: this.currentFile?.name || null,
      currentFileIndex: this.currentFileIndex,
      currentFileOffset: this.currentFileOffset,
      currentFileSize: this.currentFileSize,
      filePercent: this.currentFileSize > 0
        ? Math.min(100, Math.round((this.currentFileOffset / this.currentFileSize) * 100))
        : 0,
      filesUploaded: this.filesUploaded,
      totalFiles: this.totalFiles,
      bytesUploaded: this.bytesUploaded,
      totalBytes: this.totalBytes,
      speedMB,
      eta,
      overallPercent
    };
  }

  emitProgress() {
    this.onProgress?.(this.getState());
  }

  async start() {
    if (this.status === 'uploading') return;
    this.status = 'uploading';
    this.isPaused = false;
    this.startTime = Date.now();
    this.transferredThisSession = 0;
    this.emitProgress();

    await this._uploadLoop();
  }

  suspend() {
    if (this.status !== 'uploading' && this.status !== 'hashing') return;
    this.isPaused = true;
    this.status = 'suspended';
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.currentUploadId) {
      const headers = {};
      if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
      fetch(`/api/upload/resumable/${this.currentUploadId}/suspend`, {
        method: 'POST',
        headers
      }).catch(() => {});
    }
    this.emitProgress();
  }

  async resume() {
    if (this.status !== 'suspended') return;
    this.isPaused = false;
    this.status = 'uploading';
    this.startTime = Date.now();
    this.transferredThisSession = 0;

    if (this.currentUploadId) {
      const headers = {};
      if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
      try {
        const res = await fetch(`/api/upload/resumable/${this.currentUploadId}/resume`, {
          method: 'POST',
          headers
        });
        if (res.ok) {
          const data = await res.json();
          if (data.offset !== undefined) {
            const delta = data.offset - this.currentFileOffset;
            this.currentFileOffset = data.offset;
            this.bytesUploaded += delta;
          }
        }
      } catch (e) {}
    }

    this.emitProgress();
    await this._uploadLoop();
  }

  cancel() {
    this.isPaused = true;
    this.status = 'cancelled';
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.currentUploadId) {
      const headers = {};
      if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
      fetch(`/api/upload/resumable/${this.currentUploadId}`, {
        method: 'DELETE',
        headers
      }).catch(() => {});
    }
    this.emitProgress();
  }

  async _uploadLoop() {
    const authHeaders = {};
    if (this.authToken) authHeaders['Authorization'] = `Bearer ${this.authToken}`;

    try {
      while (this.currentFileIndex < this.fileList.length && !this.isPaused) {
        const file = this.fileList[this.currentFileIndex];
        this.currentFile = file;
        this.currentFileSize = file.size;

        // Step A: Hash file if not already initialized
        if (!this.currentUploadId) {
          this.status = 'hashing';
          this.emitProgress();

          const clientHash = await hashFile(file, this.hashAlgorithm);
          if (this.isPaused) return;

          // Step B: Init session on server
          this.status = 'uploading';
          const initRes = await fetch('/api/upload/resumable/init', {
            method: 'POST',
            headers: {
              ...authHeaders,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              filename: file.name,
              size: file.size,
              hashAlgorithm: this.hashAlgorithm,
              expectedHash: clientHash
            })
          });

          if (!initRes.ok) {
            const errData = await initRes.json().catch(() => ({}));
            throw new Error(errData.error || `Failed to initialize upload session: ${initRes.statusText}`);
          }

          const initData = await initRes.json();
          this.currentUploadId = initData.uploadId;
          this.currentFileOffset = initData.offset || 0;
          this.bytesUploaded += this.currentFileOffset;
          this.emitProgress();
        }

        // Step C: Send chunks
        while (this.currentFileOffset < file.size && !this.isPaused) {
          const chunkEnd = Math.min(this.currentFileOffset + this.chunkSize, file.size);
          const chunkBlob = file.slice(this.currentFileOffset, chunkEnd);
          const arrayBuffer = await chunkBlob.arrayBuffer();

          if (this.isPaused) return;

          this.abortController = new AbortController();

          let putRes;
          try {
            putRes = await fetch(`/api/upload/resumable/${this.currentUploadId}`, {
              method: 'PUT',
              headers: {
                ...authHeaders,
                'Content-Type': 'application/octet-stream',
                'Upload-Offset': String(this.currentFileOffset)
              },
              body: arrayBuffer,
              signal: this.abortController.signal
            });
          } catch (fetchErr) {
            if (this.isPaused || this.status === 'suspended' || this.status === 'cancelled') {
              return;
            }
            throw fetchErr;
          }

          if (!putRes.ok) {
            const errData = await putRes.json().catch(() => ({}));
            throw new Error(errData.error || `Failed to upload chunk: ${putRes.statusText}`);
          }

          const putData = await putRes.json();
          const bytesUploadedInChunk = chunkEnd - this.currentFileOffset;
          this.currentFileOffset = putData.offset;
          this.bytesUploaded += bytesUploadedInChunk;
          this.transferredThisSession += bytesUploadedInChunk;
          this.emitProgress();
        }

        if (this.isPaused) return;

        // Step D: Finish session
        const finishRes = await fetch(`/api/upload/resumable/${this.currentUploadId}/finish`, {
          method: 'POST',
          headers: authHeaders
        });

        if (!finishRes.ok) {
          const errData = await finishRes.json().catch(() => ({}));
          throw new Error(errData.error || `Checksum verification failed on server: ${finishRes.statusText}`);
        }

        const finishData = await finishRes.json();
        this.filesUploaded += 1;
        this.onFileComplete?.(finishData.file);

        // Reset for next file
        this.currentUploadId = null;
        this.currentFileOffset = 0;
        this.currentFileSize = 0;
        this.currentFileIndex += 1;
        this.emitProgress();
      }

      if (this.filesUploaded >= this.totalFiles && !this.isPaused) {
        this.status = 'completed';
        this.emitProgress();
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
