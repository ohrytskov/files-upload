import { useEffect, useState } from 'react';
import { X, ZoomIn, ZoomOut } from 'lucide-react';
import { apiFetch } from '../utils/api';

const ZOOM_LEVELS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function formatBytes(bytes) {
  if (!bytes) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / (1024 ** index)).toFixed(2))} ${units[index]}`;
}

export default function ServerPngPreview({ file, onClose }) {
  const [image, setImage] = useState({ phase: 'loading', url: null, error: null });
  const [dimensions, setDimensions] = useState(null);
  const [zoomIndex, setZoomIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = null;
    setImage({ phase: 'loading', url: null, error: null });
    setDimensions(null);
    setZoomIndex(0);

    apiFetch('/api/local/preview/png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file.path }),
      signal: controller.signal
    })
      .then(async response => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || 'Could not load this PNG preview.');
        }
        return response.blob();
      })
      .then(blob => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ phase: 'ready', url: objectUrl, error: null });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setImage({ phase: 'error', url: null, error: error.message || 'Could not load this PNG preview.' });
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.path]);

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const zoom = ZOOM_LEVELS[zoomIndex];
  const canZoom = image.phase === 'ready' && dimensions;
  const setActualSize = () => setZoomIndex(ZOOM_LEVELS.indexOf(1));

  return (
    <div
      className="commander-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`PNG preview: ${file.name}`}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="commander-preview-card">
        <header className="commander-preview-header">
          <div className="commander-preview-title">
            <strong title={file.name}>{file.name}</strong>
            <span>
              {dimensions
                ? `${dimensions.width.toLocaleString()} × ${dimensions.height.toLocaleString()} px · ${formatBytes(file.size)}`
                : formatBytes(file.size)}
            </span>
          </div>
          <div className="commander-preview-controls" aria-label="Image zoom controls">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setZoomIndex(index => Math.max(1, index - 1))} disabled={!canZoom || zoomIndex <= 1} aria-label="Zoom out" title="Zoom out">
              <ZoomOut size={16} />
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setZoomIndex(0)} disabled={!canZoom || zoomIndex === 0}>
              Fit
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={setActualSize} disabled={!canZoom || zoom === 1}>
              100%
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setZoomIndex(index => index === 0 ? ZOOM_LEVELS.indexOf(1) : Math.min(ZOOM_LEVELS.length - 1, index + 1))} disabled={!canZoom || zoomIndex === ZOOM_LEVELS.length - 1} aria-label="Zoom in" title="Zoom in">
              <ZoomIn size={16} />
            </button>
            <span className="commander-preview-zoom-value">{zoom === 0 ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close preview" title="Close preview">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="commander-preview-viewport">
          {image.phase === 'loading' && <p className="commander-preview-message">Loading full-resolution PNG…</p>}
          {image.phase === 'error' && <p className="commander-preview-message commander-preview-error">{image.error}</p>}
          {image.phase === 'ready' && image.url && (
            <div
              className={`commander-preview-stage${zoom === 0 ? ' commander-preview-stage-fit' : ' commander-preview-stage-zoomed'}`}
              style={zoom === 0 || !dimensions ? undefined : {
                width: `${Math.round(dimensions.width * zoom)}px`,
                height: `${Math.round(dimensions.height * zoom)}px`
              }}
            >
              <img
                src={image.url}
                alt={file.name}
                draggable="false"
                onLoad={event => setDimensions({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight
                })}
                onError={() => setImage({ phase: 'error', url: null, error: 'The PNG could not be decoded by this browser.' })}
                style={zoom === 0 ? undefined : {
                  width: dimensions ? `${Math.round(dimensions.width * zoom)}px` : 'auto',
                  height: dimensions ? `${Math.round(dimensions.height * zoom)}px` : 'auto'
                }}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
