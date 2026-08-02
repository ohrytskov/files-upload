import React from 'react';
import { Folder, UploadCloud, ShieldCheck, Cloud } from 'lucide-react';

export default function Sidebar({ activeTab, setActiveTab, stats }) {
  const usedMB = stats ? (stats.totalSize / (1024 * 1024)).toFixed(2) : 0;
  const maxMB = 100;
  const pct = Math.min(100, Math.round((usedMB / maxMB) * 100));

  return (
    <aside className="sidebar">
      <div>
        <div className="brand">
          <div className="brand-icon">
            <Cloud size={24} />
          </div>
          <div className="brand-text">
            <h2>CloudVault</h2>
            <span className="badge">React + Vite + MD5</span>
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
            <ShieldCheck size={18} /> MD5 Audit Report
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
          <span>100 MB Limit</span>
        </div>
      </div>
    </aside>
  );
}
