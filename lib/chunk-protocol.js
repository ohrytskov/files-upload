const MAX_HEADER_SIZE = 64 * 1024;

function encodeChunk({ relativePath, offset, data }) {
  if (typeof relativePath !== 'string' || !Number.isInteger(offset) || offset < 0) {
    throw new Error('Invalid binary chunk metadata');
  }

  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.from(JSON.stringify({
    type: 'FILE_CHUNK',
    relativePath,
    offset
  }), 'utf8');

  if (header.length > MAX_HEADER_SIZE) {
    throw new Error('Binary chunk header is too large');
  }

  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(header.length, 0);
  return Buffer.concat([headerLength, header, bytes]);
}

function decodeChunk(rawMessage) {
  const message = Buffer.isBuffer(rawMessage) ? rawMessage : Buffer.from(rawMessage);
  if (message.length < 4) throw new Error('Binary chunk frame is truncated');

  const headerLength = message.readUInt32BE(0);
  if (headerLength === 0 || headerLength > MAX_HEADER_SIZE) {
    throw new Error('Invalid binary chunk header length');
  }

  const headerEnd = 4 + headerLength;
  if (message.length < headerEnd) throw new Error('Binary chunk header is truncated');

  let header;
  try {
    header = JSON.parse(message.subarray(4, headerEnd).toString('utf8'));
  } catch {
    throw new Error('Invalid binary chunk header');
  }

  if (
    !header ||
    header.type !== 'FILE_CHUNK' ||
    typeof header.relativePath !== 'string' ||
    !Number.isInteger(header.offset) ||
    header.offset < 0
  ) {
    throw new Error('Invalid binary chunk metadata');
  }

  return {
    type: header.type,
    payload: {
      relativePath: header.relativePath,
      offset: header.offset,
      data: message.subarray(headerEnd)
    }
  };
}

function parseWebSocketMessage(rawMessage, isBinary) {
  if (isBinary) return decodeChunk(rawMessage);

  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    throw new Error('Invalid JSON payload');
  }

  if (message?.type === 'FILE_CHUNK') {
    throw new Error('FILE_CHUNK messages must use a binary frame');
  }

  return message;
}

module.exports = {
  MAX_HEADER_SIZE,
  decodeChunk,
  encodeChunk,
  parseWebSocketMessage
};
