# 📁 CloudVault Files Upload Repository

A full-stack file upload, storage, and repository management web application built with **Node.js** (`const fs = require('fs');`), **Express**, and **Vanilla HTML5/CSS3/JS**.

## 🌟 Key Features

- ⚡ **Node.js `fs` Integration**: Uses native Node file system operations for listing, reading, stats, renaming, and removing files.
- 🎨 **Sleek Glassmorphism Dark UI**: Vibrant indigo accents, modern typography, responsive layout, dark mode aesthetic.
- 📥 **Interactive Drag & Drop**: Multi-file dropzone with real-time upload progress bars and status indicators.
- 🔍 **Filtering & Search**: Live file search, category filtering (Images, Docs, Code, Audio, Video, Archives), and sorting options (Date, Name, Size).
- 👁️ **Built-in File Previews**: Image lightbox, audio/video players, text/code syntax view, and metadata tags.
- 📊 **Storage Meter**: Live storage usage tracker and category quota dashboard.

## 🚀 Quick Start

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start the Server**:
   ```bash
   npm start
   ```
   Or run in dev mode with auto-reload:
   ```bash
   npm run dev
   ```

3. **Access the Web Application**:
   Open `http://localhost:3000` in your web browser.

## 📂 Repository Architecture

```
files-upload/
├── server.js            # Node.js backend using fs, express, and multer
├── package.json         # Project dependencies & scripts
├── README.md            # Repository documentation
├── uploads/             # Physical storage directory for uploaded files
└── public/              # Client-side web application
    ├── index.html       # HTML layout & DOM structure
    ├── style.css        # Responsive CSS & design tokens
    └── app.js           # Interactive UI controller & API integration
```

## 🔌 API Endpoints

- `GET /api/files` - List all uploaded files with stats and metadata.
- `POST /api/upload` - Upload single or multiple files (up to 100MB each).
- `GET /api/stats` - Get storage consumption and category counts.
- `PATCH /api/files/:filename` - Rename a file.
- `DELETE /api/files/:filename` - Permanently delete a file from storage.
