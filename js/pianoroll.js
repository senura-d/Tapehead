'use strict';

// Piano roll for one rack channel: notes play the channel's sample at different pitches.
// Row 0 is the sample's own pitch (shown as C5); each row up or down is a semitone.
const PianoRoll = {
  ROW: 13, COL: 28, KEYS: 46, HI: 24, LO: -24,
  el: null, chId: null, snap: 1, lastLen: 2, sel: null,

  channel() {
    const pat = Engine.curPattern(App.project);
    return pat.channels.find(c => c.id === this.chId);
  },

  open(chId) {
    this.close();
    this.chId = chId;
    this.sel = null;
    const ch = this.channel(), pat = Engine.curPattern(App.project);
    if (!ch) return;
    const W = this.KEYS + pat.steps * this.COL, H = (this.HI - this.LO + 1) * this.ROW;
    const cv = this.cv = U.el('canvas.proll-cv', { width: W, height: H, style: { width: W + 'px', height: H + 'px' } });
    const snapSel = U.el('select.field.small', { title: 'Grid', onchange: e => { this.snap = +e.target.value; } },
      [[1, '1 step'], [0.5, '1/2 step'], [0.25, '1/4 step']].map(([v, t]) => U.el('option', { value: v, text: t, selected: v === this.snap })));
    this.velVal = U.el('span.val', { text: '—' });
    this.vel = U.el('input.sl.w80', { type: 'range', min: 0.1, max: 1, step: 0.01, value: 0.8, title: 'Velocity of the selected note' });
    this.vel.oninput = () => {
      const n = this.selected();
      if (!n) return;
      if (!this.velUndo) { App.pushUndo(); this.velUndo = true; }
      n.vel = +this.vel.value;
      this.velVal.textContent = Math.round(n.vel * 100) + '%';
      this.draw();
    };
    this.vel.onchange = () => { this.velUndo = false; App.touch(); Engine.resync(); };
    const scroll = U.el('div.proll-scroll', null, cv);
    const box = U.el('div.proll', { role: 'dialog' },
      U.el('div.proll-head', null,
        U.el('b', { text: 'Piano roll — ' + ch.name }),
        U.el('span.dim', { text: 'click to add · drag to move · drag the right edge to resize · right-click to delete' }),
        U.el('span.tb-grow'),
        U.el('label.inline', null, 'GRID', snapSel),
        U.el('label.inline', null, 'VELOCITY', this.vel, this.velVal),
        U.el('button.btn.small', { text: 'Play / stop', title: 'Loop this pattern (Space)', onclick: () => this.togglePlay() }),
        U.el('button.btn.small', { text: 'Clear', onclick: () => { App.pushUndo(); this.channel().notes = []; this.sel = null; this.commit(); } }),
        U.el('button.btn.small.accent', { text: 'Done', onclick: () => this.close() })),
      scroll);
    this.el = U.el('div.modal-back', { onpointerdown: e => { if (e.target === this.el) this.close(); } }, box);
    $('#overlay').append(this.el);
    scroll.scrollTop = (this.HI - 9) * this.ROW;

    cv.addEventListener('pointerdown', e => this.onDown(e));
    cv.addEventListener('pointermove', e => this.onMove(e));
    cv.addEventListener('pointerup', () => this.onUp());
    cv.addEventListener('contextmenu', e => {
      e.preventDefault();
      const h = this.hit(e);
      if (!h.note) return;
      App.pushUndo();
      const c = this.channel();
      c.notes.splice(c.notes.indexOf(h.note), 1);
      this.sel = null;
      this.commit();
    });
    this.onKey = e => {
      if (e.target.tagName === 'SELECT') return;
      if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
      else if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected()) {
        App.pushUndo();
        const c = this.channel();
        c.notes.splice(c.notes.indexOf(this.selected()), 1);
        this.sel = null;
        this.commit();
      }
    };
    document.addEventListener('keydown', this.onKey, true);
    const loop = () => { if (!this.el) return; this.draw(); requestAnimationFrame(loop); };
    loop();
  },

  close() {
    if (!this.el) return;
    document.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
    this.el = null;
    Rack.render();
  },

  togglePlay() {
    if (!Engine.playing && Engine.mode !== 'pat') App.setMode('pat');
    App.togglePlay();
  },

  selected() { const c = this.channel(); return c && c.notes.includes(this.sel) ? this.sel : null; },

  commit() {
    App.touch();
    Engine.resync();
    Playlist.draw();
    this.draw();
  },

  // Pointer position as {t (steps), pitch, note under it, whether it is on the note's right edge}.
  hit(e) {
    const r = this.cv.getBoundingClientRect(), x = e.clientX - r.left - this.KEYS, y = e.clientY - r.top;
    const t = x / this.COL, pitch = this.HI - Math.floor(y / this.ROW), ch = this.channel();
    let note = null;
    for (let i = ch.notes.length - 1; i >= 0 && !note; i--) {
      const n = ch.notes[i];
      if (n.pitch === pitch && t >= n.t && t <= n.t + n.len) note = n;
    }
    return { t, pitch, note, edge: note ? (note.t + note.len - t) * this.COL < 7 : false, keys: x < 0 };
  },

  onDown(e) {
    if (e.button !== 0) return;
    const h = this.hit(e), ch = this.channel(), pat = Engine.curPattern(App.project);
    if (h.keys) return Engine.preview(ch, (ch.pitch || 0) + h.pitch, 0.4);
    this.cv.setPointerCapture(e.pointerId);
    App.pushUndo();
    let n = h.note, kind = h.edge ? 'size' : 'move';
    if (!n) {
      const t = U.clamp(Math.floor(h.t / this.snap) * this.snap, 0, pat.steps - this.snap);
      n = { t, len: Math.min(this.lastLen, pat.steps - t), pitch: U.clamp(h.pitch, this.LO, this.HI), vel: 0.8 };
      ch.notes.push(n);
      kind = 'move';
    }
    this.sel = n;
    this.vel.value = n.vel;
    this.velVal.textContent = Math.round(n.vel * 100) + '%';
    this.drag = { kind, n, grab: h.t - n.t, pitch: n.pitch };
    Engine.preview(ch, (ch.pitch || 0) + n.pitch, 0.3);
  },

  onMove(e) {
    const d = this.drag;
    if (!d) { const h = this.hit(e); this.cv.style.cursor = h.keys ? 'pointer' : h.edge ? 'ew-resize' : h.note ? 'grab' : 'crosshair'; return; }
    const h = this.hit(e), pat = Engine.curPattern(App.project), s = this.snap, n = d.n;
    if (d.kind === 'size') {
      n.len = U.clamp(Math.round((h.t - n.t) / s) * s, s, pat.steps - n.t);
      this.lastLen = n.len;
    } else {
      n.t = U.clamp(Math.round((h.t - d.grab) / s) * s, 0, pat.steps - s);
      n.pitch = U.clamp(h.pitch, this.LO, this.HI);
      if (n.pitch !== d.pitch) { d.pitch = n.pitch; const ch = this.channel(); Engine.preview(ch, (ch.pitch || 0) + n.pitch, 0.3); }
    }
  },

  onUp() {
    if (!this.drag) return;
    this.drag = null;
    this.commit();
  },

  draw() {
    const ch = this.channel(), pat = Engine.curPattern(App.project);
    if (!ch) return this.close();
    const g = this.cv.getContext('2d'), W = this.cv.width, H = this.cv.height, R = this.ROW, C = this.COL, K = this.KEYS;
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    g.clearRect(0, 0, W, H);
    g.font = '9.5px "Cascadia Mono", Consolas, monospace';
    g.textBaseline = 'middle';
    for (let pitch = this.HI; pitch >= this.LO; pitch--) {
      const y = (this.HI - pitch) * R, k = ((pitch % 12) + 12) % 12, black = [1, 3, 6, 8, 10].includes(k);
      g.fillStyle = pitch === 0 ? '#2a2118' : black ? '#131517' : '#191c1f';
      g.fillRect(K, y, W - K, R - 1);
      g.fillStyle = black ? '#0b0c0d' : '#c9cfd4';
      g.fillRect(0, y, K - 2, R - 1);
      if (k === 0) { g.fillStyle = pitch === 0 ? '#c2570a' : '#4a525a'; g.fillText(names[k] + (5 + pitch / 12), 4, y + R / 2); }
    }
    for (let i = 0; i <= pat.steps; i++) {
      g.fillStyle = i % 16 === 0 ? 'rgba(255,255,255,0.22)' : i % 4 === 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.035)';
      g.fillRect(K + i * C, 0, 1, H);
    }
    if (Engine.playing && Engine.mode === 'pat') {
      const st = Engine.currentStep();
      if (st >= 0) { g.fillStyle = 'rgba(111,220,140,0.12)'; g.fillRect(K + st * C, 0, C, H); }
    }
    for (const n of ch.notes) {
      if (n.t >= pat.steps) continue;
      const x = K + n.t * C, y = (this.HI - n.pitch) * R, w = Math.max(4, n.len * C - 1);
      g.fillStyle = U.hexA('#ff8a2a', 0.35 + 0.65 * n.vel);
      g.fillRect(x, y, w, R - 1);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x + w - 3, y, 3, R - 1);
      if (n === this.sel) { g.strokeStyle = '#fff'; g.strokeRect(x + 0.5, y + 0.5, w - 1, R - 2); }
    }
  },
};
