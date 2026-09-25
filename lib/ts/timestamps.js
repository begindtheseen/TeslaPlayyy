// MPEG-TS clocks run at 90 kHz and wrap at 2^33. WebCodecs timestamps are microseconds.
export const PTS_WRAP = 2 ** 33;
export const ticksToUs = ticks => Math.round((ticks * 100) / 9);
export const usToTicks = us => Math.round((us * 9) / 100);

// Keeps a monotonic 90 kHz timeline across 33-bit wraparound. One instance per elementary stream.
export class TimestampUnwrapper {
  constructor() { this.reset(); }
  reset() { this.offset = 0; this.last = null; }
  unwrap(ticks) {
    if (this.last !== null) {
      const raw = ticks + this.offset;
      if (raw - this.last < -PTS_WRAP / 2) this.offset += PTS_WRAP;
      else if (raw - this.last > PTS_WRAP / 2) this.offset -= PTS_WRAP;
    }
    const out = ticks + this.offset;
    this.last = out;
    return out;
  }
}
