import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';

export default function RenameModal({ file, onClose, onSave }) {
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (file) setNewName(file.name);
  }, [file]);

  if (!file) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (newName.trim() && newName.trim() !== file.name) {
      onSave(file.name, newName.trim());
    } else {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: '420px' }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Rename File</h3>
          <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <label style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Enter new file name:</label>
            <input
              type="text"
              className="text-input"
              style={{ marginTop: '8px' }}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </div>

          <footer style={{ padding: '16px 24px', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Save Changes</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
