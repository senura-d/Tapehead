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
    sc.addEventListener('dblclick', e => { if (this.hit(...this.xy(e))) App.setTab('clip'); });
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
      rdrag = e.shiftKey ? { a: rt(e) } : {};
      if (!e.shiftKey) App.seek(rt(e));
    });
    rl.addEventListener('pointermove', e => {
      if (!rdrag) return;
      if (rdrag.a == null) return App.seek(rt(e));
      const b = rt(e), p = App.project;
      p.loop = { on: true, start: Math.min(rdrag.a, b), end: Math.max(rdrag.a, b) };
      App.syncTop();
      this.draw();
    });
    rl.addEventListener('pointerup', () => { if (rdrag && rdrag.a != null) App.touch(); rdrag = null; });

    // drag samples (from the pool) or audio files (from the OS) onto the timeline
    sc.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    sc.addEventListener('drop', async e => {
      e.preventDefault();
      const [x, y] = this.xy(e), t = this.snap(Math.max(0, this.x2t(x)), e), row = Math.floor((y + sc.scrollTop) / this.TH);
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
    const pk = Engine.getPeaks(c.sampleId, c.reverse);
    if (pk) {
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
      g.fillText('missing audio', Math.max(x, 0) + 6, y + T + 16);
    }

    // fades: shade the faded-out area
    g.fillStyle = 'rgba(8,10,12,0.55)';
    if (c.fadeIn > 0) { g.beginPath(); g.moveTo(x, y + T); g.lineTo(x + c.fadeIn * pps, y + T); g.lineTo(x, y + h); g.fill(); }
    if (c.fadeOut > 0) { g.beginPath(); g.moveTo(x + w, y + T); g.lineTo(x + w - c.fadeOut * pps, y + T); g.lineTo(x + w, y + h); g.fill(); }

    if (w > 26) {
      g.fillStyle = '#0d0f11';
      g.font = '600 10.5px "Segoe UI", system-ui, sans-serif';
      g.textBaseline = 'middle';
      g.fillText((c.reverse ? '◂ ' : '') + c.name, Math.max(x, 0) + 5, y + T / 2 + 0.5);
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

  drawRuler() {
    const p = App.project, g = this.rx, W = this.vw, sx = this.sc.scrollLeft, pps = p.view.pps, bar = 240 / p.bpm;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, 28);
    if (p.loop.end > p.loop.start) {
      g.fillStyle = p.loop.on ? 'rgba(255,138,42,0.75)' : 'rgba(255,255,255,0.15)';
      g.fillRect(p.loop.start * pps - sx, 0, (p.loop.end - p.loop.start) * pps, 5);
    }
    const every = [1, 2, 4, 8, 16, 32, 64, 128].find(n => n * bar * pps >= 46) || 256;
    g.font = '10.5px "Cascadia Mono", Consolas, monospace';
    g.textBaseline = 'middle';
    for (let k = Math.floor(sx / pps / bar), kEnd = Math.ceil((sx + W) / pps / bar); k <= kEnd; k++) {
      const x = Math.round(k * bar * pps - sx) + 0.5, major = k % every === 0;
      if (!major && bar * pps < 7) continue;
      g.strokeStyle = major ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)';
      g.beginPath(); g.moveTo(x, major ? 16 : 22); g.lineTo(x, 28); g.stroke();
      if (major) { g.fillStyle = '#8b959e'; g.fillText(k + 1, x + 4, 13); }
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
        U.el('div.h-row', null, name,
          btn('m', 'M', 'Mute', t.mute, () => App.edit(() => { t.mute = !t.mute; }, 'heads,mixer')),
          btn('s', 'S', 'Solo', t.solo, () => App.edit(() => { t.solo = !t.solo; }, 'heads,mixer')),
          btn('fx', t.fx.length ? 'FX ' + t.fx.length : 'FX', 'Effects for this track', t.fx.length > 0, () => { App.selectTrack(t.id); App.setTab('mixer'); })),
        U.el('div.h-row', null,
          UI.slider({ min: 0, max: 1.25, value: t.vol, def: 0.8, title: 'Volume', cls: 'sl h-vol', oninput: (v, s) => { t.vol = v; App.mixChanged(t.id, s); } }),
          UI.slider({ min: -1, max: 1, value: t.pan, def: 0, title: 'Pan', cls: 'sl h-pan', oninput: (v, s) => { t.pan = v; App.mixChanged(t.id, s); } }))),
      meter);
    });
    rows.push(U.el('button.add-track', { text: '+ Add track', onclick: () => App.addTrack() }));
    this.heads.replaceChildren(...rows);
  },

  headMenu(e, t, i, nameInput) {
    const p = App.project;
    UI.menu(e.clientX, e.clientY, [
      { label: 'Rename', onclick: () => { nameInput.focus(); nameInput.select(); } },
      { label: 'Change colour', onclick: () => App.edit(() => { t.color = COLORS[(COLORS.indexOf(t.color) + 1) % COLORS.length]; }, 'heads,timeline,mixer') },
      { label: 'Duplicate track', onclick: () => App.duplicateTrack(t) },
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

    if (d.kind === 'band') {
      const b = this.band = { x0: d.x + (d.sx0 = d.sx0 == null ? this.sc.scrollLeft : d.sx0), y0: d.y + (d.sy0 = d.sy0 == null ? sy : d.sy0), x1: x + this.sc.scrollLeft, y1: y + sy };
      const ta = Math.min(b.x0, b.x1) / this.pps, tb = Math.max(b.x0, b.x1) / this.pps;
      const ra = Math.floor(Math.min(b.y0, b.y1) / this.TH), rb = Math.floor(Math.max(b.y0, b.y1) / this.TH);
      const rows = new Set(p.tracks.slice(Math.max(0, ra), rb + 1).map(tr => tr.id));
      App.sel = new Set(p.clips.filter(c => rows.has(c.trackId) && c.start < tb && c.start + this.dur(c) > ta).map(c => c.id));
      return this.draw();
    }

    const c = d.clip, o = d.orig.get(c.id), oDur = o.len / o.rate, buf = Engine.buffers.get(c.sampleId), sDur = buf ? buf.duration : o.offset + o.len;
    if (d.kind === 'body') {
      let dt = this.snap(t - d.grabT, e) - o.start, dRow = Math.floor((y + sy) / this.TH) - d.row;
      let minStart = Infinity, minRow = Infinity, maxRow = -Infinity;
      for (const k of d.orig.values()) { minStart = Math.min(minStart, k.start); minRow = Math.min(minRow, k.row); maxRow = Math.max(maxRow, k.row); }
      dt = Math.max(dt, -minStart);
      dRow = U.clamp(dRow, -minRow, p.tracks.length - 1 - maxRow);
      for (const k of p.clips) {
        const ko = d.orig.get(k.id);
        if (ko) { k.start = ko.start + dt; k.trackId = p.tracks[ko.row + dRow].id; }
      }
    } else if (d.kind === 'l') {
      const ns = U.clamp(this.snap(t, e), Math.max(0, o.start - o.offset / o.rate), o.start + oDur - 0.01), delta = ns - o.start;
      c.start = ns; c.offset = o.offset + delta * o.rate; c.len = o.len - delta * o.rate;
    } else if (d.kind === 'r') {
      c.len = U.clamp((this.snap(t, e) - o.start) * o.rate, 0.01 * o.rate, sDur - o.offset);
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
    if (!d) return;
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
    if (h && tool === 'select') cur = h.zone === 'body' ? 'grab' : h.zone === 'l' || h.zone === 'r' ? 'ew-resize' : 'col-resize';
    else if (h && tool === 'slice') { cur = 'crosshair'; sliceX = Math.round(this.snap(this.x2t(x), e) * this.pps - this.sc.scrollLeft); }
    else if (h) cur = 'pointer';
    this.sc.style.cursor = cur;
    if (sliceX !== this.sliceX) { this.sliceX = sliceX; this.draw(); }
  },

  onMenu(e) {
    e.preventDefault();
    const h = this.hit(...this.xy(e));
    if (!h) return;
    if (!App.sel.has(h.clip.id)) { App.sel = new Set([h.clip.id]); App.refresh('timeline,clip'); }
    const n = App.sel.size, s = n > 1 ? ' (' + n + ')' : '';
    UI.menu(e.clientX, e.clientY, [
      { label: 'Split at playhead', onclick: () => App.splitAtPlayhead() },
      { label: 'Duplicate' + s, onclick: () => App.duplicateSelected() },
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
