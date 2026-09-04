const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const config = require('./lib/config');
const { initWebSocketServer, calculateServerHash } = require('./lib/ws-server');
const { generateHashes, normalizeHashAlgorithm } = require('./lib/hash-generator');
const { isInternalUploadFile, normalizeFilename, normalizeRelativePath, resolveSafePath } = require('./lib/path-utils');
const { copyLocalEntries, listLocalDirectory } = require('./lib/local-filesystem');
const {
  clearAuthCookie,
  createAuthMiddleware,
  createRateLimiter,
  normalizeToken
} = require('./lib/security');

const app = express();
const PORT = config.port;
const UPLOADS_DIR = config.uploadsDir;
const HASH_SCAN_ROOT = config.hashScanRoot;
const STATE_DB_PATH = path.resolve(config.stateDbPath);
const AUTH_TOKEN = normalizeToken(config.authToken);
const hashCache = new Map();
let serverStateManager = null;
let auditPromise = null;
const PART_SUFFIX = '.cloudvault-part';
const ACTIVE_UPLOAD_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.js', '.mjs', '.cjs', '.css', '.svg', '.xml'
]);

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function isInternalStoragePath(filePath) {
  const resolved = path.resolve(filePath);
  return isInternalUploadFile(path.basename(resolved)) || [
    STATE_DB_PATH,
    `${STATE_DB_PATH}-wal`,
    `${STATE_DB_PATH}-shm`,
    `${STATE_DB_PATH}-journal`
  ].includes(resolved);
}

if (!AUTH_TOKEN && !isLoopbackHost(config.host)) {
  throw new Error('CLOUDVAULT_AUTH_TOKEN must be configured when HOST is not loopback-only');
}

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage configuration for legacy HTTP uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  // Do not choose the user-visible name until the upload is complete. The
  // final name is reserved atomically in finalizeHttpUploads().
  filename: (req, file, cb) => cb(null, `.${crypto.randomUUID()}.cloudvault-http-part`)
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: config.httpUploadMaxFileSize,
    files: config.httpUploadMaxFiles
  }
});

function reserveHttpUploadName(tempPath, originalName) {
  let normalizedName;
  try {
    normalizedName = normalizeFilename(path.basename(originalName.replace(/\\/g, '/')));
    if (isInternalUploadFile(normalizedName)) {
      const error = new Error('Reserved upload filename');
      error.code = 'RESERVED_UPLOAD_FILENAME';
      throw error;
    }
  } catch (error) {
    if (error.code === 'RESERVED_UPLOAD_FILENAME') throw error;
    throw new Error('Invalid upload filename');
  }

  const ext = path.extname(normalizedName);
  const baseName = path.basename(normalizedName, ext);
  let counter = 0;

  while (true) {
    const candidate = counter === 0
      ? normalizedName
      : `${baseName}_${counter}${ext}`;
    const candidatePath = path.join(UPLOADS_DIR, candidate);
    if (isInternalStoragePath(candidatePath)) {
      const error = new Error('Reserved upload filename');
      error.code = 'RESERVED_UPLOAD_FILENAME';
      throw error;
    }

    let reserved = false;
    try {
      // The temporary upload and final name are on the same filesystem. A
      // hard-link reservation makes the collision check atomic and avoids
      // rename-overwrite races between concurrent multipart requests.
      fs.linkSync(tempPath, candidatePath);
      reserved = true;
      fs.unlinkSync(tempPath);
      return candidate;
    } catch (error) {
      if (reserved) {
        try { fs.unlinkSync(candidatePath); } catch (rollbackError) {}
      }
      if (error.code === 'EEXIST') {
        counter += 1;
        continue;
      }
      throw error;
    }
  }
}

function finalizeHttpUploads(files = []) {
  for (const file of files) {
    const tempPath = file.path || path.join(UPLOADS_DIR, file.filename);
    const finalName = reserveHttpUploadName(tempPath, file.originalname || '');
    file.filename = finalName;
    file.path = path.join(UPLOADS_DIR, finalName);
  }
}

function cleanupUploadedFiles(files = []) {
  for (const file of files) {
    if (!file?.filename) continue;
    try { fs.unlinkSync(path.join(UPLOADS_DIR, file.filename)); } catch (err) {}
  }
}

