import { describe, expect, it } from 'vitest';
import { hashArrayBuffer, hashFile, md5ArrayBuffer } from './md5';

const content = new TextEncoder().encode('CloudVault browser hashing');

function fileDouble(bytes) {
  return {
    size: bytes.byteLength,
    slice(start, end) {
      return {
        arrayBuffer: async () => bytes.slice(start, end).buffer
      };
    }
  };
}

describe('browser hash utilities', () => {
  it('calculates MD5 and SHA-256 consistently', async () => {
    expect(md5ArrayBuffer(content)).toBe('98f570877a277339013606caaa4f8d64');
    await expect(hashArrayBuffer(content, 'sha256')).resolves.toBe('b830e55d33da22f5fb7a4899c898af2dd4f62aeb12c4691a263578fe0831768f');
  });

  it('hashes a File-like object incrementally', async () => {
    const progress = [];
    await expect(hashFile(fileDouble(content), 'sha256', {
      chunkSize: 5,
      onProgress: update => progress.push(update.offset)
    })).resolves.toBe('b830e55d33da22f5fb7a4899c898af2dd4f62aeb12c4691a263578fe0831768f');
    expect(progress.at(-1)).toBe(content.byteLength);
    expect(progress.length).toBeGreaterThan(1);
  });
});
