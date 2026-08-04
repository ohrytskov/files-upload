import React, { useEffect, useState } from 'react';
import { X, Download, File } from 'lucide-react';
import { apiFetch } from '../utils/api';

const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.log', '.xml', '.yaml', '.yml', '.ini', '.conf',
  '.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css', '.py', '.java',
  '.cpp', '.c', '.sh', '.php'
]);

function isTextFile(file) {
  const extension = (file.extension || '').toLowerCase();
  return file.category === 'code' || TEXT_EXTENSIONS.has(extension);
}

export default function PreviewModal({ file, onClose }) {
  const [textContent, setTextContent] = useState('');
  const [textState, setTextState] = useState('idle');

  useEffect(() => {
    let cancelled = false;
    setTextContent('');
    setTextState('idle');

    if (!file || !isTextFile(file)) return () => { cancelled = true; };
    if (file.size > TEXT_PREVIEW_MAX_BYTES) {
      setTextState('too-large');
      return () => { cancelled = true; };
    }

    setTextState('loading');
    apiFetch(file.url)
      .then(response => {
        if (!response.ok) throw new Error('Unable to load file');
        return response.text();
      })
      .then(content => {
        if (!cancelled) {
          setTextContent(content);
          setTextState('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setTextState('error');
      });

    return () => { cancelled = true; };
  }, [file]);

  if (!file) return null;

  const formatBytes = (bytes) => {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <File size={22} color="#818cf8" />
            <h3>{file.name}</h3>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <a href={file.url} download className="btn btn-secondary" style={{ padding: '6px 12px' }}>
              <Download size={16} />
            </a>
            <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="modal-body" style={{ textAlign: 'center' }}>
          {file.category === 'image' ? (
            <img src={file.url} alt={file.name} style={{ maxWidth: '100%', maxHeight: '50vh', borderRadius: '8px' }} />
          ) : file.category === 'audio' ? (
            <audio controls src={file.url} style={{ width: '100%', marginTop: '20px' }}></audio>
          ) : file.category === 'video' ? (
            <video controls src={file.url} style={{ maxWidth: '100%', maxHeight: '50vh' }}></video>
          ) : isTextFile(file) ? (
            <div>
              {textState === 'loading' && <p style={{ color: '#94a3b8' }}>Loading preview...</p>}
              {textState === 'too-large' && <p style={{ color: '#fbbf24' }}>This text file is larger than the 2 MB preview limit.</p>}
              {textState === 'error' && <p style={{ color: '#f87171' }}>Unable to load this text preview.</p>}
              {textState === 'ready' && <pre className="text-preview">{textContent}</pre>}
            </div>
          ) : (
            <div style={{ padding: '40px 0', color: '#94a3b8' }}>
              <File size={64} color="#6366f1" style={{ margin: '0 auto 16px', display: 'block' }} />
              <p>File preview not directly playable in browser.</p>
              <a href={file.url} download className="btn btn-primary" style={{ marginTop: '16px', display: 'inline-flex' }}>
                Download to View File
              </a>
            </div>
          )}
        </div>

        <footer style={{ padding: '16px 24px', background: 'rgba(0,0,0,0.2)', display: 'flex', gap: '12px', fontSize: '0.82rem', color: '#94a3b8' }}>
          <div>Size: {formatBytes(file.size)}</div>
          <div>Category: {file.category}</div>
          <div>MD5: <code>{file.md5 || 'N/A'}</code></div>
        </footer>
      </div>
    </div>
  );
}
