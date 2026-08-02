import React, { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import FileRepository from './components/FileRepository';
import WebSocketUploader from './components/WebSocketUploader';
import MD5AuditReport from './components/MD5AuditReport';
import PreviewModal from './components/PreviewModal';
import RenameModal from './components/RenameModal';

export default function App() {
  const [activeTab, setActiveTab] = useState('repository');
  const [files, setFiles] = useState([]);
  const [stats, setStats] = useState(null);

  // Modals
  const [previewFile, setPreviewFile] = useState(null);
  const [renameFile, setRenameFile] = useState(null);

  const fetchFiles = async () => {
    try {
      const res = await fetch('/api/files');
      const data = await res.json();
      if (res.ok) setFiles(data.files || []);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/stats');
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
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        fetchFiles();
        fetchStats();
      } else {
        const err = await res.json();
        alert(err.error || 'Upload failed');
      }
    } catch (e) {
      alert('Upload error');
    }
  };

  const handleDeleteFile = async (filename) => {
    if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      if (res.ok) {
        fetchFiles();
        fetchStats();
      }
    } catch (e) {
      alert('Failed to delete file');
    }
  };

  const handleRenameFile = async (oldName, newName) => {
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(oldName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName })
      });
      if (res.ok) {
        setRenameFile(null);
        fetchFiles();
      } else {
        const data = await res.json();
        alert(data.error || 'Rename failed');
      }
    } catch (e) {
      alert('Error renaming file');
    }
  };

  return (
    <div className="app-container">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} stats={stats} />

      <main className="main-content">
        {activeTab === 'repository' && (
          <FileRepository
            files={files}
            onRefresh={() => { fetchFiles(); fetchStats(); }}
            onPreview={(f) => setPreviewFile(f)}
            onRename={(f) => setRenameFile(f)}
            onDelete={handleDeleteFile}
            onUploadFiles={handleUploadFiles}
          />
        )}

        {activeTab === 'ws-uploader' && (
          <WebSocketUploader onAuditTrigger={() => setActiveTab('hash-audit')} />
        )}

        {activeTab === 'hash-audit' && (
          <MD5AuditReport />
        )}
      </main>

      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      <RenameModal file={renameFile} onClose={() => setRenameFile(null)} onSave={handleRenameFile} />
    </div>
  );
}
