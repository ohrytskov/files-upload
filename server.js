const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const { initWebSocketServer, calculateServerMd5 } = require('./lib/ws-server');
const { generateHashes } = require('./lib/hash-generator');
const { normalizeFilename, resolveSafePath } = require('./lib/path-utils');
const { createAuthMiddleware, createRateLimiter, normalizeToken } = require('./lib/security');
const StateManager = require('./lib/state-manager');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const HASH_SCAN_ROOT = path.resolve(process.env.HASH_SCAN_ROOT || UPLOADS_DIR);
const AUTH_TOKEN = normalizeToken(process.env.CLOUDVAULT_AUTH_TOKEN || process.env.AUTH_TOKEN);
const md5Cache = new Map();

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage configuration for legacy HTTP uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    let originalName;
    try {
      originalName = normalizeFilename(path.basename(file.originalname.replace(/\\/g, '/')));
    } catch (err) {
      return cb(new Error('Invalid upload filename'));
    }

    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);
    let finalName = originalName;
    
    let counter = 1;
    while (fs.existsSync(path.join(UPLOADS_DIR, finalName))) {
      finalName = `${baseName}_${counter}${ext}`;
      counter++;
    }
    
    cb(null, finalName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB max limit
});

app.use(express.json({ limit: '10mb' }));
const DIST_DIR = path.join(__dirname, 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
} else {
  console.warn(`[Server] ${DIST_DIR} is missing; run "npm run build" before starting the web UI.`);
  app.use(express.static(DIST_DIR));
}
app.use('/uploads', express.static(UPLOADS_DIR));

const auth = createAuthMiddleware(AUTH_TOKEN);
app.use('/api', auth.middleware);

const uploadRateLimit = createRateLimiter({
  windowMs: Number(process.env.UPLOAD_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.UPLOAD_RATE_MAX) || 20
});
const mutationRateLimit = createRateLimiter({
  windowMs: Number(process.env.API_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.API_RATE_MAX) || 120
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

function isInternalUploadFile(filename) {
  return filename === 'server_state.json' || filename === 'server_state.json.tmp';
}

function getCachedServerMd5(filePath, stats) {
  const cacheKey = path.resolve(filePath);
  const cached = md5Cache.get(cacheKey);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    return cached.md5;
  }

  const pending = calculateServerMd5(filePath);
  md5Cache.set(cacheKey, { size: stats.size, mtimeMs: stats.mtimeMs, md5: pending });
  pending.then(md5 => {
    const current = md5Cache.get(cacheKey);
    if (current && current.md5 === pending) current.md5 = md5;
  }).catch(() => {
    const current = md5Cache.get(cacheKey);
    if (current && current.md5 === pending) md5Cache.delete(cacheKey);
  });
  return pending;
}

function invalidateMd5Cache(...filePaths) {
  filePaths.forEach(filePath => md5Cache.delete(path.resolve(filePath)));
}

// 1. Get all files with metadata & MD5 hash
app.get('/api/files', async (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    const fileList = [];

    for (const file of files) {
      if (isInternalUploadFile(file)) continue;
      const filePath = path.join(UPLOADS_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;

        const serverMd5 = await getCachedServerMd5(filePath, stats);

        fileList.push({
          name: file,
          size: stats.size,
          md5: serverMd5,
          createdAt: stats.birthtime || stats.ctime,
          modifiedAt: stats.mtime,
          category: getFileCategory(file),
          extension: path.extname(file).toLowerCase(),
          url: `/uploads/${encodeURIComponent(file)}`
        });
      } catch (e) {}
    }

    fileList.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    res.json({ files: fileList });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read uploads directory' });
  }
});

// 2. Upload multiple files via standard HTTP
app.post('/api/upload', uploadRateLimit, upload.array('files', 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files were uploaded.' });
  }

  const uploaded = req.files.map(file => {
    const filePath = path.join(UPLOADS_DIR, file.filename);
    const stats = fs.statSync(filePath);
    return {
      name: file.filename,
      size: stats.size,
      createdAt: stats.birthtime || stats.ctime,
      modifiedAt: stats.mtime,
      category: getFileCategory(file.filename),
      extension: path.extname(file.filename).toLowerCase(),
      url: `/uploads/${encodeURIComponent(file.filename)}`
    };
  });

  res.json({ message: 'Files uploaded successfully', files: uploaded });
});

