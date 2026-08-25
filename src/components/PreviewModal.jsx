import { useEffect, useState } from 'react';
import { X, Download, File } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { TEXT_PREVIEW_MAX_BYTES } from '../config';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.log', '.xml', '.yaml', '.yml', '.ini', '.conf',
  '.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css', '.py', '.java',
  '.cpp', '.c', '.sh', '.php'
]);
const IMAGE_EXTENSIONS = new Set(['.apng', '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav', '.weba']);
const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.webm', '.wmv']);

function isTextFile(file) {
  const extension = getFileExtension(file);
  return getFileCategory(file) === 'code' || TEXT_EXTENSIONS.has(extension);
}

function getFileName(file) {
  return file?.name || file?.relativePath || file?.file?.name || 'File';
}

function getFileExtension(file) {
  if (file?.extension) return file.extension.toLowerCase();
  const name = getFileName(file);
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : '';
}

function getFileCategory(file) {
  if (file?.category) return file.category;

  const mimeType = file?.file?.type || '';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('javascript')) return 'code';
  const extension = getFileExtension(file);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (TEXT_EXTENSIONS.has(extension)) return 'code';
  return 'other';
}

export default function PreviewModal({ file, onClose, onNotify }) {
  const [textContent, setTextContent] = useState('');
  const [textState, setTextState] = useState('idle');
  const [previewUrl, setPreviewUrl] = useState(null);

  useEffect(() => {
    let objectUrl = null;
    setPreviewUrl(null);

    if (!file) return () => {};
    if (file.url) {
      setPreviewUrl(file.url);
      return () => {};
    }
    if (file.file && typeof URL !== 'undefined' && URL.createObjectURL) {
      objectUrl = URL.createObjectURL(file.file);
      setPreviewUrl(objectUrl);
    }

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  useEffect(() => {
    let cancelled = false;
    setTextContent('');
    setTextState('idle');

    if (!file || !previewUrl || !isTextFile(file)) return () => { cancelled = true; };
    const fileSize = file.size ?? file.file?.size ?? 0;
    if (fileSize > TEXT_PREVIEW_MAX_BYTES) {
      setTextState('too-large');
      return () => { cancelled = true; };
    }

    setTextState('loading');
    const loadPreview = file.file ? fetch(previewUrl) : apiFetch(previewUrl);
    loadPreview
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
        if (!cancelled) {
          setTextState('error');
          onNotify?.(`Unable to load the preview for ${getFileName(file)}.`, 'error');
        }
    });

    return () => { cancelled = true; };
  }, [file, previewUrl, onNotify]);

  if (!file) return null;

  const fileName = getFileName(file);
  const fileCategory = getFileCategory(file);
  const fileSize = file.size ?? file.file?.size ?? 0;
  const downloadUrl = previewUrl || file.url;

  const formatBytes = (bytes) => {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={`Preview ${fileName}`} onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <File size={22} color="#818cf8" />
            <h3>{fileName}</h3>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <a href={downloadUrl} download className="btn btn-secondary" style={{ padding: '6px 12px' }}>
              <Download size={16} />
            </a>
            <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="modal-body" style={{ textAlign: 'center' }}>
          {fileCategory === 'image' && previewUrl ? (
            <img
              src={previewUrl}
              alt={fileName}
              style={{ maxWidth: '100%', maxHeight: '50vh', borderRadius: '8px' }}
              onError={() => onNotify?.(`Unable to load the preview for ${fileName}.`, 'error')}
            />
          ) : fileCategory === 'audio' && previewUrl ? (
            <audio
              controls
              src={previewUrl}
              style={{ width: '100%', marginTop: '20px' }}
              onError={() => onNotify?.(`Unable to load the preview for ${fileName}.`, 'error')}
            ></audio>
          ) : fileCategory === 'video' && previewUrl ? (
            <video
              controls
              src={previewUrl}
              style={{ maxWidth: '100%', maxHeight: '50vh' }}
              onError={() => onNotify?.(`Unable to load the preview for ${fileName}.`, 'error')}
            ></video>
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
              <a href={downloadUrl} download className="btn btn-primary" style={{ marginTop: '16px', display: 'inline-flex' }}>
                Download to View File
              </a>
            </div>
          )}
        </div>

        <footer style={{ padding: '16px 24px', background: 'rgba(0,0,0,0.2)', display: 'flex', gap: '12px', fontSize: '0.82rem', color: '#94a3b8' }}>
          <div>Size: {formatBytes(fileSize)}</div>
          <div>Category: {fileCategory}</div>
          <div>{(file.hashAlgorithm || (file.md5 ? 'md5' : 'sha256')).toUpperCase()}: <code>{file.hash || file.md5 || 'N/A'}</code></div>
        </footer>
      </div>
    </div>
  );
}
