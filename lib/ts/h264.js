// H.264 Annex B helpers: NAL splitting, keyframe detection and SPS parsing.

export const NAL = { SLICE: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9 };

// Splits an Annex B byte stream into NAL unit payloads (start codes stripped).
export function splitNalUnits(bytes) {
  const units = [];
  let start = -1;
  const n = bytes.length;
  for (let i = 0; i + 2 < n; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        // A 4-byte start code's leading zero (and trailing_zero_8bits) belongs to no NAL.
        while (end > start && bytes[end - 1] === 0) end--;
        if (end > start) units.push(bytes.subarray(start, end));
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < n) units.push(bytes.subarray(start));
  return units;
}

export const nalType = nal => nal[0] & 0x1f;

export function isKeyframe(nals) {
  return nals.some(n => nalType(n) === NAL.IDR);
}

// Removes emulation-prevention bytes (00 00 03 -> 00 00).
export function toRbsp(nal) {
  const out = new Uint8Array(nal.length);
  let o = 0;
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out[o++] = nal[i];
  }
  return out.subarray(0, o);
}

class BitReader {
  constructor(bytes) { this.b = bytes; this.pos = 0; }
  bit() {
    if (this.pos >= this.b.length * 8) throw new RangeError('SPS truncated');
    const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
  ue() { let z = 0; while (this.bit() === 0) { if (++z > 31) throw new RangeError('bad exp-golomb'); } return 2 ** z - 1 + this.bits(z); }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}

function skipScalingList(r, size) {
  let last = 8, next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

// Parses the fields needed to configure a decoder and size the canvas.
export function parseSps(nal) {
  const rbsp = toRbsp(nal);
  const profileIdc = rbsp[1], constraints = rbsp[2], levelIdc = rbsp[3];
  const r = new BitReader(rbsp.subarray(4));
  r.ue(); // seq_parameter_set_id
  let chromaFormatIdc = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.bit();
    r.ue(); r.ue(); r.bit();
    if (r.bit()) {
      for (let i = 0; i < (chromaFormatIdc !== 3 ? 8 : 12); i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.bit(); r.se(); r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); r.bit(); // max_num_ref_frames, gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1, heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit(); // direct_8x8_inference_flag
  let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
  if (r.bit()) { cropL = r.ue(); cropR = r.ue(); cropT = r.ue(); cropB = r.ue(); }
  const cropUnitX = chromaFormatIdc === 0 || chromaFormatIdc === 3 ? 1 : 2;
  const cropUnitY = (chromaFormatIdc === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return {
    profileIdc, constraints, levelIdc,
    codec: codecString(profileIdc, constraints, levelIdc),
    width: widthMbs * 16 - cropUnitX * (cropL + cropR),
    height: (2 - frameMbsOnly) * heightMapUnits * 16 - cropUnitY * (cropT + cropB),
  };
}

const hex = v => v.toString(16).padStart(2, '0').toUpperCase();
export const codecString = (profile, constraints, level) => `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
