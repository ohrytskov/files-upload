export const AUTH_TOKEN_STORAGE_KEY = 'cloudvault-auth-token';
let memoryAuthToken = null;
let useMemoryAuthToken = false;

export function getAuthToken() {
  if (typeof window === 'undefined') return '';
  if (useMemoryAuthToken) return memoryAuthToken || '';
  try {
    return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '';
  } catch (error) {
    useMemoryAuthToken = true;
    return memoryAuthToken || '';
  }
}

export function setAuthToken(token) {
  if (typeof window === 'undefined') return;

  const normalized = typeof token === 'string' ? token.trim() : '';
  try {
    if (normalized) {
      window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, normalized);
    } else {
      window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
    memoryAuthToken = null;
    useMemoryAuthToken = false;
  } catch (error) {
    // Private browsing modes can expose localStorage but reject access to it.
    // Authentication still works for the current page via the in-memory token
    // and the same-origin session cookie established by API requests.
    memoryAuthToken = normalized;
    useMemoryAuthToken = true;
  }
}

export function apiFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  const token = getAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  return fetch(input, { ...init, headers });
}