function handleHttpUpload(req, res, next) {
  upload.array('files', config.httpUploadMaxFiles)(req, res, err => {
    if (err) {
      cleanupUploadedFiles(req.files);
      const status = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT' ? 413 : 400;
      return res.status(status).json({ error: err.message || 'Invalid upload request' });
    }

    try {
      finalizeHttpUploads(req.files || []);
    } catch (finalizeError) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ error: finalizeError.message || 'Invalid upload filename' });
    }
    next();
  });
}

app.use(express.json({ limit: config.jsonBodyLimit }));
const auth = createAuthMiddleware(AUTH_TOKEN);
const DIST_DIR = path.join(__dirname, 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
} else {
  console.warn(`[Server] ${DIST_DIR} is missing; run "npm run build" before starting the web UI.`);
  app.use(express.static(DIST_DIR));
}
app.use('/uploads', auth.middleware, (req, res, next) => {
  let relativePath;
  try {
    relativePath = decodeURIComponent(req.path).replace(/^\/+/, '');
    const safePath = resolveSafePath(UPLOADS_DIR, relativePath);
    if (isInternalStoragePath(safePath.resolved)) {
      return res.status(404).end();
    }
    next();
  } catch (err) {
    res.status(400).json({ error: 'Invalid upload path' });
  }
}, express.static(UPLOADS_DIR, {
  setHeaders(response, filePath) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (ACTIVE_UPLOAD_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`
      );
    }
  }
}));

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res, req);
  res.status(204).end();
});

app.use('/api', auth.middleware);

const uploadRateLimit = createRateLimiter({
  windowMs: config.uploadRateWindowMs,
  max: config.uploadRateMax
});
const mutationRateLimit = createRateLimiter({
  windowMs: config.apiRateWindowMs,
  max: config.apiRateMax
});

// File Category Helper
function getFileCategory(filename) {
  const ext = path.extname(filename).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'];
  const docExts = ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.csv', '.xlsx', '.pptx'];
  const audioExts = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];
  const videoExts = ['.mp4', '.webm', '.mkv', '.avi', '.mov'];
  const codeExts = ['.js', '.json', '.html', '.css', '.py', '.java', '.cpp', '.c', '.ts', '.sh', '.php'];
  const archiveExts = ['.zip', '.tar', '.gz', '.7z', '.rar'];

  if (imageExts.includes(ext)) return 'image';
  if (docExts.includes(ext)) return 'document';
  if (audioExts.includes(ext)) return 'audio';
  if (videoExts.includes(ext)) return 'video';
  if (codeExts.includes(ext)) return 'code';
  if (archiveExts.includes(ext)) return 'archive';
  return 'other';
}

function encodeUploadUrl(relativePath) {
  return `/uploads/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

async function collectUploadFiles() {
  const files = [];
  const pending = [{ directory: UPLOADS_DIR, relativeDirectory: '' }];
  let visitedEntries = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.promises.readdir(current.directory, { withFileTypes: true });

    for (const entry of entries) {
      visitedEntries += 1;
      if (isInternalUploadFile(entry.name)) continue;
      const relativePath = current.relativeDirectory
        ? `${current.relativeDirectory}/${entry.name}`
        : entry.name;
      const filePath = path.join(current.directory, entry.name);

      if (isInternalStoragePath(filePath)) continue;
      if (entry.isDirectory()) {
        pending.push({ directory: filePath, relativeDirectory: relativePath });
      } else if (entry.isFile()) {
        const stats = await fs.promises.lstat(filePath);
        if (!stats.isSymbolicLink()) files.push({ relativePath, filePath, stats });
      }

      if (visitedEntries % 128 === 0) await yieldToEventLoop();
    }
  }

  return files;
}

function resolveUploadFile(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const safePath = resolveSafePath(UPLOADS_DIR, normalized);
  if (isInternalStoragePath(safePath.resolved)) {
    throw new Error('Internal upload files cannot be modified');
  }
  return {
    normalized,
    resolved: safePath.resolved
  };
}

function getPartPath(filePath) {
  return `${filePath}${PART_SUFFIX}`;
}

function moveFileNoReplace(oldPath, newPath) {
  // fs.rename() replaces an existing destination on POSIX. A hard link is an
  // exclusive destination reservation on the same filesystem, so the move
  // cannot overwrite a file created after the caller's existence check.
  fs.linkSync(oldPath, newPath);
  try {
    fs.unlinkSync(oldPath);
  } catch (error) {
    try { fs.unlinkSync(newPath); } catch (rollbackError) {}
    throw error;
  }
}

function getRegularFileStat(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  return stat;
}

function removePartFile(filePath) {
  const partPath = getPartPath(filePath);
  const stat = getRegularFileStat(partPath);
  if (stat) fs.unlinkSync(partPath);
}

function movePartFile(oldPath, newPath) {
  const oldPartPath = getPartPath(oldPath);
  const newPartPath = getPartPath(newPath);
  const oldStat = getRegularFileStat(oldPartPath);
  if (!oldStat) return false;
  if (getRegularFileStat(newPartPath)) throw new Error('A staged upload already exists at the target name');
  fs.mkdirSync(path.dirname(newPartPath), { recursive: true });
  moveFileNoReplace(oldPartPath, newPartPath);
  return true;
}

function matchesRepositoryMetadata(record, stats) {
  if (!record) return false;
  return Number(record.size) === stats.size &&
    Number(record.targetMtimeMs) === stats.mtimeMs &&
    Number(record.targetCtimeMs) === stats.ctimeMs &&
    Number(record.targetIno) === stats.ino &&
    Number(record.targetDev) === stats.dev;
}

function matchesStateMetadata(record, stats) {
  if (!record) return false;
  return Number(record.size) === stats.size &&
    Number(record.targetMtimeMs) === stats.mtimeMs &&
    Number(record.targetCtimeMs) === stats.ctimeMs &&
    Number(record.targetIno) === stats.ino &&
    Number(record.targetDev) === stats.dev;
}

function matchesFileFingerprint(record, stats) {
  if (!record) return false;
  return Number(record.size) === stats.size &&
    Number(record.mtimeMs) === stats.mtimeMs &&
    Number(record.ctimeMs) === stats.ctimeMs &&
    Number(record.ino) === stats.ino &&
    Number(record.dev) === stats.dev;
}

function resolveHashScanPath(sourcePath) {
  const root = path.resolve(HASH_SCAN_ROOT);
  const requested = sourcePath.trim().replace(/\\/g, '/');
  const candidate = path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : path.resolve(root, requested);

  if (candidate === root) {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink()) throw new Error('Hash scan root cannot be a symbolic link');
    return { normalized: '.', resolved: root };
  }

  return resolveSafePath(root, path.relative(root, candidate));
}

async function collectHashDirectories() {
  const root = path.resolve(HASH_SCAN_ROOT);
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Hash scan root must be a real directory');
  }

  const directories = [{ value: '.', label: '.' }];
  const pending = [{ absolutePath: root, relativePath: '' }];
  let visitedEntries = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.promises.readdir(current.absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      visitedEntries += 1;
      if (entry.isDirectory()) {
        const relativePath = current.relativePath
          ? `${current.relativePath}/${entry.name}`
          : entry.name;
        const absolutePath = path.join(current.absolutePath, entry.name);
        const entryStat = await fs.promises.lstat(absolutePath);
        if (!entryStat.isSymbolicLink() && entryStat.isDirectory()) {
          directories.push({ value: relativePath, label: relativePath });
          pending.push({ absolutePath, relativePath });
        }
      }
      if (visitedEntries % 128 === 0) await yieldToEventLoop();
    }
  }

  directories.sort((a, b) => a.value.localeCompare(b.value));
  return directories;
}

