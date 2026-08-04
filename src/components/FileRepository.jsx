import React, { useState } from 'react';
import { Search, Grid, List, UploadCloud, Link as LinkIcon, Edit2, Download, Trash2, FileText, Image as ImageIcon, Code, Music, Video, Archive, File } from 'lucide-react';

export default function FileRepository({ files, onRefresh, onPreview, onRename, onDelete, onUploadFiles, onNotify }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('date-desc');
  const [viewMode, setViewMode] = useState('grid');
  const [isDragOver, setIsDragOver] = useState(false);

  const getCategoryIcon = (cat) => {
    switch (cat) {
      case 'image': return <ImageIcon size={28} className="text-indigo-400" />;
      case 'document': return <FileText size={28} className="text-blue-400" />;
      case 'code': return <Code size={28} className="text-emerald-400" />;
      case 'audio': return <Music size={28} className="text-purple-400" />;
      case 'video': return <Video size={28} className="text-red-400" />;
      case 'archive': return <Archive size={28} className="text-amber-400" />;
      default: return <File size={28} className="text-slate-400" />;
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const filteredFiles = files
    .filter(f => {
      if (!search) return true;
      const q = search.toLowerCase();
      return f.name.toLowerCase().includes(q) || (f.md5 && f.md5.toLowerCase().includes(q));
    })
    .sort((a, b) => {
      if (sort === 'date-desc') return new Date(b.modifiedAt) - new Date(a.modifiedAt);
      if (sort === 'date-asc') return new Date(a.modifiedAt) - new Date(b.modifiedAt);
      if (sort === 'name-asc') return a.name.localeCompare(b.name);
      if (sort === 'size-desc') return b.size - a.size;
      if (sort === 'size-asc') return a.size - b.size;
      return 0;
    });

  const handleFileInputChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      onUploadFiles(e.target.files);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUploadFiles(e.dataTransfer.files);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <header className="top-bar">
        <div className="search-box">
          <Search size={18} color="#94a3b8" />
          <input
            type="text"
            placeholder="Search files by name or MD5 checksum..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="top-actions">
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              className={`icon-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="Grid View"
            >
              <Grid size={18} />
            </button>
            <button
              className={`icon-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
              title="List View"
            >
              <List size={18} />
            </button>
          </div>

          <select className="sort-dropdown" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="date-desc">Newest First</option>
            <option value="date-asc">Oldest First</option>
            <option value="name-asc">Name (A-Z)</option>
            <option value="size-desc">Size (Largest)</option>
            <option value="size-asc">Size (Smallest)</option>
          </select>

          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            <UploadCloud size={18} /> Quick Upload
            <input type="file" multiple hidden onChange={handleFileInputChange} />
          </label>
        </div>
      </header>

      <section className="dropzone-section">
        <div
          className={`dropzone ${isDragOver ? 'dragover' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => document.getElementById('repo-file-input').click()}
        >
          <input id="repo-file-input" type="file" multiple hidden onChange={handleFileInputChange} />
          <div className="dropzone-icon">
            <UploadCloud size={48} />
          </div>
          <div className="dropzone-text">
            <h3>Drag & Drop files here or <span className="highlight">Browse</span></h3>
            <p>Supports document, image, media, and code files</p>
          </div>
        </div>
      </section>

      <div className="section-header">
        <h2>Repository Storage</h2>
        <span className="file-count-badge">{filteredFiles.length} items</span>
      </div>

      <div className={`files-container ${viewMode === 'grid' ? 'grid-layout' : 'list-layout'}`}>
        {filteredFiles.map(file => (
          <div key={file.name} className="file-card">
            <div
              className="file-card-preview"
              onClick={() => onPreview(file)}
              style={{ cursor: 'pointer' }}
            >
              {file.category === 'image' ? (
                <img src={file.url} alt={file.name} loading="lazy" />
              ) : (
                getCategoryIcon(file.category)
              )}
            </div>

            <div>
              <div
                className="file-card-name"
                onClick={() => onPreview(file)}
                style={{ cursor: 'pointer' }}
                title={file.name}
              >
                {file.name}
              </div>
              <div className="file-card-meta" style={{ marginTop: '4px' }}>
                <span>{formatBytes(file.size)}</span>
                <code>{file.md5 ? file.md5.slice(0, 8) + '...' : 'No MD5'}</code>
              </div>
            </div>

            <div className="file-card-actions">
              <button
                className="file-action-btn"
                title="Copy Link"
                onClick={() => {
                  if (!navigator.clipboard) {
                    onNotify?.('Clipboard access is unavailable', 'error');
                    return;
                  }
                  navigator.clipboard.writeText(window.location.origin + file.url)
                    .then(() => onNotify?.('Link copied!'))
                    .catch(() => onNotify?.('Could not copy link', 'error'));
                }}
              >
                <LinkIcon size={16} />
              </button>
              <button className="file-action-btn" title="Rename" onClick={() => onRename(file)}>
                <Edit2 size={16} />
              </button>
              <a href={file.url} download className="file-action-btn" title="Download">
                <Download size={16} />
              </a>
              <button className="file-action-btn" title="Delete" onClick={() => onDelete(file.name)}>
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
