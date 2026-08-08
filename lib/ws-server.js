const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const StateManager = require('./state-manager');
const { normalizeHashAlgorithm } = require('./hash-generator');
const config = require('./config');
const { isInternalUploadFile, normalizeRelativePath, resolveSafePath } = require('./path-utils');
const { createConnectionLimiter, normalizeToken, tokensMatch } = require('./security');
const { parseWebSocketMessage } = require('./chunk-protocol');

const PART_SUFFIX = '.cloudvault-part';
const DEFAULT_HASH_ALGORITHM = config.defaultHashAlgorithm;
const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW || 0;

/**
 * Calculates a local file hash on the server using streams.
 */
function calculateServerHash(filePath, algorithm = DEFAULT_HASH_ALGORITHM) {
  const hashAlgorithm = normalizeHashAlgorithm(algorithm);
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return resolve(null);
    }
    const hash = crypto.createHash(hashAlgorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', (err) => reject(err));
  });
}

function calculateServerMd5(filePath) {
  return calculateServerHash(filePath, 'md5');
}

function getHashLength(algorithm) {
  return algorithm === 'sha256' ? 64 : 32;
}

function getFileHash(fileItem) {
  return fileItem.hash || fileItem.md5 || null;
}

function getPartPath(targetPath) {
  return `${targetPath}${PART_SUFFIX}`;
}

