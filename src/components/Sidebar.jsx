import { useEffect, useState } from 'react';
import { Folder, UploadCloud, ShieldCheck, Cloud, KeyRound } from 'lucide-react';
import { STORAGE_DISPLAY_LIMIT_MB } from '../config';

export default function Sidebar({ activeTab, setActiveTab, stats, authToken, onAuthTokenChange }) {
  const [draftToken, setDraftToken] = useState(authToken);
  const usedMB = stats ? (stats.totalSize / (1024 * 1024)).toFixed(2) : 0;
  const maxMB = STORAGE_DISPLAY_LIMIT_MB;
  const pct = maxMB > 0 ? Math.min(100, Math.round((usedMB / maxMB) * 100)) : 0;

  useEffect(() => {
    setDraftToken(authToken);
  }, [authToken]);

  const commitToken = () => {
    if (draftToken !== authToken) onAuthTokenChange(draftToken);
  };

  return (
    <aside className="sidebar">
      <div>
        <div className="brand">
          <div className="brand-icon">
            <Cloud size={24} />
          </div>
          <div className="brand-text">
            <h2>CloudVault</h2>
            <span className="badge">React + Vite + SHA-256</span>
          </div>
        </div>

        <nav className="nav-menu">
          <button
            className={`nav-item ${activeTab === 'repository' ? 'active' : ''}`}
            onClick={() => setActiveTab('repository')}
          >
            <Folder size={18} /> File Repository
          </button>
          <button
            className={`nav-item ${activeTab === 'ws-uploader' ? 'active' : ''}`}
            onClick={() => setActiveTab('ws-uploader')}
          >
            <UploadCloud size={18} /> WebSocket Uploader
          </button>
          <button
            className={`nav-item ${activeTab === 'hash-audit' ? 'active' : ''}`}
            onClick={() => setActiveTab('hash-audit')}
          >
            <ShieldCheck size={18} /> Hash Audit Report
          </button>
        </nav>
      </div>

      <div className="storage-widget">
        <div className="widget-header">
          <span>Storage Stats</span>
          <span>{pct}%</span>
        </div>
        <div className="progress-bar-bg">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }}></div>
        </div>
        <div className="storage-meta">
          <span>{usedMB} MB used</span>
          <span>{maxMB > 0 ? `${maxMB} MB Limit` : 'No configured limit'}</span>
        </div>
        <label className="auth-token-field">
          <span><KeyRound size={14} /> API token</span>
          <input
            type="password"
            value={draftToken}
            onChange={(event) => setDraftToken(event.target.value)}
            onBlur={commitToken}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            placeholder="Optional"
            autoComplete="off"
          />
        </label>
      </div>
    </aside>
  );
}
