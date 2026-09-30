#!/usr/bin/env node
// Minimal yt-dlp stand-in for tests. Understands `-j ... --extractor-args youtube:player_client=X -- URL`.
// Magic video ids reproduce YouTube's failure modes with yt-dlp's real error wording.
import { statSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('2026.08.19-fake\n'); process.exit(0); }
const url = args[args.length - 1];
const id = new URL(url).searchParams.get('v');
const clients = (args[args.indexOf('--extractor-args') + 1] || '').replace('youtube:player_client=', '');
if (process.env.FAKE_YTDLP_LOG) appendFileSync(process.env.FAKE_YTDLP_LOG, JSON.stringify({ id, clients, args }) + '\n');
const die = msg => { process.stderr.write(`ERROR: [youtube] ${id}: ${msg}\n`); process.exit(1); };
const delay = Number(process.env.FAKE_YTDLP_DELAY_MS || 0);
if (delay) await new Promise(r => setTimeout(r, delay));

switch (id) {
  case 'PRIVATEVID0': die("Private video. Sign in if you've been granted access to this video");
  case 'AGEGATED000': die('Sign in to confirm your age. This video may be inappropriate for some users.');
  case 'REGIONLOCK0': die('The uploader has not made this video available in your country');
  case 'REMOVED0000': die('Video unavailable. This video has been removed by the uploader');
  case 'MEMBERSONLY': die('Join this channel to get access to members-only content like this video, and other exclusive perks.');
  case 'ALWAYSBLOCK': die("Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.");
  case 'BOTBLOCKED0': if (clients.includes('android_vr')) die("Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.");
}

const base = process.env.FAKE_CDN_BASE, dir = process.env.FAKE_FIXTURE_DIR;
const expire = Math.floor(Date.now() / 1000) + Number(process.env.FAKE_EXPIRE_SECONDS || 21600);
const size = f => statSync(path.join(dir, f)).size;
const cdn = (itag, f) => `${base}/videoplayback?expire=${expire}&itag=${itag}&clen=${size(f)}&ip=203.0.113.7&f=${f}`;
// The DASH video entry describes the fixture actually served (360p30 by default; 1080p60 for perf runs).
const fv = { width: 640, height: 360, fps: 30, ...JSON.parse(process.env.FAKE_VIDEO || '{}') };
const vItag = fv.height >= 1080 ? (fv.fps > 30 ? 299 : 137) : fv.height >= 720 ? (fv.fps > 30 ? 298 : 136) : 134;
const progressive = { format_id: '18', ext: 'mp4', protocol: 'https', url: cdn(18, 'p.mp4'), vcodec: 'avc1.64001E', acodec: 'mp4a.40.2', width: 640, height: 360, fps: 30, tbr: 600, container: 'mp4', format_note: '360p' };
let formats = [
  { format_id: 'sb0', ext: 'mhtml', protocol: 'mhtml', url: `${base}/sb/x.jpg`, vcodec: 'none', acodec: 'none', format_note: 'storyboard' },
  { format_id: '139', ext: 'm4a', protocol: 'https', url: cdn(139, 'a.m4a'), vcodec: 'none', acodec: 'mp4a.40.5', abr: 48, asr: 22050, audio_channels: 2, container: 'm4a_dash', format_note: 'low' },
  { format_id: '140', ext: 'm4a', protocol: 'https', url: cdn(140, 'a.m4a'), vcodec: 'none', acodec: 'mp4a.40.2', abr: 96, asr: 44100, audio_channels: 2, container: 'm4a_dash', format_note: 'medium', filesize: size('a.m4a') },
  { format_id: '251', ext: 'webm', protocol: 'https', url: `${base}/videoplayback?itag=251&f=none.webm&expire=${expire}`, vcodec: 'none', acodec: 'opus', abr: 130, container: 'webm_dash' },
  progressive,
  { format_id: String(vItag), ext: 'mp4', protocol: 'https', url: cdn(vItag, 'v.mp4'), vcodec: 'avc1.640028', acodec: 'none', width: fv.width, height: fv.height, fps: fv.fps, vbr: 500, container: 'mp4_dash', format_note: `${fv.height}p` },
  { format_id: '243', ext: 'webm', protocol: 'https', url: `${base}/videoplayback?itag=243&f=none.webm&expire=${expire}`, vcodec: 'vp9', acodec: 'none', width: 640, height: 360, fps: 30, container: 'webm_dash' },
  { format_id: '96', ext: 'mp4', protocol: 'm3u8_native', url: `${base}/manifest.m3u8`, vcodec: 'avc1.640028', acodec: 'mp4a.40.2', width: 1920, height: 1080 },
];
if (id === 'PROGRESSIV0') formats = [progressive];
const info = {
  id, title: `Fake video ${id}`, channel: 'CanvasTube tests', duration: fv.seconds || 36, thumbnail: `${base}/thumb.jpg`,
  is_live: id === 'LIVESTREAM0', live_status: id === 'LIVESTREAM0' ? 'is_live' : 'not_live', availability: 'public', age_limit: 0, formats,
};
process.stdout.write(JSON.stringify(info) + '\n');
