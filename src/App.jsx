import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import FileRepository from './components/FileRepository';
import WebSocketUploader from './components/WebSocketUploader';
import MD5AuditReport from './components/MD5AuditReport';
import PreviewModal from './components/PreviewModal';
import RenameModal from './components/RenameModal';
import { apiFetch, getAuthToken, setAuthToken } from './utils/api';
import { hashFile } from './utils/md5';
import { DEFAULT_HASH_ALGORITHM } from './config';

export default function App() {
  const [activeTab, setActiveTab] = useState('repository');
  const [files, setFiles] = useState([]);
  const [stats, setStats] = useState(null);
  const [authToken, setAuthTokenState] = useState(getAuthToken);
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  // Modals
  const [previewFile, setPreviewFile] = useState(null);
  const [renameFile, setRenameFile] = useState(null);

  const notify = (message, type = 'success') => {
    const allowedTypes = new Set(['success', 'info', 'warning', 'error']);
    const normalizedType = allowedTypes.has(type) ? type : 'info';
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, type: normalizedType });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3500);
  };

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  const fetchFiles = async () => {
    try {
      const res = await apiFetch('/api/files');
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setFiles(data.files || []);
      } else {
        notify(data.error || 'Could not load repository files', 'error');
      }
    } catch (err) {
      console.error(err);
      notify('Could not load repository files', 'error');
    }
  };

  const fetchStats = async () => {
    try {
      const res = await apiFetch('/api/stats');
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStats(data);
      } else {
        notify(data.error || 'Could not load storage statistics', 'error');
      }
    } catch (err) {
      console.error(err);
      notify('Could not load storage statistics', 'error');
    }
  };

  const handleAuthTokenChange = (token) => {
    const normalizedToken = token.trim();
    setAuthToken(token);
    setAuthTokenState(normalizedToken);

    if (normalizedToken) {
      fetchFiles();
      fetchStats();
    } else {
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    }
  };

  useEffect(() => {
    fetchFiles();
    fetchStats();
  }, []);

  const handleUploadFiles = async (fileList) => {
    const formData = new FormData();
    const files = Array.from(fileList || []);
    const uploadAlgorithm = DEFAULT_HASH_ALGORITHM;

    if (files.length === 0) {
      notify('Select at least one file before uploading.', 'warning');
      return;
    }

    try {
      const clientHashes = [];
      for (const file of files) {
        clientHashes.push(await hashFile(file, uploadAlgorithm));
      }
      formData.append('algorithm', uploadAlgorithm);
      formData.append('clientHashes', JSON.stringify(clientHashes));
      for (const file of files) {
        formData.append('files', file);
      }
    } catch (err) {
      notify(`Could not hash selected files: ${err.message}`, 'error');
      return;
    }

    try {
      const res = await apiFetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        const data = await res.json();
        notify(`Uploaded ${data.files?.length || files.length} file(s).`);
        fetchFiles();
        fetchStats();
      } else {
        const err = await res.json();
        notify(err.error || 'Upload failed', 'error');
      }
    } catch (e) {
      notify('Upload error', 'error');
    }
  };

  const handleDeleteFile = async (filename) => {
    if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;
    try {
      const res = await apiFetch(`/api/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      if (res.ok) {
        notify(`Deleted ${filename}.`);
        fetchFiles();
        fetchStats();
      } else {
        const data = await res.json();
        notify(data.error || 'Failed to delete file', 'error');
      }
    } catch (e) {
      notify('Failed to delete file', 'error');
    }
  };

  const handleRenameFile = async (oldName, newName) => {
    try {
      const res = await apiFetch(`/api/files/${encodeURIComponent(oldName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName })
      });
      if (res.ok) {
        setRenameFile(null);
        notify(`Renamed ${oldName} to ${newName}.`);
        fetchFiles();
      } else {
        const data = await res.json();
        notify(data.error || 'Rename failed', 'error');
      }
    } catch (e) {
      notify('Error renaming file', 'error');
    }
  };

  return (
    <div className="app-container">
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        stats={stats}
        authToken={authToken}
        onAuthTokenChange={handleAuthTokenChange}
      />

      <main className="main-content">
        {activeTab === 'repository' && (
          <FileRepository
            files={files}
            onRefresh={() => { fetchFiles(); fetchStats(); }}
            onPreview={(f) => setPreviewFile(f)}
            onRename={(f) => setRenameFile(f)}
            onDelete={handleDeleteFile}
            onUploadFiles={handleUploadFiles}
            onNotify={notify}
          />
        )}

        {activeTab === 'ws-uploader' && (
          <WebSocketUploader onAuditTrigger={() => setActiveTab('hash-audit')} authToken={authToken} onNotify={notify} />
        )}

        {activeTab === 'hash-audit' && (
          <MD5AuditReport onNotify={notify} />
        )}
      </main>

      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} onNotify={notify} />
      <RenameModal file={renameFile} onClose={() => setRenameFile(null)} onSave={handleRenameFile} onNotify={notify} />
      {toast && (
        <div
          className={`toast toast-${toast.type}`}
          role={toast.type === 'error' ? 'alert' : 'status'}
          aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            className="toast-dismiss"
            aria-label="Dismiss message"
            onClick={() => {
              if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
              toastTimerRef.current = null;
              setToast(null);
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
