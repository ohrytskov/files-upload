export const AUTH_TOKEN_STORAGE_KEY = 'cloudvault-auth-token';

export function getAuthToken() {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '';
}

export function setAuthToken(token) {
  if (typeof window === 'undefined') return;

  const normalized = typeof token === 'string' ? token.trim() : '';
  if (normalized) {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, normalized);
  } else {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  }
}

export function apiFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  const token = getAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  return fetch(input, { ...init, headers });
}
