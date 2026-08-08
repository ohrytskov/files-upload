function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const configuredHashAlgorithm = String(import.meta.env.VITE_DEFAULT_HASH_ALGORITHM || 'sha256').toLowerCase();

export const DEFAULT_HASH_ALGORITHM = configuredHashAlgorithm === 'md5' || configuredHashAlgorithm === 'sha256'
  ? configuredHashAlgorithm
  : 'sha256';
export const UPLOAD_CHUNK_SIZE = readPositiveNumber(import.meta.env.VITE_UPLOAD_CHUNK_SIZE, 4 * 1024 * 1024);
export const MAX_FILE_RETRIES = readPositiveNumber(import.meta.env.VITE_MAX_FILE_RETRIES, 3);
export const AUDIT_PAGE_SIZE = readPositiveNumber(import.meta.env.VITE_AUDIT_PAGE_SIZE, 100);
export const REPOSITORY_PAGE_SIZE = readPositiveNumber(import.meta.env.VITE_REPOSITORY_PAGE_SIZE, 100);
export const UPLOAD_QUEUE_PAGE_SIZE = readPositiveNumber(import.meta.env.VITE_UPLOAD_QUEUE_PAGE_SIZE, 100);
export const TEXT_PREVIEW_MAX_BYTES = readPositiveNumber(import.meta.env.VITE_TEXT_PREVIEW_MAX_BYTES, 2 * 1024 * 1024);
export const STORAGE_DISPLAY_LIMIT_MB = Number.isFinite(Number(import.meta.env.VITE_STORAGE_DISPLAY_LIMIT_MB))
  ? Math.max(0, Number(import.meta.env.VITE_STORAGE_DISPLAY_LIMIT_MB))
  : 100;
