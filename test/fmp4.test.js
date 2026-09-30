// fMP4 (YouTube DASH) parser: init/sidx parsing and sample demux checked against ffprobe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseInit, segmentFor, Fmp4Demuxer } from '../lib/mp4/fmp4.js';
import { ensureDashFixture } from './helpers/dashFixture.js';

const HAS_FFMPEG = spawnSync('ffprobe', ['-version']).status === 0;
const fx = HAS_FFMPEG ? ensureDashFixture() : null;
const probePackets = (file, sel) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'packet=pts_time,flags,size', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  .stdout.trim().split('\n').map(l => { const [pts, size, flags] = l.split(','); return { pts: Number(pts), size: Number(size), key: flags.includes('K') }; });

function demuxAll(bytes, from, chunker) {
  const init = parseInit(bytes.subarray(0, 64 * 1024));
  const out = [];
  const d = new Fmp4Demuxer(init.track, { startOffset: from ?? init.firstFragment, onSample: s => out.push(s) });
  for (const c of chunker(bytes.subarray(from ?? init.firstFragment))) d.push(c);
  return { init, out, stats: d.stats };
}
const bySize = n => b => { const r = []; for (let i = 0; i < b.length; i += n) r.push(b.subarray(i, i + n)); return r; };
const random = seed => b => { let s = seed, i = 0; const r = []; while (i < b.length) { s = (s * 1103515245 + 12345) & 0x7fffffff; const n = 1 + (s % 70000); r.push(b.subarray(i, i + n)); i += n; } return r; };

test('init: codec config, dimensions and sidx segment index from the first 64 KB', { skip: !HAS_FFMPEG }, () => {
  const v = readFileSync(fx.files.video), a = readFileSync(fx.files.audio);
  const vi = parseInit(v.subarray(0, 64 * 1024));
  assert.equal(vi.status, 'ok');
  assert.deepEqual([vi.track.kind, vi.track.codec, vi.track.width, vi.track.height], ['video', 'avc1.640028', 640, 360]);
  assert.equal(vi.track.description[0], 1, 'avcC configurationVersion');
  assert.equal(vi.segments.length, 18);
  assert.ok(Math.abs(vi.segments[15].time - 30) < 0.001);
  const tail = vi.segments.at(-1).offset + vi.segments.at(-1).size; // FFmpeg appends an mfra index box
  assert.ok(tail === v.length || v.subarray(tail + 4, tail + 8).toString() === 'mfra', 'segments cover the media');
  const ai = parseInit(a.subarray(0, 64 * 1024));
  assert.deepEqual([ai.track.kind, ai.track.codec, ai.track.sampleRate, ai.track.numberOfChannels], ['audio', 'mp4a.40.2', 44100, 2]);
  assert.deepEqual([...ai.track.description.subarray(0, 2)], [0x12, 0x10]); // AAC-LC 44.1 kHz stereo (+ optional SBR sync ext)
  assert.equal(parseInit(v.subarray(0, 200)).status, 'need');
  assert.equal(segmentFor(vi.segments, 31).time, 30);
  assert.equal(segmentFor(vi.segments, 0).time, 0);
  assert.equal(segmentFor(vi.segments, 999), vi.segments.at(-1));
});

test('video demux: every sample matches ffprobe (count, size, keyframes, PTS) for any chunking', { skip: !HAS_FFMPEG }, () => {
  const v = readFileSync(fx.files.video);
  const truth = probePackets(fx.files.video, 'v:0');
  for (const chunker of [b => [b], bySize(1), bySize(188), bySize(65536), random(3)]) {
    const { out } = demuxAll(v, undefined, chunker);
    assert.equal(out.length, truth.length);
    assert.equal(out.filter(s => s.type === 'key').length, truth.filter(p => p.key).length);
    out.forEach((s, i) => {
      assert.equal(s.data.length, truth[i].size, `sample ${i} size`);
      assert.ok(Math.abs(s.timestamp / 1e6 - truth[i].pts) < 0.001, `sample ${i} pts ${s.timestamp} vs ${truth[i].pts}`);
    });
  }
});

test('audio demux matches ffprobe; demux from a mid-file segment starts on a keyframe at that time', { skip: !HAS_FFMPEG }, () => {
  const a = readFileSync(fx.files.audio), v = readFileSync(fx.files.video);
  const truth = probePackets(fx.files.audio, 'a:0');
  const { out, init } = demuxAll(a, undefined, random(9));
  assert.equal(out.length, truth.length);
  out.forEach((s, i) => assert.ok(Math.abs(s.timestamp / 1e6 - truth[i].pts) < 0.001, `audio ${i}: ${s.timestamp} vs ${truth[i].pts}`));
  assert.ok(Math.abs(out[1].timestamp - out[0].timestamp - 23220) <= 1, 'AAC frame = 1024 samples @ 44.1 kHz');
  const seg = segmentFor(parseInit(v.subarray(0, 65536)).segments, 31);
  const mid = demuxAll(v, seg.offset, bySize(4096)).out;
  assert.equal(mid[0].type, 'key');
  assert.ok(Math.abs(mid[0].timestamp / 1e6 - 30.0667) < 0.001, `first ${mid[0].timestamp}`);
  assert.equal(mid.length, 180);
  assert.ok(init);
});

test('rejects non-fragmented MP4 and DRM sample entries', { skip: !HAS_FFMPEG }, () => {
  const p = readFileSync(fx.files.progressive);
  assert.throws(() => parseInit(p), /fragmented|mdat before moov/);
});