function getCachedServerHash(filePath, stats, algorithm) {
  const normalizedAlgorithm = normalizeHashAlgorithm(algorithm);
  const cacheKey = `${normalizedAlgorithm}:${path.resolve(filePath)}`;
  const cached = hashCache.get(cacheKey);
  if (cached && matchesFileFingerprint(cached, stats)) {
    return cached.hash;
  }

  const pending = calculateServerHash(filePath, normalizedAlgorithm);
  hashCache.set(cacheKey, {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    ino: stats.ino,
    dev: stats.dev,
    hash: pending
  });
  pending.then(hash => {
    const current = hashCache.get(cacheKey);
    if (current && current.hash === pending) current.hash = hash;
  }).catch(() => {
    const current = hashCache.get(cacheKey);
    if (current && current.hash === pending) hashCache.delete(cacheKey);
  });
  return pending;
}

function invalidateHashCache(...filePaths) {
  filePaths.forEach(filePath => {
    const resolved = path.resolve(filePath);
    hashCache.delete(`md5:${resolved}`);
    hashCache.delete(`sha256:${resolved}`);
  });
}

function getLocalFilesystemErrorStatus(error) {
  if (['INVALID_PATH', 'INVALID_ENTRY', 'INVALID_OPTION', 'NOT_DIRECTORY', 'SAME_DIRECTORY', 'DESTINATION_INSIDE_SOURCE', 'SYMBOLIC_LINK', 'UNSUPPORTED_ENTRY'].includes(error?.code)) {
    return 400;
  }
  if (error?.code === 'NOT_FOUND') return 404;
  if (error?.code === 'PERMISSION_DENIED') return 403;
  return 500;
}

