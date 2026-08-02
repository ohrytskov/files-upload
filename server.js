const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const { initWebSocketServer, calculateServerMd5 } = require('./lib/ws-server');
const { generateHashes } = require('./lib/hash-generator');
const StateManager = require('./lib/state-manager');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

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
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext);
    let finalName = file.originalname;
    
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

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

// 1. Get all files with metadata & MD5 hash
app.get('/api/files', async (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    const fileList = [];

    for (const file of files) {
      if (file.endsWith('.json') || file.endsWith('.tmp')) continue; // Skip state files
      const filePath = path.join(UPLOADS_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;

        const serverMd5 = await calculateServerMd5(filePath);

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
app.post('/api/upload', upload.array('files', 20), (req, res) => {
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
app.delete('/api/files/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlink(filePath, err => {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete file' });
    }
    res.json({ message: 'File deleted successfully', filename });
  });
});

// 5. Rename file
app.patch('/api/files/:filename', (req, res) => {
  const oldName = req.params.filename;
  const { newName } = req.body;

  if (!newName) {
    return res.status(400).json({ error: 'New name is required' });
  }

  const oldPath = path.join(UPLOADS_DIR, oldName);
  const newPath = path.join(UPLOADS_DIR, newName);

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
    res.json({ message: 'File renamed successfully', oldName, newName });
  });
});

// 6. MD5 Scanner REST Endpoint
app.post('/api/hash/scan', async (req, res) => {
  const { sourcePath, outputFile } = req.body;
  if (!sourcePath) {
    return res.status(400).json({ error: 'sourcePath is required' });
  }

  try {
    const result = await generateHashes({ sourcePath, outputFile });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
const { wss, stateManager } = initWebSocketServer(server, UPLOADS_DIR);

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`⚡ WebSocket Upload Endpoint: ws://localhost:${PORT}/ws/upload`);
  console.log(`📁 Target Uploads Directory: ${UPLOADS_DIR}`);
});
