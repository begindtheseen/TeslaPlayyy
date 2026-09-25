// AAC ADTS framing (ISO/IEC 14496-3 §1.A.2). Frames may straddle PES boundaries.
export const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
export const SAMPLES_PER_FRAME = 1024;

export function parseAdtsHeader(b, i) {
  if (i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return null;
  const protectionAbsent = b[i + 1] & 1;
  const objectType = (b[i + 2] >> 6) + 1;
  const freqIndex = (b[i + 2] >> 2) & 0x0f;
  const channels = ((b[i + 2] & 1) << 2) | (b[i + 3] >> 6);
  const frameLength = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
  const rawBlocks = (b[i + 6] & 3) + 1;
  const headerLength = protectionAbsent ? 7 : 9;
  if (freqIndex >= SAMPLE_RATES.length || frameLength < headerLength) return null;
  return { objectType, freqIndex, sampleRate: SAMPLE_RATES[freqIndex], channels, frameLength, headerLength, rawBlocks };
}

// 2-byte AudioSpecificConfig for AudioDecoder `description`.
export function audioSpecificConfig({ objectType, freqIndex, channels }) {
  return new Uint8Array([(objectType << 3) | (freqIndex >> 1), ((freqIndex & 1) << 7) | (channels << 3)]);
}

// Stateful ADTS splitter. push() takes a PES payload and its PTS in microseconds (or undefined).
export class AdtsParser {
  constructor() { this.reset(); }
  reset() {
    this.pending = new Uint8Array(0);
    this.nextTs = undefined;
    this.skipped = 0;
  }
  push(payload, ptsUs) {
    let buf = payload;
    // Bytes carried over from the previous PES continue its timeline; otherwise trust this PES's PTS.
    let ts = this.pending.length ? this.nextTs : (ptsUs ?? this.nextTs);
    if (this.pending.length) {
      buf = new Uint8Array(this.pending.length + payload.length);
      buf.set(this.pending);
      buf.set(payload, this.pending.length);
    }
    const frames = [];
    let i = 0;
    while (i + 7 <= buf.length) {
      const h = parseAdtsHeader(buf, i);
      if (!h) { i++; this.skipped++; continue; }
      if (i + h.frameLength > buf.length) break;
      const durationUs = (SAMPLES_PER_FRAME * h.rawBlocks * 1e6) / h.sampleRate;
      if (ts !== undefined) {
        frames.push({ header: h, timestamp: Math.round(ts), duration: Math.round(durationUs), data: buf.slice(i + h.headerLength, i + h.frameLength) });
        ts += durationUs;
      }
      i += h.frameLength;
    }
    this.pending = buf.slice(i);
    this.nextTs = ts;
    return frames;
  }
}
