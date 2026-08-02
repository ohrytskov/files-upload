# CloudVault — Stateful WebSocket MD5 File Upload & Hash Audit Repository

A high-performance, resilient file upload and MD5 checksum verification repository built with **Node.js**, **Express**, **WebSockets (`ws`)**, and **Vanilla JavaScript**.

---

## 🌟 Key Features

1. **MD5 Hash Generator (`lib/hash-generator.js`)**:
   - Streams MD5 calculation using Node `crypto` module (Memory-efficient for gigabyte+ files).
   - Supports **Windows 11 paths** (e.g., `D:\marriage`, `C:\Users\...`) and **Linux paths**.
   - Normalizes path slashes (`\` to `/`) for cross-platform checksum alignment.

2. **WebSocket Batch Upload with Resumption (`lib/ws-client.js` & `lib/ws-server.js`)**:
   - Chunked streaming file transfer over WebSockets.
   - **Interruption Recovery (`state.json`)**: Persists session upload state locally and on server. If interrupted (connection drop, server crash, pause), re-running the upload resumes from the exact chunk offset without re-transferring verified files.

3. **Real-time Transfer Progress & Speed Dashboard**:
   - Live speed (MB/s), Estimated Time Remaining (ETA), uploaded files count, and byte totals.
   - Individual file chunk progress bars & overall batch completion gauge.

4. **Server-side MD5 Verification & Comparison Audit**:
   - Computes server-side MD5 checksum upon file completion.
   - Compares client vs server MD5 hashes to guarantee 100% data integrity.
   - Generates full verification audit reports.

5. **2-Module Architecture (Client & Server)**:
   - **Server Module** (`server.js`, `lib/ws-server.js`): Express + WebSocket server handling chunk writes, hash verification, state sync, and REST endpoints.
   - **Client Module** (`bin/upload-cli.js`, `lib/ws-client.js`, `public/ws-uploader-ui.js`): CLI tool and interactive Web Dashboard.

---

## 🚀 Quick Start

### 1. Install & Start Server
```bash
npm install
npm start
```
Server runs on:
- Web Interface: `http://localhost:3000`
- WebSocket Upload Endpoint: `ws://localhost:3000/ws/upload`

### 2. Run Stateful Batch Upload via CLI
```bash
# Upload a Windows 11 path to local or remote WebSocket server:
node bin/upload-cli.js -p "D:\marriage" -s "ws://localhost:3000/ws/upload"

# Generate hashes.txt manifest during upload:
node bin/upload-cli.js -p "/var/www/hello/my/files-area" -o "hashes.txt"
```

### 3. Interactive Web UI
Open `http://localhost:3000` in your browser to access:
- **File Repository**: View, preview, search, download, rename, or delete uploaded files with MD5 tags.
- **WebSocket Batch Uploader**: Scan target local paths, watch real-time speeds & progress bars, pause/resume transfers.
- **MD5 Audit Report**: View side-by-side Client MD5 vs Server Computed MD5 verification status.

---

## 🛠️ CLI Usage & Options

```text
Usage: node bin/upload-cli.js --path <TargetFolderPath> [options]

Options:
  -p, --path <path>      Target folder path (Windows 11 & Linux supported)
  -s, --server <url>     WebSocket server URL (default: ws://localhost:3000/ws/upload)
  -o, --output <file>    Path to save standard hashes.txt manifest
  --state <file>         State JSON path (default: state.json for resuming)
```

---

## 📂 Project Structure

```text
files-upload/
├── bin/
│   └── upload-cli.js       # Command line batch uploader tool
├── lib/
│   ├── hash-generator.js   # MD5 streaming hash generator (Windows & Linux)
│   ├── state-manager.js    # Persistent state.json manager for interruption recovery
│   ├── ws-client.js        # Client WebSocket chunked uploader engine
│   └── ws-server.js        # Server WebSocket upload handler & MD5 verification
├── public/
│   ├── index.html          # Web UI layout with tabs
│   ├── style.css           # Modern dark UI theme with state chips & dashboards
│   ├── app.js              # Repository manager script
│   └── ws-uploader-ui.js   # Browser WebSocket uploader & audit interface
├── uploads/                # Target upload directory
├── package.json
└── server.js               # Express + WebSocket main server
```
