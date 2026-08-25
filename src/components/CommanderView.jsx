import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  File,
  FileCheck2,
  FileUp,
  FolderOpen,
  GitCompareArrows,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  Server,
  UploadCloud
} from 'lucide-react';
import { apiFetch } from '../utils/api';
import { hashFile } from '../utils/md5';
import BrowserStatefulUpload from '../utils/browser-stateful-upload.mjs';

const HASH_ALGORITHM = 'sha256';

const STATUS_META = {
  match: { label: 'Match', tone: 'success', icon: CheckCircle2 },
  mismatch: { label: 'Mismatch', tone: 'danger', icon: AlertCircle },
  'missing-remote': { label: 'Needs upload', tone: 'warning', icon: FileUp },
  'remote-only': { label: 'Remote only', tone: 'info', icon: Server },
  'hash-pending': { label: 'Hash pending', tone: 'neutral', icon: CircleDashed },
  hashing: { label: 'Hashing', tone: 'info', icon: LoaderCircle },
  pending: { label: 'Queued', tone: 'neutral', icon: CircleDashed },
  uploading: { label: 'Uploading', tone: 'warning', icon: UploadCloud },
  verified: { label: 'Verified', tone: 'success', icon: FileCheck2 },
  failed: { label: 'Failed', tone: 'danger', icon: AlertCircle }
};

function getFilePath(file) {
  return file.relativePath || file.name;
}

function getBrowserPath(file) {
  return (file.webkitRelativePath || file.name).replace(/\\/g, '/');
}

