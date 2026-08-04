import React, { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import FileRepository from './components/FileRepository';
import WebSocketUploader from './components/WebSocketUploader';
import MD5AuditReport from './components/MD5AuditReport';
import PreviewModal from './components/PreviewModal';
import RenameModal from './components/RenameModal';
import { apiFetch, getAuthToken, setAuthToken } from './utils/api';

export default function App() {
  const [activeTab, setActiveTab] = useState('repository');
  const [files, setFiles] = useState([]);
  const [stats, setStats] = useState(null);
  const [authToken, setAuthTokenState] = useState(getAuthToken);
  const [toast, setToast] = useState(null);

  // Modals
  const [previewFile, setPreviewFile] = useState(null);
  const [renameFile, setRenameFile] = useState(null);

  const notify = (message, type = 'success') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 3500);
  };

  const handleAuthTokenChange = (token) => {
    setAuthToken(token);
    setAuthTokenState(token.trim());
  };

  const fetchFiles = async () => {
    try {
      const res = await apiFetch('/api/files');
      const data = await res.json();
      if (res.ok) setFiles(data.files || []);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await apiFetch('/api/stats');
      const data = await res.json();
      if (res.ok) setStats(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchFiles();
    fetchStats();
  }, []);

  const handleUploadFiles = async (fileList) => {
    const formData = new FormData();
    for (let i = 0; i < fileList.length; i++) {
      formData.append('files', fileList[i]);
    }

    try {
      const res = await apiFetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        const data = await res.json();
        notify(`Uploaded ${data.files?.length || fileList.length} file(s).`);
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

      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      <RenameModal file={renameFile} onClose={() => setRenameFile(null)} onSave={handleRenameFile} />
      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}
    </div>
  );
}
