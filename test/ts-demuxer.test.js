import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TSDemuxer, PACKET, crc32mpeg } from '../lib/ts/demuxer.js';
import { parseAdtsHeader, AdtsParser } from '../lib/ts/adts.js';
import { splitNalUnits, parseSps, NAL, nalType } from '../lib/ts/h264.js';
import { readTimestamp, parsePes } from '../lib/ts/pes.js';
import { TimestampUnwrapper, ticksToUs, PTS_WRAP } from '../lib/ts/timestamps.js';

const demo = readFileSync(new URL('../public/media/demo.ts', import.meta.url));
const demoAv = readFileSync(new URL('../public/media/demo-av.ts', import.meta.url));

function demux(bytes, chunker) {
  const out = { tracks: null, video: [], audio: [], videoConfig: null, audioConfig: null, discontinuities: [] };
  const d = new TSDemuxer({
    onTracks: t => { out.tracks = t; },
    onVideoConfig: c => { out.videoConfig = c; },
    onAudioConfig: c => { out.audioConfig = c; },
    onVideo: v => out.video.push(v),
    onAudio: a => out.audio.push(a),
    onDiscontinuity: x => out.discontinuities.push(x),
  });
  for (const c of chunker(bytes)) d.push(c);
  d.flush();
  out.stats = d.stats;
  return out;
}
const bySize = n => b => { const r = []; for (let i = 0; i < b.length; i += n) r.push(b.subarray(i, i + n)); return r; };
const random = seed => b => {
  let s = seed, i = 0; const r = [];
  while (i < b.length) { s = (s * 1103515245 + 12345) & 0x7fffffff; const n = 1 + (s % 5000); r.push(b.subarray(i, i + n)); i += n; }
  return r;
};

// Ground truth from `ffprobe -show_entries packet=codec_type,flags`: see docs/TEST_RESULTS.md.
test('video-only fixture: PAT/PMT discovery, SPS and all 120 access units', () => {
  const r = demux(demo, b => [b]);
  assert.equal(r.tracks.video.codec, 'h264');
  assert.equal(r.tracks.audio, null);
  assert.equal(r.videoConfig.codec, 'avc1.42C01E');
  assert.equal(r.videoConfig.width, 640);
  assert.equal(r.videoConfig.height, 360);
  assert.equal(r.video.length, 120);
  assert.equal(r.video.filter(v => v.type === 'key').length, 5);
  assert.equal(r.video[0].type, 'key');
  assert.equal(r.video[0].timestamp, 1_400_000); // start_time=1.4 s
  assert.equal(r.video[1].timestamp - r.video[0].timestamp, 41_667); // 24 fps in µs
  assert.equal(r.stats.ccErrors, 0);
  assert.equal(r.stats.crcErrors, 0);
});

test('A/V fixture: H.264 + AAC-LC config and frame counts', () => {
  const r = demux(demoAv, b => [b]);
  assert.equal(r.video.length, 240);
  assert.equal(r.audio.length, 470);
  assert.deepEqual({ ...r.audioConfig, description: [...r.audioConfig.description] },
    { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: [0x11, 0x90] });
  // Audio frames are contiguous: 1024 samples @ 48 kHz = 21333.3 µs.
  for (let i = 1; i < r.audio.length; i++) {
    const d = r.audio[i].timestamp - r.audio[i - 1].timestamp;
    assert.ok(Math.abs(d - 21333) <= 1, `audio gap ${d} at ${i}`);
  }
  // A/V start aligned within one audio frame.
  assert.ok(Math.abs(r.audio[0].timestamp - r.video[0].timestamp) < 25_000);
});

for (const [name, chunker] of [['1 byte', bySize(1)], ['187 bytes', bySize(187)], ['188 bytes', bySize(188)], ['189 bytes', bySize(189)], ['random 1', random(1)], ['random 7', random(7)]]) {
  test(`chunk boundaries (${name}) produce identical output`, () => {
    const whole = demux(demoAv, b => [b]);
    const split = demux(demoAv, chunker);
    assert.equal(split.video.length, whole.video.length);
    assert.equal(split.audio.length, whole.audio.length);
    for (let i = 0; i < whole.video.length; i += 17) {
      assert.equal(split.video[i].timestamp, whole.video[i].timestamp);
      assert.deepEqual(split.video[i].data, whole.video[i].data);
    }
    for (let i = 0; i < whole.audio.length; i += 23) {
      assert.equal(split.audio[i].timestamp, whole.audio[i].timestamp);
      assert.deepEqual(split.audio[i].data, whole.audio[i].data);
    }
  });
}