function prepareLocalFiles(selectedFiles) {
  const paths = selectedFiles.map(getBrowserPath);
  const roots = new Set(paths.map(filePath => filePath.includes('/') ? filePath.split('/')[0] : ''));
  const commonRoot = roots.size === 1 ? [...roots][0] : '';
  const prefix = commonRoot ? `${commonRoot}/` : '';
  const seen = new Set();

  return selectedFiles.map((file, index) => {
    const browserPath = paths[index];
    const relativePath = (prefix && browserPath.startsWith(prefix)
      ? browserPath.slice(prefix.length)
      : browserPath).replace(/^\/+/, '').trim();

    if (!relativePath || seen.has(relativePath)) {
      throw new Error(`Duplicate or invalid local path: ${browserPath}`);
    }
    seen.add(relativePath);

    return {
      file,
      relativePath,
      size: file.size,
      sourceMtimeMs: file.lastModified,
      hashAlgorithm: HASH_ALGORITHM,
      hash: null,
      status: 'hashing'
    };
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / (1024 ** index)).toFixed(2))} ${units[index]}`;
}

function shortenHash(hash) {
  if (!hash) return 'Not calculated';
  return `${hash.slice(0, 12)}…`;
}

function getComparisonStatus(localFile, remoteFile) {
  if (!localFile) return 'remote-only';
  if (!remoteFile) return 'missing-remote';
  if (!localFile.hash || remoteFile.hashAlgorithm !== HASH_ALGORITHM || !remoteFile.hash) return 'hash-pending';
  return localFile.size === remoteFile.size && localFile.hash === remoteFile.hash
    ? 'match'
    : 'mismatch';
}

function summarizeComparison(localFiles, remoteFiles) {
  const localByPath = new Map(localFiles.map(file => [getFilePath(file), file]));
  const remoteByPath = new Map(remoteFiles.map(file => [getFilePath(file), file]));
  const paths = [...new Set([...localByPath.keys(), ...remoteByPath.keys()])];
  const summary = {
    total: paths.length,
    match: 0,
    mismatch: 0,
    missingRemote: 0,
    remoteOnly: 0,
    hashPending: 0
  };

  paths.forEach(relativePath => {
    const status = getComparisonStatus(localByPath.get(relativePath), remoteByPath.get(relativePath));
    if (status === 'match') summary.match += 1;
    else if (status === 'mismatch') summary.mismatch += 1;
    else if (status === 'missing-remote') summary.missingRemote += 1;
    else if (status === 'remote-only') summary.remoteOnly += 1;
    else summary.hashPending += 1;
  });

  return summary;
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, tone: 'neutral', icon: CircleDashed };
  const Icon = meta.icon;
  return (
    <span className={`commander-status commander-status-${meta.tone}`}>
      <Icon size={14} className={status === 'hashing' ? 'animate-spin' : ''} />
      {meta.label}
    </span>
  );
}

function FileRow({ file, status, isLocal, selected, isCurrent, onToggle, onActivate }) {
  const relativePath = getFilePath(file);
  return (
    <div
      className={`commander-file-row commander-file-row-${status}${isCurrent ? ' commander-file-row-current' : ''}`}
      role="option"
      aria-selected={isCurrent}
      tabIndex={isCurrent ? 0 : -1}
      onClick={event => {
        onActivate?.();
        event.currentTarget.focus();
      }}
      onFocus={onActivate}
    >
      <div className="commander-file-select">
        {isLocal ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggle(relativePath)}
            aria-label={`Select ${relativePath}`}
          />
        ) : (
          <File size={17} />
        )}
      </div>
      <div className="commander-file-icon"><File size={17} /></div>
      <div className="commander-file-details">
        <strong title={relativePath}>{relativePath}</strong>
        <span>
          {formatBytes(file.size)} <i>·</i>
          <code title={file.hash || 'Hash not calculated'}>{shortenHash(file.hash)}</code>
        </span>
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

function isTerminalUpload(status = '') {
  return status.startsWith('Completed') || status.startsWith('Upload failed') || status.startsWith('Audit failed');
}

export default function CommanderView({ authToken, onNotify, onPreview, onRefresh }) {
  const [localFiles, setLocalFiles] = useState([]);
  const [remoteFiles, setRemoteFiles] = useState([]);
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [activePanel, setActivePanel] = useState('local');
  const [currentPaths, setCurrentPaths] = useState({ local: null, remote: null });
  const [search, setSearch] = useState('');
  const [isHashing, setIsHashing] = useState(false);
  const [hashProgress, setHashProgress] = useState('');
  const [isComparing, setIsComparing] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [comparisonState, setComparisonState] = useState('idle');
  const [serverUrl, setServerUrl] = useState(
    `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/upload`
  );
  const [uploadState, setUploadState] = useState(null);
  const uploaderRef = useRef(null);
  const localInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const listRefs = useRef({ local: null, remote: null });

  const localByPath = useMemo(
    () => new Map(localFiles.map(file => [getFilePath(file), file])),
    [localFiles]
  );
  const remoteByPath = useMemo(
    () => new Map(remoteFiles.map(file => [getFilePath(file), file])),
    [remoteFiles]
  );
  const uploadByPath = useMemo(
    () => new Map((uploadState?.files || []).map(file => [getFilePath(file), file])),
    [uploadState]
  );
  const summary = useMemo(() => summarizeComparison(localFiles, remoteFiles), [localFiles, remoteFiles]);
  const query = search.trim().toLowerCase();
  const visibleLocalFiles = useMemo(() => localFiles.filter(file => (
    !query || getFilePath(file).toLowerCase().includes(query) || file.hash?.toLowerCase().includes(query)
  )), [localFiles, query]);
  const visibleRemoteFiles = useMemo(() => remoteFiles.filter(file => (
    !query || getFilePath(file).toLowerCase().includes(query) || file.hash?.toLowerCase().includes(query)
  )), [remoteFiles, query]);
  const needsUploadFiles = localFiles.filter(file => getComparisonStatus(file, remoteByPath.get(getFilePath(file))) !== 'match');
  const selectedFiles = localFiles.filter(file => selectedPaths.has(getFilePath(file)));
  const uploadBusy = Boolean(uploadState?.isUploading && !uploadState?.isPaused);

  const visibleFilesForPanel = panel => panel === 'local' ? visibleLocalFiles : visibleRemoteFiles;

  const currentFileForPanel = panel => {
    const visibleFiles = visibleFilesForPanel(panel);
    const currentPath = currentPaths[panel];
    return visibleFiles.find(file => getFilePath(file) === currentPath) || visibleFiles[0] || null;
  };

  const activateFile = (panel, file) => {
    if (!file) return;
    setActivePanel(panel);
    setCurrentPaths(current => ({ ...current, [panel]: getFilePath(file) }));
  };

  const focusPanel = panel => {
    listRefs.current[panel]?.focus();
  };

  const switchPanel = () => {
    const nextPanel = activePanel === 'local' ? 'remote' : 'local';
    const nextFile = currentFileForPanel(nextPanel);
    if (nextFile) {
      setCurrentPaths(current => ({ ...current, [nextPanel]: getFilePath(nextFile) }));
    }
    setActivePanel(nextPanel);
    focusPanel(nextPanel);
  };

  const viewCurrentFile = (panel = activePanel) => {
    const currentFile = currentFileForPanel(panel);
    if (!currentFile) {
      onNotify?.(`There are no ${panel} files to view.`, 'info');
      return;
    }
    activateFile(panel, currentFile);
    onPreview?.(currentFile);
  };

  const handlePanelKeyDown = (panel, event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      switchPanel();
      return;
    }

    if (event.key === 'F3') {
      event.preventDefault();
      event.stopPropagation();
      viewCurrentFile(panel);
      return;
    }

    const files = visibleFilesForPanel(panel);
    if (files.length === 0) return;

    const currentIndex = Math.max(
      0,
      files.findIndex(file => getFilePath(file) === currentPaths[panel])
    );
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') nextIndex = Math.min(files.length - 1, currentIndex + 1);
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = files.length - 1;
    if (nextIndex === currentIndex && !['Home', 'End'].includes(event.key)) return;

    event.preventDefault();
    activateFile(panel, files[nextIndex]);
  };

  const fetchRemoteFiles = async (notifyOnError = true) => {
    setRemoteLoading(true);
    try {
      const response = await apiFetch('/api/files?includeHash=1&algorithm=sha256');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not load remote files');
      const files = Array.isArray(data.files) ? data.files : [];
      setRemoteFiles(files);
      return files;
    } catch (error) {
      if (notifyOnError) onNotify?.(error.message, 'error');
      throw error;
    } finally {
      setRemoteLoading(false);
    }
  };

  useEffect(() => {
    fetchRemoteFiles().catch(() => {});
  }, [authToken]);

  useEffect(() => {
    setCurrentPaths(current => {
      const nextLocalPath = current.local && localFiles.some(file => getFilePath(file) === current.local)
        ? current.local
        : localFiles[0] ? getFilePath(localFiles[0]) : null;
      const nextRemotePath = current.remote && remoteFiles.some(file => getFilePath(file) === current.remote)
        ? current.remote
        : remoteFiles[0] ? getFilePath(remoteFiles[0]) : null;

      if (nextLocalPath === current.local && nextRemotePath === current.remote) return current;
      return { local: nextLocalPath, remote: nextRemotePath };
    });
  }, [localFiles, remoteFiles]);

  useEffect(() => {
    const handleGlobalShortcut = event => {
      if (event.defaultPrevented || event.target?.closest?.('[role="dialog"]')) return;
      const commanderTarget = event.target?.closest?.('.commander-view');
      if (!commanderTarget) return;

      if (event.key === 'F3') {
        event.preventDefault();
        viewCurrentFile();
        return;
      }

      if (event.key === 'Tab' && !event.target?.matches?.('input, textarea, select, [contenteditable="true"]')) {
        event.preventDefault();
        switchPanel();
      }
    };

    window.addEventListener('keydown', handleGlobalShortcut);
    return () => window.removeEventListener('keydown', handleGlobalShortcut);
  }, [activePanel, currentPaths, visibleLocalFiles, visibleRemoteFiles]);

  useEffect(() => () => {
    uploaderRef.current?.dispose();
  }, []);

  const hashEntries = async (entries, label) => {
    const hashed = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      setHashProgress(`${label} ${index + 1}/${entries.length}: ${entry.relativePath}`);
      const hash = await hashFile(entry.file, HASH_ALGORITHM);
      const hashedEntry = {
        ...entry,
        hashAlgorithm: HASH_ALGORITHM,
        hash,
        status: 'ready'
      };
      hashed.push(hashedEntry);
      setLocalFiles(current => current.map(file => getFilePath(file) === entry.relativePath ? hashedEntry : file));
    }
    return hashed;
  };

  const handleLocalSelection = async event => {
    const selected = Array.from(event.target.files || []);
    event.target.value = '';
    if (selected.length === 0) {
      onNotify?.('Select one or more local files or a folder.', 'info');
      return;
    }
    if (isHashing || isComparing || uploadBusy) {
      onNotify?.('Wait for the current Commander operation to finish.', 'warning');
      return;
    }

    let entries;
    try {
      entries = prepareLocalFiles(selected);
    } catch (error) {
      onNotify?.(error.message, 'error');
      return;
    }

    uploaderRef.current?.dispose();
    uploaderRef.current = null;
    setUploadState(null);
    setLocalFiles(entries);
    setSelectedPaths(new Set(entries.map(file => file.relativePath)));
    setComparisonState('idle');
    setIsHashing(true);
    try {
      const hashed = await hashEntries(entries, 'Hashing local files');
      setLocalFiles(hashed);
      setComparisonState('ready');
      onNotify?.(`${hashed.length} local file(s) hashed with SHA-256.`, 'success');
    } catch (error) {
      onNotify?.(error.message || 'Could not hash the selected local files.', 'error');
    } finally {
      setHashProgress('');
      setIsHashing(false);
    }
  };

  const handleCompareAll = async () => {
    if (localFiles.length === 0) {
      onNotify?.('Choose local files or a folder before comparing.', 'warning');
      return;
    }
    if (isHashing || isComparing || uploadBusy) return;

    setIsComparing(true);
    setIsHashing(true);
    setComparisonState('comparing');
    try {
      const hashed = await hashEntries(localFiles, 'Rechecking local files');
      setLocalFiles(hashed);
      const freshRemoteFiles = await fetchRemoteFiles(false);
      const nextSummary = summarizeComparison(hashed, freshRemoteFiles);
      setComparisonState('complete');
      const issueCount = nextSummary.mismatch + nextSummary.missingRemote + nextSummary.remoteOnly;
      onNotify?.(
        issueCount === 0
          ? `All ${nextSummary.match} file(s) match by SHA-256. No upload was performed.`
          : `Compared ${nextSummary.total} path(s): ${nextSummary.match} match(es), ${issueCount} difference(s). No upload was performed.`,
        issueCount === 0 ? 'success' : 'warning'
      );
    } catch (error) {
      setComparisonState('ready');
      onNotify?.(error.message || 'SHA-256 comparison failed.', 'error');
    } finally {
      setHashProgress('');
      setIsHashing(false);
      setIsComparing(false);
    }
  };

  const startStatefulUpload = mode => {
    if (isHashing || isComparing || remoteLoading) return;

    if (uploaderRef.current && uploadState?.isPaused) {
      uploaderRef.current.resume();
      return;
    }

    if (uploaderRef.current && uploadState && !isTerminalUpload(uploadState.status)) {
      uploaderRef.current.start();
      return;
    }

    const entries = mode === 'selected'
      ? selectedFiles
      : needsUploadFiles;
    if (entries.length === 0) {
      onNotify?.(mode === 'selected' ? 'Select at least one local file to upload.' : 'There are no local SHA-256 differences to upload.', 'info');
      return;
    }
    if (entries.some(file => !file.hash)) {
      onNotify?.('Wait for local SHA-256 hashing to finish before uploading.', 'warning');
      return;
    }

    uploaderRef.current?.dispose();
    const uploader = new BrowserStatefulUpload({
      entries,
      authToken,
      serverUrl,
      onChange: nextState => setUploadState({ ...nextState }),
      onNotify,
      onComplete: async ({ verified }) => {
        if (!verified) return;
        try {
          await fetchRemoteFiles(false);
          onRefresh?.();
          setComparisonState('complete');
        } catch (error) {
          // The upload was verified even if refreshing the list failed.
        }
      }
    });
    uploaderRef.current = uploader;
    setUploadState({ ...uploader.getState() });
    uploader.start();
  };

  const toggleSelectedPath = relativePath => {
    setSelectedPaths(current => {
      const next = new Set(current);
      if (next.has(relativePath)) next.delete(relativePath);
      else next.add(relativePath);
      return next;
    });
  };

  const clearLocalFiles = () => {
    if (uploadBusy || isHashing || isComparing) return;
    uploaderRef.current?.dispose();
    uploaderRef.current = null;
    setUploadState(null);
    setLocalFiles([]);
    setSelectedPaths(new Set());
    setComparisonState('idle');
  };

  const uploadStatusFor = relativePath => {
    const uploadFile = uploadByPath.get(relativePath);
    if (uploadFile?.status === 'uploading' || uploadFile?.status === 'verified' || uploadFile?.status === 'failed') {
      return uploadFile.status;
    }
    return getComparisonStatus(localByPath.get(relativePath), remoteByPath.get(relativePath));
  };

  return (
    <div className="commander-view">
      <header className="commander-header">
        <div>
          <span className="commander-kicker">FILE TRANSFER WORKSPACE</span>
          <h1>Commander View</h1>
          <p>Compare a local selection with the remote repository, then sync only what changed.</p>
        </div>
        <div className="commander-header-actions">
          <button
            className="btn btn-secondary"
            onClick={() => fetchRemoteFiles().catch(() => {})}
            disabled={remoteLoading || isComparing || uploadBusy}
          >
            <RefreshCw size={16} className={remoteLoading ? 'animate-spin' : ''} /> Refresh remote
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCompareAll}
            disabled={!localFiles.length || isHashing || isComparing || uploadBusy}
            title="Rehash all local files and compare them with the remote list without uploading"
          >
            <GitCompareArrows size={17} /> Compare all files <span className="commander-button-note">(no upload)</span>
          </button>
        </div>
      </header>

      <section className="commander-toolbar">
        <div className="commander-toolbar-badge">
          <GitCompareArrows size={17} />
          <div><strong>SHA-256 mode</strong><span>Hashes are checked by path and size</span></div>
        </div>
        <label className="commander-server-url">
          Stateful upload target
          <input
            className="text-input"
            value={serverUrl}
            onChange={event => setServerUrl(event.target.value)}
            disabled={uploadBusy || isComparing}
            spellCheck="false"
          />
        </label>
        <div className="commander-toolbar-actions">
          <button
            className="btn btn-secondary"
            onClick={() => startStatefulUpload('selected')}
            disabled={!selectedFiles.length || isHashing || isComparing || uploadBusy}
          >
            <UploadCloud size={16} /> Upload selected ({selectedFiles.length})
          </button>
          <button
            className="btn btn-primary"
            onClick={() => startStatefulUpload('differences')}
            disabled={!needsUploadFiles.length || isHashing || isComparing || uploadBusy}
          >
            {uploadState?.isPaused ? <Play size={16} /> : <FileUp size={16} />}
            {uploadState?.isPaused ? 'Resume stateful upload' : `Upload differences (${needsUploadFiles.length})`}
          </button>
          {uploadState?.isUploading && (
            <button className="btn btn-danger" onClick={() => uploaderRef.current?.pause()} disabled={uploadState.isPaused}>
              <Pause size={16} /> Pause
            </button>
          )}
        </div>
      </section>

      {(isHashing || hashProgress) && (
        <div className="commander-operation-note">
          <LoaderCircle size={16} className="animate-spin" /> {hashProgress || 'Hashing local files...'}
        </div>
      )}

      {uploadState && (
        <section className="commander-transfer">
          <div className="commander-transfer-header">
            <div><strong>Stateful transfer</strong><span>{uploadState.stats.activeFile ? `Active: ${uploadState.stats.activeFile}` : 'Server offset is saved as each chunk is acknowledged.'}</span></div>
            <span className={`commander-transfer-status ${uploadState.status.includes('Completed') ? 'success' : uploadState.status.toLowerCase().includes('failed') || uploadState.status.toLowerCase().includes('error') ? 'danger' : 'warning'}`}>
              {uploadState.status}
            </span>
          </div>
          <div className="commander-progress-line"><div style={{ width: `${uploadState.stats.overallPct}%` }} /></div>
          <div className="commander-transfer-meta">
            <span>{uploadState.stats.filesCount} / {uploadState.stats.totalFiles} files verified</span>
            <span>{uploadState.stats.overallPct}% · {uploadState.stats.speedMB} MB/s</span>
          </div>
        </section>
      )}

      <section className="commander-summary">
        <div className="commander-summary-heading">
          <div><span className="commander-kicker">COMPARISON STATUS</span><h2>{comparisonState === 'complete' ? 'Workspace comparison complete' : 'Ready for comparison'}</h2></div>
          <span className="commander-summary-hint">{comparisonState === 'complete' ? 'Fresh SHA-256 hashes from both sides' : 'Compare all files to include remote-only paths'}</span>
        </div>
        <div className="commander-metrics">
          <div><strong>{summary.match}</strong><span>Matches</span></div>
          <div><strong>{summary.mismatch + summary.missingRemote}</strong><span>Needs upload</span></div>
          <div><strong>{summary.remoteOnly}</strong><span>Remote only</span></div>
          <div><strong>{summary.total}</strong><span>Total paths</span></div>
        </div>
      </section>

      <div className="commander-list-toolbar">
        <div className="search-box commander-search-box">
          <Search size={17} color="#94a3b8" />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Filter both file lists..." />
        </div>
        <div className="commander-selection-actions">
          <span>{selectedFiles.length} local file(s) selected</span>
          <button type="button" onClick={() => setSelectedPaths(new Set(localFiles.map(file => getFilePath(file))))} disabled={!localFiles.length}>Select all</button>
          <button type="button" onClick={() => setSelectedPaths(new Set())} disabled={!selectedFiles.length}>Clear selection</button>
          <button type="button" onClick={clearLocalFiles} disabled={!localFiles.length || uploadBusy || isHashing || isComparing}>Clear local</button>
        </div>
      </div>

      <div className="commander-panels" aria-label="Commander file panels">
        <section className={`commander-panel${activePanel === 'local' ? ' commander-panel-active' : ''}`}>
          <header className="commander-panel-header">
            <div className="commander-panel-title">
              <div className="commander-panel-icon local"><FolderOpen size={19} /></div>
              <div><h2>Local files</h2><span>{localFiles.length} file(s) · hashes computed in browser</span></div>
            </div>
            <div className="commander-picker-actions">
              <label className="commander-picker">
                <UploadCloud size={15} /> Files
                <input ref={localInputRef} type="file" multiple hidden onChange={handleLocalSelection} disabled={isHashing || uploadBusy} />
              </label>
              <label className="commander-picker commander-picker-muted">
                <FolderOpen size={15} /> Folder
                <input ref={folderInputRef} type="file" multiple webkitdirectory="true" directory="true" hidden onChange={handleLocalSelection} disabled={isHashing || uploadBusy} />
              </label>
            </div>
          </header>
          <div
            ref={element => { listRefs.current.local = element; }}
            className="commander-list commander-list-local"
            role="listbox"
            tabIndex={0}
            aria-label="Local files"
            onFocus={() => setActivePanel('local')}
            onKeyDown={event => handlePanelKeyDown('local', event)}
          >
            {visibleLocalFiles.length > 0 ? visibleLocalFiles.map(file => {
              const relativePath = getFilePath(file);
              return <FileRow
                key={relativePath}
                file={file}
                isLocal
                selected={selectedPaths.has(relativePath)}
                isCurrent={currentPaths.local === relativePath}
                onToggle={toggleSelectedPath}
                onActivate={() => activateFile('local', file)}
                status={isHashing && !file.hash ? 'hashing' : uploadStatusFor(relativePath)}
              />;
            }) : (
              <div className="commander-empty"><FolderOpen size={28} /><strong>No local files selected</strong><span>Choose files or a folder to build the local side of the workspace.</span></div>
            )}
          </div>
        </section>

        <section className={`commander-panel${activePanel === 'remote' ? ' commander-panel-active' : ''}`}>
          <header className="commander-panel-header">
            <div className="commander-panel-title">
              <div className="commander-panel-icon remote"><Server size={19} /></div>
              <div><h2>Remote repository</h2><span>{remoteFiles.length} file(s) · SHA-256 from server</span></div>
            </div>
            <span className="commander-remote-state">{activePanel === 'remote' ? 'Active' : remoteLoading ? 'Refreshing…' : 'Connected'}</span>
          </header>
          <div
            ref={element => { listRefs.current.remote = element; }}
            className="commander-list"
            role="listbox"
            tabIndex={0}
            aria-label="Remote repository files"
            onFocus={() => setActivePanel('remote')}
            onKeyDown={event => handlePanelKeyDown('remote', event)}
          >
            {visibleRemoteFiles.length > 0 ? visibleRemoteFiles.map(file => {
              const relativePath = getFilePath(file);
              return <FileRow
                key={relativePath}
                file={file}
                isCurrent={currentPaths.remote === relativePath}
                onActivate={() => activateFile('remote', file)}
                status={getComparisonStatus(localByPath.get(relativePath), file)}
              />;
            }) : (
              <div className="commander-empty"><Server size={28} /><strong>{remoteLoading ? 'Loading remote files…' : 'Remote repository is empty'}</strong><span>Refresh the remote list after another client finishes an upload.</span></div>
            )}
          </div>
        </section>
      </div>

      <p className="commander-footnote"><strong>Tab</strong> switches the active file panel. <strong>F3</strong> views the current file. <strong>Compare all files</strong> rehashes every selected local file and refreshes the complete remote list. It never uploads file contents.</p>
    </div>
  );
}
