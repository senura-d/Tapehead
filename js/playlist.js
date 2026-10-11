'use strict';

// The playlist: track headers on the left, a canvas timeline on the right.
// The canvas is an overlay; #tl-scroll underneath owns the scrollbars and pointer events.
const Playlist = {
  TH: 68,        // track height
  TITLE: 14,     // clip title strip height
  vw: 0, vh: 0, dpr: 1,
  drag: null, band: null, meters: new Map(),

  init() {
    this.sc = $('#tl-scroll'); this.spacer = $('#tl-spacer');
    this.cv = $('#tl-canvas'); this.cx = this.cv.getContext('2d');
    this.ruler = $('#ruler'); this.rx = this.ruler.getContext('2d');
    this.heads = $('#heads-inner'); this.ph = $('#playhead');
    const sc = this.sc;

    sc.addEventListener('scroll', () => {
      this.heads.style.transform = 'translateY(' + -sc.scrollTop + 'px)';
      this.draw();
    });
    new ResizeObserver(() => this.resize()).observe($('#tl-wrap'));

    sc.addEventListener('pointerdown', e => this.onDown(e));
    sc.addEventListener('pointermove', e => this.onMove(e));
    sc.addEventListener('pointerup', e => this.onUp(e));
    sc.addEventListener('pointercancel', e => this.onUp(e));
    sc.addEventListener('dblclick', e => {
      const h = this.hit(...this.xy(e));
      if (!h || App.tool !== 'select') return;
      if (h.clip.kind === 'pattern') { App.project.curPat = h.clip.patId; App.setTab('rack'); Rack.render(); }
      else App.setTab('clip');
    });
    sc.addEventListener('contextmenu', e => this.onMenu(e));
    sc.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, this.xy(e)[0]);
    }, { passive: false });
    $('#heads').addEventListener('wheel', e => { sc.scrollTop += e.deltaY; }, { passive: true });
    $('#zoom-in').onclick = () => this.zoom(1.4);
    $('#zoom-out').onclick = () => this.zoom(1 / 1.4);

    // ruler: click/drag = move playhead, shift+drag = loop region
    const rl = this.ruler;
    let rdrag = null;
    const rt = e => this.snap(Math.max(0, this.x2t(e.clientX - rl.getBoundingClientRect().left)), e);
    rl.addEventListener('pointerdown', e => {
      rl.setPointerCapture(e.pointerId);
      const mk = this.markerAt(e);
      if (mk) { App.pushUndo(); rdrag = { mk }; return; }
      rdrag = e.shiftKey ? { a: rt(e) } : {};
      if (!e.shiftKey) App.seek(rt(e));
    });
    rl.addEventListener('pointermove', e => {
      if (!rdrag) return;
      if (rdrag.mk) { rdrag.mk.t = rt(e); return this.draw(); }
      if (rdrag.a == null) return App.seek(rt(e));
      const b = rt(e), p = App.project;
      p.loop = { on: true, start: Math.min(rdrag.a, b), end: Math.max(rdrag.a, b) };
      App.syncTop();
      this.draw();
    });
    rl.addEventListener('pointerup', () => { if (rdrag && (rdrag.a != null || rdrag.mk)) App.touch(); rdrag = null; });
    rl.addEventListener('dblclick', e => { if (!this.markerAt(e)) App.addMarker(rt(e)); });
    rl.addEventListener('contextmenu', e => {
      e.preventDefault();
      const m = this.markerAt(e), p = App.project;
      if (!m) return UI.menu(e.clientX, e.clientY, [{ label: 'Add marker here', onclick: () => App.addMarker(rt(e)) }]);
      UI.menu(e.clientX, e.clientY, [
        { label: 'Rename marker', onclick: async () => { const n = await UI.prompt('Marker name', m.name); if (n) App.edit(() => { m.name = n; }, 'timeline'); } },
        { label: 'Delete marker', danger: true, onclick: () => App.edit(() => { p.markers = p.markers.filter(x => x !== m); }, 'timeline') },
      ]);
    });

    // drag samples (from the pool) or audio files (from the OS) onto the timeline
    sc.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    sc.addEventListener('drop', async e => {
      e.preventDefault();
      const [x, y] = this.xy(e), raw = Math.max(0, this.x2t(x)), t = this.magnet(raw, e) ?? this.snap(raw, e), row = Math.floor((y + sc.scrollTop) / this.TH);
      const id = e.dataTransfer.getData('text/x-sample');
      if (id) return App.addClips([id], row, t);
      if (e.dataTransfer.files.length) {
        const added = await App.importFiles(e.dataTransfer.files);
        if (added.length) App.addClips(added.map(s => s.id), row, t);
      }
    });
  },

  get pps() { return App.project.view.pps; },
  xy(e) { const r = this.sc.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; },
  x2t(x) { return (x + this.sc.scrollLeft) / this.pps; },
  dur(c) { return c.len / c.rate; },

  snap(t, e) {
    const p = App.project, s = p.view.snap;
    if (!s || (e && e.altKey)) return t;
    const g = 60 / p.bpm * s;
    return Math.round(t / g) * g;
  },

  // Magnet: the nearest clip edge, marker, loop point or playhead within a few pixels of t (or null).
  magnet(t, e, skip) {
    const p = App.project;
    if (!p.view.magnet || (e && e.altKey)) return null;
    let best = null, bd = 9 / this.pps;
    const test = x => { const d = Math.abs(x - t); if (d < bd) { bd = d; best = x; } };
    test(0);
    if (!Engine.playing) test(Engine.pos);
    for (const m of p.markers) test(m.t);
    if (p.loop.end > p.loop.start) { test(p.loop.start); test(p.loop.end); }
    for (const c of p.clips) if (!skip || !skip.has(c.id)) { test(c.start); test(c.start + c.len / c.rate); }
    return best;
  },
  // where a dragged edge lands: magnet first, grid otherwise
  edge(t, e, skip) {
    const m = this.magnet(t, e, skip);
    this.guideT = m;
    return m == null ? this.snap(t, e) : m;
  },

  // effect settings are drawn on a 0..1 scale (log for frequencies)
  fxNorm(d) {
    if (d.log) { const r = Math.log(d.max / d.min); return { to: v => Math.log(v / d.min) / r, from: n => Math.round(d.min * Math.exp(n * r)) }; }
    const s = d.step || 0.01;
    return { to: v => (v - d.min) / (d.max - d.min), from: n => Math.round((d.min + n * (d.max - d.min)) / s) * s };
  },

  zoom(f, anchorX) {
    const v = App.project.view, x = anchorX == null ? this.vw / 2 : anchorX, t = this.x2t(x);
    v.pps = U.clamp(v.pps * f, 3, 900);
    this.layout();
    this.sc.scrollLeft = t * v.pps - x;
    this.draw();
    App.touch();
  },

  resize() {
    const w = this.sc.clientWidth, h = this.sc.clientHeight;
    if (!w || !h) return;
    const d = this.dpr = window.devicePixelRatio || 1;
    this.cv.width = w * d; this.cv.height = h * d;
    this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    this.ruler.width = w * d; this.ruler.height = 28 * d;
    this.ruler.style.width = w + 'px';
    this.vw = w; this.vh = h;
    if (App.project) { this.layout(); this.draw(); }
  },

  layout() {
    const p = App.project, end = Engine.songEnd(p);
    this.spacer.style.width = Math.max(this.vw, Math.max(end + 30, 90) * this.pps) + 'px';
    this.spacer.style.height = (p.tracks.length * this.TH + 56) + 'px';
  },

  /* ---------- drawing ---------- */

  draw() {
    const p = App.project;
    if (!p || !this.vw) return;
    const g = this.cx, W = this.vw, H = this.vh, sx = this.sc.scrollLeft, sy = this.sc.scrollTop, pps = p.view.pps, TH = this.TH;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const bottom = Math.min(H, p.tracks.length * TH - sy);
    p.tracks.forEach((t, i) => {
      const y = i * TH - sy;
      if (y > H || y + TH < 0) return;
      g.fillStyle = t.id === App.selTrack ? '#1c2024' : i % 2 ? '#171a1d' : '#15181b';
      g.fillRect(0, y, W, TH - 1);
      if (t.bus) {
        g.fillStyle = 'rgba(157,140,255,0.05)';
        g.fillRect(0, y, W, TH - 1);
        g.fillStyle = 'rgba(255,255,255,0.22)';
        g.font = '11px "Segoe UI", system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.fillText('Bus — tracks routed here share this fader and effect chain (right-click a track → Output)', 12, y + TH / 2);
      }
    });

    // grid: pick the finest subdivision that stays readable at this zoom
    const beat = 60 / p.bpm;
    const stepBeats = [0.25, 0.5, 1, 4, 8, 16, 32, 64, 128].find(b => b * beat * pps >= 9) || 256;
    const step = stepBeats * beat;
    for (let k = Math.floor(sx / pps / step), kEnd = Math.ceil((sx + W) / pps / step); k <= kEnd; k++) {
      const b = k * stepBeats, x = Math.round(k * step * pps - sx) + 0.5;
      if (stepBeats <= 4 && Math.floor(b / 16) % 2 === 1 && b % 16 === 0) {
        g.fillStyle = 'rgba(255,255,255,0.016)';
        g.fillRect(x, 0, 16 * beat * pps, bottom);
      }
      g.strokeStyle = b % 4 === 0 ? 'rgba(255,255,255,0.09)' : Number.isInteger(b) ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.022)';
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, bottom); g.stroke();
    }

    const rowOf = new Map(p.tracks.map((t, i) => [t.id, i]));
    for (const c of p.clips) {
      const row = rowOf.get(c.trackId);
      if (row != null) this.drawClip(g, c, p.tracks[row], row * TH - sy, sx, pps, W, H);
    }

    const autoOn = App.tool === 'auto';
    p.tracks.forEach((t, i) => {
      for (const prm of ['vol', 'pan']) {
        const pts = t.auto[prm], active = autoOn && App.autoParam === prm;
        if (!pts.length && !active) continue;
        this.drawCurve(g, pts, prm === 'vol' ? 1 : t.pan, v => this.autoY(prm, v, i * TH - sy), tt => tt * pps - sx, 0, W, active, prm === 'vol' ? '#6fdc8c' : '#4fc3f7');
      }
    });
    p.tracks.forEach((t, i) => {
      for (const fx of t.fx) {
        const def = FX.defs[fx.type], keys = new Set(Object.keys(fx.auto || {}));
        if (!def) continue;
        if (autoOn && App.autoParam.startsWith('fx:' + fx.id + ':')) keys.add(App.autoParam.split(':')[2]);
        for (const k of keys) {
          const pts = (fx.auto && fx.auto[k]) || [], active = autoOn && App.autoParam === 'fx:' + fx.id + ':' + k, d = def.params.find(q => q.k === k);
          if (!d || (!pts.length && !active)) continue;
          const N = this.fxNorm(d), rowY = i * TH - sy;
          this.drawCurve(g, pts, fx.p[k], v => rowY + TH - 5 - U.clamp(N.to(v), 0, 1) * (TH - 10), tt => tt * pps - sx, 0, W, active, '#ffb37a');
        }
      }
    });
    for (const m of p.markers) {
      g.fillStyle = 'rgba(157,140,255,0.35)';
      g.fillRect(Math.round(m.t * pps - sx), 0, 1, bottom);
    }

    if (p.loop.end > p.loop.start) {
      const x0 = p.loop.start * pps - sx, x1 = p.loop.end * pps - sx;
      g.fillStyle = p.loop.on ? 'rgba(255,138,42,0.06)' : 'rgba(255,255,255,0.02)';
      g.fillRect(x0, 0, x1 - x0, H);
      g.fillStyle = p.loop.on ? 'rgba(255,138,42,0.5)' : 'rgba(255,255,255,0.15)';
      g.fillRect(x0, 0, 1, H); g.fillRect(x1, 0, 1, H);
    }

    if (this.band) {
      const b = this.band, x = Math.min(b.x0, b.x1) - sx, y = Math.min(b.y0, b.y1) - sy;
      g.fillStyle = 'rgba(255,138,42,0.08)'; g.strokeStyle = 'rgba(255,138,42,0.7)';
      g.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(x + 0.5, y + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    if (this.guideT != null) {
      g.fillStyle = '#ff8a2a';
      g.fillRect(Math.round(this.guideT * pps - sx), 0, 1, bottom);
    }
    if (this.drag && this.drag.kind === 'auto' && this.drag.tg.fmt) {
      const d = this.drag, lx = d.tg.xOf(d.pt.t) + 9, ly = d.tg.yOf(d.pt.v) - 9;
      g.font = '10.5px "Cascadia Mono", Consolas, monospace';
      const txt = d.tg.fmt(d.pt.v), tw = g.measureText(txt).width + 8;
      g.fillStyle = 'rgba(8,10,12,0.9)'; g.fillRect(lx - 4, ly - 9, tw, 15);
      g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(txt, lx, ly - 1);
    }
    if (this.sliceX != null) {
      g.fillStyle = '#fff';
      g.fillRect(this.sliceX, 0, 1, bottom);
    }
    this.drawRuler();
  },

  drawClip(g, c, tr, rowY, sx, pps, W, H) {
    const dur = this.dur(c), x = c.start * pps - sx, w = Math.max(2, dur * pps), y = rowY + 2, h = this.TH - 5, T = this.TITLE;
    if (x > W || x + w < 0 || y > H || y + h < 0) return;
    const sel = App.sel.has(c.id), col = tr.color;
    g.save();
    g.globalAlpha = c.mute ? 0.32 : 1;
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, 3); else g.rect(x, y, w, h);
    g.clip();
    g.fillStyle = U.hexA(col, sel ? 0.3 : 0.17);
    g.fillRect(x, y, w, h);
    g.fillStyle = U.hexA(col, sel ? 1 : 0.8);
    g.fillRect(x, y, w, T);

    const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(W, Math.ceil(x + w));
    const isPat = c.kind === 'pattern', pat = isPat ? App.project.patterns.find(q => q.id === c.patId) : null;
    const pk = isPat ? null : Engine.getPeaks(c.sampleId, c.reverse);
    if (pat) this.drawPattern(g, c, pat, x, y + T, h - T, pps, x0, x1, col);
    else if (pk) {
      const mid = y + T + (h - T) / 2, amp = (h - T - 4) / 2, gain = Math.min(c.gain, 2), last = pk.min.length - 1;
      g.fillStyle = U.hexA(col, 0.95);
      for (let px = x0; px < x1; px++) {
        const ts = c.offset + (px - x) / pps * c.rate;
        const i0 = Math.max(0, Math.floor(ts * pk.rate)), i1 = Math.min(last, Math.max(i0, Math.ceil((ts + c.rate / pps) * pk.rate) - 1));
        let lo = 0, hi = 0;
        for (let i = i0; i <= i1; i++) { if (pk.min[i] < lo) lo = pk.min[i]; if (pk.max[i] > hi) hi = pk.max[i]; }
        lo = Math.max(-1, lo * gain); hi = Math.min(1, hi * gain);
        g.fillRect(px, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    } else {
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.font = '11px system-ui';
      g.fillText(isPat ? 'pattern deleted' : 'missing audio', Math.max(x, 0) + 6, y + T + 16);
    }

    // fades: shade the faded-out area
    g.fillStyle = 'rgba(8,10,12,0.55)';
    const fade = (fx, len, dir, type) => {
      const f = Engine.SHAPE[type] || Engine.SHAPE.linear, px = len * pps;
      g.beginPath(); g.moveTo(fx, y + T); g.lineTo(fx + dir * px, y + T);
      for (let k = 1; k >= 0; k -= 0.05) g.lineTo(fx + dir * k * px, y + h - f(Math.max(0, k)) * (h - T));
      g.lineTo(fx, y + h); g.fill();
    };
    if (c.fadeIn > 0) fade(x, c.fadeIn, 1, c.inType);
    if (c.fadeOut > 0) fade(x + w, c.fadeOut, -1, c.outType);

    if (w > 26) {
      g.fillStyle = '#0d0f11';
      g.font = '600 10.5px "Segoe UI", system-ui, sans-serif';
      g.textBaseline = 'middle';
      g.fillText((c.reverse ? '◂ ' : '') + (pat ? '▦ ' + pat.name : c.name), Math.max(x, 0) + 5, y + T / 2 + 0.5);
    }
    const envOn = App.tool === 'auto' && App.autoParam === 'clip';
    if (c.env.length || envOn) {
      this.drawCurve(g, c.env, 1, v => this.clipEnvY(v, y, h), tt => x + tt * pps, x, x + w, envOn, '#ffffff');
    }
    if (sel && w > 34) {
      // fade handles
      g.fillStyle = '#fff';
      for (const hx of [x + c.fadeIn * pps + 1, x + w - c.fadeOut * pps - 8]) g.fillRect(hx, y + T + 1, 7, 7);
    }
    g.restore();
    if (sel) {
      g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath();
      if (g.roundRect) g.roundRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5, 3); else g.rect(x, y, w, h);
      g.stroke();
      g.lineWidth = 1;
    }
  },

  // step dots for a live pattern clip
  drawPattern(g, c, pat, x, y, h, pps, x0, x1, col) {
    const p = App.project, sd = 60 / p.bpm / 4, n = Math.max(1, pat.channels.length), rh = h / n, sw = sd * pps;
    const loop = pat.steps * sw;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    for (let lx = x - (c.offset * pps) % loop; lx < x1; lx += loop) if (lx > x + 1) g.fillRect(Math.round(lx), y, 1, h);
    if (sw < 1.2) return;
    g.fillStyle = U.hexA(col, 0.95);
    const a = (c.offset + (x0 - x) / pps) / sd, b = (c.offset + (x1 - x) / pps) / sd;
    Engine.patEvents(p, pat, a, b, (ch, pos, vel, pitch, len) => {
      const row = pat.channels.indexOf(ch), px = x + (pos * sd - c.offset) * pps;
      g.globalAlpha = (c.mute ? 0.32 : 1) * (0.4 + 0.6 * vel);
      g.fillRect(px, y + row * rh + 1, Math.max(2, (len || 0.45) * sw - 1), Math.max(2, rh - 2));
    });
    g.globalAlpha = c.mute ? 0.32 : 1;
  },

  // a point curve (automation or clip gain): yOf maps value to y, xOf maps time to x
  drawCurve(g, pts, def, yOf, xOf, xa, xb, active, color) {
    g.save();
    g.globalAlpha = active ? 1 : 0.5;
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = active ? 1.5 : 1;
    g.beginPath();
    g.moveTo(xa, yOf(pts.length ? pts[0].v : def));
    for (const pt of pts) g.lineTo(xOf(pt.t), yOf(pt.v));
    g.lineTo(xb, yOf(pts.length ? pts[pts.length - 1].v : def));
    g.stroke();
    if (active) for (const pt of pts) { g.beginPath(); g.arc(xOf(pt.t), yOf(pt.v), 3.5, 0, Math.PI * 2); g.fill(); }
    g.restore();
  },

  autoY(prm, v, rowY) {
    return prm === 'vol' ? rowY + this.TH - 5 - v / 1.25 * (this.TH - 10) : rowY + this.TH / 2 - v * (this.TH / 2 - 5);
  },
  clipEnvY(v, y, h) { return y + h - 3 - v / 2 * (h - this.TITLE - 6); },

  // What the automation tool edits at a viewport point: a track curve or a clip's gain envelope.
  autoTarget(x, y) {
    const p = App.project, sy = this.sc.scrollTop, sx = this.sc.scrollLeft, pps = this.pps, TH = this.TH;
    const row = Math.floor((y + sy) / TH), tr = p.tracks[row], prm = App.autoParam, rowY = row * TH - sy;
    if (!tr) return null;
    if (prm === 'clip') {
      const h = this.hit(x, y);
      if (!h) return null;
      const c = h.clip, cy = rowY + 2, ch = TH - 5, dur = this.dur(c);
      return {
        fmt: v => Math.round(v * 100) + '%',
        pts: c.env, xOf: t => (c.start + t) * pps - sx, tOf: X => U.clamp((X + sx) / pps - c.start, 0, dur),
        yOf: v => this.clipEnvY(v, cy, ch), vOf: Y => U.clamp((cy + ch - 3 - Y) / (ch - this.TITLE - 6) * 2, 0, 2),
      };
    }
    if (prm.startsWith('fx:')) {
      const [, fid, key] = prm.split(':'), fx = tr.fx.find(f => f.id === fid), d = fx && FX.defs[fx.type].params.find(q => q.k === key);
      if (!d) return null;
      fx.auto = fx.auto || {};
      const N = this.fxNorm(d);
      return {
        pts: fx.auto[key] = fx.auto[key] || [], xOf: t => t * pps - sx, tOf: (X, e) => Math.max(0, this.snap((X + sx) / pps, e)),
        yOf: v => rowY + TH - 5 - U.clamp(N.to(v), 0, 1) * (TH - 10), vOf: Y => N.from(U.clamp((rowY + TH - 5 - Y) / (TH - 10), 0, 1)),
        fmt: v => FX.fmt(d, v),
      };
    }
    return {
      fmt: v => (prm === 'vol' ? Math.round(v * 100) + '%' : Math.abs(v) < 0.01 ? 'Centre' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100)),
      pts: tr.auto[prm], xOf: t => t * pps - sx, tOf: (X, e) => Math.max(0, this.snap((X + sx) / pps, e)),
      yOf: v => this.autoY(prm, v, rowY),
      vOf: Y => (prm === 'vol' ? U.clamp((rowY + TH - 5 - Y) / (TH - 10) * 1.25, 0, 1.25) : U.clamp((rowY + TH / 2 - Y) / (TH / 2 - 5), -1, 1)),
    };
  },
  autoHit(tg, x, y) { return tg.pts.find(pt => Math.abs(tg.xOf(pt.t) - x) < 7 && Math.abs(tg.yOf(pt.v) - y) < 7); },

  autoDown(e, x, y) {
    const tg = this.autoTarget(x, y);
    if (!tg) return;
    this.sc.setPointerCapture(e.pointerId);
    App.pushUndo();
    let pt = this.autoHit(tg, x, y);
    if (!pt) {
      pt = { t: tg.tOf(x, e), v: Math.round(tg.vOf(y) * 100) / 100 };
      tg.pts.push(pt);
      tg.pts.sort((a, b) => a.t - b.t);
    }
    this.drag = { kind: 'auto', tg, pt, moved: true };
    this.draw();
  },

  markerAt(e) {
    const r = this.ruler.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (y > 15) return null;
    return App.project.markers.find(m => { const mx = m.t * this.pps - this.sc.scrollLeft; return x >= mx - 3 && x <= mx + 10 + m.name.length * 6.2; });
  },

  drawRuler() {
    const p = App.project, g = this.rx, W = this.vw, sx = this.sc.scrollLeft, pps = p.view.pps, bar = 240 / p.bpm;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, 28);
    if (p.loop.end > p.loop.start) {
      g.fillStyle = p.loop.on ? 'rgba(255,138,42,0.75)' : 'rgba(255,255,255,0.15)';
      g.fillRect(p.loop.start * pps - sx, 0, (p.loop.end - p.loop.start) * pps, 5);
    }
    g.font = '600 9.5px "Segoe UI", system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (const m of p.markers) {
      const mx = Math.round(m.t * pps - sx), tw = g.measureText(m.name).width + 8;
      g.fillStyle = '#9d8cff';
      g.fillRect(mx, 0, tw, 12); g.fillRect(mx, 0, 1, 28);
      g.fillStyle = '#12101f';
      g.fillText(m.name, mx + 4, 6.5);
    }
    const every = [1, 2, 4, 8, 16, 32, 64, 128].find(n => n * bar * pps >= 46) || 256;
    g.font = '10.5px "Cascadia Mono", Consolas, monospace';
    g.textBaseline = 'middle';
    for (let k = Math.floor(sx / pps / bar), kEnd = Math.ceil((sx + W) / pps / bar); k <= kEnd; k++) {
      const x = Math.round(k * bar * pps - sx) + 0.5, major = k % every === 0;
      if (!major && bar * pps < 7) continue;
      g.strokeStyle = major ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)';
      g.beginPath(); g.moveTo(x, major ? 14 : 23); g.lineTo(x, 28); g.stroke();
      if (major) { g.fillStyle = '#8b959e'; g.fillText(k + 1, x + 4, 20); }
    }
  },

  updatePlayhead(pos) {
    const x = pos * this.pps - this.sc.scrollLeft;
    this.ph.style.display = x < 0 || x > this.vw ? 'none' : 'block';
    this.ph.style.transform = 'translateX(' + x + 'px)';
  },

  follow(pos) {
    const x = pos * this.pps - this.sc.scrollLeft;
    if ((x > this.vw - 16 || x < 0) && !this.drag) this.sc.scrollLeft = pos * this.pps - 60;
  },

  /* ---------- track headers ---------- */

  renderHeads() {
    const p = App.project;
    this.meters.clear();
    const rows = p.tracks.map((t, i) => {
      const meter = U.el('canvas.h-meter', { width: 4, height: this.TH - 12 });
      this.meters.set(t.id, meter.getContext('2d'));
      const name = U.el('input.h-name', {
        value: t.name, spellcheck: false, title: 'Track name',
        onchange: e => App.edit(() => { t.name = e.target.value.trim() || t.name; }, 'heads,mixer'),
        onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); },
      });
      const btn = (cls, text, title, on, fn) => U.el('button.h-btn.' + cls + (on ? '.on' : ''), { text, title, onclick: fn });
      return U.el('div.head' + (t.id === App.selTrack ? '.sel' : ''), {
        data: { id: t.id }, style: { '--c': t.color, height: this.TH + 'px' },
        onpointerdown: () => App.selectTrack(t.id),
        oncontextmenu: e => { e.preventDefault(); this.headMenu(e, t, i, name); },
      },
      U.el('div.h-color'),
      U.el('div.h-main', null,
        U.el('div.h-row', null, t.bus ? U.el('span.bus-tag', { text: 'BUS' }) : null, name,
          btn('m', 'M', 'Mute', t.mute, () => App.edit(() => { t.mute = !t.mute; }, 'heads,mixer')),
          btn('s', 'S', 'Solo', t.solo, () => App.edit(() => { t.solo = !t.solo; }, 'heads,mixer')),
          btn('fx', t.fx.length ? 'FX ' + t.fx.length : 'FX', 'Effects for this track', t.fx.length > 0, () => { App.selectTrack(t.id); App.setTab('mixer'); })),
        U.el('div.h-row', null,
          UI.slider({ min: 0, max: 1.25, value: t.vol, def: 0.8, title: 'Volume', cls: 'sl h-vol', oninput: (v, s) => { t.vol = v; App.mixChanged(t.id, s); } }),
          UI.slider({ min: -1, max: 1, value: t.pan, def: 0, title: 'Pan', cls: 'sl h-pan', oninput: (v, s) => { t.pan = v; App.mixChanged(t.id, s); } }))),
      meter);
    });
    rows.push(U.el('div.add-row', null,
      U.el('button.add-track', { text: '+ Track', onclick: () => App.addTrack() }),
      U.el('button.add-track', { text: '+ Bus', title: 'A bus is a shared fader and effect chain that other tracks feed into', onclick: () => App.addBus() })));
    this.heads.replaceChildren(...rows);
  },

  headMenu(e, t, i, nameInput) {
    const p = App.project;
    UI.menu(e.clientX, e.clientY, [
      { label: 'Rename', onclick: () => { nameInput.focus(); nameInput.select(); } },
      { label: 'Change colour', onclick: () => App.edit(() => { t.color = COLORS[(COLORS.indexOf(t.color) + 1) % COLORS.length]; }, 'heads,timeline,mixer') },
      { label: 'Duplicate track', onclick: () => App.duplicateTrack(t) },
      { label: 'Clear automation', onclick: () => App.edit(() => { t.auto = { vol: [], pan: [] }; for (const f of t.fx) delete f.auto; }, 'timeline', true) },
      ...(t.bus ? [] : ['-', ...[null, ...p.tracks.filter(b => b.bus)].map(b => ({
        label: (((t.out || null) === (b ? b.id : null)) ? '● ' : '○ ') + 'Output → ' + (b ? b.name : 'Master'),
        onclick: () => App.edit(() => { t.out = b ? b.id : null; }, 'heads,mixer'),
      }))]),
      '-',
      { label: 'Move up', disabled: i === 0, onclick: () => App.edit(() => { p.tracks.splice(i - 1, 0, p.tracks.splice(i, 1)[0]); }, 'heads,timeline,mixer') },
      { label: 'Move down', disabled: i === p.tracks.length - 1, onclick: () => App.edit(() => { p.tracks.splice(i + 1, 0, p.tracks.splice(i, 1)[0]); }, 'heads,timeline,mixer') },
      '-',
      { label: 'Delete track', danger: true, onclick: () => App.deleteTrack(t.id) },
    ]);
  },

  /* ---------- pointer interaction ---------- */

  // Which clip (and which part of it) is under a viewport point.
  hit(x, y) {
    const p = App.project, sy = this.sc.scrollTop, row = Math.floor((y + sy) / this.TH), tr = p.tracks[row];
    if (!tr) return null;
    const pps = this.pps, sx = this.sc.scrollLeft, yIn = y + sy - row * this.TH;
    for (let i = p.clips.length - 1; i >= 0; i--) {
      const c = p.clips[i];
      if (c.trackId !== tr.id) continue;
      const x0 = c.start * pps - sx, w = Math.max(2, this.dur(c) * pps);
      if (x < x0 || x > x0 + w) continue;
      let zone = 'body';
      const edge = Math.min(6, w / 3), hy = 2 + this.TITLE;
      if (App.sel.has(c.id) && w > 34 && yIn >= hy && yIn <= hy + 10) {
        const fi = x0 + c.fadeIn * pps, fo = x0 + w - c.fadeOut * pps;
        if (x >= fi - 2 && x <= fi + 10) zone = 'fi';
        else if (x >= fo - 10 && x <= fo + 2) zone = 'fo';
      }
      if (zone === 'body') zone = x < x0 + edge ? 'l' : x > x0 + w - edge ? 'r' : 'body';
      return { clip: c, zone, row };
    }
    return null;
  },

  onDown(e) {
    if (e.button !== 0) return;
    const [x, y] = this.xy(e), sc = this.sc, p = App.project;
    if (x > sc.clientWidth || y > sc.clientHeight) return;   // scrollbar
    if (App.tool === 'auto') return this.autoDown(e, x, y);
    const t = this.x2t(x), h = this.hit(x, y);

    if (App.tool !== 'select') {
      if (!h) return;
      if (App.tool === 'slice') App.splitClips([h.clip], this.snap(t, e));
      else if (App.tool === 'mute') App.edit(() => { h.clip.mute = !h.clip.mute; }, 'timeline,clip', true);
      else { App.sel = new Set([h.clip.id]); App.deleteSelected(); }
      return;
    }

    sc.setPointerCapture(e.pointerId);
    if (!h) {
      this.drag = { kind: 'band', x, y, shift: e.shiftKey, row: Math.floor((y + sc.scrollTop) / this.TH), t };
      return;
    }
    const c = h.clip;
    let toggled = false;
    if (e.shiftKey) { App.sel.has(c.id) ? App.sel.delete(c.id) : App.sel.add(c.id); toggled = true; }
    else if (!App.sel.has(c.id)) App.sel = new Set([c.id]);
    App.selectTrack(c.trackId);
    App.refresh('timeline,clip');
    if (toggled) return;

    const rowOf = new Map(p.tracks.map((tr, i) => [tr.id, i]));
    this.drag = {
      kind: h.zone, x, y, clip: c, moved: false, grabT: t - c.start, row: h.row,
      orig: new Map(p.clips.filter(k => App.sel.has(k.id)).map(k => [k.id, { ...k, row: rowOf.get(k.trackId) }])),
    };
  },

  onMove(e) {
    const [x, y] = this.xy(e), d = this.drag, p = App.project;
    if (!d) return this.hover(x, y, e);
    if (!d.moved) {
      if (Math.abs(x - d.x) < 3 && Math.abs(y - d.y) < 3) return;
      d.moved = true;
      if (d.kind !== 'band') App.pushUndo();
    }
    const t = this.x2t(x), sy = this.sc.scrollTop;

    if (d.kind === 'auto') {
      d.pt.t = d.tg.tOf(x, e);
      d.pt.v = Math.round(d.tg.vOf(y) * 100) / 100;
      d.tg.pts.sort((a, b) => a.t - b.t);
      return this.draw();
    }
    if (d.kind === 'band') {
      const b = this.band = { x0: d.x + (d.sx0 = d.sx0 == null ? this.sc.scrollLeft : d.sx0), y0: d.y + (d.sy0 = d.sy0 == null ? sy : d.sy0), x1: x + this.sc.scrollLeft, y1: y + sy };
      const ta = Math.min(b.x0, b.x1) / this.pps, tb = Math.max(b.x0, b.x1) / this.pps;
      const ra = Math.floor(Math.min(b.y0, b.y1) / this.TH), rb = Math.floor(Math.max(b.y0, b.y1) / this.TH);
      const rows = new Set(p.tracks.slice(Math.max(0, ra), rb + 1).map(tr => tr.id));
      App.sel = new Set(p.clips.filter(c => rows.has(c.trackId) && c.start < tb && c.start + this.dur(c) > ta).map(c => c.id));
      return this.draw();
    }

    const c = d.clip, o = d.orig.get(c.id), oDur = o.len / o.rate, buf = Engine.buffers.get(c.sampleId), sDur = c.kind === 'pattern' ? Infinity : buf ? buf.duration : o.offset + o.len;
    if (d.kind === 'body') {
      const raw = t - d.grabT, m1 = this.magnet(raw, e, d.orig), m2 = this.magnet(raw + oDur, e, d.orig);
      const useStart = m1 != null && (m2 == null || Math.abs(m1 - raw) <= Math.abs(m2 - raw - oDur));
      const ns0 = useStart ? m1 : m2 != null ? m2 - oDur : this.snap(raw, e);
      this.guideT = useStart ? m1 : m2;
      let dt = ns0 - o.start, dRow = Math.floor((y + sy) / this.TH) - d.row;
      let minStart = Infinity, minRow = Infinity, maxRow = -Infinity;
      for (const k of d.orig.values()) { minStart = Math.min(minStart, k.start); minRow = Math.min(minRow, k.row); maxRow = Math.max(maxRow, k.row); }
      dt = Math.max(dt, -minStart);
      dRow = U.clamp(dRow, -minRow, p.tracks.length - 1 - maxRow);
      // clips cannot live on a bus: keep the last valid row
      if ([...d.orig.values()].some(k => p.tracks[k.row + dRow].bus)) dRow = d.dRow || 0;
      d.dRow = dRow;
      for (const k of p.clips) {
        const ko = d.orig.get(k.id);
        if (ko) { k.start = ko.start + dt; k.trackId = p.tracks[ko.row + dRow].id; }
      }
    } else if (d.kind === 'l') {
      const ns = U.clamp(this.edge(t, e, d.orig), Math.max(0, o.start - o.offset / o.rate), o.start + oDur - 0.01), delta = ns - o.start;
      c.start = ns; c.offset = o.offset + delta * o.rate; c.len = o.len - delta * o.rate;
    } else if (d.kind === 'r') {
      c.len = U.clamp((this.edge(t, e, d.orig) - o.start) * o.rate, 0.01 * o.rate, sDur - o.offset);
    } else if (d.kind === 'fi') {
      c.fadeIn = U.clamp(t - c.start, 0, oDur - c.fadeOut);
    } else if (d.kind === 'fo') {
      c.fadeOut = U.clamp(c.start + oDur - t, 0, oDur - c.fadeIn);
    }
    App.clampFades(c);
    this.draw();
    Panels.syncClip();
  },

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    this.guideT = null;
    if (!d) return;
    if (d.kind === 'auto') { Engine.syncMix(); App.clipsChanged(); return this.draw(); }
    if (d.kind === 'band') {
      this.band = null;
      if (!d.moved) {
        if (!d.shift) App.sel.clear();
        const tr = App.project.tracks[d.row];
        if (tr) App.selectTrack(tr.id);
        App.seek(this.snap(Math.max(0, d.t), e));
      }
      return App.refresh('timeline,clip');
    }
    if (!d.moved) {
      if (!e.shiftKey && App.sel.size > 1) { App.sel = new Set([d.clip.id]); App.refresh('timeline,clip'); }
      return;
    }
    App.selectTrack(d.clip.trackId);
    App.clipsChanged();
    App.refresh('timeline,clip');
  },

  hover(x, y, e) {
    const h = this.hit(x, y), tool = App.tool;
    let cur = 'default', sliceX = null;
    if (tool === 'auto') { const tg = this.autoTarget(x, y); this.sc.style.cursor = tg ? (this.autoHit(tg, x, y) ? 'move' : 'crosshair') : 'default'; return; }
    if (h && tool === 'select') cur = h.zone === 'body' ? 'grab' : h.zone === 'l' || h.zone === 'r' ? 'ew-resize' : 'col-resize';
    else if (h && tool === 'slice') { cur = 'crosshair'; sliceX = Math.round(this.snap(this.x2t(x), e) * this.pps - this.sc.scrollLeft); }
    else if (h) cur = 'pointer';
    this.sc.style.cursor = cur;
    if (sliceX !== this.sliceX) { this.sliceX = sliceX; this.draw(); }
  },

  onMenu(e) {
    e.preventDefault();
    if (App.tool === 'auto') {
      const [ax, ay] = this.xy(e), tg = this.autoTarget(ax, ay), pt = tg && this.autoHit(tg, ax, ay);
      if (!pt) return;
      App.pushUndo();
      tg.pts.splice(tg.pts.indexOf(pt), 1);
      Engine.syncMix(); App.clipsChanged();
      return this.draw();
    }
    const h = this.hit(...this.xy(e));
    if (!h) return;
    if (!App.sel.has(h.clip.id)) { App.sel = new Set([h.clip.id]); App.refresh('timeline,clip'); }
    const n = App.sel.size, s = n > 1 ? ' (' + n + ')' : '';
    UI.menu(e.clientX, e.clientY, [
      { label: 'Split at playhead', onclick: () => App.splitAtPlayhead() },
      { label: 'Duplicate' + s, onclick: () => App.duplicateSelected() },
      { label: 'Crossfade overlaps', onclick: () => App.crossfade() },
      { label: 'Transition to next clip…', onclick: () => App.transitionDialog() },
      { label: 'Ripple delete (close the gap)', onclick: () => App.rippleDelete() },
      { label: 'Copy' + s, onclick: () => App.copy() },
      '-',
      { label: 'Reverse' + s, onclick: () => App.eachSelected(c => App.reverseClip(c)) },
      { label: 'Normalize' + s, onclick: () => App.eachSelected(c => App.normalizeClip(c)) },
      { label: 'Mute / unmute' + s, onclick: () => App.eachSelected(c => { c.mute = !c.mute; }) },
      { label: 'Clip settings…', onclick: () => App.setTab('clip') },
      '-',
      { label: 'Delete' + s, danger: true, onclick: () => App.deleteSelected() },
    ]);
  },
};
