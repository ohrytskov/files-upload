import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileWarning,
  FolderOpen,
  RefreshCw,
  Server,
  ShieldCheck
} from 'lucide-react';
import { apiFetch } from '../utils/api';
import { hashFile } from '../utils/md5';
import { AUDIT_PAGE_SIZE, DEFAULT_HASH_ALGORITHM } from '../config';

const PAGE_SIZE = AUDIT_PAGE_SIZE;

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
      : browserPath).trim();

    if (!relativePath || seen.has(relativePath)) {
      throw new Error(`Duplicate or invalid local path: ${browserPath}`);
    }
    seen.add(relativePath);

    return {
      file,
      relativePath,
      size: file.size
    };
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / (1024 ** index)).toFixed(2))} ${units[index]}`;
}

function statusLabel(status) {
  switch (status) {
    case 'match': return 'Match';
    case 'mismatch': return 'Hash/size mismatch';
    case 'missing-on-server': return 'Missing on server';
    case 'server-only': return 'Server-only';
    default: return status;
  }
}

export default function MD5AuditReport({ onNotify }) {
  const [algorithm, setAlgorithm] = useState(DEFAULT_HASH_ALGORITHM);
  const [localSelection, setLocalSelection] = useState(null);
  const [serverDirectories, setServerDirectories] = useState([]);
  const [serverRoot, setServerRoot] = useState('configured root');
  const [serverDirectory, setServerDirectory] = useState('.');
  const [auditData, setAuditData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    let active = true;

    const loadServerDirectories = async () => {
      try {
        const response = await apiFetch('/api/hash/directories');
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not list server directories');

        const directories = Array.isArray(data.directories) ? data.directories : [];
        if (!active) return;
        setServerRoot(data.root || 'configured root');
        setServerDirectories(directories);
        setServerDirectory(current => (
          directories.some(directory => directory.value === current)
            ? current
            : directories[0]?.value || '.'
        ));
      } catch (error) {
        if (active) onNotify?.(error.message, 'error');
      }
    };

    loadServerDirectories();
    return () => { active = false; };
  }, []);

  const handleLocalDirectoryChange = (event) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length === 0) {
      onNotify?.('No local files were selected for the audit.', 'info');
      return;
    }

    if (loading) {
      onNotify?.('Wait for the current audit to finish before changing the local directory.', 'warning');
      event.target.value = '';
      return;
    }

    try {
      const files = prepareLocalFiles(selectedFiles);
      const rootPath = getBrowserPath(selectedFiles[0]);
      const rootName = rootPath.includes('/') ? rootPath.split('/')[0] : 'selected files';
      setLocalSelection({ rootName, files });
      setAuditData(null);
      setPage(1);
      setProgress('');
      onNotify?.(`${files.length} local file(s) are ready for comparison.`, 'success');
    } catch (error) {
      setLocalSelection(null);
      onNotify?.(error.message, 'error');
    }
  };

  const runAudit = async () => {
    if (!localSelection?.files?.length) {
      onNotify?.('Select a local directory before running the audit.', 'warning');
      return;
    }

    if (serverDirectories.length === 0) {
      onNotify?.('No server directories are available. Check the configured hash-scan root.', 'error');
      return;
    }

    setLoading(true);
    setAuditData(null);
    setPage(1);

    try {
      const localFiles = [];
      for (let index = 0; index < localSelection.files.length; index += 1) {
        const localFile = localSelection.files[index];
        setProgress(`Hashing local files: ${index + 1}/${localSelection.files.length}`);
        const hash = await hashFile(localFile.file, algorithm);
        localFiles.push({
          relativePath: localFile.relativePath,
          size: localFile.size,
          hash
        });
      }

      setProgress('Hashing the selected server directory...');
      const response = await apiFetch('/api/hash/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: serverDirectory || '.', algorithm })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Server directory hash scan failed');

      const serverFiles = (data.files || []).map(file => ({
        relativePath: file.relativePath,
        size: file.size,
        hash: file.hash
      }));
      const localByPath = new Map(localFiles.map(file => [file.relativePath, file]));
      const serverByPath = new Map(serverFiles.map(file => [file.relativePath, file]));
      const paths = [...new Set([...localByPath.keys(), ...serverByPath.keys()])]
        .sort((a, b) => a.localeCompare(b));

      let matchCount = 0;
      let mismatchCount = 0;
      let missingCount = 0;
      let serverOnlyCount = 0;
      const results = paths.map(relativePath => {
        const localFile = localByPath.get(relativePath);
        const serverFile = serverByPath.get(relativePath);
        let status;

        if (!serverFile) {
          status = 'missing-on-server';
          missingCount += 1;
        } else if (!localFile) {
          status = 'server-only';
          serverOnlyCount += 1;
        } else if (localFile.size === serverFile.size && localFile.hash === serverFile.hash) {
          status = 'match';
          matchCount += 1;
        } else {
          status = 'mismatch';
          mismatchCount += 1;
        }

        return {
          relativePath,
          localSize: localFile?.size ?? null,
          serverSize: serverFile?.size ?? null,
          localHash: localFile?.hash ?? null,
          serverHash: serverFile?.hash ?? null,
          status,
          match: status === 'match'
        };
      });

      setAuditData({
        algorithm,
        totalFiles: results.length,
        matchCount,
        mismatchCount,
        missingCount,
        serverOnlyCount,
        results
      });
      setProgress(`Compared ${results.length} file(s) using ${algorithm.toUpperCase()}`);
      onNotify?.(`Audit completed: ${results.length} path(s) compared using ${algorithm.toUpperCase()}.`, 'success');
    } catch (error) {
      setProgress('');
      onNotify?.(error.message || 'Directory audit failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  const results = auditData?.results || [];
  const pageCount = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const visibleResults = results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(currentPage => Math.min(currentPage, pageCount));
  }, [pageCount]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
        <div>
          <h2>Directory Hash Audit</h2>
          <p style={{ color: '#94a3b8', fontSize: '0.9rem', marginTop: '4px' }}>
            Compare a local directory with a directory below the server&apos;s configured hash-scan root.
          </p>
        </div>
        <button className="btn btn-primary" onClick={runAudit} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Run Full Audit
        </button>
      </header>

      <div className="card">
        <div className="form-grid">
          <div className="form-group">
            <label><FolderOpen size={15} /> Local directory:</label>
            <input
              type="file"
              className="text-input"
              multiple
              webkitdirectory="true"
              directory="true"
              onChange={handleLocalDirectoryChange}
            />
            <small>
              {localSelection
                ? `${localSelection.rootName}: ${localSelection.files.length} file(s) selected`
                : 'Choose the local directory to compare'}
            </small>
          </div>

          <div className="form-group">
            <label><Server size={15} /> Server directory:</label>
            <select
              className="text-input"
              value={serverDirectory}
              onChange={event => { setServerDirectory(event.target.value); setAuditData(null); }}
              disabled={loading || serverDirectories.length === 0}
            >
              {serverDirectories.length === 0 ? (
                <option value=".">No server directories available</option>
              ) : serverDirectories.map(directory => (
                <option key={directory.value} value={directory.value}>{directory.label}</option>
              ))}
            </select>
            <small>Root: {serverRoot}. Directory contents are compared by relative path.</small>
          </div>

          <div className="form-group">
            <label>Hash algorithm:</label>
            <select
              className="text-input"
              value={algorithm}
              onChange={event => { setAlgorithm(event.target.value); setAuditData(null); }}
              disabled={loading}
            >
              <option value="sha256">SHA-256 (recommended)</option>
              <option value="md5">MD5 (legacy compatibility)</option>
            </select>
            <small>Both sides are hashed during the audit.</small>
          </div>
        </div>
        {progress && <p className="card-subtitle" style={{ marginTop: '16px' }}>{progress}</p>}
      </div>

      <div className="audit-metrics" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div className="audit-card">
          <ShieldCheck size={32} color="#818cf8" />
          <div><h4>{auditData?.totalFiles || 0}</h4><p>Total paths</p></div>
        </div>
        <div className="audit-card">
          <CheckCircle2 size={32} color="#34d399" />
          <div><h4>{auditData?.matchCount || 0}</h4><p>Matches</p></div>
        </div>
        <div className="audit-card">
          <AlertCircle size={32} color="#f87171" />
          <div><h4>{auditData?.mismatchCount || 0}</h4><p>Mismatches</p></div>
        </div>
        <div className="audit-card">
          <FileWarning size={32} color="#f59e0b" />
          <div><h4>{auditData?.missingCount || 0}</h4><p>Missing on server</p></div>
        </div>
        <div className="audit-card">
          <Server size={32} color="#38bdf8" />
          <div><h4>{auditData?.serverOnlyCount || 0}</h4><p>Server-only</p></div>
        </div>
      </div>

      <div className="card">
        <h3>{auditData ? `${auditData.algorithm.toUpperCase()} comparison` : 'Comparison report'}</h3>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Relative path</th>
                <th>Local size</th>
                <th>Server size</th>
                <th>Local hash</th>
                <th>Server hash</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleResults.length > 0 ? visibleResults.map(result => (
                <tr key={result.relativePath}>
                  <td><strong>{result.relativePath}</strong></td>
                  <td>{result.localSize === null ? '--' : formatBytes(result.localSize)}</td>
                  <td>{result.serverSize === null ? '--' : formatBytes(result.serverSize)}</td>
                  <td><code>{result.localHash || '--'}</code></td>
                  <td><code>{result.serverHash || '--'}</code></td>
                  <td>
                    <span className={`status-chip ${result.status === 'match' ? 'success' : result.status === 'mismatch' ? 'danger' : 'warning'}`}>
                      {statusLabel(result.status)}
                    </span>
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="6" style={{ textAlign: 'center', color: '#94a3b8' }}>
                    {loading ? 'Running audit...' : 'Select both directories and run the audit.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {results.length > PAGE_SIZE && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
            <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(current => current - 1)}>
              Previous
            </button>
            <span style={{ color: '#94a3b8' }}>Page {page} of {pageCount}</span>
            <button className="btn btn-secondary" disabled={page >= pageCount} onClick={() => setPage(current => current + 1)}>
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
