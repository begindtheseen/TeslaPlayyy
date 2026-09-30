// Chooses YouTube formats for the canvas player and decides how they are delivered.
//
//  dual  : separate DASH video (H.264 fMP4) + audio (AAC m4a) fetched by the worker through the
//          range proxy /api/stream. No server CPU; precise byte-range seeking via the sidx index.
//  muxed : the server remuxes video + audio with `ffmpeg -c copy -f mpegts` into ONE MPEG-TS stream
//          (/api/muxed) that the worker's TS demuxer already plays. One connection, one demuxer.
//          Used for Intel Tesla MCUs, and whenever the dual path is impossible (progressive-only
//          videos, non-H.264/AAC sources which are then transcoded).

export const isH264 = f => /^avc1\./i.test(f.vcodec || '');
export const isAac = f => /^mp4a\.40\.\d+/i.test(f.acodec || '');
const isMp4 = f => f.container === 'mp4' || f.container === 'm4a';
const sdr = f => !f.dynamicRange || f.dynamicRange === 'SDR';

export function pickVideo(formats, { maxHeight = 1080, maxFps = 60 } = {}) {
  const ok = formats.filter(f => f.hasVideo && !f.hasAudio && isH264(f) && isMp4(f) && sdr(f) && f.height && f.height <= maxHeight && (f.fps || 30) <= maxFps + 1);
  return ok.sort((a, b) => b.height - a.height || (b.fps || 0) - (a.fps || 0) || b.bitrate - a.bitrate)[0] || null;
}

// AAC-LC 128k (itag 140) beats HE-AAC 48k (139); original-language track beats dubs; DRC variants last.
export function pickAudio(formats) {
  const ok = formats.filter(f => f.hasAudio && !f.hasVideo && isAac(f) && isMp4(f));
  const score = f => [(f.languagePreference ?? 0), /-drc/i.test(f.formatId || '') ? 0 : 1, /mp4a\.40\.2$/i.test(f.acodec) ? 1 : 0, f.bitrate];
  return ok.sort((a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; })[0] || null;
}

export function pickProgressive(formats, { maxHeight = 1080 } = {}) {
  return formats.filter(f => f.hasVideo && f.hasAudio && isH264(f) && isAac(f) && (f.height || 0) <= maxHeight)
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null;
}

// Tesla's browser is Chromium on Linux with "Tesla/<version>" in the UA. The UA does not reveal the
// MCU generation, so the client-side probe (lib/player/platform.js) is preferred; this is the fallback.
export const isTeslaUA = ua => /\bTesla\b/i.test(ua || '');

export function planDelivery(formats, { delivery = 'auto', maxHeight = 1080, maxFps = 60, userAgent = '' } = {}) {
  const want = delivery === 'dual' || delivery === 'muxed' ? delivery : (isTeslaUA(userAgent) ? 'muxed' : 'dual');
  const video = pickVideo(formats, { maxHeight, maxFps });
  const audio = pickAudio(formats);
  if (video && audio) return { delivery: want, video, audio, transcode: { video: false, audio: false }, reason: want === delivery ? 'requested' : 'auto' };

  const progressive = pickProgressive(formats, { maxHeight });
  if (progressive) return { delivery: 'muxed', video: progressive, audio: null, transcode: { video: false, audio: false }, reason: 'progressive-only' };

  // Last resort: whatever exists, transcoded by the muxer (CPU cost on the server).
  const anyVideo = formats.filter(f => f.hasVideo && (f.height || 0) <= maxHeight).sort((a, b) => (b.height || 0) - (a.height || 0) || b.bitrate - a.bitrate)[0]
    || formats.filter(f => f.hasVideo).sort((a, b) => (a.height || 0) - (b.height || 0))[0];
  if (!anyVideo) return null;
  const anyAudio = anyVideo.hasAudio ? null : (audio || formats.filter(f => f.hasAudio && !f.hasVideo).sort((a, b) => b.bitrate - a.bitrate)[0] || null);
  return {
    delivery: 'muxed', video: anyVideo, audio: anyAudio,
    transcode: { video: !isH264(anyVideo), audio: !!(anyAudio ? !isAac(anyAudio) : anyVideo.hasAudio && !isAac(anyVideo)) },
    reason: 'transcode-fallback',
  };
}

export const describeFormat = f => f && ({ itag: f.itag, mimeType: f.mimeType, width: f.width, height: f.height, fps: f.fps, bitrate: f.bitrate, contentLength: f.contentLength });
