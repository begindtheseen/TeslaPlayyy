// Client capability probe that chooses how YouTube media is delivered to the canvas player.
//
// Tesla's browser UA ("... Chrome/x Safari/537.36 Tesla/2025.x") is identical on both MCU generations,
// so the GPU is read through WebGL instead:
//   MCU2  Intel Atom A3950, "Intel(R) HD Graphics 505"  -> muxed: one server-remuxed MPEG-TS stream,
//         capped at 30 fps (1080p60 decode is the heaviest load on that SoC)
//   MCU3  AMD Ryzen V1000, "AMD Radeon ... Vega"          -> dual: DASH video + audio via range proxy
// URL overrides: ?intel=1 (force muxed), ?intel=0 or ?delivery=dual|muxed, ?maxHeight=720, ?maxFps=30.
// This mapping is from published hardware specs; it has not been verified on a vehicle.

export function gpuRenderer() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return r;
  } catch { return ''; }
}

export function classifyGpu(r) {
  if (/amd|radeon/i.test(r)) return 'amd';
  if (/intel/i.test(r)) return 'intel';
  if (/nvidia|geforce/i.test(r)) return 'nvidia';
  if (/apple/i.test(r)) return 'apple';
  if (/swiftshader|llvmpipe|software/i.test(r)) return 'software';
  return 'unknown';
}

// Pure decision so it can be unit tested: {ua, gpu, cores, search} -> platform.
export function decidePlatform({ ua = '', gpu = '', cores = 0, search = '' } = {}) {
  const q = new URLSearchParams(search);
  const tesla = /\bTesla\b/.test(ua);
  const gpuVendor = classifyGpu(gpu);
  const mcu = !tesla ? null : gpuVendor === 'amd' ? 'amd' : gpuVendor === 'intel' ? 'intel' : cores && cores <= 4 ? 'intel' : 'unknown';
  let delivery, reason;
  if (q.get('intel') === '1') { delivery = 'muxed'; reason = '?intel=1'; }
  else if (q.get('intel') === '0') { delivery = 'dual'; reason = '?intel=0'; }
  else if (['muxed', 'dual'].includes(q.get('delivery'))) { delivery = q.get('delivery'); reason = `?delivery=${delivery}`; }
  else if (tesla) { delivery = mcu === 'amd' ? 'dual' : 'muxed'; reason = `Tesla ${mcu === 'unknown' ? 'MCU (unknown GPU)' : `${mcu.toUpperCase()} MCU`}`; }
  else if (gpuVendor === 'intel' && cores > 0 && cores <= 4) { delivery = 'muxed'; reason = 'low-power Intel GPU'; }
  else { delivery = 'dual'; reason = 'desktop-class browser'; }
  const num = k => { const n = Number.parseInt(q.get(k) || '', 10); return Number.isFinite(n) ? n : null; };
  return {
    tesla, gpu, gpuVendor, cores, mcu, delivery, reason,
    maxHeight: num('maxHeight') ?? 1080,
    maxFps: num('maxFps') ?? (mcu === 'intel' || reason === 'low-power Intel GPU' ? 30 : 60),
  };
}

export function detectPlatform() {
  if (typeof window === 'undefined') return decidePlatform();
  return decidePlatform({ ua: navigator.userAgent, gpu: gpuRenderer(), cores: navigator.hardwareConcurrency || 0, search: location.search });
}
