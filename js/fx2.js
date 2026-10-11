'use strict';

// More effects, built on the helpers in fx.js. Level-dependent ones (gate, de-esser, ducker)
// use an envelope follower made of native nodes: rectify -> smooth -> shape -> drive a gain.
(() => {
  const { setP, defs: D } = FX, { wetDry, lfo, biquad } = FX.h;
  const ABS = new Float32Array([1, 0, 1]), POS = new Float32Array([0, 0, 1]);

  // rectified, smoothed level of whatever is connected to .in
  function follower(ctx) {
    const abs = ctx.createWaveShaper(), lp = biquad(ctx, 'lowpass');
    abs.curve = ABS;
    lp.Q.value = 0.5;
    abs.connect(lp);
    return { in: abs, out: lp, lp };
  }

  // 0 below the threshold, 1 above it, with a short knee. Input is the follower output boosted x8.
  function thrCurve(thrDb) {
    const thr = Math.min(0.7, U.dbToGain(thrDb) * 0.64 * 8), n = 4096, c = new Float32Array(n), lo = thr * 0.7, hi = thr * 1.4;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * 2 - 1, k = U.clamp((x - lo) / (hi - lo), 0, 1);
      c[i] = x <= 0 ? 0 : k * k * (3 - 2 * k);
    }
    return c;
  }

  // The limiter becomes a true look-ahead brick wall when worklets are available.
  const softLimiter = D.limiter.create;
  D.limiter.create = function (ctx) {
    if (!ctx._tp) return softLimiter(ctx);
    const n = new AudioWorkletNode(ctx, 'tp-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    const P = n.parameters;
    return {
      in: n, out: n,
      set(p) { P.get('gain').value = U.dbToGain(p.gain); P.get('ceil').value = U.dbToGain(p.ceil); P.get('rel').value = p.rel / 1000; },
    };
  };

  D.duck = {
    name: 'Sidechain duck',
    params: [
      { k: 'src', label: 'Trigger', track: true, def: '' },
      { k: 'amount', label: 'Amount', min: 0, max: 1, def: 0.7, unit: '%' },
      { k: 'sens', label: 'Sensitivity', min: 1, max: 40, def: 10, step: 0.5 },
      { k: 'rel', label: 'Release', min: 30, max: 600, def: 140, unit: 'ms', step: 5 },
    ],
    create(ctx) {
      const vca = ctx.createGain(), key = ctx.createGain(), f = follower(ctx), sens = ctx.createGain(), clamp = ctx.createWaveShaper(), amt = ctx.createGain();
      clamp.curve = POS;
      key.connect(f.in); f.out.connect(sens); sens.connect(clamp); clamp.connect(amt); amt.connect(vca.gain);
      return {
        in: vca, out: vca, key,
        set(p) { setP(ctx, sens.gain, p.sens); setP(ctx, amt.gain, -p.amount); setP(ctx, f.lp.frequency, 4000 / (2 * Math.PI * p.rel)); },
      };
    },
  };

  D.gate = {
    name: 'Noise gate',
    params: [
      { k: 'thr', label: 'Threshold', min: -70, max: -20, def: -45, unit: 'dB', step: 1 },
      { k: 'rel', label: 'Release', min: 20, max: 500, def: 80, unit: 'ms', step: 5 },
    ],
    create(ctx) {
      const inp = ctx.createGain(), vca = ctx.createGain(), f = follower(ctx), boost = ctx.createGain(), sh = ctx.createWaveShaper();
      vca.gain.value = 0; boost.gain.value = 8;
      inp.connect(vca); inp.connect(f.in); f.out.connect(boost); boost.connect(sh); sh.connect(vca.gain);
      let thr = null;
      return {
        in: inp, out: vca,
        set(p) {
          if (p.thr !== thr) { sh.curve = thrCurve(p.thr); thr = p.thr; }
          setP(ctx, f.lp.frequency, 4000 / (2 * Math.PI * p.rel));
        },
      };
    },
  };

  D.deesser = {
    name: 'De-esser',
    params: [
      { k: 'freq', label: 'Frequency', min: 3000, max: 10000, def: 6000, unit: 'Hz', log: true },
      { k: 'thr', label: 'Threshold', min: -60, max: -20, def: -38, unit: 'dB', step: 1 },
      { k: 'amount', label: 'Reduction', min: 0, max: 1, def: 0.7, unit: '%' },
    ],
    create(ctx) {
      // out = in - amount * (how far the highs are over threshold) * highs
      const inp = ctx.createGain(), out = ctx.createGain(), hp = biquad(ctx, 'highpass'), vca = ctx.createGain(), inv = ctx.createGain();
      const f = follower(ctx), boost = ctx.createGain(), sh = ctx.createWaveShaper(), amt = ctx.createGain();
      vca.gain.value = 0; inv.gain.value = -1; boost.gain.value = 8; f.lp.frequency.value = 40;
      inp.connect(out); inp.connect(hp); hp.connect(vca); vca.connect(inv); inv.connect(out);
      hp.connect(f.in); f.out.connect(boost); boost.connect(sh); sh.connect(amt); amt.connect(vca.gain);
      let thr = null;
      return {
        in: inp, out,
        set(p) {
          if (p.thr !== thr) { sh.curve = thrCurve(p.thr); thr = p.thr; }
          setP(ctx, hp.frequency, p.freq); setP(ctx, amt.gain, p.amount);
        },
      };
    },
  };

  D.widener = {
    name: 'Stereo widener',
    params: [{ k: 'width', label: 'Width', min: 0, max: 2, def: 1.4, unit: '%' }],
    create(ctx) {
      const inp = ctx.createGain(), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      inp.channelCount = 2; inp.channelCountMode = 'explicit';
      const ll = ctx.createGain(), lr = ctx.createGain(), rl = ctx.createGain(), rr = ctx.createGain();
      inp.connect(split);
      split.connect(ll, 0); split.connect(lr, 0); split.connect(rl, 1); split.connect(rr, 1);
      ll.connect(merge, 0, 0); rl.connect(merge, 0, 0); lr.connect(merge, 0, 1); rr.connect(merge, 0, 1);
      return {
        in: inp, out: merge,
        set(p) {
          const same = (1 + p.width) / 2, cross = (1 - p.width) / 2;
          setP(ctx, ll.gain, same); setP(ctx, rr.gain, same); setP(ctx, lr.gain, cross); setP(ctx, rl.gain, cross);
        },
      };
    },
  };

  D.flanger = {
    name: 'Flanger',
    params: [
      { k: 'rate', label: 'Rate', min: 0.05, max: 5, def: 0.3, unit: 'Hz', step: 0.05 },
      { k: 'depth', label: 'Depth', min: 0, max: 1, def: 0.6, unit: '%' },
      { k: 'fb', label: 'Feedback', min: 0, max: 0.9, def: 0.5, unit: '%' },
      { k: 'mix', label: 'Mix', min: 0, max: 1, def: 0.5, unit: '%' },
    ],
    create(ctx) {
      const m = wetDry(ctx, false), d = ctx.createDelay(0.05), fb = ctx.createGain();
      d.delayTime.value = 0.004;
      m.in.connect(d); d.connect(m.wet); d.connect(fb); fb.connect(d);
      const a = lfo(ctx, d.delayTime);
      return {
        in: m.in, out: m.out, stop() { a.osc.stop(); },
        set(p) { setP(ctx, a.osc.frequency, p.rate); setP(ctx, a.depth.gain, p.depth * 0.0035); setP(ctx, fb.gain, p.fb); m.mix(p.mix); },
      };
    },
  };

  D.tape = {
    name: 'Tape saturation',
    params: [
      { k: 'drive', label: 'Drive', min: 0, max: 100, def: 35, step: 1 },
      { k: 'warmth', label: 'Warmth', min: 0, max: 12, def: 4, unit: 'dB', step: 0.5 },
      { k: 'level', label: 'Output', min: -18, max: 6, def: 0, unit: 'dB', step: 0.5 },
    ],
    create(ctx) {
      const pre = ctx.createGain(), ws = ctx.createWaveShaper(), hi = biquad(ctx, 'highshelf'), lo = biquad(ctx, 'lowshelf'), lvl = ctx.createGain();
      ws.oversample = '2x'; hi.frequency.value = 7000; lo.frequency.value = 90; lo.gain.value = 1.5;
      pre.connect(ws); ws.connect(hi); hi.connect(lo); lo.connect(lvl);
      let drive = null;
      return {
        in: pre, out: lvl,
        set(p) {
          if (p.drive !== drive) {
            // slightly asymmetric soft clip, normalised so quiet signals keep their level
            const k = 1 + p.drive / 12, n = 2048, c = new Float32Array(n), b = 0.12, z = Math.tanh(b);
            for (let i = 0; i < n; i++) c[i] = (Math.tanh(k * (i / (n - 1) * 2 - 1) + b) - z) / k;
            ws.curve = c; drive = p.drive;
          }
          setP(ctx, hi.gain, -p.warmth); setP(ctx, lvl.gain, U.dbToGain(p.level));
        },
      };
    },
  };

  D.pitch = {
    name: 'Pitch shifter',
    params: [
      { k: 'st', label: 'Semitones', min: -12, max: 12, def: 3, step: 1 },
      { k: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '%' },
    ],
    create(ctx) {
      // Two delay lines whose delay ramps (which changes the pitch), cross-faded so each reset of the ramp is silent.
      const F = 10, T = 1 / F, m = wetDry(ctx, false), cosWave = ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]));
      const oscs = [], ramps = [], delays = [];
      for (let v = 0; v < 2; v++) {
        const d = ctx.createDelay(0.5), vg = ctx.createGain(), saw = ctx.createOscillator(), ramp = ctx.createGain(), win = ctx.createOscillator(), wg = ctx.createGain();
        saw.type = 'sawtooth'; saw.frequency.value = F; win.setPeriodicWave(cosWave); win.frequency.value = F;
        vg.gain.value = 0.5; wg.gain.value = 0.5;
        saw.connect(ramp); ramp.connect(d.delayTime); win.connect(wg); wg.connect(vg.gain);
        m.in.connect(d); d.connect(vg); vg.connect(m.wet);
        const at = ctx.currentTime + v * T / 2;
        saw.start(at); win.start(at);
        oscs.push(saw, win); ramps.push(ramp); delays.push(d);
      }
      return {
        in: m.in, out: m.out, stop() { oscs.forEach(o => o.stop()); },
        set(p) {
          const depth = (1 - Math.pow(2, p.st / 12)) / (2 * F);
          for (const r of ramps) setP(ctx, r.gain, depth);
          for (const d of delays) setP(ctx, d.delayTime, Math.abs(depth) + 0.012);
          m.mix(p.mix);
        },
      };
    },
  };

  FX.order.push('duck', 'gate', 'deesser', 'widener', 'flanger', 'tape', 'pitch');
})();
