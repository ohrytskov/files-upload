const path = require('path');
require('./load-env');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function readNumber(name, fallback, minimum = 0) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function readBoolean(name, fallback = false) {
  if (process.env[name] === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name]).toLowerCase());
}

function readHashAlgorithm() {
  const value = String(process.env.DEFAULT_HASH_ALGORITHM || 'sha256').toLowerCase();
  return value === 'md5' || value === 'sha256' ? value : 'sha256';
}

const uploadsDir = path.resolve(
  process.env.UPLOADS_DIR || path.join(PROJECT_ROOT, 'uploads')
);
const stateDbPath = path.resolve(
  process.env.STATE_DB_PATH || path.join(uploadsDir, 'cloudvault.sqlite')
);

module.exports = {
  port: readNumber('PORT', 3000),
  host: process.env.HOST || '127.0.0.1',
  uploadsDir,
  stateDbPath,
  hashScanRoot: path.resolve(process.env.HASH_SCAN_ROOT || uploadsDir),
  authToken: process.env.CLOUDVAULT_AUTH_TOKEN || process.env.AUTH_TOKEN || '',
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '10mb',
  httpUploadMaxFileSize: readNumber('HTTP_UPLOAD_MAX_FILE_SIZE', 100 * 1024 * 1024, 1),
  httpUploadMaxFiles: readNumber('HTTP_UPLOAD_MAX_FILES', 20, 1),
  uploadRateWindowMs: readNumber('UPLOAD_RATE_WINDOW_MS', 60_000, 1),
  uploadRateMax: readNumber('UPLOAD_RATE_MAX', 20, 1),
  apiRateWindowMs: readNumber('API_RATE_WINDOW_MS', 60_000, 1),
  apiRateMax: readNumber('API_RATE_MAX', 120, 1),
  wsConnectionRateMax: readNumber('WS_CONNECTION_RATE_MAX', 20, 1),
  wsConnectionRateWindowMs: readNumber('WS_CONNECTION_RATE_WINDOW_MS', 60_000, 1),
  wsMaxPayload: readNumber('WS_MAX_PAYLOAD', 50 * 1024 * 1024, 1),
  wsMaxChunkSize: readNumber('WS_MAX_CHUNK_SIZE', 4 * 1024 * 1024, 1),
  wsMaxFileSize: readNumber('WS_MAX_FILE_SIZE', 10 * 1024 * 1024 * 1024, 1),
  wsMaxTotalBytes: readNumber('WS_MAX_TOTAL_BYTES', 100 * 1024 * 1024 * 1024, 1),
  wsMaxManifestBytes: readNumber('WS_MAX_MANIFEST_BYTES', 25 * 1024 * 1024, 1),
  wsMaxManifestFiles: readNumber('WS_MAX_MANIFEST_FILES', 250_000, 1),
  wsAuthTimeoutMs: readNumber('WS_AUTH_TIMEOUT_MS', 5_000, 1),
  wsSyncEachChunk: readBoolean('WS_SYNC_EACH_CHUNK', false),
  uploadChunkSize: readNumber('UPLOAD_CHUNK_SIZE', 4 * 1024 * 1024, 1),
  maxFileRetries: readNumber('MAX_FILE_RETRIES', 3, 1),
  stateSaveDebounceMs: readNumber('STATE_SAVE_DEBOUNCE_MS', 1_000, 1),
  defaultHashAlgorithm: readHashAlgorithm(),
  defaultStateFile: process.env.DEFAULT_STATE_FILE || 'state.json',
  auditPageSize: readNumber('AUDIT_PAGE_SIZE', 100, 1),
  repositoryPageSize: readNumber('REPOSITORY_PAGE_SIZE', 100, 1),
  storageDisplayLimitMb: readNumber('STORAGE_DISPLAY_LIMIT_MB', 100, 0)
};
