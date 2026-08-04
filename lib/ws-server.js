const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const StateManager = require('./state-manager');
const { normalizeHashAlgorithm } = require('./hash-generator');
const { normalizeRelativePath, resolveSafePath } = require('./path-utils');
const { createConnectionLimiter, normalizeToken, tokensMatch } = require('./security');
const { parseWebSocketMessage } = require('./chunk-protocol');

const MAX_CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * Calculates a local file hash on the server using streams.
 */
function calculateServerHash(filePath, algorithm = 'md5') {
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

/**
 * Initializes WebSocket Upload Server on top of existing HTTP Server.
 * @param {import('http').Server} httpServer
 * @param {string} uploadsDir
 */
function initWebSocketServer(httpServer, uploadsDir, options = {}) {
  const wss = new WebSocket.Server({
    noServer: true,
    maxPayload: 10 * 1024 * 1024
  });
  const serverStatePath = path.join(uploadsDir, 'server_state.json');
  const stateManager = new StateManager(serverStatePath);
  const authToken = normalizeToken(options.authToken);
  const connectionLimiter = createConnectionLimiter({
    windowMs: options.connectionRateWindowMs || 60_000,
    max: options.maxConnectionsPerAddress || 20
  });

  // Load existing server state if present
  stateManager.loadState();

  // Listen for HTTP upgrade requests on /ws/upload
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname === '/ws/upload') {
      const address = request.socket.remoteAddress || 'unknown';
      if (!connectionLimiter(address)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws) => {
    console.log('[WSS] Client connected for WebSocket Upload session');
    let activeSession = null;
    let authenticated = !authToken;
    const authTimeout = authToken
      ? setTimeout(() => ws.close(1008, 'Authentication timeout'), 5_000)
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
        return {
          normalized,
          fileItem: activeSession.files[normalized],
          targetPath: resolveSafePath(uploadsDir, normalized).resolved
        };
      } catch (err) {
        return { error: 'Invalid relative path', normalized };
      }
    };

    ws.on('message', async (rawMessage, isBinary) => {
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
          const { sessionId, sourcePath, files } = payload || {};
          if (!Array.isArray(files)) {
            return sendError('Session files must be an array');
          }

          let normalizedFiles;
          try {
            const seenPaths = new Set();
            normalizedFiles = files.map(fileItem => {
              const sourceFile = fileItem || {};
              const relativePath = normalizeRelativePath(sourceFile.relativePath);
              if (seenPaths.has(relativePath)) {
                throw new Error(`Duplicate relative path: ${relativePath}`);
              }
              if (!Number.isInteger(sourceFile.size) || sourceFile.size < 0) {
                throw new Error(`Invalid size for ${relativePath}`);
              }
              const hashAlgorithm = normalizeHashAlgorithm(sourceFile.hashAlgorithm || 'md5');
              const hash = getFileHash(sourceFile);
              if (typeof hash !== 'string' || !new RegExp(`^[a-f0-9]{${getHashLength(hashAlgorithm)}}$`, 'i').test(hash)) {
                throw new Error(`Invalid ${hashAlgorithm} hash for ${relativePath}`);
              }
              seenPaths.add(relativePath);
              resolveSafePath(uploadsDir, relativePath);
              return {
                ...sourceFile,
                relativePath,
                hashAlgorithm,
                hash: hash.toLowerCase(),
                ...(hashAlgorithm === 'md5' ? { md5: hash.toLowerCase() } : { md5: null })
              };
            });
          } catch (err) {
            return sendError(err.message);
          }

          activeSession = stateManager.initSession({ sessionId, sourcePath, files: normalizedFiles });

          // Check server disk for existing files to provide resumption offsets
          const fileStatuses = {};
          for (const key in activeSession.files) {
            const fileItem = activeSession.files[key];
            const targetPath = resolveSafePath(uploadsDir, fileItem.relativePath).resolved;

            let offset = 0;
            let status = fileItem.status || 'pending';
            let serverHash = fileItem.serverHash || fileItem.serverMd5 || null;

            if (!fs.existsSync(targetPath)) {
              status = 'pending';
              serverHash = null;
            } else {
              const stat = fs.statSync(targetPath);
              offset = stat.size;

              if (offset > fileItem.size) {
                fs.unlinkSync(targetPath);
                offset = 0;
                status = 'pending';
                serverHash = null;
              }

              if (offset === fileItem.size && fs.existsSync(targetPath)) {
                // Recalculate even when state has a cached hash: the file may
                // have changed while keeping the same byte length.
                serverHash = await calculateServerHash(targetPath, fileItem.hashAlgorithm);
                if (serverHash === fileItem.hash) {
                  status = 'verified';
                  stateManager.updateFile(key, {
                    status: 'verified',
                    serverHash,
                    serverMd5: fileItem.hashAlgorithm === 'md5' ? serverHash : null,
                    verified: true,
                    bytesUploaded: fileItem.size
                  });
                } else {
                  fs.unlinkSync(targetPath);
                  offset = 0;
                  status = 'pending';
                  serverHash = null;
                }
              }
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

          const { normalized, fileItem, targetPath } = sessionFile;
          const targetDir = path.dirname(targetPath);

          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }

          if (fileItem.size === 0 && !fs.existsSync(targetPath)) {
            fs.writeFileSync(targetPath, Buffer.alloc(0));
          }

          let offset = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
          if (offset > fileItem.size) {
            fs.unlinkSync(targetPath);
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

          const { normalized, fileItem, targetPath } = sessionFile;

          try {
            if (!Number.isInteger(offset) || offset < 0) {
              throw new Error('Invalid chunk offset');
            }
            if (!Buffer.isBuffer(data)) {
              throw new Error('Chunk data must be sent as a binary frame');
            }
            const buffer = data;
            if (buffer.length > MAX_CHUNK_SIZE) {
              throw new Error(`Chunk exceeds maximum size of ${MAX_CHUNK_SIZE} bytes`);
            }
            const currentSize = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
            if (currentSize !== offset) {
              throw new Error(`Chunk offset ${offset} does not match server size ${currentSize}`);
            }
            if (offset + buffer.length > fileItem.size) {
              throw new Error('Chunk exceeds declared file size');
            }

            const flags = offset === 0 ? 'w' : 'r+';
            const writeStream = fs.createWriteStream(targetPath, { flags, start: offset });

            await new Promise((resolve, reject) => {
              writeStream.on('finish', resolve);
              writeStream.on('error', reject);
              writeStream.end(buffer);
            });

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

          const { normalized, fileItem, targetPath } = sessionFile;

          if (!fs.existsSync(targetPath)) {
            return ws.send(JSON.stringify({
              type: 'FILE_ERROR',
              payload: { relativePath: normalized, error: 'File missing on server' }
            }));
          }

          try {
            if (fs.statSync(targetPath).size !== fileItem.size) {
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
            const serverHash = await calculateServerHash(targetPath, fileItem.hashAlgorithm);
            const isMatch = (serverHash === fileItem.hash && serverHash === normalizedClientHash);

            if (isMatch) {
              const fileStat = fs.statSync(targetPath);
              stateManager.updateFile(normalized, {
                status: 'verified',
                serverHash,
                serverMd5: fileItem.hashAlgorithm === 'md5' ? serverHash : null,
                verified: true,
                bytesUploaded: fileStat.size,
                error: null
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

              fs.unlinkSync(targetPath);

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
          const auditResults = [];
          let matchCount = 0;
          let mismatchCount = 0;
          let missingCount = 0;

          if (activeSession && activeSession.files) {
            for (const key in activeSession.files) {
              const fileItem = activeSession.files[key];
              const targetPath = resolveSafePath(uploadsDir, fileItem.relativePath).resolved;

              if (!fs.existsSync(targetPath)) {
                missingCount++;
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
                  match: false
                });
                continue;
              }

              const serverHash = await calculateServerHash(targetPath, fileItem.hashAlgorithm);
              const match = (serverHash === fileItem.hash.toLowerCase());

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
    });

    ws.on('close', () => {
      if (authTimeout) clearTimeout(authTimeout);
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
