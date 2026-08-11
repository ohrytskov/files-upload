const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeChunk,
  encodeChunk,
  parseWebSocketMessage
} = require('../lib/chunk-protocol');

test('binary chunk frames round-trip metadata and payload', () => {
  const payload = Buffer.from('chunk payload');
  const frame = encodeChunk({ relativePath: 'nested/file.txt', offset: 12, data: payload });
  const decoded = decodeChunk(frame);

  assert.equal(decoded.type, 'FILE_CHUNK');
  assert.equal(decoded.payload.relativePath, 'nested/file.txt');
  assert.equal(decoded.payload.offset, 12);
  assert.deepEqual(decoded.payload.data, payload);
  assert.deepEqual(parseWebSocketMessage(frame, true), decoded);
});
test('JSON FILE_CHUNK messages are rejected', () => {
  assert.throws(
    () => parseWebSocketMessage(JSON.stringify({ type: 'FILE_CHUNK' }), false),
    /binary frame/
  );
});

test('malformed binary chunk frames are rejected', () => {
  assert.throws(() => decodeChunk(Buffer.from([0, 0, 0, 0])), /header length/);
  assert.throws(() => encodeChunk({ relativePath: '../outside', offset: -1, data: Buffer.alloc(0) }), /metadata/);
  assert.throws(() => encodeChunk({ relativePath: 'file.txt', offset: Number.MAX_SAFE_INTEGER + 1, data: Buffer.alloc(0) }), /metadata/);
});
