import { beforeEach, describe, expect, it } from 'vitest';
import { getAuthToken, setAuthToken } from './api';

function storageDouble() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
}

describe('browser authentication token storage', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: storageDouble() }
    });
    setAuthToken('');
  });

  it('does not cache a token after localStorage succeeds', () => {
    setAuthToken('first-token');
    expect(getAuthToken()).toBe('first-token');

    window.localStorage.setItem('cloudvault-auth-token', 'changed-in-another-tab');
    expect(getAuthToken()).toBe('changed-in-another-tab');
  });

  it('falls back to an in-memory token when localStorage is unavailable', () => {
    window.localStorage = {
      getItem() { throw new Error('storage blocked'); },
      setItem() { throw new Error('storage blocked'); },
      removeItem() { throw new Error('storage blocked'); }
    };

    setAuthToken('session-only-token');
    expect(getAuthToken()).toBe('session-only-token');

    setAuthToken('');
    expect(getAuthToken()).toBe('');
  });
});
