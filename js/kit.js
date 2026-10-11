'use strict';

// Built-in drum kit, synthesised at startup so the beat maker works with no files loaded.
const Kit = {
  list: [
    { id: 'kit:kick', name: 'Kick' },
    { id: 'kit:808', name: '808 Bass' },
    { id: 'kit:snare', name: 'Snare' },
    { id: 'kit:clap', name: 'Clap' },
    { id: 'kit:chat', name: 'Closed Hat' },
    { id: 'kit:ohat', name: 'Open Hat' },
    { id: 'kit:tom', name: 'Tom' },
    { id: 'kit:rim', name: 'Rim' },
    { id: 'kit:shaker', name: 'Shaker' },
    { id: 'kit:cowbell', name: 'Cowbell' },
  ],

  build(ctx, map) {
    const sr = ctx.sampleRate, TAU = Math.PI * 2;
    const noise = () => Math.random() * 2 - 1;
    const lp = fc => { let y = 0; const a = 1 - Math.exp(-TAU * fc / sr); return x => (y += a * (x - y)); };
    const hp = fc => { const f = lp(fc); return x => x - f(x); };
    const make = (dur, fn) => {
      const n = Math.floor(dur * sr), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = fn(i / sr, i);
      const f = Math.min(200, n);
      for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
      return buf;
    };
    // sine with a pitch sweep from f1 down to f0
    const sweep = (f0, f1, rate) => { let ph = 0; return t => { ph += TAU * (f0 + (f1 - f0) * Math.exp(-t * rate)) / sr; return Math.sin(ph); }; };
    const sq = f => t => (Math.sin(TAU * f * t) >= 0 ? 1 : -1);

    let s = sweep(46, 170, 30);
    map.set('kit:kick', make(0.5, t => Math.tanh(1.5 * s(t) * Math.exp(-t * 7)) + noise() * Math.exp(-t * 500) * 0.25));

    s = sweep(48, 120, 45);
    map.set('kit:808', make(1.4, t => Math.tanh(1.8 * s(t) * Math.exp(-t * 2.4)) * 0.9));

    let h = hp(1800);
    map.set('kit:snare', make(0.3, t =>
      Math.sin(TAU * 185 * t) * Math.exp(-t * 24) * 0.5 + Math.sin(TAU * 330 * t) * Math.exp(-t * 32) * 0.25
      + h(noise()) * Math.exp(-t * 17) * 0.7));

    h = hp(900); let l = lp(3200);
    map.set('kit:clap', make(0.35, t => {
      let env = Math.exp(-Math.max(0, t - 0.03) * 26) * (t >= 0.03 ? 1 : 0);
      for (const o of [0, 0.01, 0.02]) if (t >= o && t < o + 0.01) env = Math.max(env, Math.exp(-(t - o) * 160));
      return l(h(noise())) * env * 1.6;
    }));

    h = hp(7000);
    map.set('kit:chat', make(0.09, t => h(noise()) * Math.exp(-t * 70) * 0.8));
    h = hp(6500);
    map.set('kit:ohat', make(0.5, t => h(noise()) * Math.exp(-t * 9) * 0.7));

    s = sweep(95, 190, 18);
    map.set('kit:tom', make(0.5, t => s(t) * Math.exp(-t * 7) * 0.9));

    map.set('kit:rim', make(0.09, t =>
      (Math.sin(TAU * 1700 * t) * 0.6 + Math.sin(TAU * 480 * t) * 0.4) * Math.exp(-t * 90) + noise() * Math.exp(-t * 900) * 0.4));

    h = hp(4500);
    map.set('kit:shaker', make(0.14, t => h(noise()) * Math.min(1, t / 0.02) * Math.exp(-t * 36) * 0.8));

    h = hp(500); l = lp(4000);
    const a = sq(540), b = sq(800);
    map.set('kit:cowbell', make(0.4, t => l(h(a(t) + b(t))) * Math.exp(-t * 12) * 0.35));
  },
};
