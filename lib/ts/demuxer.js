// Streaming MPEG-TS demuxer: PAT/PMT discovery, PES assembly, H.264 access units and AAC ADTS frames.
// Pure module (no DOM/WebCodecs) so it runs in the worker and under node:test.
import { parsePes } from './pes.js';
import { splitNalUnits, nalType, NAL, parseSps, isKeyframe } from './h264.js';
import { AdtsParser, audioSpecificConfig } from './adts.js';
import { TimestampUnwrapper, ticksToUs } from './timestamps.js';

export const PACKET = 188;
const SYNC = 0x47;
export const STREAM_TYPES = { 0x1b: 'h264', 0x0f: 'aac', 0x24: 'hevc', 0x03: 'mp3', 0x04: 'mp3', 0x11: 'aac-latm', 0x81: 'ac3' };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();
export function crc32mpeg(b, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

const concat = (a, b) => {
  if (!a.length) return b;
  const o = new Uint8Array(a.length + b.length);
  o.set(a); o.set(b, a.length);
  return o;
};

/**
 * Events (all optional):
 *  onTracks({video:{pid,codec,streamType}|null, audio:{...}|null, unsupported:[...]})
 *  onVideoConfig({codec,width,height,profileIdc,levelIdc})
 *  onVideo({type:'key'|'delta', timestamp, dts, duration, data})   // timestamps in µs, data = Annex B AU
 *  onAudioConfig({codec,sampleRate,numberOfChannels,description})
 *  onAudio({timestamp, duration, data})                              // raw AAC (ADTS header stripped)
 *  onDiscontinuity({pid, reason})
 */
export class TSDemuxer {
  constructor(handlers = {}) {
    this.h = handlers;
    this.reset();
  }

  reset() {
    this.buf = new Uint8Array(0);
    this.pmtPid = -1;
    this.pmtVersion = -1;
    this.videoPid = -1;
    this.audioPid = -1;
    this.sections = new Map(); // pid -> {data, needed}
    this.pes = new Map();      // pid -> {parts, size, expected}
    this.cc = new Map();       // pid -> last continuity counter
    this.videoUnwrap = new TimestampUnwrapper();
    this.videoDtsUnwrap = new TimestampUnwrapper();
    this.audioUnwrap = new TimestampUnwrapper();
    this.adts = new AdtsParser();
    this.pendingAU = null;
    this.videoConfigKey = '';
    this.audioConfigKey = '';
    this.lastVideoTs = undefined;
    this.frameDurationUs = 0; // learned from PTS deltas
    this.stats = { packets: 0, resyncBytes: 0, ccErrors: 0, crcErrors: 0, videoFrames: 0, audioFrames: 0, droppedPes: 0 };
  }

  push(chunk) {
    const b = concat(this.buf, chunk);
    let off = 0;
    while (off + PACKET <= b.length) {
      if (b[off] !== SYNC || (off + PACKET < b.length && b[off + PACKET] !== SYNC)) {
        off++; this.stats.resyncBytes++;
        continue;
      }
      this.packet(b.subarray(off, off + PACKET));
      off += PACKET;
    }
    this.buf = b.slice(off);
  }

  // End of stream: emit whatever complete units remain.
  flush() {
    for (const pid of [...this.pes.keys()]) this.flushPes(pid);
    this.emitPendingAU();
  }

  packet(p) {
    this.stats.packets++;
    if (p[1] & 0x80) return; // transport_error_indicator
    const pusi = (p[1] & 0x40) !== 0;
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const afc = (p[3] >> 4) & 3;
    const cc = p[3] & 0x0f;
    let i = 4;
    if (afc & 2) {
      const afLen = p[4];
      if (afLen > 0 && p[5] & 0x80) this.discontinuity(pid, 'indicator');
      i += 1 + afLen;
    }
    if (!(afc & 1) || i >= PACKET) return;
    if (pid === 0x1fff) return;

    const last = this.cc.get(pid);
    if (last !== undefined) {
      if (cc === last) return; // duplicate packet
      if (cc !== ((last + 1) & 0x0f)) {
        this.stats.ccErrors++;
        this.dropPartial(pid);
        this.h.onDiscontinuity?.({ pid, reason: 'continuity' });
      }
    }
    this.cc.set(pid, cc);

    const payload = p.subarray(i);
    if (pid === 0 || pid === this.pmtPid) this.psi(pid, payload, pusi);
    else if (pid === this.videoPid || pid === this.audioPid) this.pesData(pid, payload, pusi);
  }

  discontinuity(pid, reason) {
    if (pid === this.videoPid) { this.videoUnwrap.reset(); this.videoDtsUnwrap.reset(); }
    if (pid === this.audioPid) { this.audioUnwrap.reset(); this.adts.reset(); }
    this.h.onDiscontinuity?.({ pid, reason });
  }

  dropPartial(pid) {
    if (this.pes.has(pid)) { this.pes.delete(pid); this.stats.droppedPes++; }
    if (pid === this.audioPid) this.adts.reset();
    this.sections.delete(pid);
  }

  // PSI sections may span packets; assemble by section_length.
  psi(pid, payload, pusi) {
    let s = this.sections.get(pid);
    if (pusi) {
      const pointer = payload[0];
      if (s) { // tail of previous section precedes the pointer
        s.data = concat(s.data, payload.subarray(1, 1 + pointer));
        this.trySection(pid, s);
      }
      s = { data: payload.slice(1 + pointer) };
      this.sections.set(pid, s);
    } else if (s) {
      s.data = concat(s.data, payload);
    } else return;
    this.trySection(pid, s);
  }

  trySection(pid, s) {
    const d = s.data;
    if (d.length < 3 || d[0] === 0xff) { if (d[0] === 0xff) this.sections.delete(pid); return; }
    const len = 3 + (((d[1] & 0x0f) << 8) | d[2]);
    if (d.length < len) return;
    this.sections.delete(pid);
    const section = d.subarray(0, len);
    const crc = (section[len - 4] << 24 | section[len - 3] << 16 | section[len - 2] << 8 | section[len - 1]) >>> 0;
    if (crc32mpeg(section, 0, len - 4) !== crc) { this.stats.crcErrors++; return; }
    if (section[0] === 0x00) this.pat(section);
    else if (section[0] === 0x02) this.pmt(section);
  }

  pat(s) {
    const end = s.length - 4;
    for (let i = 8; i + 4 <= end; i += 4) {
      const program = (s[i] << 8) | s[i + 1];
      const pid = ((s[i + 2] & 0x1f) << 8) | s[i + 3];
      if (program !== 0) { if (pid !== this.pmtPid) { this.pmtPid = pid; this.pmtVersion = -1; } return; }
    }
  }

  pmt(s) {
    const version = (s[5] >> 1) & 0x1f;
    if (version === this.pmtVersion) return;
    this.pmtVersion = version;
    const end = s.length - 4;
    let i = 12 + (((s[10] & 0x0f) << 8) | s[11]);
    let video = null, audio = null;
    const unsupported = [];
    while (i + 5 <= end) {
      const streamType = s[i];
      const pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
      const esInfo = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
      const codec = STREAM_TYPES[streamType] || `0x${streamType.toString(16)}`;
      if (codec === 'h264' && !video) video = { pid, codec, streamType };
      else if (codec === 'aac' && !audio) audio = { pid, codec, streamType };
      else unsupported.push({ pid, codec, streamType });
      i += 5 + esInfo;
    }
    if ((video?.pid ?? -1) !== this.videoPid) { this.videoPid = video?.pid ?? -1; this.videoUnwrap.reset(); this.videoDtsUnwrap.reset(); }
    if ((audio?.pid ?? -1) !== this.audioPid) { this.audioPid = audio?.pid ?? -1; this.audioUnwrap.reset(); this.adts.reset(); }
    this.h.onTracks?.({ video, audio, unsupported });
  }

  pesData(pid, payload, pusi) {
    if (pusi) {
      this.flushPes(pid);
      const expected = payload.length >= 6 ? ((payload[4] << 8) | payload[5]) : 0;
      this.pes.set(pid, { parts: [payload.slice()], size: payload.length, expected: expected ? expected + 6 : 0 });
    } else {
      const st = this.pes.get(pid);
      if (!st) return; // joined mid-PES; wait for next unit start
      st.parts.push(payload.slice());
      st.size += payload.length;
    }
    const st = this.pes.get(pid);
    if (st.expected && st.size >= st.expected) this.flushPes(pid); // bounded PES complete: lower latency
  }

  flushPes(pid) {
    const st = this.pes.get(pid);
    if (!st) return;
    this.pes.delete(pid);
    let data;
    if (st.parts.length === 1) data = st.parts[0];
    else {
      data = new Uint8Array(st.size);
      let o = 0;
      for (const part of st.parts) { data.set(part, o); o += part.length; }
    }
    if (st.expected) data = data.subarray(0, st.expected);
    const pes = parsePes(data);
    if (!pes) { this.stats.droppedPes++; return; }
    if (pid === this.videoPid) this.videoPes(pes);
    else if (pid === this.audioPid) this.audioPes(pes);
  }

  videoPes(pes) {
    const nals = splitNalUnits(pes.payload);
    if (!nals.length) return;
    // A PES without PTS whose data does not start a new AU continues the previous access unit.
    const startsAU = nals.some(n => { const t = nalType(n); return t === NAL.AUD || t === NAL.SPS || t === NAL.IDR; }) || pes.pts !== undefined;
    if (!startsAU && this.pendingAU) {
      this.pendingAU.chunks.push(pes.payload);
      this.pendingAU.nals.push(...nals);
      return;
    }
    // Several AUDs inside one PES = several access units.
    const audIdx = [];
    nals.forEach((n, k) => { if (nalType(n) === NAL.AUD) audIdx.push(k); });
    const groups = audIdx.length > 1 ? audIdx.map((k, j) => nals.slice(k, audIdx[j + 1] ?? nals.length)) : [nals];
    groups.forEach((g, j) => {
      this.emitPendingAU();
      const pts = j === 0 && pes.pts !== undefined ? ticksToUs(this.videoUnwrap.unwrap(pes.pts)) : undefined;
      const dts = j === 0 && pes.dts !== undefined ? ticksToUs(this.videoDtsUnwrap.unwrap(pes.dts)) : undefined;
      this.pendingAU = { pts, dts, nals: g, chunks: groups.length === 1 ? [pes.payload] : null };
    });
  }

  emitPendingAU() {
    const au = this.pendingAU;
    if (!au) return;
    this.pendingAU = null;
    for (const n of au.nals) {
      if (nalType(n) === NAL.SPS) {
        try {
          const sps = parseSps(n);
          const key = `${sps.codec}:${sps.width}x${sps.height}`;
          if (key !== this.videoConfigKey) { this.videoConfigKey = key; this.h.onVideoConfig?.(sps); }
        } catch { /* malformed SPS: keep previous config */ }
      }
    }
    let ts = au.pts;
    if (ts === undefined) ts = this.lastVideoTs === undefined ? 0 : this.lastVideoTs + (this.frameDurationUs || 33333);
    else if (this.lastVideoTs !== undefined) {
      const d = Math.abs(ts - this.lastVideoTs); // abs(): B-frames arrive out of presentation order
      if (d > 1000 && d < 200000 && (!this.frameDurationUs || d < this.frameDurationUs)) this.frameDurationUs = d;
    }
    this.lastVideoTs = ts;
    let data;
    if (au.chunks) {
      if (au.chunks.length === 1) data = au.chunks[0];
      else { const n = au.chunks.reduce((s, c) => s + c.length, 0); data = new Uint8Array(n); let o = 0; for (const c of au.chunks) { data.set(c, o); o += c.length; } }
    } else {
      const n = au.nals.reduce((s, x) => s + x.length + 4, 0);
      data = new Uint8Array(n);
      let o = 0;
      for (const x of au.nals) { data.set([0, 0, 0, 1], o); data.set(x, o + 4); o += x.length + 4; }
    }
    this.stats.videoFrames++;
    this.h.onVideo?.({ type: isKeyframe(au.nals) ? 'key' : 'delta', timestamp: ts, dts: au.dts ?? ts, duration: this.frameDurationUs || 33333, data });
  }

  audioPes(pes) {
    const ts = pes.pts !== undefined ? ticksToUs(this.audioUnwrap.unwrap(pes.pts)) : undefined;
    for (const f of this.adts.push(pes.payload, ts)) {
      const h = f.header;
      const key = `${h.objectType}:${h.sampleRate}:${h.channels}`;
      if (key !== this.audioConfigKey) {
        this.audioConfigKey = key;
        this.h.onAudioConfig?.({ codec: `mp4a.40.${h.objectType}`, sampleRate: h.sampleRate, numberOfChannels: h.channels, description: audioSpecificConfig(h) });
      }
      this.stats.audioFrames++;
      this.h.onAudio?.({ timestamp: f.timestamp, duration: f.duration, data: f.data });
    }
  }
}
