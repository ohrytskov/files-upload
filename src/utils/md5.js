const SHIFT_AMOUNTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

const K = Array.from({ length: 64 }, (_, index) => (
  Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) | 0
));

function add32(a, b) {
  return (a + b) | 0;
}

function rotateLeft(value, amount) {
  return (value << amount) | (value >>> (32 - amount));
}

function wordToHex(word) {
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, word >>> 24]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function md5ArrayBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const wordCount = (((bytes.length + 8) >>> 6) + 1) * 16;
  const words = new Uint32Array(wordCount);

  for (let index = 0; index < bytes.length; index++) {
    words[index >>> 2] |= bytes[index] << ((index & 3) * 8);
  }

  words[bytes.length >>> 2] |= 0x80 << ((bytes.length & 3) * 8);
  const bitLength = bytes.length * 8;
  words[wordCount - 2] = bitLength >>> 0;
  words[wordCount - 1] = Math.floor(bitLength / 0x100000000) >>> 0;

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  for (let block = 0; block < words.length; block += 16) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

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

      const next = add32(
        add32(add32(a, functionValue), K[index]),
        words[block + wordIndex]
      );
      const rotated = rotateLeft(next, SHIFT_AMOUNTS[index]);
      const nextB = add32(b, rotated);
      a = d;
      d = c;
      c = b;
      b = nextB;
    }

    a0 = add32(a0, a);
    b0 = add32(b0, b);
    c0 = add32(c0, c);
    d0 = add32(d0, d);
  }

  return `${wordToHex(a0)}${wordToHex(b0)}${wordToHex(c0)}${wordToHex(d0)}`;
}
