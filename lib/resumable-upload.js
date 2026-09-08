const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isInternalUploadFile, normalizeFilename } = require('./path-utils');

class ResumableUploadError extends Error {
  constructor(message, code = 'RESUMABLE_UPLOAD_ERROR', statusCode = 400) {
    super(message);
    this.name = 'ResumableUploadError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class ResumableUploadManager {
  constructor({ uploadsDir, maxFileSize = 50 * 1024 * 1024 * 1024, sessionTimeoutMs = 24 * 60 * 60 * 1000 }) {
    this.uploadsDir = uploadsDir;
    this.maxFileSize = maxFileSize;
    this.sessionTimeoutMs = sessionTimeoutMs;
    this.sessions = new Map();
  }

  initSession({ filename, size, hashAlgorithm = 'sha256', expectedHash = null }) {
    if (!filename || typeof filename !== 'string') {
      throw new ResumableUploadError('Filename is required', 'INVALID_FILENAME', 400);
    }
    const fileSize = Number(size);
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      throw new ResumableUploadError('Invalid file size', 'INVALID_SIZE', 400);
    }
    if (fileSize > this.maxFileSize) {
      throw new ResumableUploadError('File exceeds maximum allowed size', 'FILE_TOO_LARGE', 413);
    }

    let normalizedName;
    try {
      normalizedName = normalizeFilename(path.basename(filename.replace(/\\/g, '/')));
      if (isInternalUploadFile(normalizedName)) {
        throw new ResumableUploadError('Reserved upload filename', 'RESERVED_FILENAME', 400);
      }
    } catch (err) {
      if (err instanceof ResumableUploadError) throw err;
      throw new ResumableUploadError('Invalid upload filename', 'INVALID_FILENAME', 400);
    }

    // Check if an active session already exists for this exact file to allow seamless resume
    for (const existing of this.sessions.values()) {
      if (
        existing.filename === normalizedName &&
        existing.size === fileSize &&
        existing.expectedHash === (expectedHash ? expectedHash.toLowerCase() : null) &&
        fs.existsSync(existing.partPath)
      ) {
        const stat = fs.statSync(existing.partPath);
        existing.offset = stat.size;
        existing.updatedAt = new Date().toISOString();
        return {
          uploadId: existing.uploadId,
          filename: existing.filename,
          size: existing.size,
          offset: existing.offset,
          hashAlgorithm: existing.hashAlgorithm,
          resumed: true
        };
      }
    }

    const uploadId = `upl_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const partPath = path.join(this.uploadsDir, `.${uploadId}.cloudvault-http-part`);

    // Ensure staging file is initialized
    fs.writeFileSync(partPath, Buffer.alloc(0));

    const session = {
      uploadId,
      filename: normalizedName,
      size: fileSize,
      offset: 0,
      hashAlgorithm: (hashAlgorithm || 'sha256').toLowerCase(),
      expectedHash: expectedHash ? expectedHash.toLowerCase() : null,
      partPath,
      status: 'uploading', // 'uploading' | 'suspended' | 'completed'
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.sessions.set(uploadId, session);

    return {
      uploadId,
      filename: normalizedName,
      size: fileSize,
      offset: 0,
      hashAlgorithm: session.hashAlgorithm,
      resumed: false
    };
  }

  getSession(uploadId) {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new ResumableUploadError('Upload session not found', 'SESSION_NOT_FOUND', 404);
    }
    return session;
  }

  writeChunk(uploadId, offset, buffer) {
    const session = this.getSession(uploadId);
    const chunkOffset = Number(offset);

    if (!Number.isSafeInteger(chunkOffset) || chunkOffset < 0) {
      throw new ResumableUploadError('Invalid chunk offset', 'INVALID_OFFSET', 400);
    }

    // Verify current part file size
    let currentPartSize = 0;
    try {
      const stat = fs.statSync(session.partPath);
      currentPartSize = stat.size;
    } catch (e) {
      throw new ResumableUploadError('Staging file missing', 'STAGING_MISSING', 500);
    }

    if (chunkOffset > currentPartSize) {
      throw new ResumableUploadError(
        `Offset mismatch: expected ${currentPartSize}, got ${chunkOffset}`,
        'OFFSET_MISMATCH',
        409
      );
    }

    // Open file and write buffer at chunkOffset
    const fd = fs.openSync(session.partPath, chunkOffset === 0 ? 'w' : 'r+');
    try {
      fs.writeSync(fd, buffer, 0, buffer.length, chunkOffset);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    session.offset = chunkOffset + buffer.length;
    session.updatedAt = new Date().toISOString();

    return {
      uploadId,
      offset: session.offset,
      size: session.size,
      completed: session.offset >= session.size
    };
  }

  suspendSession(uploadId) {
    const session = this.getSession(uploadId);
    session.status = 'suspended';
    session.updatedAt = new Date().toISOString();
    return {
      uploadId,
      offset: session.offset,
      status: session.status
    };
  }

  resumeSession(uploadId) {
    const session = this.getSession(uploadId);
    let currentPartSize = session.offset;
    try {
      const stat = fs.statSync(session.partPath);
      currentPartSize = stat.size;
    } catch (e) {}

    session.offset = currentPartSize;
    session.status = 'uploading';
    session.updatedAt = new Date().toISOString();
    return {
      uploadId,
      offset: session.offset,
      size: session.size,
      status: session.status
    };
  }

  async finishSession(uploadId, { calculateServerHash, reserveHttpUploadName, serverStateManager, invalidateHashCache, getFileCategory, encodeUploadUrl }) {
    const session = this.getSession(uploadId);

    let stat;
    try {
      stat = fs.statSync(session.partPath);
    } catch (e) {
      throw new ResumableUploadError('Staging file missing', 'STAGING_MISSING', 500);
    }

    if (stat.size !== session.size) {
      throw new ResumableUploadError(
        `File size mismatch: expected ${session.size} bytes, got ${stat.size} bytes`,
        'SIZE_MISMATCH',
        400
      );
    }

    // Calculate server hash
    const serverHash = await calculateServerHash(session.partPath, session.hashAlgorithm);
    if (session.expectedHash && session.expectedHash !== serverHash.toLowerCase()) {
      try { fs.unlinkSync(session.partPath); } catch (e) {}
      this.sessions.delete(uploadId);
      throw new ResumableUploadError(
        `${session.hashAlgorithm.toUpperCase()} checksum mismatch for ${session.filename}`,
        'CHECKSUM_MISMATCH',
        422
      );
    }

    // Reserve final name atomically in uploads directory
    let finalName;
    try {
      finalName = reserveHttpUploadName(session.partPath, session.filename);
    } catch (err) {
      try { fs.unlinkSync(session.partPath); } catch (e) {}
      this.sessions.delete(uploadId);
      throw err;
    }

    const finalPath = path.join(this.uploadsDir, finalName);
    const finalStats = fs.statSync(finalPath);

    if (invalidateHashCache) {
      invalidateHashCache(finalPath);
    }

    if (serverStateManager) {
      serverStateManager.upsertRepositoryFile({
        relativePath: finalName,
        size: finalStats.size,
        hash: serverHash,
        hashAlgorithm: session.hashAlgorithm,
        md5: session.hashAlgorithm === 'md5' ? serverHash : null,
        hashStatus: session.expectedHash ? 'verified' : 'server-only',
        createdAtMs: finalStats.birthtimeMs,
        modifiedAtMs: finalStats.mtimeMs,
        targetMtimeMs: finalStats.mtimeMs,
        targetCtimeMs: finalStats.ctimeMs,
        targetIno: finalStats.ino,
        targetDev: finalStats.dev
      });
      serverStateManager.flushSave();
    }

    this.sessions.delete(uploadId);

    const category = getFileCategory ? getFileCategory(finalName) : 'other';
    const url = encodeUploadUrl ? encodeUploadUrl(finalName) : `/uploads/${encodeURIComponent(finalName)}`;

    return {
      name: finalName,
      relativePath: finalName,
      size: finalStats.size,
      hash: serverHash,
      hashAlgorithm: session.hashAlgorithm,
      md5: session.hashAlgorithm === 'md5' ? serverHash : null,
      hashStatus: session.expectedHash ? 'verified' : 'server-only',
      createdAt: finalStats.birthtime || finalStats.ctime,
      modifiedAt: finalStats.mtime,
      category,
      extension: path.extname(finalName).toLowerCase(),
      url
    };
  }

  cancelSession(uploadId) {
    const session = this.sessions.get(uploadId);
    if (session) {
      try {
        if (fs.existsSync(session.partPath)) fs.unlinkSync(session.partPath);
      } catch (e) {}
      this.sessions.delete(uploadId);
      return true;
    }
    return false;
  }
}

module.exports = {
  ResumableUploadError,
  ResumableUploadManager
};