test('resyncs after leading garbage and corrupted sync bytes', () => {
  const garbage = new Uint8Array(1000).fill(0x47 ^ 0xff);
  const corrupted = new Uint8Array(demo);
  corrupted[PACKET * 500] = 0x00; // break one sync byte mid-stream
  const bytes = new Uint8Array(garbage.length + corrupted.length);
  bytes.set(garbage); bytes.set(corrupted, garbage.length);
  const r = demux(bytes, bySize(4096));
  assert.ok(r.stats.resyncBytes >= 1000);
  assert.ok(r.video.length >= 118, `got ${r.video.length}`);
});

test('missing PAT yields no tracks and no crash', () => {
  const copy = new Uint8Array(demo);
  for (let o = 0; o < copy.length; o += PACKET) {
    const pid = ((copy[o + 1] & 0x1f) << 8) | copy[o + 2];
    if (pid === 0) copy[o + 1] |= 0x80; // mark transport error so PAT packets are ignored
  }
  const r = demux(copy, b => [b]);
  assert.equal(r.tracks, null);
  assert.equal(r.video.length, 0);
});

test('continuity-counter gap drops the partial PES and reports a discontinuity', () => {
  const copy = new Uint8Array(demo);
  // Remove one video payload packet from the middle.
  let dropAt = -1, count = 0;
  for (let o = 0; o < copy.length; o += PACKET) {
    const pid = ((copy[o + 1] & 0x1f) << 8) | copy[o + 2];
    if (pid === 256 && !(copy[o + 1] & 0x40) && ++count === 400) { dropAt = o; break; }
  }
  assert.ok(dropAt > 0);
  const cut = new Uint8Array(copy.length - PACKET);
  cut.set(copy.subarray(0, dropAt)); cut.set(copy.subarray(dropAt + PACKET), dropAt);
  const r = demux(cut, b => [b]);
  assert.equal(r.stats.ccErrors, 1);
  assert.equal(r.discontinuities.length, 1);
  assert.equal(r.video.length, 119);
});

test('CRC32/MPEG-2 check vector', () => {
  const s = new TextEncoder().encode('123456789');
  assert.equal(crc32mpeg(s, 0, s.length), 0x0376e6e7);
});

test('PES PTS/DTS parsing and 33-bit timestamps', () => {
  // PTS = 2^32 + 5 exercises the high bit that 32-bit bit-ops would lose.
  const v = 2 ** 32 + 5;
  const enc = t => [0x21 | (Math.floor(t / 2 ** 30) & 7) << 1, (t >> 22) & 0xff, ((t >> 14) & 0xfe) | 1, (t >> 7) & 0xff, ((t << 1) & 0xfe) | 1];
  const b = new Uint8Array([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...enc(v), 0xaa]);
  assert.equal(readTimestamp(b, 9), v);
  const p = parsePes(b);
  assert.equal(p.pts, v);
  assert.deepEqual([...p.payload], [0xaa]);
});

test('timestamp unwrapper handles 33-bit wraparound', () => {
  const u = new TimestampUnwrapper();
  assert.equal(u.unwrap(PTS_WRAP - 3000), PTS_WRAP - 3000);
  assert.equal(u.unwrap(600), PTS_WRAP + 600);
  assert.equal(ticksToUs(90000), 1_000_000);
});

test('H.264 NAL splitting with 3- and 4-byte start codes', () => {
  const b = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x65, 9]);
  const n = splitNalUnits(b);
  assert.deepEqual(n.map(nalType), [NAL.AUD, NAL.SPS, NAL.IDR]);
  assert.deepEqual([...n[1]], [0x67, 1, 2]);
});

test('SPS parser handles High profile and cropping (1920x1080)', () => {
  // x264 High@4.0 1920x1080 SPS (crop bottom 8 rows).
  const sps = Uint8Array.from([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58]);
  const r = parseSps(sps);
  assert.equal(r.codec, 'avc1.640028');
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
});

test('ADTS frames straddling PES boundaries keep a continuous timeline', () => {
  const frames = demux(demoAv, b => [b]).audio;
  // Re-frame raw audio into ADTS and split mid-frame.
  const hdr = (len) => { const L = len + 7; return [0xff, 0xf1, 0x4c, 0x80 | (L >> 11), (L >> 3) & 0xff, ((L & 7) << 5) | 0x1f, 0xfc]; };
  const adts = frames.slice(0, 3).map(f => Uint8Array.from([...hdr(f.data.length), ...f.data]));
  const all = Uint8Array.from(adts.flatMap(a => [...a]));
  const p = new AdtsParser();
  const cut = adts[0].length + 10;
  const a = p.push(all.subarray(0, cut), 1_000_000);
  const b = p.push(all.subarray(cut), 1_064_000 /* deliberately wrong PTS for the continuation */);
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
  assert.equal(b[0].timestamp, 1_021_333);
  assert.ok(parseAdtsHeader(adts[0], 0).sampleRate === 48000);
});
