import { useEffect, useMemo, useState } from 'react';
import {
  Search, Grid, List, UploadCloud, Link as LinkIcon, Edit2, Download, Trash2,
  FileText, Image as ImageIcon, Code, Music, Video, Archive, File,
  Pause, Play, X, LoaderCircle
} from 'lucide-react';
import { REPOSITORY_PAGE_SIZE } from '../config';
import { BrowserStatefulDownloader } from '../utils/browser-stateful-download';
import { BrowserStatefulUploader } from '../utils/browser-stateful-uploader';
import { getAuthToken } from '../utils/api';

export default function FileRepository({ files, onRefresh, onPreview, onRename, onDelete, onUploadFiles, onNotify }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('date-desc');
  const [viewMode, setViewMode] = useState('grid');
  const [isDragOver, setIsDragOver] = useState(false);
  const [page, setPage] = useState(1);
  const [uploadManager, setUploadManager] = useState(null);
  const [uploadState, setUploadState] = useState(null);
  const [downloadManager, setDownloadManager] = useState(null);
  const [downloadState, setDownloadState] = useState(null);
  const PAGE_SIZE = REPOSITORY_PAGE_SIZE;

function getDisplayedHash(file) {
  return file.hash || file.md5 || null;
}

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
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const filteredFiles = useMemo(() => files
    .filter(f => {
      if (!search) return true;
      const q = search.toLowerCase();
      const hash = getDisplayedHash(f);
      return f.name.toLowerCase().includes(q) || (hash && hash.toLowerCase().includes(q));
    })
    .slice()
    .sort((a, b) => {
      if (sort === 'date-desc') return new Date(b.modifiedAt) - new Date(a.modifiedAt);
      if (sort === 'date-asc') return new Date(a.modifiedAt) - new Date(b.modifiedAt);
      if (sort === 'name-asc') return a.name.localeCompare(b.name);
      if (sort === 'size-desc') return b.size - a.size;
      if (sort === 'size-asc') return a.size - b.size;
      return 0;
    }), [files, search, sort]);

  const pageCount = Math.max(1, Math.ceil(filteredFiles.length / PAGE_SIZE));
  const visibleFiles = filteredFiles.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [search, sort]);

  useEffect(() => {
    setPage(currentPage => Math.min(currentPage, pageCount));
  }, [pageCount]);

  const startStatefulUpload = (selectedFiles) => {
    if (!selectedFiles || selectedFiles.length === 0) {
      onNotify?.('No files were selected for upload.', 'info');
      return;
    }

    const token = getAuthToken();
    const uploader = new BrowserStatefulUploader({
      files: selectedFiles,
      authToken: token,
      onProgress: (state) => setUploadState({ ...state }),
      onFileComplete: () => {
        onRefresh?.();
      },
      onComplete: (state) => {
        setUploadState({ ...state });
        onNotify?.(`Stateful upload completed! Uploaded ${state.filesUploaded} file(s).`, 'success');
        onRefresh?.();
        setTimeout(() => {
          setUploadManager(null);
          setUploadState(null);
        }, 3000);
      },
      onError: (err) => {
        onNotify?.(`Upload error: ${err.message}`, 'error');
      }
    });

    setUploadManager(uploader);
    uploader.start();
  };

  const startStatefulDownload = (file) => {
    if (downloadManager && downloadState && !['completed', 'failed', 'cancelled'].includes(downloadState.status)) {
      onNotify?.('Another download is currently in progress.', 'warning');
      return;
    }

    const token = getAuthToken();
    const downloader = new BrowserStatefulDownloader({
      file,
      authToken: token,
      onProgress: (state) => setDownloadState({ ...state }),
      onComplete: (state) => {
        setDownloadState({ ...state });
        onNotify?.(`Downloaded "${file.name}" successfully!`, 'success');
        setTimeout(() => {
          setDownloadManager(null);
          setDownloadState(null);
        }, 3000);
      },
      onError: (err) => {
        onNotify?.(`Download error: ${err.message}`, 'error');
      }
    });

    setDownloadManager(downloader);
    downloader.start();
  };

  const handleFileInputChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      startStatefulUpload(e.target.files);
    } else {
      onNotify?.('No files were selected for upload.', 'info');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      startStatefulUpload(e.dataTransfer.files);
    } else {
      onNotify?.('Drop one or more files to upload them.', 'warning');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <header className="top-bar">
        <div className="search-box">
          <Search size={18} color="#94a3b8" />
            <input
              type="text"
              placeholder="Search files by name or hash..."
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
            <UploadCloud size={18} /> Quick Upload (small files)
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
          <input
            id="repo-file-input"
            type="file"
            multiple
            hidden
            onClick={event => event.stopPropagation()}
            onChange={handleFileInputChange}
          />
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
        {visibleFiles.map(file => (
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
                <code>{getDisplayedHash(file) ? getDisplayedHash(file).slice(0, 8) + '...' : file.hashStatus === 'unknown' ? 'Not audited' : 'No hash'}</code>
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
                    .then(() => onNotify?.('Link copied!', 'success'))
                    .catch(() => onNotify?.('Could not copy link', 'error'));
                }}
              >
                <LinkIcon size={16} />
              </button>
              <button className="file-action-btn" title="Rename" onClick={() => onRename(file)}>
                <Edit2 size={16} />
              </button>
              <button className="file-action-btn" title="Download (resumable)" onClick={() => startStatefulDownload(file)}>
                <Download size={16} />
              </button>
              <button className="file-action-btn" title="Delete" onClick={() => onDelete(file.name)}>
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {filteredFiles.length === 0 && (
        <div className="empty-state">
          {files.length === 0
            ? 'No files are stored yet. Use Quick Upload or drag files here to get started.'
            : `No files match “${search}”. Try a different name or hash.`}
        </div>
      )}

      {filteredFiles.length > PAGE_SIZE && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px' }}>
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(current => current - 1)}>
            Previous
          </button>
          <span style={{ color: '#94a3b8' }}>Page {page} of {pageCount}</span>
          <button className="btn btn-secondary" disabled={page >= pageCount} onClick={() => setPage(current => current + 1)}>
            Next
          </button>
        </div>
      )}

      {/* ── Stateful Upload Progress Card ───────────────────────────────── */}
      {uploadState && (
        <div className="stateful-transfer-card">
          <div className="transfer-header">
            <LoaderCircle size={16} className={uploadState.status === 'uploading' ? 'transfer-spin' : ''} />
            <span className="transfer-title">
              Uploading {uploadState.currentFile ? `"${uploadState.currentFile}"` : 'files…'}
            </span>
            <span className="transfer-status-badge">{uploadState.status}</span>
          </div>

          <div className="transfer-progress-bar-wrap">
            <div
              className="transfer-progress-bar"
              style={{ width: `${Math.round((uploadState.overallProgress || 0) * 100)}%` }}
            />
          </div>
          <div className="transfer-stats">
            <span>{formatBytes(uploadState.bytesUploaded || 0)} / {formatBytes(uploadState.totalBytes || 0)}</span>
            <span>File {uploadState.fileIndex || 0} of {uploadState.totalFiles || 0}</span>
          </div>

          <div className="transfer-actions">
            {uploadState.status === 'uploading' && (
              <button
                className="transfer-btn"
                title="Pause"
                onClick={() => { uploadManager?.suspend(); }}
              >
                <Pause size={14} /> Pause
              </button>
            )}
            {uploadState.status === 'suspended' && (
              <button
                className="transfer-btn"
                title="Resume"
                onClick={() => { uploadManager?.resume(); }}
              >
                <Play size={14} /> Resume
              </button>
            )}
            <button
              className="transfer-btn transfer-btn-cancel"
              title="Cancel"
              onClick={() => {
                uploadManager?.cancel();
                setUploadManager(null);
                setUploadState(null);
              }}
            >
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Stateful Download Progress Card ─────────────────────────────── */}
      {downloadState && (
        <div className="stateful-transfer-card">
          <div className="transfer-header">
            <Download size={16} className={downloadState.status === 'downloading' ? 'transfer-spin' : ''} />
            <span className="transfer-title">
              {downloadState.status === 'completed'
                ? `Downloaded "${downloadState.filename || 'file'}"`
                : `Downloading "${downloadState.filename || 'file'}"…`}
            </span>
            <span className="transfer-status-badge">{downloadState.status}</span>
          </div>

          <div className="transfer-progress-bar-wrap">
            <div
              className="transfer-progress-bar"
              style={{ width: `${Math.round((downloadState.progress || 0) * 100)}%` }}
            />
          </div>
          <div className="transfer-stats">
            <span>{formatBytes(downloadState.bytesDownloaded || 0)} / {formatBytes(downloadState.totalBytes || 0)}</span>
            <span>{Math.round((downloadState.progress || 0) * 100)}%</span>
          </div>

          <div className="transfer-actions">
            {downloadState.status === 'downloading' && (
              <button
                className="transfer-btn"
                title="Pause"
                onClick={() => { downloadManager?.suspend(); }}
              >
                <Pause size={14} /> Pause
              </button>
            )}
            {downloadState.status === 'suspended' && (
              <button
                className="transfer-btn"
                title="Resume"
                onClick={() => { downloadManager?.resume(); }}
              >
                <Play size={14} /> Resume
              </button>
            )}
            {!['completed', 'failed', 'cancelled'].includes(downloadState.status) && (
              <button
                className="transfer-btn transfer-btn-cancel"
                title="Cancel"
                onClick={() => {
                  downloadManager?.cancel();
                  setDownloadManager(null);
                  setDownloadState(null);
                }}
              >
                <X size={14} /> Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
