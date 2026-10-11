'use strict';

// Time-stretching (change length, keep pitch), pitch-shifting (change pitch, keep length) and tempo detection.
const Stretch = {
  // WSOLA: overlap-add windows taken from the input at a different spacing than they are laid down,
  // nudging each window to where it lines up best with the previous one. F = output length / input length.
  wsola(chs, sr, F) {
    const inLen = chs[0].length, outLen = Math.max(1, Math.round(inLen * F));
    const N = Math.round(sr * 0.046) & ~1, Hs = N / 2, Ha = Hs / F, tol = Math.round(sr * 0.012);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    let mono = chs[0];
    if (chs.length > 1) {
      mono = new Float32Array(inLen);
      for (const c of chs) for (let i = 0; i < inLen; i++) mono[i] += c[i];
    }
    const out = chs.map(() => new Float32Array(outLen + N));
    let prev = 0;
    for (let m = 0; m * Hs < outLen; m++) {
      let p = Math.round(m * Ha);
      if (m > 0) {
        // best match for the natural continuation of the previous window
        const ref = prev + Hs;
        let best = -Infinity, bestD = 0;
        for (let d = -tol; d <= tol; d += 2) {
          const a = p + d;
          if (a < 0 || a + Hs >= inLen) continue;
          let s = 0;
          for (let i = 0; i < Hs; i += 3) s += mono[a + i] * (mono[ref + i] || 0);
          if (s > best) { best = s; bestD = d; }
        }
        p += bestD;
      }
      const o = m * Hs;
      for (let c = 0; c < chs.length; c++) {
        const src = chs[c], dst = out[c];
        for (let i = 0, e = Math.min(N, inLen - p); i < e; i++) dst[o + i] += src[p + i] * win[i];
      }
      prev = p;
    }
    return out.map(d => d.subarray(0, outLen));
  },

  // New buffer that is `time`x as long and `semis` semitones higher than the source.
  async make(buf, time, semis) {
    const sr = buf.sampleRate, ratio = Math.pow(2, semis / 12), F = time * ratio;
    let chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    if (Math.abs(F - 1) > 1e-3) chs = this.wsola(chs, sr, F);
    const ctx = Engine.ctx, mid = ctx.createBuffer(chs.length, chs[0].length, sr);
    chs.forEach((d, c) => mid.getChannelData(c).set(d));
    if (Math.abs(ratio - 1) < 1e-4) return mid;
    // resample: playing faster raises the pitch and brings the length back to time x original
    const off = new OfflineAudioContext(chs.length, Math.max(1, Math.round(mid.length / ratio)), sr), src = off.createBufferSource();
    src.buffer = mid;
    src.playbackRate.value = ratio;
    src.connect(off.destination);
    src.start();
    return off.startRendering();
  },

  // Tempo in BPM, or null when there is no clear pulse. Autocorrelation of the onset envelope,
  // then snapped to a whole number of bars when the file is a tight loop.
  detectBpm(buf) {
    const sr = buf.sampleRate, dur = buf.duration;
    if (dur < 1.5) return null;
    const hop = Math.round(sr / 200), n = Math.min(Math.floor(buf.length / hop), 200 * 90);
    const env = new Float32Array(n), d0 = buf.getChannelData(0), d1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = i * hop, e = j + hop; j < e; j++) { const v = d1 ? (d0[j] + d1[j]) / 2 : d0[j]; s += v * v; }
      env[i] = Math.log(1 + 200 * s / hop);
    }
    const on = new Float32Array(n);
    let total = 0;
    // the 0.25 floor ignores the small ripple a steady tone leaves in the envelope
    for (let i = 1; i < n; i++) { on[i] = Math.max(0, env[i] - env[i - 1] - 0.25); total += on[i]; }
    if (total / n < 0.002) return null;
    let best = 0, bestL = 0;
    const score = L => {
      let s = 0;
      for (let i = 0; i + 2 * L < n; i++) s += on[i] * (on[i + L] + 0.5 * on[i + 2 * L]);
      return s / Math.max(1, n - 2 * L);
    };
    let sum = 0, top = 0;
    for (let L = 60; L <= 200; L++) {     // 200 .. 60 BPM
      const bpm = 12000 / L, w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      const raw = score(L), s = raw * w;
      sum += raw;
      if (raw > top) top = raw;
      if (s > best) { best = s; bestL = L; }
    }
    // a real pulse stands well clear of the average; sustained sounds do not
    if (!bestL || top < 2 * sum / 141) return null;
    let est = 12000 / bestL;
    for (const mult of [1, 2, 0.5]) {
      for (const bars of [1, 2, 4, 8, 16, 32]) {
        const b = 240 * bars / dur;
        if (b >= 60 && b <= 200 && Math.abs(b - est * mult) / b < 0.035) return Math.round(b * 100) / 100;
      }
    }
    return Math.round(est * 10) / 10;
  },
};
