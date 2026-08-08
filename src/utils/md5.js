import { DEFAULT_HASH_ALGORITHM, UPLOAD_CHUNK_SIZE } from '../config';

const SHIFT_AMOUNTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

const MD5_K = Array.from({ length: 64 }, (_, index) => (
  Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) | 0
));

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function add32(...values) {
  return values.reduce((sum, value) => (sum + value) | 0, 0);
}

function rotateLeft(value, amount) {
  return (value << amount) | (value >>> (32 - amount));
}

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function wordToLittleEndianHex(word) {
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, word >>> 24]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function wordToBigEndianHex(word) {
  return [(word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

class Md5Hasher {
  constructor() {
    this.state = [0x67452301 | 0, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476 | 0];
    this.buffer = new Uint8Array(0);
    this.totalBytes = 0;
  }

  processBlock(bytes, offset) {
    const words = new Int32Array(16);
    for (let index = 0; index < 16; index++) {
      const position = offset + index * 4;
      words[index] = bytes[position]
        | (bytes[position + 1] << 8)
        | (bytes[position + 2] << 16)
        | (bytes[position + 3] << 24);
    }

    let [a, b, c, d] = this.state;
    for (let index = 0; index < 64; index++) {
      let functionValue;
      let wordIndex;
      if (index < 16) {
        functionValue = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        functionValue = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        functionValue = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        functionValue = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }

      const next = add32(a, functionValue, MD5_K[index], words[wordIndex]);
      const nextB = add32(b, rotateLeft(next, SHIFT_AMOUNTS[index]));
      a = d;
      d = c;
      c = b;
      b = nextB;
    }

    this.state[0] = add32(this.state[0], a);
    this.state[1] = add32(this.state[1], b);
    this.state[2] = add32(this.state[2], c);
    this.state[3] = add32(this.state[3], d);
  }

  update(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.totalBytes += bytes.byteLength;

    let combined;
    if (this.buffer.byteLength > 0) {
      combined = new Uint8Array(this.buffer.byteLength + bytes.byteLength);
      combined.set(this.buffer);
      combined.set(bytes, this.buffer.byteLength);
    } else {
      combined = bytes;
    }

    const completeLength = combined.byteLength - (combined.byteLength % 64);
    for (let offset = 0; offset < completeLength; offset += 64) {
      this.processBlock(combined, offset);
    }
    this.buffer = combined.slice(completeLength);
    return this;
  }

  digest() {
    const paddingLength = (56 - ((this.totalBytes + 1) % 64) + 64) % 64;
    const tail = new Uint8Array(this.buffer.byteLength + 1 + paddingLength + 8);
    tail.set(this.buffer);
    tail[this.buffer.byteLength] = 0x80;

    let bitLength = this.totalBytes * 8;
    const lengthOffset = tail.byteLength - 8;
    for (let index = 0; index < 8; index++) {
      tail[lengthOffset + index] = bitLength & 0xff;
      bitLength = Math.floor(bitLength / 256);
    }

    for (let offset = 0; offset < tail.byteLength; offset += 64) {
      this.processBlock(tail, offset);
    }

    return this.state.map(wordToLittleEndianHex).join('');
  }
}

class Sha256Hasher {
  constructor() {
    this.state = [
      0x6a09e667 | 0, 0xbb67ae85 | 0, 0x3c6ef372 | 0, 0xa54ff53a | 0,
      0x510e527f | 0, 0x9b05688c | 0, 0x1f83d9ab | 0, 0x5be0cd19 | 0
    ];
    this.buffer = new Uint8Array(0);
    this.totalBytes = 0;
  }

  processBlock(bytes, offset) {
    const words = new Int32Array(64);
    for (let index = 0; index < 16; index++) {
      const position = offset + index * 4;
      words[index] = (bytes[position] << 24)
        | (bytes[position + 1] << 16)
        | (bytes[position + 2] << 8)
        | bytes[position + 3];
    }

    for (let index = 16; index < 64; index++) {
      const value1 = rotateRight(words[index - 15], 7)
        ^ rotateRight(words[index - 15], 18)
        ^ (words[index - 15] >>> 3);
      const value2 = rotateRight(words[index - 2], 17)
        ^ rotateRight(words[index - 2], 19)
        ^ (words[index - 2] >>> 10);
      words[index] = add32(value2, words[index - 7], value1, words[index - 16]);
    }

    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index++) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = add32(h, sigma1, choose, SHA256_K[index], words[index]);
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = add32(sigma0, majority);

      h = g;
      g = f;
      f = e;
      e = add32(d, temp1);
      d = c;
      c = b;
      b = a;
      a = add32(temp1, temp2);
    }

    this.state = this.state.map((value, index) => add32(value, [a, b, c, d, e, f, g, h][index]));
  }

  update(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.totalBytes += bytes.byteLength;

    let combined;
    if (this.buffer.byteLength > 0) {
      combined = new Uint8Array(this.buffer.byteLength + bytes.byteLength);
      combined.set(this.buffer);
      combined.set(bytes, this.buffer.byteLength);
    } else {
      combined = bytes;
    }

    const completeLength = combined.byteLength - (combined.byteLength % 64);
    for (let offset = 0; offset < completeLength; offset += 64) {
      this.processBlock(combined, offset);
    }
    this.buffer = combined.slice(completeLength);
    return this;
  }

  digest() {
    const paddingLength = (56 - ((this.totalBytes + 1) % 64) + 64) % 64;
    const tail = new Uint8Array(this.buffer.byteLength + 1 + paddingLength + 8);
    tail.set(this.buffer);
    tail[this.buffer.byteLength] = 0x80;

    const bitLengthLow = (this.totalBytes * 8) >>> 0;
    const bitLengthHigh = Math.floor(this.totalBytes / 0x20000000) >>> 0;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.byteLength - 8, bitLengthHigh, false);
    view.setUint32(tail.byteLength - 4, bitLengthLow, false);

    for (let offset = 0; offset < tail.byteLength; offset += 64) {
      this.processBlock(tail, offset);
    }

    return this.state.map(wordToBigEndianHex).join('');
  }
}

function createHasher(algorithm) {
  const normalized = algorithm.toLowerCase();
  if (normalized === 'md5') return new Md5Hasher();
  if (normalized === 'sha256') return new Sha256Hasher();
  throw new Error(`Unsupported hash algorithm: ${algorithm}`);
}

export function md5ArrayBuffer(arrayBuffer) {
  return new Md5Hasher().update(arrayBuffer).digest();
}

export async function hashArrayBuffer(arrayBuffer, algorithm = DEFAULT_HASH_ALGORITHM) {
  return createHasher(algorithm).update(arrayBuffer).digest();
}

/**
 * Hash a browser File incrementally. Only one chunk plus the hasher's small
 * block buffer is resident, so a multi-gigabyte video does not become a
 * multi-gigabyte ArrayBuffer.
 */
export async function hashFile(file, algorithm = DEFAULT_HASH_ALGORITHM, {
  chunkSize = UPLOAD_CHUNK_SIZE,
  onProgress = null
} = {}) {
  const hasher = createHasher(algorithm);
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, file.size);
    const buffer = await file.slice(offset, end).arrayBuffer();
    hasher.update(buffer);
    onProgress?.({ offset: end, size: file.size });
    // Yield to rendering/input between large chunks.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return hasher.digest();
}