function sendLocalFilesystemError(response, error, fallbackMessage) {
  const status = getLocalFilesystemErrorStatus(error);
  const message = status === 500 ? fallbackMessage : error.message;
  return response.status(status).json({ error: message });
}

// Local Commander filesystem operations intentionally work outside the upload
// directory so a server running on Windows can copy between drive letters and
// a server running on Linux can copy to/from mounted removable media. The API
// is behind the same authentication middleware as every other /api route.
app.get('/api/local/list', async (req, res) => {
  try {
    const requestedPath = Array.isArray(req.query.path) ? null : (req.query.path || '.');
    const listing = await listLocalDirectory(requestedPath);
    res.json(listing);
  } catch (error) {
    sendLocalFilesystemError(res, error, 'Failed to list local directory');
  }
});

app.post('/api/local/copy', mutationRateLimit, async (req, res) => {
  const { sourcePath, destinationPath, entries, overwrite = false } = req.body || {};
  try {
    const result = await copyLocalEntries({
      sourcePath,
      destinationPath,
      entries,
      overwrite
    });
    res.json({
      message: result.errors.length > 0
        ? 'Local copy completed with errors'
        : 'Local copy completed successfully',
      ...result
    });
  } catch (error) {
    sendLocalFilesystemError(res, error, 'Failed to copy local entries');
  }
});

