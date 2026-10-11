'use strict';

// Audio engine: decoded buffers, the live mixer graph, transport, and offline rendering.
// Signal path: clip -> track input -> track FX -> pan -> volume -> master input -> master FX -> master volume -> out
const Engine = {
  ctx: null,
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
    const s = { input: ctx.createGain(), fxOut: ctx.createGain(), pan: ctx.createStereoPanner(), vol: ctx.createGain(), fx: [], analyser: null, level: 0 };
    s.fxOut.connect(s.pan); s.pan.connect(s.vol);
    if (live) {
      s.analyser = ctx.createAnalyser();
      s.analyser.fftSize = 512;
      s.vol.connect(s.analyser);
    }
    return s;
  },

  wireFx(ctx, strip, list, env) {
    strip.input.disconnect();
    for (const f of strip.fx) { f.inst.out.disconnect(); if (f.inst.stop) f.inst.stop(); }
    strip.fx = [];
    let node = strip.input;
    for (const fx of list) {
      if (!fx.on) continue;
      const inst = FX.instance(ctx, fx, env);
      node.connect(inst.in);
      node = inst.out;
      strip.fx.push({ id: fx.id, inst });
    }
    node.connect(strip.fxOut);
  },

  buildGraph(ctx, p, live) {
    const g = { ctx, live, tracks: new Map(), master: this.makeStrip(ctx, live) };
    g.master.vol.connect(ctx.destination);
    this.wireFx(ctx, g.master, p.master.fx, { bpm: p.bpm });
    this.applyMix(g, p);
    return g;
  },

  applyMix(g, p) {
    const anySolo = p.tracks.some(t => t.solo), seen = new Set();
    for (const t of p.tracks) {
      seen.add(t.id);
      let s = g.tracks.get(t.id);
      if (!s) {
        s = this.makeStrip(g.ctx, g.live);
        s.vol.connect(g.master.input);
        this.wireFx(g.ctx, s, t.fx, { bpm: p.bpm });
        g.tracks.set(t.id, s);
      }
      FX.setP(g.ctx, s.pan.pan, t.pan);
      FX.setP(g.ctx, s.vol.gain, t.mute || (anySolo && !t.solo) ? 0 : t.vol);
    }
    for (const [id, s] of g.tracks) if (!seen.has(id)) { s.vol.disconnect(); g.tracks.delete(id); }
    FX.setP(g.ctx, g.master.vol.gain, p.master.vol);
  },

  setProject(p) {
    this.ensure();
    if (this.graph) {
      this.graph.master.vol.disconnect();
      for (const s of [this.graph.master, ...this.graph.tracks.values()]) for (const f of s.fx) if (f.inst.stop) f.inst.stop();
    }
    this.project = p;
    this.mode = p.mode;
    this.graph = this.buildGraph(this.ctx, p, true);
  },

  strip(owner) { return owner === 'master' ? this.graph.master : this.graph.tracks.get(owner); },
  fxList(p, owner) { return owner === 'master' ? p.master.fx : (p.tracks.find(t => t.id === owner) || { fx: [] }).fx; },

  syncMix() { if (this.graph) this.applyMix(this.graph, this.project); },

  rebuildFx(owner) {
    const s = this.strip(owner);
    if (s) this.wireFx(this.ctx, s, this.fxList(this.project, owner), { bpm: this.project.bpm });
  },
  rebuildAllFx() {
    this.rebuildFx('master');
    for (const t of this.project.tracks) this.rebuildFx(t.id);
  },
  updateFx(owner, fx) {
    const s = this.strip(owner), f = s && s.fx.find(x => x.id === fx.id);
    if (f) f.inst.set(fx.p);
  },

  /* ---------- scheduling ---------- */

  // Schedule every clip that sounds after playlist time `from`, with context time t0 == `from`.
  scheduleClips(g, p, t0, from, to, sink) {
    const ctx = g.ctx;
    for (const c of p.clips) {
      if (c.mute) continue;
      const buf = this.getBuffer(c.sampleId, c.reverse), strip = g.tracks.get(c.trackId);
      if (!buf || !strip) continue;
      const dur = c.len / c.rate, end = c.start + dur;
      if (end <= from + 1e-4 || (to != null && c.start >= to)) continue;
      const into = Math.max(0, from - c.start), when = t0 + Math.max(0, c.start - from), rem = dur - into;

      const src = ctx.createBufferSource(), gn = ctx.createGain();
      src.buffer = buf;
      src.playbackRate.value = c.rate;
      src.connect(gn); gn.connect(strip.input);

      const fi = Math.min(c.fadeIn || 0, dur), fo = Math.min(c.fadeOut || 0, dur - fi);
      const env = t => c.gain * Math.min(1, fi > 0 ? t / fi : 1, fo > 0 ? (dur - t) / fo : 1);
      gn.gain.setValueAtTime(env(into), when);
      if (fi > 0 && into < fi) gn.gain.linearRampToValueAtTime(env(fi), when + fi - into);
      if (fo > 0) {
        const fs = dur - fo;
        if (into < fs) gn.gain.setValueAtTime(env(fs), when + fs - into);
        gn.gain.linearRampToValueAtTime(0, when + rem);
      }

      src.start(when, c.offset + into * c.rate, rem * c.rate);
      if (to != null && end > to) src.stop(t0 + to - from);
      if (sink) this.track(src, sink);
    }
  },

  track(src, sink) {
    sink.add(src);
    src.onended = () => sink.delete(src);
  },

  trigger(ctx, ch, time, dest, sink) {
    const buf = this.getBuffer(ch.sampleId);
    if (!buf) return;
    const src = ctx.createBufferSource(), g = ctx.createGain(), pan = ctx.createStereoPanner();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (ch.pitch || 0) / 12);
    g.gain.value = ch.vol;
    pan.pan.value = ch.pan || 0;
    src.connect(g); g.connect(pan); pan.connect(dest);
    src.start(time);
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
    this.halt();
    this.playing = true;
    this.p0 = from != null ? from : this.pos;
    this.t0 = ctx.currentTime + 0.06;
    if (this.mode === 'song') {
      this.scheduleClips(this.graph, p, this.t0, this.p0, null, this.sources);
      this.metroNext = Math.ceil(this.p0 / (60 / p.bpm) - 1e-6);
    } else {
      this.patStep = 0;
      this.patTime = this.t0;
      this.stepQ = [];
    }
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  },

  halt() {
    clearInterval(this.timer);
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch (e) { /* not started */ } s.disconnect(); }
    this.sources.clear();
    this.playing = false;
  },

  pause() {
    if (!this.playing) return;
    const at = this.position();
    this.halt();
    if (this.mode === 'song') this.pos = at;
  },

  stop() {
    this.halt();
    const l = this.project && this.project.loop;
    this.pos = l && l.on && l.end > l.start ? l.start : 0;
  },

  seek(t) {
    this.pos = Math.max(0, t);
    if (this.playing && this.mode === 'song') this.play(this.pos);
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
      while (this.patTime < horizon) {
        const st = this.patStep % pat.steps, t = this.patTime + (st % 2 ? p.swing * sd * 0.5 : 0);
        for (const ch of pat.channels) if (!ch.mute && ch.steps[st]) this.trigger(ctx, ch, t, this.graph.master.input, this.sources);
        if (p.metro && st % 4 === 0) this.click(this.patTime, st === 0);
        this.stepQ.push({ step: st, time: this.patTime });
        this.patStep++;
        this.patTime += sd;
      }
      return;
    }
    const pos = this.position(), l = p.loop, end = this.songEnd(p);
    if (l.on && l.end > l.start + 0.05) {
      if (pos >= l.end) return this.play(l.start);
    } else if (end > 0 && pos > end + 0.5) {
      this.halt();
      this.pos = 0;
      return;
    }
    if (p.metro) {
      const beat = 60 / p.bpm;
      while (this.metroNext * beat < pos + 0.12) {
        this.click(this.t0 + this.metroNext * beat - this.p0, this.metroNext % 4 === 0);
        this.metroNext++;
      }
    }
  },

  // Audition a sample or rack channel immediately.
  preview(ch) {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    if (this.previewSrc) { try { this.previewSrc.stop(); } catch (e) { /* ended */ } }
    const sink = new Set();
    this.trigger(ctx, ch, ctx.currentTime + 0.01, this.graph ? this.graph.master.input : ctx.destination, sink);
    this.previewSrc = [...sink][0];
  },

  /* ---------- offline rendering ---------- */

  async renderPattern(p, pat, repeats) {
    const sr = this.ctx.sampleRate, sd = 60 / p.bpm / 4, loopLen = pat.steps * sd * repeats;
    const off = new OfflineAudioContext(2, Math.ceil((loopLen + 1.5) * sr), sr);
    for (let i = 0; i < pat.steps * repeats; i++) {
      const st = i % pat.steps, t = i * sd + (st % 2 ? p.swing * sd * 0.5 : 0);
      for (const ch of pat.channels) if (!ch.mute && ch.steps[st]) this.trigger(off, ch, t, off.destination);
    }
    return { buf: await off.startRendering(), loopLen };
  },

  async renderSong(p, { sampleRate, from, to, tail }) {
    const off = new OfflineAudioContext(2, Math.ceil((to - from + tail) * sampleRate), sampleRate);
    const g = this.buildGraph(off, p, false);
    this.scheduleClips(g, p, 0, from, to, null);
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
