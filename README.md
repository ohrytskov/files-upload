# CloudVault — Stateful WebSocket File Upload & Hash Audit Repository

A high-performance, resilient file upload and checksum verification repository built with **Node.js**, **Express**, **WebSockets (`ws`)**, and **React + Vite**.

The server persists its state in SQLite. It prefers `better-sqlite3`; on Node.js 22.5+ installations where that native binary cannot load, it automatically uses Node's built-in `node:sqlite` driver.

---

## 🌟 Key Features

1. **Configurable Hash Generator (`lib/hash-generator.js`)**:
   - Streams MD5 or SHA-256 calculation using Node `crypto` (memory-efficient for gigabyte+ files).
   - Supports **Windows 11 paths** (e.g., `D:\marriage`, `C:\Users\...`) and **Linux paths**.
   - Normalizes path slashes (`\` to `/`) for cross-platform checksum alignment.

2. **WebSocket Batch Upload with Resumption (`lib/ws-client.js` & `lib/ws-server.js`)**:
   - Chunked streaming file transfer over WebSockets.
   - **Interruption Recovery**: Persists the client session in the configured local `state.json` and the server session, repository metadata, and audit results in SQLite. If interrupted (connection drop, server crash, pause), re-running the upload resumes from the exact chunk offset without re-transferring verified files.

3. **Real-time Transfer Progress & Speed Dashboard**:
   - Live speed (MB/s), Estimated Time Remaining (ETA), uploaded files count, and byte totals.
   - Individual file chunk progress bars & overall batch completion gauge.

4. **Server-side Hash Verification & Comparison Audit**:
   - Computes the selected server-side hash upon file completion.
   - Compares client vs server hashes to guarantee data integrity; SHA-256 is the default and MD5 remains available for legacy compatibility.
   - Generates full verification audit reports.

5. **2-Module Architecture (Client & Server)**:
   - **Server Module** (`server.js`, `lib/ws-server.js`): Express + WebSocket server handling chunk writes, hash verification, state sync, and REST endpoints.
   - **Client Module** (`bin/upload-cli.js`, `lib/ws-client.js`, `src/components/WebSocketUploader.jsx`): CLI tool and interactive React dashboard.

6. **Security and Transport Controls**:
   - Optional bearer-token authentication for API, WebSocket control traffic, and uploaded-file downloads via `CLOUDVAULT_AUTH_TOKEN`.
   - Authenticated browser API requests establish a same-origin HttpOnly session cookie so image, media, preview, and download requests do not expose the token in URLs.
   - Request and WebSocket connection rate limits can be tuned with environment variables.
   - Upload chunks use binary WebSocket frames instead of base64-encoded JSON payloads.

---

## 🚀 Quick Start

### 1. Install & Start Backend
```bash
npm install
npm run build
npm start
```

Backend configuration is loaded from `.env`. The checked-in `.env.example` keeps the backend on `127.0.0.1:3001`, while the frontend is exposed separately on port `3000`. Set a non-empty `CLOUDVAULT_AUTH_TOKEN` before starting a network deployment.

The default scan root is:
```dotenv
HASH_SCAN_ROOT=./uploads
```
Copy `.env.example` when setting up another installation and change the paths as needed. Shell environment variables still take precedence over `.env`.

The backend listens internally on:
- HTTP API: `http://127.0.0.1:3001`
- WebSocket Upload Endpoint: `ws://127.0.0.1:3001/ws/upload`

### 2. Start Frontend

Run the Vite frontend in a second shell:
```bash
# Development server:
npm run dev

# Or, after `npm run build`, serve the built UI:
npm run preview
```

The frontend is pinned to `0.0.0.0:3000` and proxies `/api`, `/uploads`, and `/ws` to the internal backend. Open `http://<server-ip>:3000` from a remote laptop. Only TCP port `3000` needs to be exposed externally; keep backend port `3001` internal.

To enable authentication, set `CLOUDVAULT_AUTH_TOKEN` before starting the server. Enter the same token in the dashboard API token field or pass it to the CLI with `--token`. When authentication is enabled, `/api`, `/ws/upload`, and `/uploads` require authentication; the dashboard obtains a browser session cookie through its authenticated API requests.

### Capacity and production notes

The WebSocket uploader is the large-transfer path. It streams one bounded chunk at a time, writes to a hidden staging file, verifies the complete hash, and only then atomically publishes the final file. The default 4 MiB chunk size keeps transfer memory bounded; `WS_MAX_CHUNK_SIZE`, `WS_MAX_PAYLOAD`, `WS_MAX_MANIFEST_BYTES`, `WS_MAX_MANIFEST_FILES`, and `WS_MAX_QUEUED_MESSAGES` protect the server from oversized or backlogged requests.

This is suitable for a single host handling thousands of files and multi-gigabyte batches when the host has sufficient disk, CPU, and network capacity. It is not yet a horizontally scalable object-storage service: one Node process permits one active WebSocket upload session, the active manifest remains in memory, and an audit rereads files when its cached verification metadata is unavailable or has changed. Upload state, repository hash metadata, and audit results are persisted in SQLite at `STATE_DB_PATH` (default: `uploads/cloudvault.sqlite`). For larger or concurrent workloads, use a database/object store and a resumable protocol behind a job/session service.

For production deployments, configure a non-empty `CLOUDVAULT_AUTH_TOKEN`, terminate WebSocket traffic over TLS (`wss://`) at a reverse proxy, enforce storage quotas/free-space monitoring, back up the uploads directory and SQLite database, and test the filesystem’s rename/fsync behavior. Per-chunk fsync is disabled by default for throughput and the completed file is synced before publication; set `WS_SYNC_EACH_CHUNK=true` when stronger power-loss durability is worth the throughput cost.

### 3. Run Stateful Batch Upload via CLI
```bash
# Upload a Windows 11 path to local or remote WebSocket server:
node bin/upload-cli.js -p "D:\marriage" -s "ws://127.0.0.1:3001/ws/upload"

# Use SHA-256 and an authenticated server:
node bin/upload-cli.js -p "/data/to-upload" --algorithm sha256 --token "$CLOUDVAULT_AUTH_TOKEN"

# Generate hashes.txt manifest during upload:
node bin/upload-cli.js -p "/var/www/hello/my/files-area" -o "hashes.txt"
```

### 4. Interactive Web UI
Open `http://<server-ip>:3000` in your browser to access:
- **File Repository**: View, preview, search, download, rename, or delete uploaded files with hash tags.
- **Commander View** (the default view): Set the left and right panels to any server-local directory, including Windows drives, UNC paths, and mounted flash drives, then copy selected files or directories between them. See [local Commander copy](docs/local-copy.md).
- **WebSocket Batch Uploader**: Select local files/directories, choose MD5 or SHA-256, watch real-time speeds and progress bars, and pause/resume transfers.
- The browser uploader persists session metadata locally; after a page reload, select the same files again to resume their server-side staged upload.
- **Hash Audit Report**: Select a local directory and a configured server directory, then compare SHA-256 or MD5 hashes.

### Validation

```bash
npm run lint
npm test
npm run build
```

---

## 🛠️ CLI Usage & Options

```text
Usage: node bin/upload-cli.js --path <TargetFolderPath> [options]

Options:
  -p, --path <path>      Target folder path (Windows 11 & Linux supported)
  -s, --server <url>     WebSocket server URL (default: ws://localhost:3001/ws/upload)
  -o, --output <file>    Path to save standard hashes.txt manifest
  --state <file>         State JSON path (default: state.json for resuming)
  --token <token>        Bearer token when authentication is enabled
  --algorithm <name>     Hash algorithm: sha256 (default) or md5
```

---

## 📂 Project Structure

```text
files-upload/
├── bin/
│   └── upload-cli.js       # Command line batch uploader tool
├── lib/
│   ├── hash-generator.js   # MD5/SHA-256 streaming hash generator
│   ├── chunk-protocol.js   # Binary WebSocket chunk framing
│   ├── path-utils.js       # Upload path containment checks
│   ├── security.js         # Token auth and rate limiting
│   ├── database.js         # SQLite state, repository, and audit persistence
│   ├── state-manager.js    # Resumable state manager (JSON client / SQLite server)
│   ├── ws-client.js        # Client WebSocket chunked uploader engine
│   └── ws-server.js        # Server WebSocket upload handler & hash verification
├── src/                    # React UI source
├── dist/                   # Production UI generated by npm run build
├── uploads/                # Target upload directory
├── package.json
└── server.js               # Express + WebSocket main server
```