// 1. Get all files with metadata & verified hash when available
app.get('/api/files', async (req, res) => {
  try {
    const includeHashValue = String(req.query.includeHash || '').toLowerCase();
    const requestedAlgorithmValue = String(req.query.algorithm || '').toLowerCase();
    const hashRequestedByAlgorithm = ['md5', 'sha256'].includes(requestedAlgorithmValue);
    const hashRequestedByValue = ['md5', 'sha256'].includes(includeHashValue);
    const includeHash = ['1', 'true', 'yes'].includes(includeHashValue) ||
      hashRequestedByAlgorithm || hashRequestedByValue;
    // Keep includeHash=1 backwards-compatible with the original MD5 listing,
    // while allowing Commander View to request a fresh SHA-256 listing.
    let requestedHashAlgorithm = null;
    if (includeHash) {
      try {
        requestedHashAlgorithm = normalizeHashAlgorithm(
          requestedAlgorithmValue || (hashRequestedByValue ? includeHashValue : 'md5')
        );
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
    const files = await collectUploadFiles();
    const fileList = [];

    for (const file of files) {
      const stateFile = serverStateManager?.state?.files?.[file.relativePath];
      const repositoryFile = serverStateManager?.getRepositoryFile(file.relativePath);
      let serverHash = null;
      let hashAlgorithm = null;
      let hashStatus = 'unknown';
      const stateAlgorithm = stateFile?.hashAlgorithm || (stateFile?.md5 ? 'md5' : null);

      if (
        repositoryFile &&
        matchesRepositoryMetadata(repositoryFile, file.stats) &&
        repositoryFile.hash &&
        (!requestedHashAlgorithm || repositoryFile.hashAlgorithm === requestedHashAlgorithm)
      ) {
        serverHash = repositoryFile.hash;
        hashAlgorithm = repositoryFile.hashAlgorithm;
        hashStatus = repositoryFile.hashStatus || 'unknown';
      } else if (
        stateFile?.status === 'verified' &&
        stateAlgorithm &&
        (!requestedHashAlgorithm || stateAlgorithm === requestedHashAlgorithm) &&
        matchesStateMetadata(stateFile, file.stats)
      ) {
        serverHash = stateFile.serverHash || stateFile.serverMd5 || null;
        hashAlgorithm = stateAlgorithm;
        hashStatus = serverHash ? 'verified' : 'unknown';
      } else if (includeHash) {
        serverHash = await getCachedServerHash(file.filePath, file.stats, requestedHashAlgorithm);
        hashAlgorithm = requestedHashAlgorithm;
        hashStatus = serverHash ? 'server-only' : 'unknown';
        if (serverHash) {
          serverStateManager?.upsertRepositoryFile({
            relativePath: file.relativePath,
            size: file.stats.size,
            hash: serverHash,
            hashAlgorithm: requestedHashAlgorithm,
            md5: requestedHashAlgorithm === 'md5' ? serverHash : null,
            hashStatus,
            createdAtMs: file.stats.birthtimeMs,
            modifiedAtMs: file.stats.mtimeMs,
            targetMtimeMs: file.stats.mtimeMs,
            targetCtimeMs: file.stats.ctimeMs,
            targetIno: file.stats.ino,
            targetDev: file.stats.dev
          });
        }
      } else if (repositoryFile) {
        hashStatus = 'stale';
      }

      fileList.push({
        name: file.relativePath,
        relativePath: file.relativePath,
        size: file.stats.size,
        hash: serverHash,
        hashAlgorithm,
        md5: hashAlgorithm === 'md5' ? serverHash : null,
        hashStatus,
        createdAt: file.stats.birthtime || file.stats.ctime,
        modifiedAt: file.stats.mtime,
        category: getFileCategory(file.relativePath),
        extension: path.extname(file.relativePath).toLowerCase(),
        url: encodeUploadUrl(file.relativePath)
      });
    }

    fileList.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    res.json({ files: fileList });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read uploads directory' });
  }
});

// 2. Upload multiple files via standard HTTP. This remains a convenience path
// for small files; bulk/resumable transfers use the WebSocket uploader.
app.post('/api/upload', uploadRateLimit, handleHttpUpload, async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files were uploaded.' });
  }

  let hashAlgorithm;
  try {
    // Requests from older clients that submit clientHashes without an
    // algorithm are MD5 requests. New clients default to SHA-256.
    hashAlgorithm = normalizeHashAlgorithm(
      req.body?.algorithm || (req.body?.clientHashes ? 'md5' : 'sha256')
    );
  } catch (err) {
    for (const file of req.files) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, file.filename)); } catch (cleanupErr) {}
    }
    return res.status(400).json({ error: err.message });
  }

  let clientHashes = null;
  if (req.body?.clientHashes) {
    try {
      clientHashes = JSON.parse(req.body.clientHashes);
      if (!Array.isArray(clientHashes) || clientHashes.length !== req.files.length) {
        throw new Error(`clientHashes must contain one ${hashAlgorithm.toUpperCase()} value per uploaded file`);
      }
      const hashLength = hashAlgorithm === 'sha256' ? 64 : 32;
      const hashPattern = new RegExp(`^[a-f0-9]{${hashLength}}$`, 'i');
      if (clientHashes.some(hash => typeof hash !== 'string' || !hashPattern.test(hash))) {
        throw new Error(`clientHashes contains an invalid ${hashAlgorithm.toUpperCase()} value`);
      }
    } catch (err) {
      for (const file of req.files) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, file.filename)); } catch (cleanupErr) {}
      }
      return res.status(400).json({ error: err.message });
    }
  }

  const uploaded = [];
  try {
    for (let index = 0; index < req.files.length; index += 1) {
      const file = req.files[index];
      const filePath = path.join(UPLOADS_DIR, file.filename);
      const stats = fs.statSync(filePath);
      const serverHash = hashAlgorithm === 'md5'
        ? await getCachedServerHash(filePath, stats, 'md5')
        : await calculateServerHash(filePath, hashAlgorithm);
      const expectedHash = clientHashes ? clientHashes[index].toLowerCase() : null;

      if (expectedHash && expectedHash !== serverHash) {
        throw new Error(`${hashAlgorithm.toUpperCase()} checksum mismatch for ${file.originalname}`);
      }

      serverStateManager?.upsertRepositoryFile({
        relativePath: file.filename,
        size: stats.size,
        hash: serverHash,
        hashAlgorithm,
        md5: hashAlgorithm === 'md5' ? serverHash : null,
        hashStatus: expectedHash ? 'verified' : 'server-only',
        createdAtMs: stats.birthtimeMs,
        modifiedAtMs: stats.mtimeMs,
        targetMtimeMs: stats.mtimeMs,
        targetCtimeMs: stats.ctimeMs,
        targetIno: stats.ino,
        targetDev: stats.dev
      });

      uploaded.push({
        name: file.filename,
        relativePath: file.filename,
        size: stats.size,
        hash: serverHash,
        hashAlgorithm,
        md5: hashAlgorithm === 'md5' ? serverHash : null,
        hashStatus: expectedHash ? 'verified' : 'server-only',
        createdAt: stats.birthtime || stats.ctime,
        modifiedAt: stats.mtime,
        category: getFileCategory(file.filename),
        extension: path.extname(file.filename).toLowerCase(),
        url: encodeUploadUrl(file.filename)
      });
    }
  } catch (err) {
    for (const file of req.files) {
      const filePath = path.join(UPLOADS_DIR, file.filename);
      try {
        fs.unlinkSync(filePath);
        invalidateHashCache(filePath);
      } catch (cleanupErr) {}
      serverStateManager?.deleteRepositoryFile(file.filename);
    }
    serverStateManager?.flushSave();
    return res.status(422).json({ error: err.message });
  }

  res.json({ message: 'Files uploaded successfully', files: uploaded });
});

