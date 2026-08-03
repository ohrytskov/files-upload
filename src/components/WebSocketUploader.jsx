import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, CheckCircle2, AlertCircle } from 'lucide-react';
import { md5ArrayBuffer } from '../utils/md5';

export default function WebSocketUploader({ onAuditTrigger }) {
  const [serverUrl, setServerUrl] = useState(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/upload`);
  const [manifest, setManifest] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [sessionStatus, setSessionStatus] = useState('Idle');

  // Stats
  const [stats, setStats] = useState({
    filesCount: 0,
    totalFiles: 0,
    uploadedBytes: 0,
    totalBytes: 0,
    speedMB: '0.00',
    eta: '--',
    overallPct: 0,
    activeFile: null,
    activePct: 0
  });

  const socketRef = useRef(null);
  const manifestRef = useRef(null);
  const startTimeRef = useRef(null);
  const transferredBytesRef = useRef(0);
  const lastOffsetsRef = useRef({});

  useEffect(() => {
    manifestRef.current = manifest;
  }, [manifest]);

  const handleFilesSelected = async (event) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length === 0) return;

    setIsScanning(true);
    try {
      const seenPaths = new Set();
      const files = [];
      let totalBytes = 0;

      for (const file of selectedFiles) {
        const relativePath = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
        if (seenPaths.has(relativePath)) {
          throw new Error(`Duplicate file path selected: ${relativePath}`);
        }

        seenPaths.add(relativePath);
        files.push({
          file,
          relativePath,
          size: file.size,
          md5: md5ArrayBuffer(await file.arrayBuffer()),
          status: 'pending',
          offset: 0,
          serverMd5: null
        })
        totalBytes += file.size;
      }

      const data = {
        sourcePath: 'browser-selection',
        totalFiles: files.length,
        totalBytes,
        files
      };
      manifestRef.current = data;
      setManifest(data);
      setSessionStatus('Files Hashed & Ready');
      setStats(prev => ({ ...prev, totalFiles: data.totalFiles, totalBytes: data.totalBytes }));
    } catch (error) {
      alert(error.message || 'Failed to read selected files');
    } finally {
      setIsScanning(false);
    }
  };

  const startUpload = () => {
    if (!manifestRef.current) return;

    if (isPaused && socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      setIsPaused(false);
      setSessionStatus('Uploading...');
      uploadNextFile();
      return;
    }

    setSessionStatus('Connecting...');
    const ws = new WebSocket(serverUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setIsUploading(true);
      setIsPaused(false);
      startTimeRef.current = Date.now();
      transferredBytesRef.current = 0;
      setSessionStatus('Uploading...');

      ws.send(JSON.stringify({
        type: 'INIT_SESSION',
        payload: {
          sessionId: `session_${Date.now()}`,
          sourcePath: 'browser-selection',
          files: manifestRef.current.files.map(({ file, ...fileItem }) => fileItem)
        }
      }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      } catch (err) {}
    };

    ws.onerror = () => {
      setSessionStatus('Connection Error');
    };
  };

  const handleMessage = (msg) => {
    const { type, payload } = msg;

    if (type === 'SESSION_READY') {
      const { files: serverFiles } = payload;
      const currentManifest = manifestRef.current;
      if (!currentManifest) return;
      const updated = {
        ...currentManifest,
        files: currentManifest.files.map(f => {
          const sf = serverFiles[f.relativePath];
          return {
            ...f,
            offset: sf ? sf.offset || 0 : 0,
            status: sf ? sf.status || 'pending' : 'pending',
            serverMd5: sf ? sf.serverMd5 : null
          };
        })
      };
      manifestRef.current = updated;
      setManifest(updated);
      uploadNextFile();
    } else if (type === 'FILE_STARTED') {
      sendChunk(payload.relativePath, payload.offset);
    } else if (type === 'CHUNK_ACK') {
      const { relativePath, offset } = payload;
      const previousOffset = lastOffsetsRef.current[relativePath] || 0;
      transferredBytesRef.current += Math.max(0, offset - previousOffset);
      lastOffsetsRef.current[relativePath] = offset;
      updateProgress(relativePath, offset);

      const currentManifest = manifestRef.current;
      const file = currentManifest && currentManifest.files.find(f => f.relativePath === relativePath);
      if (file && offset >= file.size) {
        socketRef.current?.send(JSON.stringify({
          type: 'FINISH_FILE',
          payload: { relativePath, clientMd5: file.md5 }
        }));
      } else {
        sendChunk(relativePath, offset);
      }
    } else if (type === 'FILE_VERIFIED') {
      const updated = {
        ...manifestRef.current,
        files: manifestRef.current.files.map(f => f.relativePath === payload.relativePath ? { ...f, status: 'verified', serverMd5: payload.serverMd5, match: true } : f)
      };
      manifestRef.current = updated;
      setManifest(updated);
      uploadNextFile();
    } else if (type === 'FILE_ERROR') {
      const updated = {
        ...manifestRef.current,
        files: manifestRef.current.files.map(f => f.relativePath === payload.relativePath ? { ...f, status: 'failed', serverMd5: payload.serverMd5 || null, match: false } : f)
      };
      manifestRef.current = updated;
      setManifest(updated);
      uploadNextFile();
    } else if (type === 'AUDIT_COMPLETE') {
      setIsUploading(false);
      setSessionStatus('Completed & Verified');
      if (onAuditTrigger) onAuditTrigger(payload);
    }
  };

  const uploadNextFile = () => {
    if (isPaused || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;

    const currentManifest = manifestRef.current;
    if (!currentManifest) return;
    const pending = currentManifest.files.find(f => f.status === 'pending' || f.status === 'uploading');

    if (!pending) {
      setSessionStatus('Running MD5 Server Audit...');
      socketRef.current.send(JSON.stringify({ type: 'RUN_FULL_AUDIT' }));
      return;
    }

    const updated = {
      ...currentManifest,
      files: currentManifest.files.map(f => f.relativePath === pending.relativePath ? { ...f, status: 'uploading' } : f)
    };
    manifestRef.current = updated;
    setManifest(updated);
    socketRef.current.send(JSON.stringify({
      type: 'START_FILE',
      payload: {
        relativePath: pending.relativePath,
        size: pending.size,
        clientMd5: pending.md5,
        offset: pending.offset || 0
      }
    }));
  };

  const sendChunk = async (relativePath, offset) => {
    if (!socketRef.current || isPaused) return;
    const fileItem = manifestRef.current?.files.find(f => f.relativePath === relativePath);
    if (!fileItem || !fileItem.file) return;

    try {
      const end = Math.min(offset + 256 * 1024, fileItem.size);
      const buffer = await fileItem.file.slice(offset, end).arrayBuffer();
      if (isPaused || socketRef.current?.readyState !== WebSocket.OPEN) return;

      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);

      socketRef.current.send(JSON.stringify({
        type: 'FILE_CHUNK',
        payload: { relativePath, offset, data: btoa(binary) }
      }));
    } catch (error) {
      alert(`Failed to read ${relativePath}: ${error.message}`);
    }
  };

  const updateProgress = (relativePath, offset) => {
    const elapsedSec = (Date.now() - startTimeRef.current) / 1000;
    const speedBps = elapsedSec > 0 ? (transferredBytesRef.current / elapsedSec) : 0;
    const speedMB = (speedBps / (1024 * 1024)).toFixed(2);

    const currentManifest = manifestRef.current;
    if (currentManifest) {
      let totalUploaded = 0;
      let completedCount = 0;
      let activeFileObj = null;

      for (const f of currentManifest.files) {
        if (f.status === 'verified') {
          completedCount++;
          totalUploaded += f.size;
        } else if (f.relativePath === relativePath) {
          activeFileObj = f;
          totalUploaded += offset;
        }
      }

      const overallPct = Math.round((totalUploaded / currentManifest.totalBytes) * 100);
      const filePct = activeFileObj ? Math.round((offset / activeFileObj.size) * 100) : 0;
      const remainingBytes = currentManifest.totalBytes - totalUploaded;
      const etaSec = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : 0;

      setStats({
        filesCount: completedCount,
        totalFiles: currentManifest.totalFiles,
        uploadedBytes: totalUploaded,
        totalBytes: currentManifest.totalBytes,
        speedMB,
        eta: etaSec > 0 ? `${Math.ceil(etaSec / 60)}m ${etaSec % 60}s` : 'Done',
        overallPct,
        activeFile: relativePath,
        activePct: filePct
      });
    }
  };

  const togglePause = () => {
    setIsPaused(prev => !prev);
    setSessionStatus(isPaused ? 'Uploading...' : 'Paused');
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div className="card">
        <h3>Select Files & Server Setup</h3>
        <p className="card-subtitle">Choose individual files or a directory. File contents are read locally by your browser.</p>

        <div className="form-grid">
          <div className="form-group">
            <label>Files or directory:</label>
            <input type="file" className="text-input" multiple webkitdirectory="true" directory="true" onChange={handleFilesSelected} />
            <small>{manifest ? `${manifest.totalFiles} file(s) selected` : 'No files selected'}</small>
          </div>

          <div className="form-group">
            <label>Remote WebSocket URL:</label>
            <input
              type="text"
              className="text-input"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="ws://localhost:3000/ws/upload"
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
          <span className="status-chip neutral">
            {isScanning ? 'Hashing selected files...' : 'Select files above to generate hashes'}
          </span>
          <button className="btn btn-primary" onClick={startUpload} disabled={!manifest || isUploading && !isPaused}>
            <Play size={16} /> {isPaused ? 'Resume Upload' : 'Start / Resume Stateful Upload'}
          </button>
          {isUploading && (
            <button className="btn btn-danger" onClick={togglePause}>
              <Pause size={16} /> {isPaused ? 'Resume' : 'Pause Upload'}
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Live Transfer Dashboard</h3>
          <span className={`status-chip ${sessionStatus.includes('Completed') ? 'success' : sessionStatus.includes('Uploading') ? 'warning' : 'neutral'}`}>
            {sessionStatus}
          </span>
        </div>

        <div className="stats-overview">
          <div className="stat-box">
            <span className="stat-label">Files Uploaded</span>
            <span className="stat-value">{stats.filesCount} / {stats.totalFiles}</span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Data Transferred</span>
            <span className="stat-value">{(stats.uploadedBytes / (1024 * 1024)).toFixed(1)} MB / {(stats.totalBytes / (1024 * 1024)).toFixed(1)} MB</span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Transfer Speed</span>
            <span className="stat-value">{stats.speedMB} MB/s</span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Est. Time Remaining</span>
            <span className="stat-value">{stats.eta}</span>
          </div>
        </div>

        <div style={{ marginTop: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '0.85rem' }}>
            <span>Overall Completion</span>
            <span>{stats.overallPct}%</span>
          </div>
          <div className="progress-bar-bg" style={{ height: '12px' }}>
            <div className="progress-bar-fill" style={{ width: `${stats.overallPct}%` }}></div>
          </div>
        </div>

        {stats.activeFile && (
          <div style={{ background: 'rgba(99, 102, 241, 0.08)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '6px' }}>
              <span>Active File: <code>{stats.activeFile}</code></span>
              <span>{stats.activePct}%</span>
            </div>
            <div className="progress-bar-bg">
              <div className="progress-bar-fill" style={{ width: `${stats.activePct}%` }}></div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>File Batch Queue & Server MD5 Status</h3>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Relative Path</th>
                <th>Size</th>
                <th>Client MD5</th>
                <th>Server MD5</th>
                <th>Status</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {manifest && manifest.files ? manifest.files.map(f => (
                <tr key={f.relativePath}>
                  <td><strong>{f.relativePath}</strong></td>
                  <td>{formatBytes(f.size)}</td>
                  <td><code>{f.md5 ? f.md5.slice(0, 10) + '...' : 'N/A'}</code></td>
                  <td><code>{f.serverMd5 ? f.serverMd5.slice(0, 10) + '...' : '--'}</code></td>
                  <td>
                    <span className={`status-chip ${f.status === 'verified' ? 'success' : f.status === 'uploading' ? 'warning' : f.status === 'failed' ? 'danger' : 'neutral'}`}>
                      {f.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {f.match ? <CheckCircle2 size={18} color="#34d399" /> : f.status === 'failed' ? <AlertCircle size={18} color="#f87171" /> : '--'}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="6" style={{ textAlign: 'center', color: '#94a3b8' }}>Click "Scan & Generate Hashes" to load target directory files.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
