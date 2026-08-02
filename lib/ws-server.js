const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const StateManager = require('./state-manager');

/**
 * Calculates MD5 hash of a local file on server using streams.
 */
function calculateServerMd5(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return resolve(null);
    }
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Initializes WebSocket Upload Server on top of existing HTTP Server.
 * @param {import('http').Server} httpServer
 * @param {string} uploadsDir
 */
function initWebSocketServer(httpServer, uploadsDir) {
  const wss = new WebSocket.Server({ noServer: true });
  const serverStatePath = path.join(uploadsDir, 'server_state.json');
  const stateManager = new StateManager(serverStatePath);

  // Load existing server state if present
  stateManager.loadState();

  // Listen for HTTP upgrade requests on /ws/upload
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname === '/ws/upload') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws) => {
    console.log('[WSS] Client connected for WebSocket Upload session');
    let activeSession = null;

    ws.on('message', async (rawMessage) => {
      let msg;
      try {
        msg = JSON.parse(rawMessage.toString());
      } catch (e) {
        return ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid JSON payload' }));
      }

      const { type, payload } = msg;

      switch (type) {
        case 'INIT_SESSION': {
          const { sessionId, sourcePath, files } = payload;
          activeSession = stateManager.initSession({ sessionId, sourcePath, files });

          // Check server disk for existing files to provide resumption offsets
          const fileStatuses = {};
          for (const key in activeSession.files) {
            const fileItem = activeSession.files[key];
            const targetPath = path.join(uploadsDir, fileItem.relativePath);

            let offset = 0;
            let status = fileItem.status || 'pending';
            let serverMd5 = fileItem.serverMd5 || null;

            if (fs.existsSync(targetPath)) {
              const stat = fs.statSync(targetPath);
              offset = stat.size;

              if (offset === fileItem.size) {
                // If sizes match, check MD5
                if (!serverMd5) {
                  serverMd5 = await calculateServerMd5(targetPath);
                }
                if (serverMd5 === fileItem.md5) {
                  status = 'verified';
                  stateManager.updateFile(key, { status: 'verified', serverMd5, verified: true, bytesUploaded: fileItem.size });
                }
              }
            }

            fileStatuses[key] = {
              relativePath: fileItem.relativePath,
              size: fileItem.size,
              md5: fileItem.md5,
              offset,
              status,
              serverMd5
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
          const { relativePath, size, clientMd5, offset = 0 } = payload;
          const targetPath = path.join(uploadsDir, relativePath);
          const targetDir = path.dirname(targetPath);

          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }

          // If offset is 0, reset file
          if (offset === 0 && fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
          }

          stateManager.updateFile(relativePath, { status: 'uploading', bytesUploaded: offset });

          ws.send(JSON.stringify({
            type: 'FILE_STARTED',
            payload: { relativePath, offset }
          }));
          break;
        }

        case 'FILE_CHUNK': {
          const { relativePath, data, offset } = payload;
          const targetPath = path.join(uploadsDir, relativePath);

          try {
            const buffer = Buffer.from(data, 'base64');
            const flags = offset === 0 ? 'w' : 'a';
            const writeStream = fs.createWriteStream(targetPath, { flags, start: offset });
            
            writeStream.write(buffer);
            writeStream.end();

            await new Promise((resolve, reject) => {
              writeStream.on('finish', resolve);
              writeStream.on('error', reject);
            });

            const newOffset = offset + buffer.length;
            stateManager.updateFile(relativePath, { bytesUploaded: newOffset, status: 'uploading' });

            ws.send(JSON.stringify({
              type: 'CHUNK_ACK',
              payload: { relativePath, offset: newOffset }
            }));
          } catch (err) {
            console.error(`[WSS] Error writing chunk for ${relativePath}:`, err.message);
            ws.send(JSON.stringify({
              type: 'FILE_ERROR',
              payload: { relativePath, error: err.message }
            }));
          }
          break;
        }

        case 'FINISH_FILE': {
          const { relativePath, clientMd5 } = payload;
          const targetPath = path.join(uploadsDir, relativePath);

          if (!fs.existsSync(targetPath)) {
            return ws.send(JSON.stringify({
              type: 'FILE_ERROR',
              payload: { relativePath, error: 'File missing on server' }
            }));
          }

          try {
            console.log(`[WSS] Verifying server MD5 for ${relativePath}...`);
            const serverMd5 = await calculateServerMd5(targetPath);
            const isMatch = (serverMd5 === clientMd5.toLowerCase());

            if (isMatch) {
              const fileStat = fs.statSync(targetPath);
              stateManager.updateFile(relativePath, {
                status: 'verified',
                serverMd5,
                verified: true,
                bytesUploaded: fileStat.size,
                error: null
              });

              ws.send(JSON.stringify({
                type: 'FILE_VERIFIED',
                payload: {
                  relativePath,
                  status: 'verified',
                  clientMd5,
                  serverMd5,
                  match: true,
                  summary: stateManager.getSummary()
                }
              }));
            } else {
              stateManager.updateFile(relativePath, {
                status: 'failed',
                serverMd5,
                verified: false,
                error: 'MD5 checksum mismatch'
              });

              ws.send(JSON.stringify({
                type: 'FILE_ERROR',
                payload: {
                  relativePath,
                  status: 'failed',
                  clientMd5,
                  serverMd5,
                  match: false,
                  error: `Checksum mismatch! Client: ${clientMd5}, Server: ${serverMd5}`
                }
              }));
            }
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'FILE_ERROR',
              payload: { relativePath, error: `Verification failed: ${err.message}` }
            }));
          }
          break;
        }

        case 'RUN_FULL_AUDIT': {
          console.log('[WSS] Running full MD5 audit check on server files...');
          const auditResults = [];
          let matchCount = 0;
          let mismatchCount = 0;
          let missingCount = 0;

          if (activeSession && activeSession.files) {
            for (const key in activeSession.files) {
              const fileItem = activeSession.files[key];
              const targetPath = path.join(uploadsDir, fileItem.relativePath);

              if (!fs.existsSync(targetPath)) {
                missingCount++;
                auditResults.push({
                  relativePath: fileItem.relativePath,
                  clientMd5: fileItem.md5,
                  serverMd5: null,
                  status: 'missing',
                  size: fileItem.size,
                  match: false
                });
                continue;
              }

              const serverMd5 = await calculateServerMd5(targetPath);
              const match = (serverMd5 === fileItem.md5.toLowerCase());

              if (match) matchCount++;
              else mismatchCount++;

              auditResults.push({
                relativePath: fileItem.relativePath,
                clientMd5: fileItem.md5,
                serverMd5,
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
      console.log('[WSS] Client disconnected from WebSocket Upload session');
    });
  });

  return { wss, stateManager };
}

module.exports = {
  initWebSocketServer,
  calculateServerMd5
};
