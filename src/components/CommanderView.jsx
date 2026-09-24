import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronUp,
  CircleAlert,
  Eye,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  X
} from 'lucide-react';
import { apiFetch } from '../utils/api';
import ServerPngPreview from './ServerPngPreview';

const PANEL_KEYS = ['left', 'right'];

function createPanelState() {
  return {
    path: null,
    parentPath: null,
    entries: [],
    selectedNames: new Set(),
    currentName: null,
    error: null
  };
}

function formatBytes(bytes) {
  if (!bytes) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / (1024 ** index)).toFixed(2))} ${units[index]}`;
}

function formatModified(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
}

function isWindowsStylePath(value = '') {
  return /^[a-z]:($|[\\/])/i.test(value) || value.includes('\\') || value.startsWith('\\\\');
}

function joinLocalPath(directoryPath, name) {
  if (isWindowsStylePath(directoryPath)) {
    const trimmed = directoryPath.replace(/[\\/]+$/, '');
    return `${trimmed || '\\'}\\${name}`;
  }
  const trimmed = directoryPath.replace(/\/+$/, '');
  return `${trimmed}/${name}`;
}

function isCopyable(entry) {
  return entry.type === 'file' || entry.type === 'directory';
}

function isPdfFile(entry) {
  return entry?.type === 'file' && /\.pdf$/i.test(entry.name);
}

function isPngFile(entry) {
  return entry?.type === 'file' && /\.png$/i.test(entry.name);
}

function EntryRow({ entry, selected, current, onActivate, onToggle, onOpen, onPreview }) {
  const directory = entry.type === 'directory';
  const unsupported = !isCopyable(entry);
  const Icon = directory ? Folder : File;

  return (
    <div
      className={`commander-file-row commander-file-row-${entry.type}${current ? ' commander-file-row-current' : ''}`}
      role="option"
      aria-selected={current}
      aria-label={`${entry.type} ${entry.name}`}
      tabIndex={current ? 0 : -1}
      onClick={() => onActivate(entry)}
      onDoubleClick={() => {
        if (directory) onOpen(entry);
        else if (isPngFile(entry)) onPreview(entry);
      }}
      onFocus={() => onActivate(entry)}
    >
      <div className="commander-file-select">
        <input
          type="checkbox"
          checked={selected}
          disabled={unsupported}
          onClick={event => event.stopPropagation()}
          onChange={() => onToggle(entry.name)}
          onKeyDown={event => event.stopPropagation()}
          aria-label={`Select ${entry.name}`}
        />
      </div>
      <div className={`commander-file-icon ${directory ? 'commander-file-icon-folder' : ''}`}>
        <Icon size={17} />
      </div>
      <div className="commander-file-details">
        <strong title={entry.name}>{entry.name}</strong>
        <span>
          {directory ? 'Directory' : unsupported ? 'Unsupported filesystem entry' : formatBytes(entry.size)}
          <i>·</i>
          <code title={formatModified(entry.modifiedAt)}>{formatModified(entry.modifiedAt)}</code>
        </span>
      </div>
      <span className={`commander-entry-type commander-entry-type-${entry.type}`}>
        {directory ? 'DIR' : entry.type === 'symlink' ? 'LINK' : entry.type.toUpperCase()}
      </span>
    </div>
  );
}

function CommanderPanel({
  panelKey,
  panel,
  draftPath,
  visibleEntries,
  active,
  loading,
  onActivatePanel,
  onPathChange,
  onPathSubmit,
  onUp,
  onRefresh,
  onSelectAll,
  onClearSelection,
  onActivateEntry,
  onToggle,
  onOpenDirectory,
  onPreviewImage,
  onKeyDown
}) {
  const label = panelKey === 'left' ? 'Left panel' : 'Right panel';
  const selectedCount = panel.selectedNames.size;
  const canGoUp = panel.parentPath && panel.parentPath !== panel.path;

  return (
    <section
      className={`commander-panel${active ? ' commander-panel-active' : ''}`}
      onClick={() => onActivatePanel(panelKey)}
    >
      <header className="commander-panel-header">
        <div className="commander-panel-title">
          <div className={`commander-panel-icon ${panelKey}`}><HardDrive size={19} /></div>
          <div>
            <h2>{label}</h2>
            <span>{panel.path ? `${panel.entries.length} item(s)` : 'Path not loaded'} · server-local filesystem</span>
          </div>
        </div>
        <div className="commander-panel-actions">
          <button
            type="button"
            className="commander-icon-button"
            onClick={event => { event.stopPropagation(); onUp(panelKey); }}
            disabled={!canGoUp || loading}
            title="Open parent directory"
            aria-label={`${label}: open parent directory`}
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            className="commander-icon-button"
            onClick={event => { event.stopPropagation(); onRefresh(panelKey); }}
            disabled={!panel.path || loading}
            title="Refresh directory"
            aria-label={`${label}: refresh directory`}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      <form
        className="commander-path-form"
        onSubmit={event => { event.preventDefault(); onPathSubmit(panelKey); }}
        onClick={event => event.stopPropagation()}
      >
        <input
          className="commander-path-input"
          value={draftPath}
          onChange={event => onPathChange(panelKey, event.target.value)}
          placeholder="Enter a local path, e.g. C:\\ or /media/flash"
          spellCheck="false"
          autoComplete="off"
          aria-label={`${label} path`}
        />
        <button type="submit" className="btn btn-secondary commander-go-button" disabled={loading}>
          {loading ? <LoaderCircle size={15} className="animate-spin" /> : <FolderOpen size={15} />}
          Go
        </button>
      </form>

      <div className="commander-current-path" title={panel.path || ''}>
        <FolderOpen size={14} />
        <code>{panel.path || 'Enter a path above'}</code>
      </div>

      <div
        className="commander-list"
        role="listbox"
        tabIndex={0}
        aria-label={`${label} entries`}
        onFocus={() => onActivatePanel(panelKey)}
        onKeyDown={event => onKeyDown(panelKey, event)}
      >
        {panel.error ? (
          <div className="commander-empty commander-empty-error">
            <CircleAlert size={28} />
            <strong>Could not open this path</strong>
            <span>{panel.error}</span>
          </div>
        ) : visibleEntries.length > 0 ? visibleEntries.map(entry => (
          <EntryRow
            key={entry.name}
            entry={entry}
            selected={panel.selectedNames.has(entry.name)}
            current={panel.currentName === entry.name}
            onActivate={entryToActivate => onActivateEntry(panelKey, entryToActivate)}
            onToggle={name => onToggle(panelKey, name)}
            onOpen={entryToOpen => onOpenDirectory(panelKey, entryToOpen)}
            onPreview={entryToPreview => onPreviewImage(panelKey, entryToPreview)}
          />
        )) : (
          <div className="commander-empty">
            <FolderOpen size={28} />
            <strong>{panel.path ? 'This directory is empty' : 'Enter a local path'}</strong>
            <span>{panel.path ? 'There are no entries matching the current filter.' : 'Use the path field above to open a directory on this server.'}</span>
          </div>
        )}
      </div>

      <footer className="commander-panel-footer">
        <span>{selectedCount} selected</span>
        <button type="button" onClick={event => { event.stopPropagation(); onSelectAll(panelKey); }} disabled={!visibleEntries.some(isCopyable)}>
          Select all
        </button>
        <button type="button" onClick={event => { event.stopPropagation(); onClearSelection(panelKey); }} disabled={!selectedCount}>
          Clear
        </button>
      </footer>
    </section>
  );
}

export default function CommanderView({ onNotify, onRefresh }) {
  const [panels, setPanels] = useState({ left: createPanelState(), right: createPanelState() });
  const [pathDrafts, setPathDrafts] = useState({ left: '.', right: 'uploads' });
  const [activePanel, setActivePanel] = useState('left');
  const [search, setSearch] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [loadingPanel, setLoadingPanel] = useState({ left: false, right: false });
  const [copyState, setCopyState] = useState(null);
  const [conversionState, setConversionState] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [copyJob, setCopyJob] = useState(null);
  const requestIds = useRef({ left: 0, right: 0 });
  const listRefs = useRef({ left: null, right: null });
  const pollingTimerRef = useRef(null);

  const stopPolling = () => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => stopPolling();
  }, []);

  const query = search.trim().toLowerCase();
  const visibleEntries = useMemo(() => Object.fromEntries(
    PANEL_KEYS.map(panelKey => [
      panelKey,
      panels[panelKey].entries.filter(entry => !query || entry.name.toLowerCase().includes(query))
    ])
  ), [panels, query]);
  const isBusy = Object.values(loadingPanel).some(Boolean)
    || copyState?.phase === 'copying'
    || conversionState?.phase === 'converting'
    || copyJob?.status === 'running';
  const selectedCount = PANEL_KEYS.reduce((total, panelKey) => total + panels[panelKey].selectedNames.size, 0);
  const activeSelection = panels[activePanel].entries.filter(entry => panels[activePanel].selectedNames.has(entry.name));
  const canCopyAsPng = activeSelection.length > 0
    && activeSelection.every(isPdfFile)
    && Boolean(panels[activePanel].path)
    && Boolean(panels[activePanel === 'left' ? 'right' : 'left'].path);
  const canPreviewPng = activeSelection.length === 1
    && isPngFile(activeSelection[0])
    && Boolean(panels[activePanel].path);

  const updatePanel = (panelKey, updates) => {
    setPanels(current => ({
      ...current,
      [panelKey]: { ...current[panelKey], ...updates }
    }));
  };

  const loadPanel = async (panelKey, requestedPath, notifyOnError = true) => {
    const requestId = requestIds.current[panelKey] + 1;
    requestIds.current[panelKey] = requestId;
    const pathValue = typeof requestedPath === 'string' ? requestedPath : pathDrafts[panelKey];
    setLoadingPanel(current => ({ ...current, [panelKey]: true }));

    try {
      const response = await apiFetch(`/api/local/list?path=${encodeURIComponent(pathValue)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not list local directory');
      if (requestIds.current[panelKey] !== requestId) return null;

      const entries = Array.isArray(data.entries) ? data.entries : [];
      updatePanel(panelKey, {
        path: data.path || pathValue,
        parentPath: data.parentPath || data.path || pathValue,
        entries,
        selectedNames: new Set(),
        currentName: entries[0]?.name || null,
        error: null
      });
      setPathDrafts(current => ({ ...current, [panelKey]: data.path || pathValue }));
      return data;
    } catch (error) {
      if (requestIds.current[panelKey] !== requestId) return null;
      updatePanel(panelKey, { error: error.message || 'Could not list local directory' });
      if (notifyOnError) onNotify?.(error.message || 'Could not list local directory', 'error');
      return null;
    } finally {
      if (requestIds.current[panelKey] === requestId) {
        setLoadingPanel(current => ({ ...current, [panelKey]: false }));
      }
    }
  };

  useEffect(() => {
    loadPanel('left', '.', false);
    loadPanel('right', 'uploads', false);
  }, []);

  const activatePanel = panelKey => setActivePanel(panelKey);

  const activateEntry = (panelKey, entry) => {
    setActivePanel(panelKey);
    updatePanel(panelKey, { currentName: entry.name });
  };

  const toggleSelection = (panelKey, name) => {
    setActivePanel(panelKey);
    setPanels(current => {
      const selectedNames = new Set(current[panelKey].selectedNames);
      if (selectedNames.has(name)) selectedNames.delete(name);
      else selectedNames.add(name);
      return { ...current, [panelKey]: { ...current[panelKey], selectedNames } };
    });
  };

  const selectAll = panelKey => {
    const selectedNames = new Set(visibleEntries[panelKey].filter(isCopyable).map(entry => entry.name));
    updatePanel(panelKey, { selectedNames });
  };

  const clearSelection = panelKey => updatePanel(panelKey, { selectedNames: new Set() });

  const openPngPreview = (panelKey, entry) => {
    const directoryPath = panels[panelKey].path;
    if (!directoryPath || !isPngFile(entry)) return;
    setPreviewFile({
      name: entry.name,
      path: joinLocalPath(directoryPath, entry.name),
      size: entry.size
    });
  };

  const openDirectory = (panelKey, entry) => {
    const panel = panels[panelKey];
    loadPanel(panelKey, joinLocalPath(panel.path, entry.name));
  };

  const handlePanelKeyDown = (panelKey, event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const nextPanel = panelKey === 'left' ? 'right' : 'left';
      setActivePanel(nextPanel);
      listRefs.current[nextPanel]?.focus();
      return;
    }

    const entries = visibleEntries[panelKey];
    if (entries.length === 0) return;
    const panel = panels[panelKey];
    const currentIndex = Math.max(0, entries.findIndex(entry => entry.name === panel.currentName));
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') nextIndex = Math.min(entries.length - 1, currentIndex + 1);
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = entries.length - 1;

    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      activateEntry(panelKey, entries[nextIndex]);
      return;
    }

    const currentEntry = entries[currentIndex];
    if (event.key === 'Enter' && currentEntry?.type === 'directory') {
      event.preventDefault();
      openDirectory(panelKey, currentEntry);
    } else if (event.key === 'Enter' && isPngFile(currentEntry)) {
      event.preventDefault();
      openPngPreview(panelKey, currentEntry);
    } else if (event.key === ' ' && currentEntry && isCopyable(currentEntry)) {
      event.preventDefault();
      toggleSelection(panelKey, currentEntry.name);
    }
  };

  const handleSuspendCopy = async () => {
    if (!copyJob?.id) return;
    try {
      const res = await apiFetch(`/api/local/copy/jobs/${copyJob.id}/suspend`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setCopyJob(data.job);
        onNotify?.('Copy suspended (paused). Click Resume when ready.', 'info');
      }
    } catch (e) {
      onNotify?.('Could not suspend copy', 'error');
    }
  };

  const handleResumeCopy = async () => {
    if (!copyJob?.id) return;
    try {
      const res = await apiFetch(`/api/local/copy/jobs/${copyJob.id}/resume`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setCopyJob(data.job);
        onNotify?.('Copy resumed.', 'success');
      }
    } catch (e) {
      onNotify?.('Could not resume copy', 'error');
    }
  };

  const handleCancelCopy = async () => {
    if (!copyJob?.id) return;
    try {
      const res = await apiFetch(`/api/local/copy/jobs/${copyJob.id}/cancel`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setCopyJob(data.job);
        stopPolling();
        setCopyState(null);
        onNotify?.('Copy operation cancelled.', 'info');
      }
    } catch (e) {
      onNotify?.('Could not cancel copy', 'error');
    }
  };

  const copyFrom = async sourceKey => {
    const destinationKey = sourceKey === 'left' ? 'right' : 'left';
    const source = panels[sourceKey];
    const destination = panels[destinationKey];
    const entries = source.entries
      .filter(entry => source.selectedNames.has(entry.name) && isCopyable(entry))
      .map(entry => entry.name);

    if (entries.length === 0) {
      onNotify?.(`Select at least one file or directory in the ${sourceKey} panel first.`, 'warning');
      return;
    }
    if (!source.path || !destination.path) {
      onNotify?.('Open both destination panels before copying.', 'warning');
      return;
    }
    if (isBusy) return;

    setActivePanel(sourceKey);
    stopPolling();
    setConversionState(null);
    setCopyState({ phase: 'copying', sourceKey, destinationKey, entries });

    try {
      const response = await apiFetch('/api/local/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePath: source.path,
          destinationPath: destination.path,
          entries,
          overwrite: replaceExisting,
          stateful: true
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not start local copy');

      const jobId = data.jobId;
      setCopyJob(data.job);

      pollingTimerRef.current = setInterval(async () => {
        try {
          const res = await apiFetch(`/api/local/copy/jobs/${jobId}`);
          if (!res.ok) return;
          const currentJob = await res.json();
          setCopyJob(currentJob);

          if (currentJob.status === 'completed') {
            stopPolling();
            await loadPanel(destinationKey, destination.path, false);
            setCopyState({ phase: 'complete', sourceKey, destinationKey, ...currentJob });
            const copiedCount = Array.isArray(currentJob.copied) ? currentJob.copied.length : 0;
            const errorCount = Array.isArray(currentJob.errors) ? currentJob.errors.length : 0;
            if (errorCount > 0) {
              onNotify?.(`Copied ${copiedCount} item(s); ${errorCount} item(s) need attention.`, copiedCount ? 'warning' : 'error');
            } else {
              onNotify?.(`Copied ${currentJob.filesCopied || 0} file(s) to the ${destinationKey} panel.`, 'success');
            }
            onRefresh?.();
          } else if (currentJob.status === 'failed') {
            stopPolling();
            setCopyState({ phase: 'error', sourceKey, destinationKey, message: currentJob.error || 'Copy failed' });
            onNotify?.(`Copy failed: ${currentJob.error || 'Unknown error'}`, 'error');
          } else if (currentJob.status === 'cancelled') {
            stopPolling();
            setCopyState({ phase: 'error', sourceKey, destinationKey, message: 'Copy cancelled' });
            onNotify?.('Copy was cancelled.', 'info');
          }
        } catch (e) {}
      }, 350);
    } catch (error) {
      setCopyState({ phase: 'error', sourceKey, destinationKey, message: error.message });
      onNotify?.(error.message || 'Could not copy local entries', 'error');
    }
  };

  const copyAsPng = async () => {
    const sourceKey = activePanel;
    const destinationKey = sourceKey === 'left' ? 'right' : 'left';
    const source = panels[sourceKey];
    const destination = panels[destinationKey];
    const selectedEntries = source.entries.filter(entry => source.selectedNames.has(entry.name));
    const entries = selectedEntries.filter(isPdfFile).map(entry => entry.name);

    if (entries.length === 0 || entries.length !== selectedEntries.length) {
      onNotify?.('Select only PDF files in the active panel to use Copy as…', 'warning');
      return;
    }
    if (!source.path || !destination.path) {
      onNotify?.('Open both panels before copying PDFs as PNG.', 'warning');
      return;
    }
    if (isBusy) return;

    setCopyState(null);
    setConversionState({ phase: 'converting', sourceKey, destinationKey, entries });

    try {
      const response = await apiFetch('/api/local/convert/pdf-to-png', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePath: source.path,
          destinationPath: destination.path,
          entries,
          overwrite: replaceExisting
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data.code === 'DESTINATION_EXISTS'
          ? `${data.error || 'PNG files already exist.'} Enable Replace existing files to overwrite them.`
          : data.error || 'Could not copy the selected PDFs as PNG.';
        throw new Error(message);
      }

      await loadPanel(destinationKey, destination.path, false);
      const errors = Array.isArray(data.errors) ? data.errors : [];
      setConversionState({
        phase: errors.length ? 'partial' : 'complete',
        sourceKey,
        destinationKey,
        entries,
        filesCopied: data.filesCopied || 0,
        errors
      });
      onNotify?.(
        errors.length
          ? `Copied ${data.filesCopied || 0} PNG page(s); ${errors.length} item(s) need attention.`
          : `Copied ${data.filesCopied || 0} PNG page(s) to the ${destinationKey} panel.`,
        errors.length ? 'warning' : 'success'
      );
      onRefresh?.();
    } catch (error) {
      setConversionState({
        phase: 'error',
        sourceKey,
        destinationKey,
        entries,
        message: error.message || 'Could not copy the selected PDFs as PNG.'
      });
      onNotify?.(error.message || 'Could not copy the selected PDFs as PNG.', 'error');
    }
  };

  const copyStatus = copyJob?.status === 'suspended'
    ? `Copy suspended (paused). Click Resume to continue copying.`
    : copyJob?.status === 'running'
      ? `Copying ${copyJob.totalFiles} item(s)... ${copyJob.overallPercent}%`
      : copyState?.phase === 'copying'
        ? `Copying ${copyState.entries.length} item(s) from ${copyState.sourceKey} to ${copyState.destinationKey}…`
        : copyState?.phase === 'error'
          ? copyState.message
          : copyState?.phase === 'complete'
            ? `${copyState.copied?.length || 0} item(s) copied · ${copyState.errors?.length || 0} error(s)`
            : 'Select entries in either panel and copy them to the other directory.';
  const conversionStatus = conversionState?.phase === 'converting'
    ? `Converting ${conversionState.entries.length} PDF(s) to 300 DPI PNG pages from ${conversionState.sourceKey} to ${conversionState.destinationKey}…`
    : conversionState?.phase === 'error'
      ? conversionState.message
      : conversionState?.phase === 'partial'
        ? `Copied ${conversionState.filesCopied} PNG page(s) · ${conversionState.errors.length} item(s) need attention`
        : conversionState?.phase === 'complete'
          ? `${conversionState.filesCopied} PNG page(s) copied to the ${conversionState.destinationKey} panel.`
          : null;
  const operationStatus = conversionStatus || copyStatus;

  return (
    <div className="commander-view">
      <header className="commander-header">
        <div>
          <span className="commander-kicker">LOCAL FILE TRANSFER WORKSPACE</span>
          <h1>Commander View</h1>
          <p>Copy files between any directories available to this server, including Windows drives and mounted flash drives.</p>
        </div>
        <div className="commander-header-actions">
          <button type="button" className="btn btn-secondary" onClick={() => loadPanel(activePanel, panels[activePanel].path)} disabled={!panels[activePanel].path || isBusy}>
            <RefreshCw size={16} className={loadingPanel[activePanel] ? 'animate-spin' : ''} /> Refresh active
          </button>
        </div>
      </header>

      <section className="commander-toolbar">
        <div className="commander-toolbar-badge">
          <HardDrive size={17} />
          <div><strong>Server-local mode</strong><span>Both panels use the machine running CloudVault</span></div>
        </div>
        <label className="commander-server-url commander-replace-toggle">
          <span>Copy behavior</span>
          <span className="commander-checkbox-label">
            <input type="checkbox" checked={replaceExisting} onChange={event => setReplaceExisting(event.target.checked)} disabled={isBusy} />
            Replace existing files
          </span>
        </label>
        <div className="commander-toolbar-actions">
          <button type="button" className="btn btn-secondary" onClick={() => copyFrom('left')} disabled={isBusy || !panels.left.selectedNames.size}>
            <ArrowRight size={16} /> Copy selected to right
          </button>
          <button type="button" className="btn btn-primary" onClick={() => copyFrom('right')} disabled={isBusy || !panels.right.selectedNames.size}>
            <ArrowLeft size={16} /> Copy selected to left
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={copyAsPng}
            disabled={isBusy || !canCopyAsPng}
            title="Copy selected PDFs as 300 DPI PNG page images to the opposite panel"
          >
            <File size={16} /> Copy as...
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => openPngPreview(activePanel, activeSelection[0])}
            disabled={!canPreviewPng}
            title="Preview the selected PNG at full resolution"
          >
            <Eye size={16} /> Preview PNG
          </button>
        </div>
      </section>

      {copyJob && ['running', 'suspended'].includes(copyJob.status) && (
        <div className={`commander-transfer-card ${copyJob.status === 'suspended' ? 'suspended' : ''}`}>
          <div className="transfer-header">
            <div className="transfer-title">
              {copyJob.status === 'running' && <LoaderCircle size={18} className="animate-spin text-indigo-400" />}
              {copyJob.status === 'suspended' && <Pause size={18} className="text-amber-400" />}
              <strong>
                {copyJob.status === 'running' ? 'Copying files...' : 'Copy suspended (paused)'}
              </strong>
              <span className="transfer-meta">
                {copyJob.filesCopied} / {copyJob.totalFiles} file(s) · {formatBytes(copyJob.bytesCopied)} / {formatBytes(copyJob.totalBytes)} ({copyJob.overallPercent}%)
              </span>
            </div>
            <div className="transfer-controls">
              {copyJob.status === 'running' && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleSuspendCopy} title="Suspend (pause) copy">
                  <Pause size={14} /> Suspend
                </button>
              )}
              {copyJob.status === 'suspended' && (
                <button type="button" className="btn btn-primary btn-sm" onClick={handleResumeCopy} title="Resume copy">
                  <Play size={14} /> Resume
                </button>
              )}
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleCancelCopy} title="Cancel copy">
                <X size={14} /> Cancel
              </button>
            </div>
          </div>

          <div className="transfer-progress-bar">
            <div className="transfer-progress-fill" style={{ width: `${copyJob.overallPercent}%` }} />
          </div>

          {copyJob.currentFile && (
            <div className="transfer-file-details">
              <span title={copyJob.currentFile}>Current: <code>{copyJob.currentFile}</code> ({copyJob.filePercent}%)</span>
              <span>Speed: {copyJob.speedMB} MB/s · ETA: {copyJob.eta}</span>
            </div>
          )}
        </div>
      )}

      <div className={`commander-operation-note${copyState?.phase === 'error' || conversionState?.phase === 'error' ? ' commander-operation-note-error' : ''}`}>
        {copyState?.phase === 'copying' || conversionState?.phase === 'converting'
          ? <LoaderCircle size={16} className="animate-spin" />
          : copyState?.phase === 'error' || conversionState?.phase === 'error'
            ? <CircleAlert size={16} />
            : <CheckCircle2 size={16} />}
        <span>{operationStatus}</span>
      </div>

      <div className="commander-list-toolbar">
        <div className="search-box commander-search-box">
          <Search size={17} color="#94a3b8" />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Filter both directories..." />
        </div>
        <div className="commander-selection-actions">
          <span>{selectedCount} item(s) selected across both panels</span>
          <button type="button" onClick={() => { selectAll('left'); selectAll('right'); }} disabled={!panels.left.entries.length && !panels.right.entries.length}>Select both</button>
          <button type="button" onClick={() => { clearSelection('left'); clearSelection('right'); }} disabled={!selectedCount}>Clear both</button>
        </div>
      </div>

      <div className="commander-panels" aria-label="Commander local file panels">
        {PANEL_KEYS.map(panelKey => (
          <CommanderPanel
            key={panelKey}
            panelKey={panelKey}
            panel={panels[panelKey]}
            draftPath={pathDrafts[panelKey]}
            visibleEntries={visibleEntries[panelKey]}
            active={activePanel === panelKey}
            loading={loadingPanel[panelKey]}
            onActivatePanel={activatePanel}
            onPathChange={(key, value) => setPathDrafts(current => ({ ...current, [key]: value }))}
            onPathSubmit={key => loadPanel(key, pathDrafts[key])}
            onUp={key => loadPanel(key, panels[key].parentPath)}
            onRefresh={key => loadPanel(key, panels[key].path)}
            onSelectAll={selectAll}
            onClearSelection={clearSelection}
            onActivateEntry={activateEntry}
            onToggle={toggleSelection}
            onOpenDirectory={openDirectory}
            onPreviewImage={openPngPreview}
            onKeyDown={handlePanelKeyDown}
          />
        ))}
      </div>

      <p className="commander-footnote"><strong>Enter a path</strong> to open any server-local directory. Double-click a folder to enter it or a PNG to preview it, <strong>Tab</strong> switches panels, <strong>Space</strong> selects the current entry, and <strong>Copy as...</strong> converts selected PDFs to 300 DPI PNG page images in the opposite panel.</p>

      {previewFile && <ServerPngPreview file={previewFile} onClose={() => setPreviewFile(null)} />}
    </div>
  );
}
