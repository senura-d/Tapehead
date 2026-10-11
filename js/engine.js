'use strict';

// Audio engine: decoded buffers, the live mixer graph, transport, and offline rendering.
// Signal path: clip -> track input -> track FX -> pan -> automation gain -> volume -> bus or master
//              master input -> master FX -> master volume -> out
const Engine = {
  ctx: null,
  ready: null,          // resolves once worklets are loaded on the live context
  buffers: new Map(),   // sampleId -> AudioBuffer
  reversed: new Map(),  // sampleId -> reversed AudioBuffer
  peaks: new Map(),     // sampleId[~r] -> {min, max, rate}
  graph: null,
  project: null,

  playing: false,
  mode: 'song',         // 'song' plays the playlist, 'pat' loops the current pattern
  pos: 0,               // playlist position (s) while stopped
  t0: 0, p0: 0,         // context time / playlist time at which playback started
  sources: new Set(),
  timer: null,
  stepQ: [],

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      Kit.build(this.ctx, this.buffers);
      this.ready = Worklets.add(this.ctx);
    }
    return this.ctx;
  },

  decode(bytes) { return this.ensure().decodeAudioData(bytes.slice(0)); },

  getBuffer(id, reverse) {
    const buf = this.buffers.get(id);
    if (!buf || !reverse) return buf;
    let r = this.reversed.get(id);
    if (!r) {
      r = this.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
      for (let c = 0; c < buf.numberOfChannels; c++) r.getChannelData(c).set(buf.getChannelData(c).slice().reverse());
      this.reversed.set(id, r);
    }
    return r;
  },

  getPeaks(id, reverse) {
    const key = id + (reverse ? '~r' : '');
    let pk = this.peaks.get(key);
    if (pk) return pk;
    const buf = this.getBuffer(id, reverse);
    if (!buf) return null;
    const B = 64, n = Math.ceil(buf.length / B), min = new Float32Array(n), max = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        let lo = min[i], hi = max[i];
        for (let j = i * B, e = Math.min(d.length, j + B); j < e; j++) { const v = d[j]; if (v < lo) lo = v; else if (v > hi) hi = v; }
        min[i] = lo; max[i] = hi;
      }
    }
    pk = { min, max, rate: buf.sampleRate / B };
    this.peaks.set(key, pk);
    return pk;
  },

  // Highest absolute sample value in a region of a sample (seconds).
  peakOf(id, reverse, from, len) {
    const pk = this.getPeaks(id, reverse);
    if (!pk) return 0;
    let m = 0;
    for (let i = Math.max(0, Math.floor(from * pk.rate)), e = Math.min(pk.min.length, Math.ceil((from + len) * pk.rate)); i < e; i++) {
      m = Math.max(m, pk.max[i], -pk.min[i]);
    }
    return m;
  },

  songEnd(p) {
    let end = 0;
    for (const c of p.clips) end = Math.max(end, c.start + c.len / c.rate);
    return end;
  },

  /* ---------- graph ---------- */

  makeStrip(ctx, live) {
    const s = {
      input: ctx.createGain(), fxOut: ctx.createGain(), pan: ctx.createStereoPanner(), auto: ctx.createGain(),
      vol: ctx.createGain(), send: ctx.createGain(), fx: [], analyser: null, level: 0, dest: null, sendDest: null,
    };
    s.fxOut.connect(s.pan); s.pan.connect(s.auto); s.auto.connect(s.vol); s.vol.connect(s.send);
    if (live) {
      s.analyser = ctx.createAnalyser();
      s.analyser.fftSize = 2048;
      s.analyser.smoothingTimeConstant = 0.75;
      s.vol.connect(s.analyser);
    }
    return s;
  },

  killFx(strip) {
    for (const f of strip.fx) {
      if (f.keySrc) { try { f.keySrc.disconnect(f.inst.key); } catch (e) { /* already gone */ } }
      f.inst.out.disconnect();
      if (f.inst.stop) f.inst.stop();
    }
    strip.fx = [];
  },

  wireFx(ctx, strip, list, env) {
    strip.input.disconnect();
    this.killFx(strip);
    let node = strip.input;
    for (const fx of list) {
      if (!fx.on || !FX.defs[fx.type]) continue;
      const inst = FX.instance(ctx, fx, env);
      node.connect(inst.in);
      node = inst.out;
      strip.fx.push({ id: fx.id, inst, fx, keySrc: null });
    }
    node.connect(strip.fxOut);
  },

  // Feed sidechain effects from the track they name as their trigger.
  linkKeys(g, p) {
    const strips = [['master', g.master], ...g.tracks];
    for (const [owner, s] of strips) {
      for (const f of s.fx) {
        if (!f.inst.key) continue;
        const srcId = f.fx.p.src, src = srcId && srcId !== owner && p.tracks.some(t => t.id === srcId) ? g.tracks.get(srcId) : null;
        const want = src ? src.fxOut : null;
        if (f.keySrc === want) continue;
        if (f.keySrc) { try { f.keySrc.disconnect(f.inst.key); } catch (e) { /* already gone */ } }
        if (want) want.connect(f.inst.key);
        f.keySrc = want;
      }
    }
  },

  buildGraph(ctx, p, live) {
    const g = { ctx, live, tracks: new Map(), master: this.makeStrip(ctx, live) };
    g.master.vol.connect(ctx.destination);
    this.wireFx(ctx, g.master, p.master.fx, { bpm: p.bpm });
    this.applyMix(g, p);
    return g;
  },

  applyMix(g, p) {
    const byId = new Map(p.tracks.map(t => [t.id, t])), anySolo = p.tracks.some(t => t.solo);
    for (const t of p.tracks) {
      if (g.tracks.has(t.id)) continue;
      const s = this.makeStrip(g.ctx, g.live);
      this.wireFx(g.ctx, s, t.fx, { bpm: p.bpm });
      g.tracks.set(t.id, s);
    }
    for (const [id, s] of g.tracks) {
      if (byId.has(id)) continue;
      s.vol.disconnect(); s.send.disconnect();
      this.killFx(s);
      g.tracks.delete(id);
    }
    const busOf = id => { const b = id ? byId.get(id) : null; return b && b.bus ? b : null; };
    for (const t of p.tracks) {
      const s = g.tracks.get(t.id), bus = t.bus ? null : busOf(t.out), sendBus = t.bus ? null : busOf(t.send.to);
      const dest = (bus ? g.tracks.get(bus.id) : g.master).input;
      if (s.dest !== dest) { if (s.dest) s.vol.disconnect(s.dest); s.vol.connect(dest); s.dest = dest; }
      const sd = sendBus ? g.tracks.get(sendBus.id).input : null;
      if (s.sendDest !== sd) { if (s.sendDest) s.send.disconnect(s.sendDest); if (sd) s.send.connect(sd); s.sendDest = sd; }
      FX.setP(g.ctx, s.send.gain, sd ? t.send.amt : 0);
      // soloing a track keeps the buses it feeds audible, and soloing a bus keeps its members
      const soloed = t.solo || (bus && bus.solo)
        || (t.bus && p.tracks.some(c => c.solo && (c.out === t.id || c.send.to === t.id)));
      if (!t.auto.pan.length) FX.setP(g.ctx, s.pan.pan, t.pan);
      FX.setP(g.ctx, s.vol.gain, t.mute || (anySolo && !soloed) ? 0 : t.vol);
    }
    FX.setP(g.ctx, g.master.vol.gain, p.master.vol);
    this.linkKeys(g, p);
  },

  setProject(p) {
    this.ensure();
    if (this.graph) {
      this.graph.master.vol.disconnect();
      for (const s of [this.graph.master, ...this.graph.tracks.values()]) this.killFx(s);
    }
    this.project = p;
    this.mode = p.mode;
    this.graph = this.buildGraph(this.ctx, p, true);
    this.settleAuto(this.pos);
  },

  strip(owner) { return owner === 'master' ? this.graph.master : this.graph.tracks.get(owner); },
  fxList(p, owner) { return owner === 'master' ? p.master.fx : (p.tracks.find(t => t.id === owner) || { fx: [] }).fx; },

  syncMix() {
    if (!this.graph) return;
    this.applyMix(this.graph, this.project);
    if (!this.playing || this.mode !== 'song') this.settleAuto(this.pos);
  },

  rebuildFx(owner) {
    const s = this.strip(owner);
    if (!s) return;
    this.wireFx(this.ctx, s, this.fxList(this.project, owner), { bpm: this.project.bpm });
    this.linkKeys(this.graph, this.project);
  },
  rebuildAllFx() {
    this.rebuildFx('master');
    for (const t of this.project.tracks) this.rebuildFx(t.id);
  },
  updateFx(owner, fx) {
    const s = this.strip(owner), f = s && s.fx.find(x => x.id === fx.id);
    if (f) { f.inst.set(fx.p); this.linkKeys(this.graph, this.project); }
  },

  /* ---------- automation ---------- */

  // Value of a point curve at time t (points sorted by t; flat before the first and after the last).
  interp(pts, t, def) {
    if (!pts || !pts.length) return def;
    if (t <= pts[0].t) return pts[0].v;
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) {
        const a = pts[i - 1], b = pts[i];
        return b.t === a.t ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
      }
    }
    return pts[pts.length - 1].v;
  },

  // Play a point curve on an AudioParam: curve time `from` happens at context time `when`.
  autoSchedule(param, pts, from, when, def) {
    param.cancelScheduledValues(0);
    param.setValueAtTime(this.interp(pts, from, def), when);
    for (const pt of pts) if (pt.t > from) param.linearRampToValueAtTime(pt.v, when + pt.t - from);
  },

  scheduleAuto(g, p, t0, from) {
    for (const t of p.tracks) {
      const s = g.tracks.get(t.id);
      if (t.auto.vol.length) this.autoSchedule(s.auto.gain, t.auto.vol, from, t0, 1);
      if (t.auto.pan.length) this.autoSchedule(s.pan.pan, t.auto.pan, from, t0, t.pan);
    }
  },

  // While stopped, hold every automated control at its value for the playhead position.
  settleAuto(pos) {
    const g = this.graph, p = this.project;
    if (!g || !p) return;
    for (const t of p.tracks) {
      const s = g.tracks.get(t.id);
      if (!s) continue;
      s.auto.gain.cancelScheduledValues(0);
      s.auto.gain.value = this.interp(t.auto.vol, pos, 1);
      if (t.auto.pan.length) { s.pan.pan.cancelScheduledValues(0); s.pan.pan.value = this.interp(t.auto.pan, pos, t.pan); }
    }
    this.applyFxAuto(g, p, pos);
  },

  /* ---------- effect automation ---------- */

  hasFxAuto(p) {
    const any = list => list.some(f => f.auto && Object.values(f.auto).some(a => a.length));
    return any(p.master.fx) || p.tracks.some(t => any(t.fx));
  },

  // Set every automated effect to its values for playlist time `pos`.
  applyFxAuto(g, p, pos) {
    for (const s of [g.master, ...g.tracks.values()]) {
      for (const f of s.fx) {
        const a = f.fx.auto;
        let q = null;
        if (a) for (const k in a) if (a[k].length) { q = q || { ...f.fx.p }; q[k] = this.interp(a[k], pos, f.fx.p[k]); }
        if (q) { f.inst.set(q); f.autoOn = true; }
        else if (f.autoOn) { f.inst.set(f.fx.p); f.autoOn = false; }
      }
    }
  },

  /* ---------- fades and transitions ---------- */

  // how the level moves through a fade, 0..1 -> 0..1
  SHAPE: {
    linear: x => x,
    smooth: x => Math.sin(x * Math.PI / 2),   // equal power: two of these crossing keep the loudness steady
    exp: x => x * x,
    filter: x => Math.pow(x, 0.35),           // level stays up while the filter does the work
    tape: x => Math.sqrt(x),
  },

  fadeCurve(type, a, b, gain) {
    const f = this.SHAPE[type] || this.SHAPE.linear, n = 48, c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = gain * f(a + (b - a) * i / (n - 1));
    return c;
  },

  // Schedule a clip's fade in / fade out on its gain. `into` = how far into the clip playback starts.
  fadeGain(P, gain, inT, outT, fi, fo, dur, into, when) {
    const fs = dur - fo, rem = dur - into;
    try {
      if (fi > 0 && into < fi) P.setValueCurveAtTime(this.fadeCurve(inT, into / fi, 1, gain), when, Math.max(0.001, fi - into - 0.0005));
      else if (!(fo > 0 && into > fs)) P.setValueAtTime(gain, when);
      if (fo > 0) {
        if (into <= fs) P.setValueCurveAtTime(this.fadeCurve(outT, 1, 0, gain), when + fs - into + (into === fs ? 0.0006 : 0), Math.max(0.001, fo - 0.001));
        else P.setValueCurveAtTime(this.fadeCurve(outT, (dur - into) / fo, 0, gain), when, Math.max(0.001, rem));
      }
    } catch (e) {
      // curves may not overlap; fall back to plain ramps rather than lose the clip
      P.cancelScheduledValues(0);
      P.setValueAtTime(gain * Math.min(1, fi > 0 ? into / fi : 1, fo > 0 ? rem / fo : 1), when);
      if (fi > 0 && into < fi) P.linearRampToValueAtTime(gain, when + fi - into);
      if (fo > 0) { if (into < fs) P.setValueAtTime(gain, when + fs - into); P.linearRampToValueAtTime(0, when + rem); }
    }
  },

  /* ---------- scheduling ---------- */

  // Calls fn(channel, position, velocity, pitch, lengthInSteps) for every hit of a pattern
  // between step positions a and b. Positions keep counting past the pattern end (it loops).
  patEvents(p, pat, a, b, fn) {
    const n = pat.steps;
    for (let k = Math.floor(a); k < b; k++) {
      const st = ((k % n) + n) % n, sw = st % 2 ? p.swing * 0.5 : 0;
      for (const ch of pat.channels) {
        const v = ch.steps[st];
        if (ch.mute || !v) continue;
        const rolls = ch.rolls[st] || 1;
        for (let j = 0; j < rolls; j++) {
          const pos = k + sw + j / rolls * (1 - sw);
          if (pos >= a && pos < b) fn(ch, pos, j ? v * 0.8 : v, ch.pitch || 0, 0);
        }
      }
    }
    for (let loop = Math.floor(a / n); loop * n < b; loop++) {
      for (const ch of pat.channels) {
        if (ch.mute) continue;
        for (const nt of ch.notes) {
          const pos = loop * n + nt.t;
          if (nt.t < n && pos >= a && pos < b) fn(ch, pos, nt.vel, (ch.pitch || 0) + nt.pitch, Math.min(nt.len, n - nt.t));
        }
      }
    }
  },

  // Schedule every clip that sounds after playlist time `from`, with context time t0 == `from`.
  scheduleClips(g, p, t0, from, to, sink) {
    const ctx = g.ctx, sd = 60 / p.bpm / 4;
    for (const c of p.clips) {
      if (c.mute) continue;
      const strip = g.tracks.get(c.trackId), isPat = c.kind === 'pattern';
      const buf = isPat ? null : this.getBuffer(c.sampleId, c.reverse), pat = isPat ? p.patterns.find(x => x.id === c.patId) : null;
      if (!strip || (!buf && !pat)) continue;
      const dur = c.len / c.rate, end = c.start + dur;
      if (end <= from + 1e-4 || (to != null && c.start >= to)) continue;
      const into = Math.max(0, from - c.start), when = t0 + Math.max(0, c.start - from), rem = dur - into;

      // fades / transitions
      const gn = ctx.createGain();
      const fi = Math.min(c.fadeIn || 0, dur), fo = Math.min(c.fadeOut || 0, dur - fi), fs = dur - fo;
      const inT = c.inType || 'linear', outT = c.outType || 'linear';
      this.fadeGain(gn.gain, c.gain, inT, outT, fi, fo, dur, into, when);
      let out = gn;
      // "filter sweep" transitions: a low-pass that opens on the way in and closes on the way out
      if ((inT === 'filter' && fi > 0) || (outT === 'filter' && fo > 0)) {
        const lp = ctx.createBiquadFilter(), F = lp.frequency, LO = 160, HI = 18000;
        lp.type = 'lowpass'; lp.Q.value = 0.8;
        if (inT === 'filter' && fi > 0 && into < fi) { F.setValueAtTime(LO * Math.pow(HI / LO, into / fi), when); F.exponentialRampToValueAtTime(HI, when + fi - into); }
        else F.setValueAtTime(HI, when);
        if (outT === 'filter' && fo > 0) {
          if (into < fs) F.setValueAtTime(HI, when + fs - into);
          else F.setValueAtTime(HI * Math.pow(LO / HI, (into - fs) / fo), when);
          F.exponentialRampToValueAtTime(LO, when + rem);
        }
        gn.connect(lp);
        out = lp;
      }
      // drawn gain envelope
      if (c.env && c.env.length) {
        const eg = ctx.createGain();
        out.connect(eg);
        out = eg;
        this.autoSchedule(out.gain, c.env, into, when, 1);
      }
      out.connect(strip.input);

      if (isPat) {
        const cut = to != null && end > to ? to - c.start : dur, a = (c.offset + into) / sd, b = (c.offset + cut) / sd;
        this.patEvents(p, pat, a, b, (ch, pos, vel, pitch, len) => this.trigger(ctx, ch, when + (pos - a) * sd, gn, sink, vel, pitch, len * sd));
        continue;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = c.rate;
      src.connect(gn);
      // "tape" transitions: the audio spins up from, or winds down to, a near stop
      const R = src.playbackRate;
      let off0 = c.offset + into * c.rate;
      if (inT === 'tape' && fi > 0 && into === 0) {
        R.setValueAtTime(c.rate * 0.05, when);
        R.linearRampToValueAtTime(c.rate, when + fi);
        off0 = Math.min(buf.duration - 0.01, off0 + fi * c.rate * 0.475);   // so the audio after the spin-up stays in time
      }
      if (outT === 'tape' && fo > 0) {
        if (into < fs) R.setValueAtTime(c.rate, when + fs - into);
        else R.setValueAtTime(c.rate * (1 - 0.95 * (into - fs) / fo), when);
        R.linearRampToValueAtTime(c.rate * 0.05, when + rem);
      }
      src.start(when, off0, rem * c.rate);
      if (inT === 'tape' || outT === 'tape') src.stop(when + rem);
      if (to != null && end > to) src.stop(t0 + to - from);
      if (sink) this.track(src, sink);
    }
  },

  track(src, sink) {
    sink.add(src);
    src.onended = () => sink.delete(src);
  },

  // Play one hit of a rack channel. lenSec > 0 cuts the sample off after that long (piano-roll notes).
  trigger(ctx, ch, time, dest, sink, vel, pitch, lenSec) {
    const buf = this.getBuffer(ch.sampleId);
    if (!buf) return;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (pitch == null ? ch.pitch || 0 : pitch) / 12);
    const level = ch.vol * (vel == null ? 1 : vel);
    g.gain.value = level;
    src.connect(g);
    if (ch.pan) { const pan = ctx.createStereoPanner(); pan.pan.value = ch.pan; g.connect(pan); pan.connect(dest); }
    else g.connect(dest);
    src.start(time);
    if (lenSec > 0) {
      g.gain.setValueAtTime(level, time + lenSec);
      g.gain.linearRampToValueAtTime(0, time + lenSec + 0.03);
      src.stop(time + lenSec + 0.04);
    }
    if (sink) this.track(src, sink);
  },

  click(time, accent) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.25, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    o.connect(g); g.connect(ctx.destination);
    o.start(time); o.stop(time + 0.06);
    this.track(o, this.sources);
  },

  curPattern(p) { return p.patterns.find(x => x.id === p.curPat) || p.patterns[0]; },

  /* ---------- transport ---------- */

  play(from) {
    const ctx = this.ensure(), p = this.project;
    if (ctx.state === 'suspended') ctx.resume();
    this.halt(true);
    this.playing = true;
    this.p0 = from != null ? from : this.pos;
    this.t0 = ctx.currentTime + 0.06;
    if (this.mode === 'song') {
      this.scheduleAuto(this.graph, p, this.t0, this.p0);
      this.fxAuto = this.hasFxAuto(p);
      if (this.fxAuto) this.applyFxAuto(this.graph, p, this.p0);
      this.scheduleClips(this.graph, p, this.t0, this.p0, null, this.sources);
      this.metroNext = Math.ceil(this.p0 / (60 / p.bpm) - 1e-6);
    } else {
      this.patStep = 0;
      this.stepQ = [];
    }
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  },

  halt(restarting) {
    clearInterval(this.timer);
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch (e) { /* not started */ } s.disconnect(); }
    this.sources.clear();
    this.playing = false;
    if (!restarting) this.settleAuto(this.pos);
  },

  pause() {
    if (!this.playing) return;
    const at = this.position();
    if (this.mode === 'song') this.pos = at;
    this.halt();
  },

  stop() {
    const l = this.project && this.project.loop;
    this.pos = l && l.on && l.end > l.start ? l.start : 0;
    this.halt();
  },

  seek(t) {
    this.pos = Math.max(0, t);
    if (this.playing && this.mode === 'song') this.play(this.pos);
    else this.settleAuto(this.pos);
  },

  // Re-schedule after the arrangement changed mid-playback.
  resync() { if (this.playing && this.mode === 'song') this.play(this.position()); },

  position() {
    if (!this.playing || this.mode !== 'song') return this.pos;
    return this.p0 + Math.max(0, this.ctx.currentTime - this.t0);
  },

  currentStep() {
    const now = this.ctx.currentTime, q = this.stepQ;
    while (q.length > 1 && q[1].time <= now) q.shift();
    return q.length && q[0].time <= now ? q[0].step : -1;
  },

  tick() {
    const ctx = this.ctx, p = this.project, horizon = ctx.currentTime + 0.12;
    if (this.mode === 'pat') {
      const pat = this.curPattern(p), sd = 60 / p.bpm / 4;
      while (this.t0 + this.patStep * sd < horizon) {
        const k = this.patStep, time = this.t0 + k * sd, st = k % pat.steps;
        this.patEvents(p, pat, k, k + 1, (ch, pos, vel, pitch, len) =>
          this.trigger(ctx, ch, this.t0 + pos * sd, this.graph.master.input, this.sources, vel, pitch, len * sd));
        if (p.metro && st % 4 === 0) this.click(time, st === 0);
        this.stepQ.push({ step: st, time });
        this.patStep++;
      }
      return;
    }
    const pos = this.position(), l = p.loop, end = this.songEnd(p);
    if (l.on && l.end > l.start + 0.05) {
      if (pos >= l.end) return this.play(l.start);
    } else if (end > 0 && pos > end + 0.5 && !this.recording) {
      this.pos = 0;
      this.halt();
      return;
    }
    if (this.fxAuto) this.applyFxAuto(this.graph, p, pos + 0.02);
    if (p.metro) {
      const beat = 60 / p.bpm;
      while (this.metroNext * beat < pos + 0.12) {
        this.click(this.t0 + this.metroNext * beat - this.p0, this.metroNext % 4 === 0);
        this.metroNext++;
      }
    }
  },

  // Audition a sample or rack channel immediately.
  preview(ch, pitch, lenSec) {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    if (this.previewSrc) { try { this.previewSrc.stop(); } catch (e) { /* ended */ } }
    const sink = new Set();
    this.trigger(ctx, ch, ctx.currentTime + 0.01, this.graph ? this.graph.master.input : ctx.destination, sink, 1, pitch, lenSec || 0);
    this.previewSrc = [...sink][0];
  },

  /* ---------- offline rendering ---------- */

  async renderPattern(p, pat, repeats) {
    const sr = this.ctx.sampleRate, sd = 60 / p.bpm / 4, loopLen = pat.steps * sd * repeats;
    const off = new OfflineAudioContext(2, Math.ceil((loopLen + 1.5) * sr), sr);
    this.patEvents(p, pat, 0, pat.steps * repeats, (ch, pos, vel, pitch, len) => this.trigger(off, ch, pos * sd, off.destination, null, vel, pitch, len * sd));
    return { buf: await off.startRendering(), loopLen };
  },

  async renderSong(p, { sampleRate, from, to, tail }) {
    const off = new OfflineAudioContext(2, Math.max(1, Math.ceil((to - from + tail) * sampleRate)), sampleRate);
    await Worklets.add(off);
    const g = this.buildGraph(off, p, false);
    this.scheduleAuto(g, p, 0, from);
    this.scheduleClips(g, p, 0, from, to, null);
    if (this.hasFxAuto(p)) {
      // effect automation: pause the render every 25 ms across the automated span and move the settings
      let a = Infinity, b = -Infinity;
      for (const f of [...p.master.fx, ...p.tracks.flatMap(t => t.fx)]) {
        for (const pts of Object.values(f.auto || {})) for (const pt of pts) { a = Math.min(a, pt.t); b = Math.max(b, pt.t); }
      }
      this.applyFxAuto(g, p, from);
      const step = 0.025, total = to - from + tail;
      for (let t = Math.max(step, Math.floor((a - from) / step) * step); t < Math.min(total, b - from + step * 2); t += step) {
        const at = t;
        off.suspend(at).then(() => { this.applyFxAuto(g, p, from + at); off.resume(); });
      }
    }
    return off.startRendering();
  },

  // Peak level 0..1 for a live strip, with a little decay so meters fall smoothly.
  level(strip) {
    if (!strip || !strip.analyser) return 0;
    const b = this._lvBuf || (this._lvBuf = new Float32Array(512));
    strip.analyser.getFloatTimeDomainData(b);
    let m = 0;
    for (let i = 0; i < b.length; i++) { const v = b[i] < 0 ? -b[i] : b[i]; if (v > m) m = v; }
    const lin = m <= 0.001 ? 0 : U.clamp((U.gainToDb(m) + 54) / 54, 0, 1.08);
    strip.level = Math.max(lin, strip.level * 0.9 - 0.005);
    return strip.level;
  },
};
