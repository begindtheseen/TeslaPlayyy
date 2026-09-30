// Fragmented-MP4 (DASH) parsing for YouTube adaptive formats: one track per file laid out as
// ftyp, moov, sidx, (moof, mdat)*. Pure module (no DOM/WebCodecs) so it runs in the worker and node:test.
//
//  parseInit(bytes)          -> {status:'need', need} | {status:'ok', track, segments, firstFragment}
//  segmentFor(segments, t)   -> the sidx segment to start reading from for media time t (seconds)
//  new Fmp4Demuxer(track, {startOffset, onSample}).push(chunk)
//      onSample({type:'key'|'delta', timestamp, duration, data})   // µs, data = AVCC sample / raw AAC
//
// Video samples stay length-prefixed (AVCC); configure VideoDecoder with `description` = avcC.
// Audio samples are raw AAC; `description` = AudioSpecificConfig from esds.

const u32 = (b, o) => (b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const i64 = (b, o) => i32(b, o) * 2 ** 32 + u32(b, o + 4);
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const hex = v => v.toString(16).padStart(2, '0').toUpperCase();

// Box header at o (needs 8/16 bytes), or null when not enough data.
export function boxHeader(b, o, limit = b.length) {
  if (o + 8 > limit) return null;
  let size = u32(b, o), hdr = 8;
  const type = fourcc(b, o + 4);
  if (size === 1) { if (o + 16 > limit) return null; size = u64(b, o + 8); hdr = 16; }
  else if (size === 0) size = Infinity; // box extends to end of file
  if (size < hdr) throw new Error(`Corrupt MP4 box ${type} (size ${size})`);
  return { type, start: o, size, hdr, body: o + hdr, end: o + size };
}

function* children(b, box) {
  const end = Math.min(box.end, b.length);
  for (let o = box.body; o + 8 <= end;) {
    const h = boxHeader(b, o, end);
    if (!h) return;
    yield h;
    o = h.end;
  }
}
const find = (b, box, ...path) => {
  let cur = box;
  for (const t of path) { cur = [...children(b, cur)].find(c => c.type === t); if (!cur) return null; }
  return cur;
};

// ---- init segment ---------------------------------------------------------------------------------

function parseEsds(b, box) {
  let o = box.body + 4; // version/flags
  const end = box.end;
  const readLen = () => { let n = 0; for (let i = 0; i < 4; i++) { const c = b[o++]; n = (n << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return n; };
  while (o < end) {
    const tag = b[o++]; const len = readLen();
    if (tag === 0x03) { const flags = b[o + 2]; o += 3; if (flags & 0x80) o += 2; if (flags & 0x40) o += 1 + b[o]; if (flags & 0x20) o += 2; continue; }
    if (tag === 0x04) { o += 13; continue; } // objectTypeIndication..avgBitrate, then DecoderSpecificInfo
    if (tag === 0x05) return b.slice(o, o + len);
    o += len;
  }
  return null;
}

const ASC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function parseTrak(b, trak, movieTimescale) {
  const tkhd = find(b, trak, 'tkhd');
  const trackId = tkhd ? u32(b, tkhd.body + (b[tkhd.body] === 1 ? 20 : 12)) : 1;
  const mdhd = find(b, trak, 'mdia', 'mdhd');
  const timescale = u32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
  const hdlr = find(b, trak, 'mdia', 'hdlr');
  const handler = fourcc(b, hdlr.body + 8);
  // Edit list: an initial empty edit delays presentation; media_time skips (e.g. B-frame delay, AAC priming).
  let offsetUs = 0;
  const elst = find(b, trak, 'edts', 'elst');
  if (elst) {
    const v1 = b[elst.body] === 1, n = u32(b, elst.body + 4);
    let o = elst.body + 8;
    for (let i = 0; i < n; i++) {
      const dur = v1 ? u64(b, o) : u32(b, o), mediaTime = v1 ? i64(b, o + 8) : i32(b, o + 4);
      o += v1 ? 20 : 12;
      if (mediaTime === -1) { offsetUs += (dur / movieTimescale) * 1e6; continue; }
      offsetUs -= (mediaTime / timescale) * 1e6;
      break;
    }
  }
  const stsd = find(b, trak, 'mdia', 'minf', 'stbl', 'stsd');
  const entry = boxHeader(b, stsd.body + 8);
  const track = { trackId, timescale, offsetUs: Math.round(offsetUs), sampleEntry: entry.type };
  if (handler === 'vide') {
    if (entry.type === 'encv') throw new Error('Encrypted (DRM) video is not supported');
    const avcC = [...children(b, { ...entry, body: entry.body + 78 })].find(c => c.type === 'avcC');
    if (!/^avc[13]$/.test(entry.type) || !avcC) throw new Error(`Unsupported video sample entry ${entry.type}`);
    const d = b.slice(avcC.body, avcC.end);
    Object.assign(track, { kind: 'video', codec: `avc1.${hex(d[1])}${hex(d[2])}${hex(d[3])}`, width: u16(b, entry.body + 24), height: u16(b, entry.body + 26), description: d });
  } else if (handler === 'soun') {
    if (entry.type === 'enca') throw new Error('Encrypted (DRM) audio is not supported');
    if (entry.type !== 'mp4a') throw new Error(`Unsupported audio sample entry ${entry.type}`);
    const esds = [...children(b, { ...entry, body: entry.body + 28 })].find(c => c.type === 'esds');
    const asc = esds && parseEsds(b, esds);
    if (!asc) throw new Error('mp4a without AudioSpecificConfig');
    const aot = asc[0] >> 3, freqIndex = ((asc[0] & 7) << 1) | (asc[1] >> 7), chanCfg = (asc[1] >> 3) & 0x0f;
    Object.assign(track, {
      kind: 'audio', codec: `mp4a.40.${aot}`, description: asc,
      sampleRate: ASC_RATES[freqIndex] || (u32(b, entry.body + 24) >>> 16),
      numberOfChannels: chanCfg || u16(b, entry.body + 16),
    });
  } else throw new Error(`Unsupported track handler ${handler}`);
  return track;
}

function parseSidx(b, box) {
  const v = b[box.body];
  const timescale = u32(b, box.body + 8);
  let o = box.body + 12;
  const ept = v === 0 ? u32(b, o) : u64(b, o);
  const firstOffset = v === 0 ? u32(b, o + 4) : u64(b, o + 8);
  o += v === 0 ? 8 : 16;
  const count = u16(b, o + 2);
  o += 4;
  const segments = [];
  let offset = box.end + firstOffset, t = ept;
  for (let i = 0; i < count; i++, o += 12) {
    const ref = u32(b, o), dur = u32(b, o + 4);
    if (ref & 0x80000000) throw new Error('Hierarchical sidx is not supported');
    segments.push({ offset, size: ref & 0x7fffffff, time: t / timescale, duration: dur / timescale });
    offset += ref & 0x7fffffff; t += dur;
  }
  return segments;
}

export function parseInit(b) {
  let moov = null, segments = null;
  for (let o = 0; ;) {
    const h = boxHeader(b, o);
    if (!h) return { status: 'need', need: o + 16 };
    if (h.type === 'moov' || h.type === 'sidx') {
      if (h.end > b.length) return { status: 'need', need: h.end };
      if (h.type === 'moov') moov = h; else segments = parseSidx(b, h);
    } else if (h.type === 'moof') {
      if (!moov) throw new Error('moof before moov');
      return finish(b, moov, segments, h.start);
    } else if (h.type === 'mdat') throw new Error(moov ? 'Not a fragmented MP4 (use the muxed path)' : 'mdat before moov');
    if (moov && segments) return finish(b, moov, segments, segments[0]?.offset ?? h.end);
    o = h.end;
    if (!Number.isFinite(o)) return { status: 'need', need: Infinity };
  }
}

function finish(b, moov, segments, firstFragment) {
  const mvhd = find(b, moov, 'mvhd');
  const movieTimescale = mvhd ? u32(b, mvhd.body + (b[mvhd.body] === 1 ? 20 : 12)) : 1000;
  const traks = [...children(b, moov)].filter(c => c.type === 'trak');
  if (traks.length !== 1) throw new Error(`Expected one track per DASH file, found ${traks.length}`);
  const track = parseTrak(b, traks[0], movieTimescale);
  const trex = [...children(b, find(b, moov, 'mvex') || { body: 0, end: 0 })].find(c => c.type === 'trex' && u32(b, c.body + 4) === track.trackId);
  track.defaults = trex ? { duration: u32(b, trex.body + 12), size: u32(b, trex.body + 16), flags: u32(b, trex.body + 20) } : {};
  return { status: 'ok', track, segments, firstFragment };
}

// Last segment starting at or before media time t (seconds). Segments start on keyframes (SAP).
export function segmentFor(segments, t, offsetUs = 0) {
  if (!segments?.length) return null;
  const x = t - offsetUs / 1e6;
  let i = 0;
  while (i + 1 < segments.length && segments[i + 1].time <= x + 1e-6) i++;
  return segments[i];
}

// ---- media segments -------------------------------------------------------------------------------

function parseMoof(b, moof, moofStart, track, nextDts) {
  const samples = [];
  for (const traf of children(b, moof)) {
    if (traf.type !== 'traf') continue;
    const tfhd = find(b, traf, 'tfhd');
    const tf = u32(b, tfhd.body) & 0xffffff;
    if (u32(b, tfhd.body + 4) !== track.trackId && track.trackId) continue;
    let o = tfhd.body + 8;
    let base = moofStart;
    if (tf & 0x1) { base = u64(b, o); o += 8; }
    if (tf & 0x2) o += 4;
    const defDur = tf & 0x8 ? u32(b, (o += 4) - 4) : track.defaults.duration;
    const defSize = tf & 0x10 ? u32(b, (o += 4) - 4) : track.defaults.size;
    const defFlags = tf & 0x20 ? u32(b, (o += 4) - 4) : track.defaults.flags;
    const tfdt = find(b, traf, 'tfdt');
    let dts = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : nextDts;
    let dataPos = base;
    for (const trun of children(b, traf)) {
      if (trun.type !== 'trun') continue;
      const version = b[trun.body], fl = u32(b, trun.body) & 0xffffff, n = u32(b, trun.body + 4);
      let p = trun.body + 8;
      if (fl & 0x1) { dataPos = base + i32(b, p); p += 4; }
      let firstFlags;
      if (fl & 0x4) { firstFlags = u32(b, p); p += 4; }
      for (let i = 0; i < n; i++) {
        const dur = fl & 0x100 ? u32(b, (p += 4) - 4) : defDur;
        const size = fl & 0x200 ? u32(b, (p += 4) - 4) : defSize;
        let flags = fl & 0x400 ? u32(b, (p += 4) - 4) : defFlags;
        if (i === 0 && firstFlags !== undefined) flags = firstFlags;
        const cto = fl & 0x800 ? (version ? i32(b, p) : u32(b, p)) : 0;
        if (fl & 0x800) p += 4;
        const key = track.kind === 'audio' || flags === undefined || !(flags & 0x10000);
        samples.push({ offset: dataPos, size, key, pts: dts + cto, dur });
        dataPos += size; dts += dur;
      }
    }
    nextDts = dts;
  }
  return { samples, nextDts };
}

export class Fmp4Demuxer {
  constructor(track, { startOffset = 0, onSample = () => {} } = {}) {
    this.track = track; this.onSample = onSample;
    this.pos = startOffset;           // absolute file offset of buf[0]
    this.buf = new Uint8Array(0);
    this.skip = 0;                    // bytes still to discard (rest of an mdat)
    this.mdatEnd = -1;                // >=0 while inside an mdat
    this.samples = []; this.si = 0; this.nextDts = 0;
    this.stats = { samples: 0, fragments: 0, skippedBoxes: 0 };
  }

  consume(n) { this.buf = this.buf.subarray(n); this.pos += n; }

  push(chunk) {
    const input = chunk;
    if (this.skip) { const k = Math.min(this.skip, chunk.length); chunk = chunk.subarray(k); this.skip -= k; this.pos += k; }
    if (this.buf.length) { const x = new Uint8Array(this.buf.length + chunk.length); x.set(this.buf); x.set(chunk, this.buf.length); this.buf = x; }
    else this.buf = chunk;
    for (;;) {
      if (this.mdatEnd >= 0) { if (!this.drainMdat()) break; continue; }
      const h = boxHeader(this.buf, 0);
      if (!h) break;
      if (h.type === 'mdat') { this.mdatEnd = this.pos + h.size; this.consume(h.hdr); continue; }
      if (h.end > this.buf.length) { if (h.size > 16 * 1024 * 1024) throw new Error(`Oversized ${h.type} box`); break; }
      if (h.type === 'moof') {
        const r = parseMoof(this.buf, h, this.pos, this.track, this.nextDts);
        this.samples = r.samples; this.si = 0; this.nextDts = r.nextDts; this.stats.fragments++;
      } else this.stats.skippedBoxes++;
      this.consume(h.size);
    }
    if (this.buf.buffer === input.buffer) this.buf = this.buf.slice(); // detach from the caller's chunk
  }

  // Emits every sample of the current mdat whose bytes are buffered. Returns true when the mdat is done.
  drainMdat() {
    const t = this.track;
    while (this.si < this.samples.length && this.samples[this.si].offset < this.mdatEnd) {
      const s = this.samples[this.si];
      if (s.offset < this.pos) { this.si++; continue; } // overlapping/corrupt: skip
      const local = s.offset - this.pos;
      if (local + s.size > this.buf.length) return false;
      this.onSample({
        type: s.key ? 'key' : 'delta',
        timestamp: Math.round((s.pts / t.timescale) * 1e6 + t.offsetUs),
        duration: Math.round((s.dur / t.timescale) * 1e6),
        data: this.buf.slice(local, local + s.size),
      });
      this.stats.samples++; this.si++;
      this.consume(local + s.size);
    }
    const rest = this.mdatEnd - this.pos;
    if (rest > this.buf.length) { this.skip = rest - this.buf.length; this.pos += this.buf.length; this.buf = new Uint8Array(0); this.mdatEnd = -1; return false; }
    this.consume(rest); this.mdatEnd = -1;
    return true;
  }
}
