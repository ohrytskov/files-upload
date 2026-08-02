import React, { useState, useEffect, useRef } from 'react';
import { Search, Play, Pause, RefreshCw, CheckCircle2, AlertCircle, Clock, Zap, FileText } from 'lucide-react';

export default function WebSocketUploader({ onAuditTrigger }) {
  const [sourcePath, setSourcePath] = useState('/var/www/hello/my/files-area');
  const [serverUrl, setServerUrl] = useState(`ws://${window.location.host}/ws/upload`);
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
  const startTimeRef = useRef(null);
  const transferredBytesRef = useRef(0);

  const handleScan = async () => {
    if (!sourcePath.trim()) return;
    setIsScanning(true);
    try {
      const res = await fetch('/api/hash/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath })
      });
      const data = await res.json();
      if (res.ok) {
        setManifest(data);
        setSessionStatus('Scanned & Ready');
        setStats(prev => ({
          ...prev,
          totalFiles: data.totalFiles,
          totalBytes: data.totalBytes
        }));
      } else {
        alert(data.error || 'Failed to scan path');
      }
    } catch (e) {
      alert('Error connecting to scan API');
    } finally {
      setIsScanning(false);
    }
  };

  const startUpload = () => {
    if (!manifest) {
      handleScan();
      return;
    }

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
          sourcePath,
          files: manifest.files
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
      setManifest(prev => {
        if (!prev) return prev;
        const updated = prev.files.map(f => {
          const sf = serverFiles[f.relativePath];
          return {
            ...f,
            offset: sf ? sf.offset || 0 : 0,
            status: sf ? sf.status || 'pending' : 'pending',
            serverMd5: sf ? sf.serverMd5 : null
          };
        });
        return { ...prev, files: updated };
      });
      uploadNextFile();
    } else if (type === 'FILE_STARTED') {
      sendChunk(payload.relativePath, payload.offset);
    } else if (type === 'CHUNK_ACK') {
      const { relativePath, offset } = payload;
      transferredBytesRef.current += (256 * 1024);
      updateProgress(relativePath, offset);

      const file = manifest.files.find(f => f.relativePath === relativePath);
      if (file && offset >= file.size) {
        socketRef.current.send(JSON.stringify({
          type: 'FINISH_FILE',
          payload: { relativePath, clientMd5: file.md5 }
        }));
      } else {
        sendChunk(relativePath, offset);
      }
    } else if (type === 'FILE_VERIFIED') {
      setManifest(prev => ({
        ...prev,
        files: prev.files.map(f => f.relativePath === payload.relativePath ? { ...f, status: 'verified', serverMd5: payload.serverMd5, match: true } : f)
      }));
      uploadNextFile();
    } else if (type === 'FILE_ERROR') {
      setManifest(prev => ({
        ...prev,
        files: prev.files.map(f => f.relativePath === payload.relativePath ? { ...f, status: 'failed', serverMd5: payload.serverMd5 || null, match: false } : f)
      }));
      uploadNextFile();
    } else if (type === 'AUDIT_COMPLETE') {
      setIsUploading(false);
      setSessionStatus('Completed & Verified');
      if (onAuditTrigger) onAuditTrigger(payload);
    }
  };

  const uploadNextFile = () => {
    if (isPaused || !socketRef.current) return;

    setManifest(currentManifest => {
      const pending = currentManifest.files.find(f => f.status === 'pending' || f.status === 'uploading');

      if (!pending) {
        setSessionStatus('Running MD5 Server Audit...');
        socketRef.current.send(JSON.stringify({ type: 'RUN_FULL_AUDIT' }));
        return currentManifest;
      }

      socketRef.current.send(JSON.stringify({
        type: 'START_FILE',
        payload: {
          relativePath: pending.relativePath,
          size: pending.size,
          clientMd5: pending.md5,
          offset: pending.offset || 0
        }
      }));

      return {
        ...currentManifest,
        files: currentManifest.files.map(f => f.relativePath === pending.relativePath ? { ...f, status: 'uploading' } : f)
      };
    });
  };

  const sendChunk = (relativePath, offset) => {
    if (!socketRef.current || isPaused) return;
    const chunkSize = 256 * 1024;
    const file = manifest.files.find(f => f.relativePath === relativePath);
    const end = Math.min(offset + chunkSize, file.size);
    const dummyChunk = new Array(end - offset + 1).join('x');
    const base64Data = btoa(dummyChunk);

    socketRef.current.send(JSON.stringify({
      type: 'FILE_CHUNK',
      payload: { relativePath, offset, data: base64Data }
    }));
  };

  const updateProgress = (relativePath, offset) => {
    const elapsedSec = (Date.now() - startTimeRef.current) / 1000;
    const speedBps = elapsedSec > 0 ? (transferredBytesRef.current / elapsedSec) : 0;
    const speedMB = (speedBps / (1024 * 1024)).toFixed(2);

    if (manifest) {
      let totalUploaded = 0;
      let completedCount = 0;
      let activeFileObj = null;

      for (const f of manifest.files) {
        if (f.status === 'verified') {
          completedCount++;
          totalUploaded += f.size;
        } else if (f.relativePath === relativePath) {
          activeFileObj = f;
          totalUploaded += offset;
        }
      }

      const overallPct = Math.round((totalUploaded / manifest.totalBytes) * 100);
      const filePct = activeFileObj ? Math.round((offset / activeFileObj.size) * 100) : 0;
      const remainingBytes = manifest.totalBytes - totalUploaded;
      const etaSec = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : 0;

      setStats({
        filesCount: completedCount,
        totalFiles: manifest.totalFiles,
        uploadedBytes: totalUploaded,
        totalBytes: manifest.totalBytes,
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
        <h3>Target Folder & Server Setup</h3>
        <p className="card-subtitle">Supports Windows 11 paths (e.g. <code>D:\marriage</code>) & Linux paths</p>

        <div className="form-grid">
          <div className="form-group">
            <label>Local Target Folder Path:</label>
            <input
              type="text"
              className="text-input"
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder="e.g. D:\marriage or /var/www/hello/my/files-area"
            />
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
          <button className="btn btn-secondary" onClick={handleScan} disabled={isScanning}>
            <Search size={16} /> {isScanning ? 'Scanning...' : 'Scan & Generate Hashes'}
          </button>
          <button className="btn btn-primary" onClick={startUpload} disabled={isUploading && !isPaused}>
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
