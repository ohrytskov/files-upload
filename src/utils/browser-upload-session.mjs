export const BROWSER_UPLOAD_SESSION_KEY = 'cloudvault-browser-upload-session';

function getStorage(storage) {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

function getFileMetadata(file) {
  return {
    relativePath: file.relativePath,
    size: Number(file.size),
    lastModified: Number(file.sourceMtimeMs ?? file.lastModified ?? 0),
    hashAlgorithm: file.hashAlgorithm,
    hash: file.hash
  };
}

function sortFiles(files) {
  return files
    .map(getFileMetadata)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function browserUploadSessionMatches(session, files, hashAlgorithm) {
  if (!session || session.hashAlgorithm !== hashAlgorithm || !Array.isArray(session.files)) {
    return false;
  }

  const expected = sortFiles(files);
  const actual = session.files
    .map(getFileMetadata)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return expected.length === actual.length && expected.every((file, index) => {
    const saved = actual[index];
    return saved.relativePath === file.relativePath &&
      saved.size === file.size &&
      saved.lastModified === file.lastModified &&
      saved.hashAlgorithm === file.hashAlgorithm &&
      saved.hash === file.hash;
  });
}

export function loadBrowserUploadSession(storage) {
  const target = getStorage(storage);
  if (!target) return null;

  try {
    const raw = target.getItem(BROWSER_UPLOAD_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.sessionId !== 'string' ||
      !parsed.sessionId ||
      typeof parsed.hashAlgorithm !== 'string' ||
      !Array.isArray(parsed.files)
    ) {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

export function saveBrowserUploadSession(session, storage) {
  const target = getStorage(storage);
  if (!target) return false;

  try {
    target.setItem(BROWSER_UPLOAD_SESSION_KEY, JSON.stringify({
      version: 1,
      sessionId: session.sessionId,
      hashAlgorithm: session.hashAlgorithm,
      files: sortFiles(session.files)
    }));
    return true;
  } catch (error) {
    return false;
  }
}

export function clearBrowserUploadSession(storage) {
  const target = getStorage(storage);
  if (!target) return;

  try {
    target.removeItem(BROWSER_UPLOAD_SESSION_KEY);
  } catch (error) {}
}
