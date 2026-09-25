// PES header parsing (ISO/IEC 13818-1 §2.4.3.6).

// Reads a 33-bit PTS/DTS from 5 bytes. Uses arithmetic (not bit ops) because 2^32 overflows int32.
export function readTimestamp(b, i) {
  return (
    ((b[i] >> 1) & 0x07) * 2 ** 30 +
    ((b[i + 1] << 22) | ((b[i + 2] >> 1) << 15) | (b[i + 3] << 7) | (b[i + 4] >> 1))
  );
}

// Returns {streamId, pts, dts, payload} with pts/dts in raw 90 kHz ticks (undefined when absent),
// or null when the buffer is not a valid PES packet.
export function parsePes(b) {
  if (b.length < 9 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1) return null;
  const streamId = b[3];
  // Stream ids without the optional header (padding, private_stream_2, ECM, EMM, DSMCC, ...).
  if (streamId === 0xbc || streamId === 0xbe || streamId === 0xbf || streamId === 0xf0 ||
      streamId === 0xf1 || streamId === 0xff || streamId === 0xf2 || streamId === 0xf8) {
    return { streamId, pts: undefined, dts: undefined, payload: b.subarray(6) };
  }
  if ((b[6] & 0xc0) !== 0x80) return null;
  const flags = b[7] >> 6;
  const headerEnd = 9 + b[8];
  if (headerEnd > b.length) return null;
  let pts, dts;
  if (flags & 0b10) {
    if (b.length < 14) return null;
    pts = readTimestamp(b, 9);
    dts = pts;
  }
  if (flags === 0b11) {
    if (b.length < 19) return null;
    dts = readTimestamp(b, 14);
  }
  return { streamId, pts, dts, payload: b.subarray(headerEnd) };
}