function getRegularFileStat(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Upload target is not a regular file: ${filePath}`);
  }
  return stat;
}

function removeRegularFile(filePath) {
  const stat = getRegularFileStat(filePath);
  if (stat) fs.unlinkSync(filePath);
}

function getTargetMetadata(stat) {
  return {
    targetMtimeMs: stat.mtimeMs,
    targetCtimeMs: stat.ctimeMs,
    targetIno: stat.ino,
    targetDev: stat.dev
  };
}

function matchesTargetMetadata(fileItem, stat) {
  return Number.isFinite(Number(fileItem.targetMtimeMs)) &&
    Number.isFinite(Number(fileItem.targetCtimeMs)) &&
    Number.isFinite(Number(fileItem.targetIno)) &&
    Number.isFinite(Number(fileItem.targetDev)) &&
    Number(fileItem.targetMtimeMs) === stat.mtimeMs &&
    Number(fileItem.targetCtimeMs) === stat.ctimeMs &&
    Number(fileItem.targetIno) === stat.ino &&
    Number(fileItem.targetDev) === stat.dev;
}

function syncFile(filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function writeChunkAtOffset(filePath, offset, buffer, syncEachChunk = false) {
  const flags = offset === 0
    ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NOFOLLOW_FLAG
    : fs.constants.O_WRONLY | NOFOLLOW_FLAG;
  const handle = await fs.promises.open(filePath, flags, 0o600);
  try {
    let written = 0;
    while (written < buffer.length) {
      const result = await handle.write(buffer, written, buffer.length - written, offset + written);
      if (!result.bytesWritten) throw new Error('Unable to make progress while writing chunk');
      written += result.bytesWritten;
    }
    if (syncEachChunk) await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Resolve an existing final/partial file into a safe resumable state. Partial
 * data is kept out of the public final filename and is atomically renamed only
 * after the complete file hash matches the manifest.
 */
async function inspectExistingUpload(fileItem, targetPath) {
  const partPath = getPartPath(targetPath);
  let finalStat = getRegularFileStat(targetPath);
  let partStat = getRegularFileStat(partPath);

  if (finalStat) {
    if (finalStat.size === fileItem.size) {
      const knownHash = fileItem.serverHash || fileItem.serverMd5;
      if (
        fileItem.status === 'verified' &&
        knownHash === fileItem.hash &&
        matchesTargetMetadata(fileItem, finalStat)
      ) {
        if (partStat) removeRegularFile(partPath);
        return { offset: fileItem.size, status: 'verified', serverHash: knownHash, ...getTargetMetadata(finalStat) };
      }

      const finalHash = await calculateServerHash(targetPath, fileItem.hashAlgorithm);
      if (finalHash === fileItem.hash) {
        if (partStat) removeRegularFile(partPath);
        return { offset: fileItem.size, status: 'verified', serverHash: finalHash, ...getTargetMetadata(finalStat) };
      }
      // A same-sized final file with a different hash is not a resumable
      // prefix. It must be replaced by this manifest's content.
      removeRegularFile(targetPath);
      finalStat = null;
    } else if (finalStat.size < fileItem.size) {
      // Migrate partial files created by older versions into the staging name.
      if (!partStat) {
        fs.renameSync(targetPath, partPath);
        partStat = fs.lstatSync(partPath);
      } else {
        removeRegularFile(targetPath);
      }
      finalStat = null;
    } else {
      removeRegularFile(targetPath);
      finalStat = null;
    }
  }

  partStat = getRegularFileStat(partPath);
  if (partStat && partStat.size > fileItem.size) {
    removeRegularFile(partPath);
    partStat = null;
  }

  if (partStat && partStat.size === fileItem.size) {
    const partHash = await calculateServerHash(partPath, fileItem.hashAlgorithm);
    if (partHash === fileItem.hash) {
      fs.renameSync(partPath, targetPath);
      const finalStat = fs.statSync(targetPath);
      return { offset: fileItem.size, status: 'verified', serverHash: partHash, ...getTargetMetadata(finalStat) };
    }
    removeRegularFile(partPath);
    partStat = null;
  }

  return {
    offset: partStat ? partStat.size : 0,
    status: 'pending',
    serverHash: null,
    targetMtimeMs: null,
    targetCtimeMs: null,
    targetIno: null,
    targetDev: null
  };
}

/**
 * Initializes WebSocket Upload Server on top of existing HTTP Server.
 * @param {import('http').Server} httpServer
 * @param {string} uploadsDir
 */
function initWebSocketServer(httpServer, uploadsDir, options = {}) {
  const maxPayload = options.maxPayload ?? config.wsMaxPayload;
  const maxChunkSize = options.maxChunkSize ?? config.wsMaxChunkSize;
  const maxFileSize = options.maxFileSize ?? config.wsMaxFileSize;
  const maxTotalBytes = options.maxTotalBytes ?? config.wsMaxTotalBytes;
  const maxManifestBytes = options.maxManifestBytes ?? config.wsMaxManifestBytes;
  const maxManifestFiles = options.maxManifestFiles ?? config.wsMaxManifestFiles;
  const authTimeoutMs = options.authTimeoutMs ?? config.wsAuthTimeoutMs;
  const syncEachChunk = options.syncEachChunk ?? config.wsSyncEachChunk;
  const defaultHashAlgorithm = options.defaultHashAlgorithm || DEFAULT_HASH_ALGORITHM;
  const wss = new WebSocket.Server({
    noServer: true,
    maxPayload
  });
  const serverStatePath = path.join(uploadsDir, 'server_state.json');
  const stateManager = new StateManager(serverStatePath, {
    // Library callers often provide a temporary/custom uploads directory. Do
    // not silently put their state in the process-wide configured directory.
    databasePath: options.databasePath ?? path.join(uploadsDir, 'cloudvault.sqlite')
  });
  const authToken = normalizeToken(options.authToken);
  const connectionLimiter = createConnectionLimiter({
    windowMs: options.connectionRateWindowMs || 60_000,
    max: options.maxConnectionsPerAddress || 20
  });

  // Load existing server state if present
  stateManager.loadState();
  let activeSessionOwner = null;
  let activeSessionId = null;

  // Listen for HTTP upgrade requests on /ws/upload
  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
    } catch (error) {
      socket.destroy();
      return;
    }

    if (pathname !== '/ws/upload') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const address = request.socket.remoteAddress || 'unknown';
    if (!connectionLimiter(address)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    console.log('[WSS] Client connected for WebSocket Upload session');
    let activeSession = null;
    let authenticated = !authToken;
    const authTimeout = authToken
      ? setTimeout(() => ws.close(1008, 'Authentication timeout'), authTimeoutMs)
      : null;

    const sendError = (message, relativePath = null) => {
      ws.send(JSON.stringify({
        type: 'ERROR',
        ...(relativePath ? { payload: { relativePath } } : {}),
        message
      }));
    };

    const getSessionFile = (relativePath) => {
      let normalized;
      try {
        normalized = normalizeRelativePath(relativePath);
      } catch (err) {
        return { error: 'Invalid relative path' };
      }

      if (!activeSession || !activeSession.files || !activeSession.files[normalized]) {
        return { error: 'File is not part of the active session', normalized };
      }

      try {
        const safePath = resolveSafePath(uploadsDir, normalized);
        return {
          normalized,
          fileItem: activeSession.files[normalized],
          targetPath: safePath.resolved,
          partPath: getPartPath(safePath.resolved)
        };
      } catch (err) {
        return { error: 'Invalid relative path', normalized };
      }
    };

    // Process messages in arrival order. The normal clients wait for an ACK,
    // but serializing here also prevents concurrent chunks or FINISH_FILE
    // messages from racing when a client misbehaves or reconnects quickly.
    const processMessage = async (rawMessage, isBinary) => {
      let msg;
      try {
        msg = parseWebSocketMessage(rawMessage, isBinary);
      } catch (err) {
        return ws.send(JSON.stringify({ type: 'ERROR', message: err.message }));
      }

      const { type, payload } = msg;

      if (!authenticated) {
        if (type !== 'AUTH') {
          sendError('Authentication required before starting an upload');
          return;
        }

        if (!tokensMatch(payload?.token, authToken)) {
          ws.close(1008, 'Authentication failed');
          return;
        }

        authenticated = true;
        clearTimeout(authTimeout);
        ws.send(JSON.stringify({ type: 'AUTH_OK' }));
        return;
      }

      switch (type) {
        case 'INIT_SESSION': {
          const { sessionId, files } = payload || {};
          if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
            return sendError('A non-empty sessionId is required');
          }
          if (!Array.isArray(files)) {
            return sendError('Session files must be an array');
          }
          if (files.length > maxManifestFiles) {
            return sendError(`Session contains too many files (maximum ${maxManifestFiles})`);
          }
          if (Buffer.byteLength(JSON.stringify(files), 'utf8') > maxManifestBytes) {
            return sendError(`Session manifest exceeds maximum size of ${maxManifestBytes} bytes`);
          }

          let normalizedFiles;
          try {
            const seenPaths = new Set();
            let totalBytes = 0;
            normalizedFiles = files.map(fileItem => {
              const sourceFile = fileItem || {};
              const relativePath = normalizeRelativePath(sourceFile.relativePath);
              if (seenPaths.has(relativePath)) {
                throw new Error(`Duplicate relative path: ${relativePath}`);
              }
              if (!Number.isSafeInteger(sourceFile.size) || sourceFile.size < 0) {
                throw new Error(`Invalid size for ${relativePath}`);
              }
              if (sourceFile.size > maxFileSize) {
                throw new Error(`File ${relativePath} exceeds the maximum size of ${maxFileSize} bytes`);
              }
              if (totalBytes > maxTotalBytes - sourceFile.size) {
                throw new Error(`Session exceeds the maximum total upload size of ${maxTotalBytes} bytes`);
              }
              if (isInternalUploadFile(path.posix.basename(relativePath))) {
                throw new Error(`Reserved upload path: ${relativePath}`);
              }
              const hashAlgorithm = normalizeHashAlgorithm(
                sourceFile.hashAlgorithm || (sourceFile.md5 ? 'md5' : defaultHashAlgorithm)
              );
              const hash = getFileHash(sourceFile);
              if (typeof hash !== 'string' || !new RegExp(`^[a-f0-9]{${getHashLength(hashAlgorithm)}}$`, 'i').test(hash)) {
                throw new Error(`Invalid ${hashAlgorithm} hash for ${relativePath}`);
              }
              seenPaths.add(relativePath);
              totalBytes += sourceFile.size;
              resolveSafePath(uploadsDir, relativePath);
              // Keep only server-relevant metadata. In particular, never
              // persist a client's absolute local path in server state.
              return {
                relativePath,
                size: sourceFile.size,
                hashAlgorithm,
                hash: hash.toLowerCase(),
                ...(hashAlgorithm === 'md5' ? { md5: hash.toLowerCase() } : { md5: null })
              };
            });
          } catch (err) {
            return sendError(err.message);
          }

          if (
            activeSessionOwner &&
            activeSessionOwner !== ws &&
            activeSessionId !== sessionId
          ) {
            return sendError('Another upload session is currently active');
          }
          if (activeSessionOwner && activeSessionOwner !== ws) {
            activeSessionOwner.close(1012, 'Session taken over by reconnecting client');
          }
          activeSessionOwner = ws;
          activeSessionId = sessionId;

          // The source path belongs to the client machine. Keep the server
          // state portable and do not expose a local filesystem path through
          // /api/hash/state.
          activeSession = stateManager.initSession({
            sessionId,
            sourcePath: 'websocket-upload',
            files: normalizedFiles
          });

          // Check server disk for existing files to provide resumption offsets
          const fileStatuses = {};
          for (const key in activeSession.files) {
            const fileItem = activeSession.files[key];
            const targetPath = resolveSafePath(uploadsDir, fileItem.relativePath).resolved;
            const inspected = await inspectExistingUpload(fileItem, targetPath);
            const { offset, status, serverHash } = inspected;

            stateManager.updateFile(key, {
              status,
              serverHash,
              serverMd5: fileItem.hashAlgorithm === 'md5' ? serverHash : null,
              verified: status === 'verified',
              bytesUploaded: offset,
              targetMtimeMs: inspected.targetMtimeMs,
              targetCtimeMs: inspected.targetCtimeMs,
              targetIno: inspected.targetIno,
              targetDev: inspected.targetDev,
              error: null
            });

            if (status === 'verified') {
              const targetStat = getRegularFileStat(targetPath);
              stateManager.upsertRepositoryFile({
                relativePath: key,
                size: targetStat.size,
                hash: serverHash,
                hashAlgorithm: fileItem.hashAlgorithm,
                md5: fileItem.hashAlgorithm === 'md5' ? serverHash : null,
                hashStatus: 'verified',
                createdAtMs: targetStat.birthtimeMs,
                modifiedAtMs: targetStat.mtimeMs,
                ...getTargetMetadata(targetStat)
              });
            } else {
              stateManager.deleteRepositoryFile(key);
            }

            fileStatuses[key] = {
              relativePath: fileItem.relativePath,
              size: fileItem.size,
              hashAlgorithm: fileItem.hashAlgorithm,
              hash: fileItem.hash,
              ...(fileItem.hashAlgorithm === 'md5' ? { md5: fileItem.hash } : {}),
              offset,
              status,
              serverHash,
              ...(fileItem.hashAlgorithm === 'md5' ? { serverMd5: serverHash } : {})
            };
          }

          ws.send(JSON.stringify({
            type: 'SESSION_READY',
            payload: {
              sessionId: activeSession.sessionId,
              files: fileStatuses,
              summary: stateManager.getSummary()
            }
          }));
          break;
        }

        case 'START_FILE': {
          const { relativePath } = payload || {};
          const sessionFile = getSessionFile(relativePath);
          if (sessionFile.error) {
            return sendError(sessionFile.error, relativePath);
          }

          const { normalized, fileItem, targetPath, partPath } = sessionFile;
          const targetDir = path.dirname(targetPath);

          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }

          let partStat = getRegularFileStat(partPath);
          if (fileItem.size === 0 && !partStat) {
            await writeChunkAtOffset(partPath, 0, Buffer.alloc(0), syncEachChunk);
            partStat = getRegularFileStat(partPath);
          }

          let offset = partStat ? partStat.size : 0;
          if (offset > fileItem.size) {
            removeRegularFile(partPath);
            offset = 0;
          }

          stateManager.updateFile(normalized, { status: 'uploading', bytesUploaded: offset });

          ws.send(JSON.stringify({
            type: 'FILE_STARTED',
            payload: { relativePath: normalized, offset }
          }));
          break;
        }

        case 'FILE_CHUNK': {
          const { relativePath, data, offset } = payload || {};
          const sessionFile = getSessionFile(relativePath);
          if (sessionFile.error) {
            return sendError(sessionFile.error, relativePath);
          }

          const { normalized, fileItem, partPath } = sessionFile;

          try {
            if (!Number.isInteger(offset) || offset < 0) {
              throw new Error('Invalid chunk offset');
            }
            if (!Buffer.isBuffer(data)) {
              throw new Error('Chunk data must be sent as a binary frame');
            }
            const buffer = data;
            if (buffer.length === 0 && offset < fileItem.size) {
              throw new Error('Empty chunk is not valid for a non-empty file');
            }
            if (buffer.length > maxChunkSize) {
              throw new Error(`Chunk exceeds maximum size of ${maxChunkSize} bytes`);
            }
            const partStat = getRegularFileStat(partPath);
            const currentSize = partStat ? partStat.size : 0;
            if (currentSize !== offset) {
              throw new Error(`Chunk offset ${offset} does not match server size ${currentSize}`);
            }
            if (offset + buffer.length > fileItem.size) {
              throw new Error('Chunk exceeds declared file size');
            }

            await writeChunkAtOffset(partPath, offset, buffer, syncEachChunk);

            const newOffset = offset + buffer.length;
            stateManager.updateFile(normalized, { bytesUploaded: newOffset, status: 'uploading' });

            ws.send(JSON.stringify({
              type: 'CHUNK_ACK',
              payload: { relativePath: normalized, offset: newOffset }
            }));
          } catch (err) {
            console.error(`[WSS] Error writing chunk for ${normalized}:`, err.message);
            ws.send(JSON.stringify({
              type: 'FILE_ERROR',
              payload: { relativePath: normalized, error: err.message }
            }));
          }
          break;
        }

        case 'FINISH_FILE': {
          const { relativePath, clientHash, clientMd5 } = payload || {};
          const sessionFile = getSessionFile(relativePath);
          if (sessionFile.error) {
            return sendError(sessionFile.error, relativePath);
          }

          const { normalized, fileItem, partPath, targetPath } = sessionFile;

          const partStat = getRegularFileStat(partPath);
          if (!partStat) {
            return ws.send(JSON.stringify({
              type: 'FILE_ERROR',
              payload: { relativePath: normalized, error: 'File missing on server' }
            }));
          }

          try {
            if (partStat.size !== fileItem.size) {
              throw new Error('Uploaded file size does not match manifest');
            }
            const submittedHash = clientHash || clientMd5;
            const hashLength = getHashLength(fileItem.hashAlgorithm);
            if (
              typeof submittedHash !== 'string' ||
              !new RegExp(`^[a-f0-9]{${hashLength}}$`, 'i').test(submittedHash)
            ) {
              throw new Error(`Invalid client ${fileItem.hashAlgorithm} hash`);
            }

            const normalizedClientHash = submittedHash.toLowerCase();
            if (normalizedClientHash !== fileItem.hash) {
              throw new Error('Client hash does not match the session manifest');
            }

            console.log(`[WSS] Verifying server ${fileItem.hashAlgorithm} for ${normalized}...`);
            syncFile(partPath);
            const serverHash = await calculateServerHash(partPath, fileItem.hashAlgorithm);
            const isMatch = (serverHash === fileItem.hash && serverHash === normalizedClientHash);

            if (isMatch) {
              // The final filename becomes visible only after verification.
              // A rename is atomic on the target filesystem when the final
              // path does not already exist.
              if (getRegularFileStat(targetPath)) removeRegularFile(targetPath);
              fs.renameSync(partPath, targetPath);
              const fileStat = fs.statSync(targetPath);
              stateManager.updateFile(normalized, {
                status: 'verified',
                serverHash,
                serverMd5: fileItem.hashAlgorithm === 'md5' ? serverHash : null,
                verified: true,
                bytesUploaded: fileStat.size,
                ...getTargetMetadata(fileStat),
                error: null
              });
              stateManager.upsertRepositoryFile({
                relativePath: normalized,
                size: fileStat.size,
                hash: serverHash,
                hashAlgorithm: fileItem.hashAlgorithm,
                md5: fileItem.hashAlgorithm === 'md5' ? serverHash : null,
                hashStatus: 'verified',
                createdAtMs: fileStat.birthtimeMs,
                modifiedAtMs: fileStat.mtimeMs,
                ...getTargetMetadata(fileStat)
              });

              ws.send(JSON.stringify({
                type: 'FILE_VERIFIED',
                payload: {
                  relativePath: normalized,
                  status: 'verified',
                  hashAlgorithm: fileItem.hashAlgorithm,
                  clientHash: normalizedClientHash,
                  serverHash,
                  ...(fileItem.hashAlgorithm === 'md5' ? {
                    clientMd5: normalizedClientHash,
                    serverMd5: serverHash
                  } : {}),
                  match: true,
                  summary: stateManager.getSummary()
                }
              }));
            } else {
              stateManager.updateFile(normalized, {
                status: 'failed',
                serverHash,
                serverMd5: fileItem.hashAlgorithm === 'md5' ? serverHash : null,
                verified: false,
                error: `${fileItem.hashAlgorithm.toUpperCase()} checksum mismatch`
              });

              removeRegularFile(partPath);
              stateManager.deleteRepositoryFile(normalized);

              ws.send(JSON.stringify({
                type: 'FILE_ERROR',
                payload: {
                  relativePath: normalized,
                  status: 'failed',
                  hashAlgorithm: fileItem.hashAlgorithm,
                  clientHash: normalizedClientHash,
                  serverHash,
                  ...(fileItem.hashAlgorithm === 'md5' ? {
                    clientMd5: normalizedClientHash,
                    serverMd5: serverHash
                  } : {}),
                  match: false,
                  error: `Checksum mismatch! Client: ${normalizedClientHash}, Server: ${serverHash}`
                }
              }));
            }
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'FILE_ERROR',
              payload: { relativePath: normalized, error: `Verification failed: ${err.message}` }
            }));
          }
          break;
        }

        case 'RUN_FULL_AUDIT': {
          console.log('[WSS] Running full hash audit check on server files...');
          const auditStartedAt = new Date().toISOString();
          const auditResults = [];
          let matchCount = 0;
          let mismatchCount = 0;
          let missingCount = 0;

          if (activeSession && activeSession.files) {
            for (const key in activeSession.files) {
              const fileItem = activeSession.files[key];
              const targetPath = resolveSafePath(uploadsDir, fileItem.relativePath).resolved;

              let targetStat;
              try {
                targetStat = getRegularFileStat(targetPath);
              } catch (err) {
                targetStat = null;
              }

              if (!targetStat) {
                missingCount++;
                stateManager.updateFile(key, {
                  status: 'failed',
                  serverHash: null,
                  serverMd5: null,
                  verified: false,
                  bytesUploaded: 0,
                  targetMtimeMs: null,
                  targetCtimeMs: null,
                  targetIno: null,
                  targetDev: null,
                  error: 'File missing or not a regular file'
                });
                stateManager.deleteRepositoryFile(fileItem.relativePath);
                auditResults.push({
                  relativePath: fileItem.relativePath,
                  hashAlgorithm: fileItem.hashAlgorithm,
                  clientHash: fileItem.hash,
                  serverHash: null,
                  ...(fileItem.hashAlgorithm === 'md5' ? {
                    clientMd5: fileItem.hash,
                    serverMd5: null
                  } : {}),
                  status: 'missing',
                  size: fileItem.size,
                  match: false,
                  error: 'File missing or not a regular file'
                });
                continue;
              }

              const knownHash = fileItem.serverHash || fileItem.serverMd5;
              const canReuseVerifiedHash = fileItem.status === 'verified' &&
                knownHash === fileItem.hash &&
                matchesTargetMetadata(fileItem, targetStat);
              const serverHash = canReuseVerifiedHash
                ? knownHash
                : await calculateServerHash(targetPath, fileItem.hashAlgorithm);
              const match = (serverHash === fileItem.hash.toLowerCase());

              stateManager.updateFile(key, {
                status: match ? 'verified' : 'failed',
                serverHash,
                serverMd5: fileItem.hashAlgorithm === 'md5' ? serverHash : null,
                verified: match,
                bytesUploaded: targetStat.size,
                ...getTargetMetadata(targetStat),
                error: match ? null : `${fileItem.hashAlgorithm.toUpperCase()} checksum mismatch`
              });
              stateManager.upsertRepositoryFile({
                relativePath: fileItem.relativePath,
                size: targetStat.size,
                hash: serverHash,
                hashAlgorithm: fileItem.hashAlgorithm,
                md5: fileItem.hashAlgorithm === 'md5' ? serverHash : null,
                hashStatus: match ? 'verified' : 'mismatch',
                createdAtMs: targetStat.birthtimeMs,
                modifiedAtMs: targetStat.mtimeMs,
                ...getTargetMetadata(targetStat)
              });

              if (match) matchCount++;
              else mismatchCount++;

              auditResults.push({
                relativePath: fileItem.relativePath,
                hashAlgorithm: fileItem.hashAlgorithm,
                clientHash: fileItem.hash,
                serverHash,
                ...(fileItem.hashAlgorithm === 'md5' ? {
                  clientMd5: fileItem.hash,
                  serverMd5: serverHash
                } : {}),
                status: match ? 'verified' : 'mismatch',
                size: fileItem.size,
                match
              });
            }
          }

          const auditCompletedAt = new Date().toISOString();
          stateManager.flushSave();
          stateManager.recordAudit({
            sessionId: activeSession?.sessionId || null,
            status: 'complete',
            startedAt: auditStartedAt,
            completedAt: auditCompletedAt,
            results: auditResults
          });

          ws.send(JSON.stringify({
            type: 'AUDIT_COMPLETE',
            payload: {
              totalFiles: auditResults.length,
              matchCount,
              mismatchCount,
              missingCount,
              auditResults
            }
          }));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'ERROR', message: `Unknown message type: ${type}` }));
      }
    };

    let messageQueue = Promise.resolve();
    ws.on('message', (rawMessage, isBinary) => {
      messageQueue = messageQueue
        .then(() => processMessage(rawMessage, isBinary))
        .catch(err => {
          console.error('[WSS] WebSocket message failed:', err.message);
          if (ws.readyState === WebSocket.OPEN) {
            try { sendError('WebSocket request failed'); } catch (sendErr) {}
          }
        });
    });

    ws.on('close', () => {
      if (authTimeout) clearTimeout(authTimeout);
      if (activeSessionOwner === ws) {
        activeSessionOwner = null;
        activeSessionId = null;
      }
      stateManager.flushSave();
      console.log('[WSS] Client disconnected from WebSocket Upload session');
    });
  });

  return { wss, stateManager };
}

module.exports = {
  initWebSocketServer,
  calculateServerHash,
  calculateServerMd5
};