// 3. Storage statistics endpoint
app.get('/api/stats', (req, res) => {
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to compute stats' });
    }

    let totalSize = 0;
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
      if (isInternalUploadFile(file)) return;
      const filePath = path.join(UPLOADS_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          const cat = getFileCategory(file);
          totalSize += stats.size;
          if (categories[cat]) {
            categories[cat].count += 1;
            categories[cat].size += stats.size;
          }
        }
      } catch (e) {}
    });

    res.json({
      totalFiles: files.length,
      totalSize,
      categories
    });
  });
});

// 4. Delete file
app.delete('/api/files/:filename', mutationRateLimit, (req, res) => {
  const filename = req.params.filename;
  let filePath;
  try {
    filePath = resolveSafePath(UPLOADS_DIR, normalizeFilename(filename)).resolved;
  } catch (err) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlink(filePath, err => {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete file' });
    }
    invalidateMd5Cache(filePath);
    res.json({ message: 'File deleted successfully', filename });
  });
});

// 5. Rename file
app.patch('/api/files/:filename', mutationRateLimit, (req, res) => {
  const oldName = req.params.filename;
  const { newName } = req.body;

  if (!newName) {
    return res.status(400).json({ error: 'New name is required' });
  }

  let oldPath;
  let newPath;
  try {
    oldPath = resolveSafePath(UPLOADS_DIR, normalizeFilename(oldName)).resolved;
    newPath = resolveSafePath(UPLOADS_DIR, normalizeFilename(newName)).resolved;
  } catch (err) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ error: 'Source file not found' });
  }

  if (fs.existsSync(newPath)) {
    return res.status(400).json({ error: 'File with target name already exists' });
  }

  fs.rename(oldPath, newPath, err => {
    if (err) {
      return res.status(500).json({ error: 'Failed to rename file' });
    }
    invalidateMd5Cache(oldPath, newPath);
    res.json({ message: 'File renamed successfully', oldName, newName });
  });
});

// 6. MD5 Scanner REST Endpoint
app.post('/api/hash/scan', uploadRateLimit, async (req, res) => {
  const { sourcePath, outputFile } = req.body;
  if (!sourcePath) {
    return res.status(400).json({ error: 'sourcePath is required' });
  }

  try {
    const source = resolveSafePath(HASH_SCAN_ROOT, path.isAbsolute(sourcePath)
      ? path.relative(HASH_SCAN_ROOT, sourcePath)
      : sourcePath);
    const safeOutputFile = outputFile
      ? resolveSafePath(HASH_SCAN_ROOT, outputFile).resolved
      : null;
    const result = await generateHashes({ sourcePath: source.resolved, outputFile: safeOutputFile });
    res.json(result);
  } catch (err) {
    res.status(403).json({ error: 'Hash scans are restricted to the configured scan directory' });
  }
});

// 7. Get Current Session State (from server state.json)
app.get('/api/hash/state', (req, res) => {
  const statePath = path.join(UPLOADS_DIR, 'server_state.json');
  const sm = new StateManager(statePath);
  const state = sm.loadState();

  if (!state) {
    return res.json({ status: 'no_session', message: 'No active upload session state found' });
  }

  res.json(state);
});

// Create HTTP Server & Bind WebSockets
const server = http.createServer(app);
const { wss, stateManager } = initWebSocketServer(server, UPLOADS_DIR, {
  authToken: AUTH_TOKEN,
  maxConnectionsPerAddress: Number(process.env.WS_CONNECTION_RATE_MAX) || 20,
  connectionRateWindowMs: Number(process.env.WS_CONNECTION_RATE_WINDOW_MS) || 60_000
});

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`⚡ WebSocket Upload Endpoint: ws://${HOST}:${PORT}/ws/upload`);
  console.log(`📁 Target Uploads Directory: ${UPLOADS_DIR}`);
});