// 3. Storage statistics endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const files = await collectUploadFiles();
    let totalSize = 0;
    let totalFiles = 0;
    const categories = {
      image: { count: 0, size: 0 },
      document: { count: 0, size: 0 },
      audio: { count: 0, size: 0 },
      video: { count: 0, size: 0 },
      code: { count: 0, size: 0 },
      archive: { count: 0, size: 0 },
      other: { count: 0, size: 0 }
    };

    files.forEach(file => {
      totalFiles += 1;
      const cat = getFileCategory(file.relativePath);
      totalSize += file.stats.size;
      if (categories[cat]) {
        categories[cat].count += 1;
        categories[cat].size += file.stats.size;
      }
    });

    res.json({
      totalFiles,
      totalSize,
      categories
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

// 4. Delete file
app.delete('/api/files/:filename(*)', mutationRateLimit, (req, res) => {
  const filename = req.params.filename;
  let filePath;
  let normalizedFilename;
  try {
    const resolved = resolveUploadFile(filename);
    normalizedFilename = resolved.normalized;
    filePath = resolved.resolved;
  } catch (err) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  if (!getRegularFileStat(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlink(filePath, err => {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete file' });
    }
    invalidateHashCache(filePath);
    try { removePartFile(filePath); } catch (partError) {
      console.error('[Server] Failed to remove staged upload after delete:', partError.message);
    }
    serverStateManager?.deleteRepositoryFile(normalizedFilename);
    serverStateManager?.markTrackedFileDeleted(normalizedFilename);
    serverStateManager?.flushSave();
    res.json({ message: 'File deleted successfully', filename: normalizedFilename });
  });
});

// 5. Rename file
app.patch('/api/files/:filename(*)', mutationRateLimit, (req, res) => {
  const oldName = req.params.filename;
  const { newName } = req.body || {};

  if (!newName) {
    return res.status(400).json({ error: 'New name is required' });
  }

  let oldPath;
  let newPath;
  let normalizedOldName;
  let normalizedNewName;
  try {
    const oldFile = resolveUploadFile(oldName);
    normalizedOldName = oldFile.normalized;
    oldPath = oldFile.resolved;
    const requestedNewName = normalizeRelativePath(newName);
    normalizedNewName = requestedNewName.includes('/')
      ? requestedNewName
      : path.posix.join(path.posix.dirname(normalizedOldName), requestedNewName);
    newPath = resolveUploadFile(normalizedNewName).resolved;
  } catch (err) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  if (!getRegularFileStat(oldPath)) {
    return res.status(404).json({ error: 'Source file not found' });
  }

  if (fs.existsSync(newPath)) {
    return res.status(400).json({ error: 'File with target name already exists' });
  }
  if (serverStateManager?.state?.files?.[normalizedNewName]) {
    return res.status(400).json({ error: 'A tracked upload already exists at the target name' });
  }

  fs.mkdir(path.dirname(newPath), { recursive: true }, mkdirErr => {
    if (mkdirErr) {
      return res.status(500).json({ error: 'Failed to prepare rename destination' });
    }
    let finalMoved = false;
    let partMoved = false;
    try {
      moveFileNoReplace(oldPath, newPath);
      finalMoved = true;
      partMoved = movePartFile(oldPath, newPath);
    } catch (err) {
      if (partMoved) {
        try { moveFileNoReplace(getPartPath(newPath), getPartPath(oldPath)); } catch (rollbackError) {}
      }
      if (finalMoved) {
        try { moveFileNoReplace(newPath, oldPath); } catch (rollbackError) {}
      }
      if (err.code === 'EEXIST') {
        return res.status(400).json({ error: 'File with target name already exists' });
      }
      return res.status(500).json({ error: 'Failed to rename file' });
    }

    try {
      serverStateManager?.renameRepositoryFile(normalizedOldName, normalizedNewName);
      serverStateManager?.renameTrackedFile(normalizedOldName, normalizedNewName);
      serverStateManager?.flushSave();
      invalidateHashCache(oldPath, newPath);
      res.json({ message: 'File renamed successfully', oldName: normalizedOldName, newName: normalizedNewName });
    } catch (renameError) {
      if (partMoved) {
        try { moveFileNoReplace(getPartPath(newPath), getPartPath(oldPath)); } catch (rollbackError) {}
      }
      if (finalMoved) {
        try { moveFileNoReplace(newPath, oldPath); } catch (rollbackError) {}
      }
      return res.status(500).json({ error: 'Failed to finalize file rename' });
    }
  });
});

// 6. Hash Scanner REST Endpoint
app.post('/api/hash/scan', uploadRateLimit, async (req, res) => {
  const { sourcePath, outputFile, algorithm = config.defaultHashAlgorithm } = req.body || {};
  if (!sourcePath) {
    return res.status(400).json({ error: 'sourcePath is required' });
  }

  try {
    const source = resolveHashScanPath(sourcePath);
    const safeOutputFile = outputFile
      ? resolveSafePath(HASH_SCAN_ROOT, outputFile).resolved
      : null;
    if (safeOutputFile && isInternalStoragePath(safeOutputFile)) {
      throw new Error('Reserved output filename');
    }

    const result = await generateHashes({
      sourcePath: source.resolved,
      outputFile: safeOutputFile,
      algorithm,
      excludeFile: filePath => isInternalStoragePath(filePath)
    });
    // Absolute server paths are useful to the CLI but should not be returned
    // by an authenticated browser API. Keep the scan response portable and
    // avoid disclosing the server filesystem layout.
    res.json({
      ...result,
      sourcePath: source.normalized,
      normalizedSource: source.normalized,
      files: result.files.map(({ absolutePath, ...file }) => file)
    });
  } catch (err) {
    res.status(403).json({ error: 'Hash scans are restricted to the configured scan directory' });
  }
});

app.get('/api/hash/directories', async (req, res) => {
  try {
    res.json({
      root: path.basename(HASH_SCAN_ROOT) || 'configured root',
      directories: await collectHashDirectories()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list configured hash directories' });
  }
});

// 7. Get current upload session state from SQLite
app.get('/api/hash/state', (req, res) => {
  const state = serverStateManager?.state;

  if (!state) {
    return res.json({ status: 'no_session', message: 'No active upload session state found' });
  }

  res.json(state);
});

async function runManifestAudit() {
  const state = serverStateManager?.state;
  if (!state || !state.files) {
    return { status: 'no_session', totalFiles: 0, matchCount: 0, mismatchCount: 0, missingCount: 0, results: [] };
  }

  const results = [];
  const startedAt = new Date().toISOString();
  let matchCount = 0;
  let mismatchCount = 0;
  let missingCount = 0;

  for (const key of Object.keys(state.files)) {
    const fileItem = state.files[key];
    const relativePath = fileItem.relativePath || key;
    const algorithm = fileItem.hashAlgorithm || (fileItem.md5 ? 'md5' : config.defaultHashAlgorithm);
    const clientHash = fileItem.hash || fileItem.md5 || null;
    let targetPath;

    try {
      targetPath = resolveUploadFile(relativePath).resolved;
      const stats = fs.lstatSync(targetPath);
      if (!stats.isFile() || stats.size !== fileItem.size) {
        throw new Error('missing or incorrect file size');
      }

      const serverHash = await calculateServerHash(targetPath, algorithm);
      const match = Boolean(clientHash && serverHash === clientHash.toLowerCase());
      if (match) matchCount++;
      else mismatchCount++;

      serverStateManager.updateFile(relativePath, {
        status: match ? 'verified' : 'failed',
        serverHash,
        serverMd5: algorithm === 'md5' ? serverHash : null,
        verified: match,
        bytesUploaded: stats.size,
        targetMtimeMs: stats.mtimeMs,
        targetCtimeMs: stats.ctimeMs,
        targetIno: stats.ino,
        targetDev: stats.dev,
        error: match ? null : `${algorithm.toUpperCase()} checksum mismatch`
      });
      serverStateManager.upsertRepositoryFile({
        relativePath,
        size: stats.size,
        hash: serverHash,
        hashAlgorithm: algorithm,
        md5: algorithm === 'md5' ? serverHash : null,
        hashStatus: match ? 'verified' : 'mismatch',
        createdAtMs: stats.birthtimeMs,
        modifiedAtMs: stats.mtimeMs,
        targetMtimeMs: stats.mtimeMs,
        targetCtimeMs: stats.ctimeMs,
        targetIno: stats.ino,
        targetDev: stats.dev
      });

      results.push({
        relativePath,
        hashAlgorithm: algorithm,
        clientHash,
        serverHash,
        ...(algorithm === 'md5' ? { clientMd5: clientHash, serverMd5: serverHash } : {}),
        status: match ? 'verified' : 'mismatch',
        size: stats.size,
        match
      });
    } catch (err) {
      missingCount++;
      serverStateManager.updateFile(relativePath, {
        status: 'failed',
        serverHash: null,
        serverMd5: null,
        verified: false,
        bytesUploaded: 0,
        targetMtimeMs: null,
        targetCtimeMs: null,
        targetIno: null,
        targetDev: null,
        error: err.message
      });
      serverStateManager.deleteRepositoryFile(relativePath);
      results.push({
        relativePath,
        hashAlgorithm: algorithm,
        clientHash,
        serverHash: null,
        ...(algorithm === 'md5' ? { clientMd5: clientHash, serverMd5: null } : {}),
        status: 'missing',
        size: fileItem.size,
        match: false,
        error: err.message
      });
    }
  }

  const completedAt = new Date().toISOString();
  serverStateManager.flushSave();
  serverStateManager.recordAudit({
    sessionId: state.sessionId,
    status: 'complete',
    startedAt,
    completedAt,
    results
  });
  return {
    status: 'complete',
    totalFiles: results.length,
    matchCount,
    mismatchCount,
    missingCount,
    results
  };
}

app.post('/api/hash/audit', uploadRateLimit, async (req, res) => {
  try {
    if (!auditPromise) {
      auditPromise = runManifestAudit().finally(() => {
        auditPromise = null;
      });
    }
    res.json(await auditPromise);
  } catch (err) {
    res.status(500).json({ error: 'Manifest audit failed' });
  }
});

// Keep malformed JSON and oversized JSON requests in the API's response
// format instead of allowing Express's HTML error page to leak through.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON request body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }
  console.error('[Server] Unhandled request error:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP Server & Bind WebSockets
const server = http.createServer(app);
const { wss, stateManager } = initWebSocketServer(server, UPLOADS_DIR, {
  authToken: AUTH_TOKEN,
  maxConnectionsPerAddress: config.wsConnectionRateMax,
  connectionRateWindowMs: config.wsConnectionRateWindowMs,
  maxPayload: config.wsMaxPayload,
  maxChunkSize: config.wsMaxChunkSize,
  maxFileSize: config.wsMaxFileSize,
  maxTotalBytes: config.wsMaxTotalBytes,
  maxManifestBytes: config.wsMaxManifestBytes,
  maxManifestFiles: config.wsMaxManifestFiles,
  maxQueuedMessages: config.wsMaxQueuedMessages,
  authTimeoutMs: config.wsAuthTimeoutMs,
  syncEachChunk: config.wsSyncEachChunk,
  defaultHashAlgorithm: config.defaultHashAlgorithm,
  databasePath: config.stateDbPath
});
serverStateManager = stateManager;

const HOST = config.host;

let shuttingDown = false;
let shutdownFinished = false;
let forceExitTimer = null;

function finishShutdown(error = null) {
  if (shutdownFinished) return;
  shutdownFinished = true;
  if (forceExitTimer) clearTimeout(forceExitTimer);

  try {
    serverStateManager?.close();
  } catch (closeError) {
    console.error('[Server] Failed to close persisted state:', closeError.message);
    error = error || closeError;
  }

  if (error) {
    console.error('[Server] Shutdown completed with an error:', error.message);
    process.exitCode = 1;
  }
  process.exit();
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] Received ${signal}; stopping new work and flushing state...`);

  try { serverStateManager?.flushSave(); } catch (error) {
    console.error('[Server] Failed to flush state during shutdown:', error.message);
  }

  for (const client of wss.clients) {
    try { client.close(1001, 'Server shutting down'); } catch (error) {}
  }
  try { wss.close(); } catch (error) {}
  server.close(error => finishShutdown(error));
  server.closeIdleConnections?.();

  forceExitTimer = setTimeout(() => {
    for (const client of wss.clients) {
      try { client.terminate(); } catch (error) {}
    }
    server.closeAllConnections?.();
    finishShutdown(new Error('Shutdown timed out'));
  }, 10_000);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`⚡ WebSocket Upload Endpoint: ws://${HOST}:${PORT}/ws/upload`);
  console.log(`📁 Target Uploads Directory: ${UPLOADS_DIR}`);
});
