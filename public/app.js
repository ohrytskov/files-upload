document.addEventListener('DOMContentLoaded', () => {
  // State management
  let filesData = [];
  let currentCategory = 'all';
  let searchQuery = '';
  let currentSort = 'date-desc';
  let viewMode = 'grid'; // 'grid' | 'list'

  // DOM Elements
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const triggerUploadBtn = document.getElementById('trigger-upload-btn');
  const filesContainer = document.getElementById('files-container');
  const emptyState = document.getElementById('empty-state');
  const fileCountBadge = document.getElementById('file-count');
  const searchInput = document.getElementById('search-input');
  const sortSelect = document.getElementById('sort-select');
  const gridViewBtn = document.getElementById('grid-view-btn');
  const listViewBtn = document.getElementById('list-view-btn');
  const navItems = document.querySelectorAll('.nav-item');
  const uploadProgressContainer = document.getElementById('upload-progress-container');
  const uploadProgressBar = document.getElementById('upload-progress-bar');
  const uploadStatusText = document.getElementById('upload-status-text');
  const uploadPercentText = document.getElementById('upload-percent');

  // Storage Stats Elements
  const storageBar = document.getElementById('storage-bar');
  const storagePercentage = document.getElementById('storage-percentage');
  const storageUsedText = document.getElementById('storage-used-text');

  // Preview Modal Elements
  const previewModal = document.getElementById('preview-modal');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const modalFilename = document.getElementById('modal-filename');
  const modalIcon = document.getElementById('modal-icon');
  const modalBody = document.getElementById('modal-body-content');
  const modalDownloadBtn = document.getElementById('modal-download-btn');
  const modalSize = document.getElementById('modal-size');
  const modalDate = document.getElementById('modal-date');
  const modalType = document.getElementById('modal-type');

  // Rename Modal Elements
  const renameModal = document.getElementById('rename-modal');
  const renameCloseBtn = document.getElementById('rename-close-btn');
  const renameCancelBtn = document.getElementById('rename-cancel-btn');
  const renameSaveBtn = document.getElementById('rename-save-btn');
  const renameInput = document.getElementById('rename-input');
  const renameOldName = document.getElementById('rename-old-name');

  // Init
  fetchFiles();
  fetchStats();

  // Event Listeners - Navigation / Filter
  navItems.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.category) {
        navItems.forEach(b => { if (b.dataset.category) b.classList.remove('active'); });
        btn.classList.add('active');
        currentCategory = btn.dataset.category;
        renderFiles();
      }
    });
  });

  // Search & Sort
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    renderFiles();
  });

  sortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderFiles();
  });

  // View Toggle
  gridViewBtn.addEventListener('click', () => {
    viewMode = 'grid';
    gridViewBtn.classList.add('active');
    listViewBtn.classList.remove('active');
    filesContainer.className = 'files-container grid-layout';
  });

  listViewBtn.addEventListener('click', () => {
    viewMode = 'list';
    listViewBtn.classList.add('active');
    gridViewBtn.classList.remove('active');
    filesContainer.className = 'files-container list-layout';
  });

  // Dropzone & Upload Listeners
  triggerUploadBtn.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('click', (e) => {
    if (e.target.closest('#upload-progress-container')) return;
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      uploadFiles(fileInput.files);
    }
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length > 0) {
      uploadFiles(droppedFiles);
    }
  });

  // Modal Closures
  modalCloseBtn.addEventListener('click', () => previewModal.classList.add('hidden'));
  previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) previewModal.classList.add('hidden');
  });

  renameCloseBtn.addEventListener('click', () => renameModal.classList.add('hidden'));
  renameCancelBtn.addEventListener('click', () => renameModal.classList.add('hidden'));
  renameSaveBtn.addEventListener('click', submitRename);

  // Core API Functions
  async function fetchFiles() {
    try {
      const res = await fetch('/api/files');
      const data = await res.json();
      if (res.ok) {
        filesData = data.files || [];
        renderFiles();
      } else {
        showToast(data.error || 'Failed to fetch files', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Server connection error', 'error');
    }
  }

  async function fetchStats() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      if (res.ok) {
        const usedMB = (data.totalSize / (1024 * 1024)).toFixed(2);
        const maxMB = 100;
        const pct = Math.min(100, Math.round((data.totalSize / (maxMB * 1024 * 1024)) * 100));
        
        storageBar.style.width = `${pct}%`;
        storagePercentage.textContent = `${pct}%`;
        storageUsedText.textContent = `${usedMB} MB used`;
      }
    } catch (err) {
      console.error('Failed to fetch storage stats:', err);
    }
  }

  function uploadFiles(fileList) {
    const formData = new FormData();
    for (let i = 0; i < fileList.length; i++) {
      formData.append('files', fileList[i]);
    }

    uploadProgressContainer.classList.remove('hidden');
    uploadStatusText.textContent = `Uploading ${fileList.length} file(s)...`;
    uploadProgressBar.style.width = '10%';
    uploadPercentText.textContent = '10%';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        uploadProgressBar.style.width = `${percent}%`;
        uploadPercentText.textContent = `${percent}%`;
      }
    };

    xhr.onload = () => {
      uploadProgressContainer.classList.add('hidden');
      fileInput.value = '';
      if (xhr.status === 200) {
        showToast('Files uploaded successfully!', 'success');
        fetchFiles();
        fetchStats();
      } else {
        let response = {};
        try { response = JSON.parse(xhr.responseText); } catch(e){}
        showToast(response.error || 'Upload failed', 'error');
      }
    };

    xhr.onerror = () => {
      uploadProgressContainer.classList.add('hidden');
      fileInput.value = '';
      showToast('Network error during upload', 'error');
    };

    xhr.send(formData);
  }

  async function deleteFile(filename) {
    if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;

    try {
      const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        showToast('File deleted successfully', 'success');
        fetchFiles();
        fetchStats();
      } else {
        showToast(data.error || 'Failed to delete file', 'error');
      }
    } catch (err) {
      showToast('Error deleting file', 'error');
    }
  }

  function openRenameModal(filename) {
    renameOldName.value = filename;
    renameInput.value = filename;
    renameModal.classList.remove('hidden');
    renameInput.focus();
  }

  async function submitRename() {
    const oldName = renameOldName.value;
    const newName = renameInput.value.trim();

    if (!newName || newName === oldName) {
      renameModal.classList.add('hidden');
      return;
    }

    try {
      const res = await fetch(`/api/files/${encodeURIComponent(oldName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('File renamed successfully', 'success');
        renameModal.classList.add('hidden');
        fetchFiles();
      } else {
        showToast(data.error || 'Rename failed', 'error');
      }
    } catch (err) {
      showToast('Error renaming file', 'error');
    }
  }

  // Render & Filter Logic
  function renderFiles() {
    let filtered = filesData.filter(file => {
      // Category filter
      if (currentCategory !== 'all' && file.category !== currentCategory) {
        return false;
      }
      // Search query filter
      if (searchQuery && !file.name.toLowerCase().includes(searchQuery)) {
        return false;
      }
      return true;
    });

    // Sorting
    filtered.sort((a, b) => {
      if (currentSort === 'date-desc') return new Date(b.modifiedAt) - new Date(a.modifiedAt);
      if (currentSort === 'date-asc') return new Date(a.modifiedAt) - new Date(b.modifiedAt);
      if (currentSort === 'name-asc') return a.name.localeCompare(b.name);
      if (currentSort === 'size-desc') return b.size - a.size;
      if (currentSort === 'size-asc') return a.size - b.size;
      return 0;
    });

    fileCountBadge.textContent = `${filtered.length} items`;

    if (filtered.length === 0) {
      filesContainer.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    filesContainer.innerHTML = filtered.map(file => createFileCardHTML(file)).join('');

    // Attach Event Listeners to Cards
    document.querySelectorAll('.file-card').forEach(card => {
      const name = card.dataset.filename;
      const fileObj = filesData.find(f => f.name === name);

      card.querySelector('.preview-trigger')?.addEventListener('click', () => openPreviewModal(fileObj));
      card.querySelector('.delete-btn')?.addEventListener('click', () => deleteFile(name));
      card.querySelector('.rename-btn')?.addEventListener('click', () => openRenameModal(name));
      card.querySelector('.copy-btn')?.addEventListener('click', () => {
        const fullUrl = window.location.origin + fileObj.url;
        navigator.clipboard.writeText(fullUrl);
        showToast('Link copied to clipboard!', 'info');
      });
    });
  }

  function createFileCardHTML(file) {
    const iconClass = getCategoryIcon(file.category);
    const formattedSize = formatBytes(file.size);
    const dateStr = new Date(file.modifiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    let previewContent = `<i class="${iconClass} file-icon-large"></i>`;
    if (file.category === 'image') {
      previewContent = `<img src="${file.url}" alt="${file.name}" loading="lazy" />`;
    }

    return `
      <div class="file-card" data-filename="${escapeHtml(file.name)}">
        <div class="file-card-preview preview-trigger" style="cursor: pointer;">
          ${previewContent}
        </div>
        <div class="file-card-info">
          <div class="file-card-name preview-trigger" style="cursor: pointer;" title="${escapeHtml(file.name)}">
            ${escapeHtml(file.name)}
          </div>
          <div class="file-card-meta">
            <span>${formattedSize}</span>
            <span>${dateStr}</span>
          </div>
        </div>
        <div class="file-card-actions">
          <button class="file-action-btn copy-btn" title="Copy URL"><i class="ri-link"></i></button>
          <button class="file-action-btn rename-btn" title="Rename"><i class="ri-edit-line"></i></button>
          <a href="${file.url}" download class="file-action-btn" title="Download"><i class="ri-download-2-line"></i></a>
          <button class="file-action-btn delete-btn" title="Delete"><i class="ri-delete-bin-line"></i></button>
        </div>
      </div>
    `;
  }

  async function openPreviewModal(file) {
    modalFilename.textContent = file.name;
    modalDownloadBtn.href = file.url;
    modalSize.textContent = `Size: ${formatBytes(file.size)}`;
    modalDate.textContent = `Modified: ${new Date(file.modifiedAt).toLocaleString()}`;
    modalType.textContent = `Type: ${file.category.toUpperCase()} (${file.extension})`;
    modalIcon.className = `file-category-icon ${getCategoryIcon(file.category)}`;

    modalBody.innerHTML = '<div style="color: var(--text-muted);">Loading preview...</div>';
    previewModal.classList.remove('hidden');

    if (file.category === 'image') {
      modalBody.innerHTML = `<img src="${file.url}" alt="${escapeHtml(file.name)}" />`;
    } else if (file.category === 'audio') {
      modalBody.innerHTML = `<audio controls src="${file.url}" style="width: 100%; max-width: 500px;"></audio>`;
    } else if (file.category === 'video') {
      modalBody.innerHTML = `<video controls src="${file.url}" style="width: 100%; max-width: 650px;"></video>`;
    } else if (file.category === 'code' || file.extension === '.txt' || file.extension === '.md' || file.extension === '.csv') {
      try {
        const res = await fetch(file.url);
        const text = await res.text();
        modalBody.innerHTML = `<pre><code>${escapeHtml(text.slice(0, 10000))}</code></pre>`;
      } catch (e) {
        modalBody.innerHTML = '<p style="color: var(--text-muted);">Unable to load text preview.</p>';
      }
    } else {
      modalBody.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 40px 0;">
          <i class="${getCategoryIcon(file.category)}" style="font-size: 4rem; display: block; margin-bottom: 12px; color: var(--accent-primary);"></i>
          <p>Preview not available for this file type.</p>
          <a href="${file.url}" download class="btn btn-primary" style="margin-top: 16px;">Download to View</a>
        </div>
      `;
    }
  }

  // Helpers
  function getCategoryIcon(cat) {
    switch (cat) {
      case 'image': return 'ri-image-2-fill';
      case 'document': return 'ri-file-text-fill';
      case 'code': return 'ri-code-s-slash-line';
      case 'audio': return 'ri-music-2-fill';
      case 'video': return 'ri-video-fill';
      case 'archive': return 'ri-zip-fill';
      default: return 'ri-file-3-line';
    }
  }

  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, function(m) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      }[m];
    });
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let icon = 'ri-information-line';
    if (type === 'success') icon = 'ri-checkbox-circle-fill';
    if (type === 'error') icon = 'ri-error-warning-fill';

    toast.innerHTML = `<i class="${icon}"></i><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }
});
