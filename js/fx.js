'use strict';

// Effect definitions. Each create(ctx, p, env) returns {in, out, set(p), stop?()} and must
// work in both the live AudioContext and the OfflineAudioContext used for export.
const FX = (() => {
  const isLive = ctx => typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
  const setP = (ctx, param, v) => {
    // (an offline render only changes parameters mid-way when automation is being applied)
    if (isLive(ctx) || ctx.currentTime > 0) param.setTargetAtTime(v, ctx.currentTime, 0.012);
    else param.value = v;
  };

  function wetDry(ctx, equalPower) {
    const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    inp.connect(dry); dry.connect(out); wet.connect(out);
    return {
      in: inp, out, wet,
      mix(m) {
        setP(ctx, dry.gain, equalPower ? Math.cos(m * Math.PI / 2) : 1 - m);
        setP(ctx, wet.gain, equalPower ? Math.sin(m * Math.PI / 2) : m);
      },
    };
  }

  function lfo(ctx, target) {
    const osc = ctx.createOscillator(), depth = ctx.createGain();
    osc.connect(depth); depth.connect(target);
    osc.start();
    return { osc, depth };
  }

  function biquad(ctx, type) {
    const b = ctx.createBiquadFilter();
    b.type = type;
    return b;
  }

  function impulse(ctx, sec) {
    const sr = ctx.sampleRate, n = Math.max(1, Math.floor(sr * sec)), buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-6.9 * i / n);
    }
    return buf;
  }

  const SYNC = { '1/2': 2, '1/4': 1, '1/4 triplet': 2 / 3, '1/8 dotted': 0.75, '1/8': 0.5, '1/16': 0.25 };

  const defs = {
    eq: {
      name: 'Parametric EQ',
      params: [
        { k: 'hp', label: 'Low cut', min: 20, max: 1000, def: 20, unit: 'Hz', log: true },
        { k: 'low', label: 'Low', min: -18, max: 18, def: 0, unit: 'dB', step: 0.5 },
        { k: 'mid', label: 'Mid', min: -18, max: 18, def: 0, unit: 'dB', step: 0.5 },
        { k: 'midF', label: 'Mid freq', min: 200, max: 8000, def: 1000, unit: 'Hz', log: true },
        { k: 'high', label: 'High', min: -18, max: 18, def: 0, unit: 'dB', step: 0.5 },
      ],
      create(ctx) {
        const hp = biquad(ctx, 'highpass'), lo = biquad(ctx, 'lowshelf'), mid = biquad(ctx, 'peaking'), hi = biquad(ctx, 'highshelf');
        lo.frequency.value = 120; hi.frequency.value = 6000; mid.Q.value = 0.9; hp.Q.value = 0.707;
        hp.connect(lo); lo.connect(mid); mid.connect(hi);
        return {
          in: hp, out: hi,
          // combined magnitude response in dB at the given frequencies (for the EQ display)
          curve(freqs) {
            const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length), out = new Float32Array(freqs.length);
            for (const n of [hp, lo, mid, hi]) { n.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < out.length; i++) out[i] += 20 * Math.log10(mag[i] || 1e-6); }
            return out;
          },
          set(p) {
            setP(ctx, hp.frequency, p.hp); setP(ctx, lo.gain, p.low);
            setP(ctx, mid.gain, p.mid); setP(ctx, mid.frequency, p.midF); setP(ctx, hi.gain, p.high);
          },
        };
      },
    },

    filter: {
      name: 'Filter',
      params: [
        { k: 'type', label: 'Type', opts: ['lowpass', 'highpass', 'bandpass', 'notch'], def: 'lowpass' },
        { k: 'freq', label: 'Cutoff', min: 20, max: 20000, def: 1200, unit: 'Hz', log: true },
        { k: 'q', label: 'Resonance', min: 0.1, max: 20, def: 1, step: 0.1 },
      ],
      create(ctx) {
        const f = biquad(ctx, 'lowpass');
        return { in: f, out: f, set(p) { f.type = p.type; setP(ctx, f.frequency, p.freq); setP(ctx, f.Q, p.q); } };
      },
    },

    comp: {
      name: 'Compressor',
      params: [
        { k: 'thr', label: 'Threshold', min: -60, max: 0, def: -24, unit: 'dB', step: 0.5 },
        { k: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, step: 0.5, unit: ':1' },
        { k: 'att', label: 'Attack', min: 0, max: 200, def: 5, unit: 'ms', step: 1 },
        { k: 'rel', label: 'Release', min: 10, max: 1000, def: 150, unit: 'ms', step: 5 },
        { k: 'knee', label: 'Knee', min: 0, max: 40, def: 12, unit: 'dB', step: 1 },
        { k: 'makeup', label: 'Makeup', min: 0, max: 24, def: 0, unit: 'dB', step: 0.5 },
      ],
      create(ctx) {
        const c = ctx.createDynamicsCompressor(), g = ctx.createGain();
        c.connect(g);
        return {
          in: c, out: g,
          set(p) {
            setP(ctx, c.threshold, p.thr); setP(ctx, c.ratio, p.ratio); setP(ctx, c.attack, p.att / 1000);
            setP(ctx, c.release, p.rel / 1000); setP(ctx, c.knee, p.knee); setP(ctx, g.gain, U.dbToGain(p.makeup));
          },
        };
      },
    },

    limiter: {
      name: 'Limiter',
      params: [
        { k: 'gain', label: 'Input gain', min: 0, max: 24, def: 0, unit: 'dB', step: 0.5 },
        { k: 'ceil', label: 'Ceiling', min: -12, max: 0, def: -1, unit: 'dB', step: 0.1 },
        { k: 'rel', label: 'Release', min: 10, max: 500, def: 80, unit: 'ms', step: 5 },
      ],
      create(ctx) {
        const g = ctx.createGain(), c = ctx.createDynamicsCompressor();
        c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001;
        g.connect(c);
        return {
          in: g, out: c,
          set(p) { setP(ctx, g.gain, U.dbToGain(p.gain)); setP(ctx, c.threshold, p.ceil); setP(ctx, c.release, p.rel / 1000); },
        };
      },
    },

    reverb: {
      name: 'Reverb',
      params: [
        { k: 'decay', label: 'Decay', min: 0.2, max: 8, def: 2.2, unit: 's', step: 0.1, noAuto: true },
        { k: 'pre', label: 'Pre-delay', min: 0, max: 100, def: 10, unit: 'ms', step: 1 },
        { k: 'tone', label: 'Tone', min: 500, max: 16000, def: 6000, unit: 'Hz', log: true },
        { k: 'mix', label: 'Mix', min: 0, max: 1, def: 0.25, unit: '%' },
      ],
      create(ctx) {
        const m = wetDry(ctx, true), pre = ctx.createDelay(0.2), conv = ctx.createConvolver(), tone = biquad(ctx, 'lowpass');
        m.in.connect(pre); pre.connect(conv); conv.connect(tone); tone.connect(m.wet);
        let decay = null;
        return {
          in: m.in, out: m.out,
          set(p) {
            if (p.decay !== decay) { conv.buffer = impulse(ctx, p.decay); decay = p.decay; }
            setP(ctx, pre.delayTime, p.pre / 1000); setP(ctx, tone.frequency, p.tone); m.mix(p.mix);
          },
        };
      },
    },

    delay: {
      name: 'Delay',
      params: [
        { k: 'sync', label: 'Sync', opts: ['free', ...Object.keys(SYNC)], def: '1/8 dotted' },
        { k: 'time', label: 'Time (free)', min: 10, max: 2000, def: 375, unit: 'ms', step: 1 },
        { k: 'fb', label: 'Feedback', min: 0, max: 0.95, def: 0.4, unit: '%' },
        { k: 'tone', label: 'Tone', min: 500, max: 16000, def: 5000, unit: 'Hz', log: true },
        { k: 'mix', label: 'Mix', min: 0, max: 1, def: 0.3, unit: '%' },
      ],
      create(ctx, p0, env) {
        const m = wetDry(ctx, true), d = ctx.createDelay(4), tone = biquad(ctx, 'lowpass'), fb = ctx.createGain();
        m.in.connect(d); d.connect(tone); tone.connect(m.wet); tone.connect(fb); fb.connect(d);
        return {
          in: m.in, out: m.out,
          set(p) {
            const t = p.sync === 'free' ? p.time / 1000 : 60 / env.bpm * SYNC[p.sync];
            setP(ctx, d.delayTime, Math.min(4, t)); setP(ctx, fb.gain, p.fb); setP(ctx, tone.frequency, p.tone); m.mix(p.mix);
          },
        };
      },
    },

    dist: {
      name: 'Distortion',
      params: [
        { k: 'drive', label: 'Drive', min: 0, max: 100, def: 30, step: 1 },
        { k: 'tone', label: 'Tone', min: 500, max: 16000, def: 8000, unit: 'Hz', log: true },
        { k: 'level', label: 'Output', min: -24, max: 6, def: -3, unit: 'dB', step: 0.5 },
        { k: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '%' },
      ],
      create(ctx) {
        const m = wetDry(ctx, false), ws = ctx.createWaveShaper(), tone = biquad(ctx, 'lowpass'), lvl = ctx.createGain();
        ws.oversample = '4x';
        m.in.connect(ws); ws.connect(tone); tone.connect(lvl); lvl.connect(m.wet);
        let drive = null;
        return {
          in: m.in, out: m.out,
          set(p) {
            if (p.drive !== drive) {
              const k = 1 + p.drive / 4, n = 2048, c = new Float32Array(n), norm = Math.tanh(k);
              for (let i = 0; i < n; i++) c[i] = Math.tanh(k * (i / (n - 1) * 2 - 1)) / norm;
              ws.curve = c; drive = p.drive;
            }
            setP(ctx, tone.frequency, p.tone); setP(ctx, lvl.gain, U.dbToGain(p.level)); m.mix(p.mix);
          },
        };
      },
    },

    chorus: {
      name: 'Chorus',
      params: [
        { k: 'rate', label: 'Rate', min: 0.05, max: 8, def: 0.8, unit: 'Hz', step: 0.05 },
        { k: 'depth', label: 'Depth', min: 0, max: 1, def: 0.4, unit: '%' },
        { k: 'mix', label: 'Mix', min: 0, max: 1, def: 0.5, unit: '%' },
      ],
      create(ctx) {
        // two delay lines modulated in opposite phase, one per side, for width
        const m = wetDry(ctx, false), dl = ctx.createDelay(0.1), dr = ctx.createDelay(0.1), merge = ctx.createChannelMerger(2);
        dl.delayTime.value = 0.017; dr.delayTime.value = 0.021;
        m.in.connect(dl); m.in.connect(dr); dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); merge.connect(m.wet);
        const a = lfo(ctx, dl.delayTime), inv = ctx.createGain();
        a.osc.connect(inv); inv.connect(dr.delayTime);
        return {
          in: m.in, out: m.out, stop() { a.osc.stop(); },
          set(p) {
            setP(ctx, a.osc.frequency, p.rate); setP(ctx, a.depth.gain, p.depth * 0.006);
            setP(ctx, inv.gain, -p.depth * 0.006); m.mix(p.mix);
          },
        };
      },
    },

    phaser: {
      name: 'Phaser',
      params: [
        { k: 'rate', label: 'Rate', min: 0.05, max: 8, def: 0.5, unit: 'Hz', step: 0.05 },
        { k: 'depth', label: 'Depth', min: 0, max: 1, def: 0.7, unit: '%' },
        { k: 'fb', label: 'Feedback', min: 0, max: 0.9, def: 0.4, unit: '%' },
        { k: 'mix', label: 'Mix', min: 0, max: 1, def: 0.5, unit: '%' },
      ],
      create(ctx) {
        const m = wetDry(ctx, false), fb = ctx.createGain(), mod = ctx.createGain();
        const stages = [0, 1, 2, 3].map(() => { const a = biquad(ctx, 'allpass'); a.frequency.value = 1000; a.Q.value = 0.6; return a; });
        m.in.connect(stages[0]);
        stages.forEach((s, i) => { if (i) stages[i - 1].connect(s); mod.connect(s.frequency); });
        stages[3].connect(m.wet); stages[3].connect(fb); fb.connect(stages[0]);
        const a = lfo(ctx, mod);
        a.depth.gain.value = 1;
        return {
          in: m.in, out: m.out, stop() { a.osc.stop(); },
          set(p) { setP(ctx, a.osc.frequency, p.rate); setP(ctx, mod.gain, p.depth * 800); setP(ctx, fb.gain, p.fb); m.mix(p.mix); },
        };
      },
    },

    tremolo: {
      name: 'Tremolo',
      params: [
        { k: 'rate', label: 'Rate', min: 0.1, max: 20, def: 5, unit: 'Hz', step: 0.1 },
        { k: 'depth', label: 'Depth', min: 0, max: 1, def: 0.6, unit: '%' },
      ],
      create(ctx) {
        const g = ctx.createGain(), a = lfo(ctx, g.gain);
        return {
          in: g, out: g, stop() { a.osc.stop(); },
          set(p) { setP(ctx, a.osc.frequency, p.rate); setP(ctx, g.gain, 1 - p.depth / 2); setP(ctx, a.depth.gain, p.depth / 2); },
        };
      },
    },

    bitcrush: {
      name: 'Bitcrusher',
      params: [
        { k: 'bits', label: 'Bit depth', min: 2, max: 16, def: 8, step: 1, unit: 'bit' },
        { k: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '%' },
      ],
      create(ctx) {
        const m = wetDry(ctx, false), ws = ctx.createWaveShaper();
        m.in.connect(ws); ws.connect(m.wet);
        let bits = null;
        return {
          in: m.in, out: m.out,
          set(p) {
            if (p.bits !== bits) {
              const n = 65536, c = new Float32Array(n), lv = Math.pow(2, p.bits - 1);
              for (let i = 0; i < n; i++) c[i] = Math.round((i / (n - 1) * 2 - 1) * lv) / lv;
              ws.curve = c; bits = p.bits;
            }
            m.mix(p.mix);
          },
        };
      },
    },

    utility: {
      name: 'Gain / Phase',
      params: [
        { k: 'gain', label: 'Gain', min: -24, max: 24, def: 0, unit: 'dB', step: 0.5 },
        { k: 'invert', label: 'Invert phase', opts: ['off', 'on'], def: 'off' },
      ],
      create(ctx) {
        const g = ctx.createGain();
        return { in: g, out: g, set(p) { setP(ctx, g.gain, U.dbToGain(p.gain) * (p.invert === 'on' ? -1 : 1)); } };
      },
    },
  };

  return {
    defs,
    order: ['eq', 'filter', 'comp', 'limiter', 'reverb', 'delay', 'dist', 'chorus', 'phaser', 'tremolo', 'bitcrush', 'utility'],
    setP,
    h: { wetDry, lfo, biquad },
    make(type) {
      const p = {};
      for (const d of defs[type].params) p[d.k] = d.def;
      return { id: U.uid('f'), type, on: true, p };
    },
    instance(ctx, fx, env) {
      const inst = defs[fx.type].create(ctx, fx.p, env);
      inst.set(fx.p);
      return inst;
    },
    fmt(d, v) {
      if (d.opts) return v;
      switch (d.unit) {
        case '%': return Math.round(v * 100) + '%';
        case 'Hz': return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + ' kHz' : (v < 20 ? v.toFixed(2) : Math.round(v)) + ' Hz';
        case 'dB': return (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
        case 'ms': return Math.round(v) + ' ms';
        case 's': return v.toFixed(1) + ' s';
        case 'bit': return v + ' bit';
        case ':1': return v + ':1';
        default: return String(Math.round(v * 100) / 100);
      }
    },
  };
})();
