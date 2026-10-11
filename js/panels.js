'use strict';

// Side and bottom panels: sample pool, mixer + effect chain, clip inspector.
const Panels = {
  meters: new Map(),
  spec: null,

  init() {
    this.mixer = $('#tab-mixer'); this.clip = $('#tab-clip'); this.pool = $('#pool-list');
    this.strips = U.el('div.strips'); this.chain = U.el('div.chain');
    this.mixer.append(this.strips, this.chain);

    $('#pool-import').onclick = () => $('#file-input').click();
    $('#file-input').onchange = async e => { await App.importFiles(e.target.files); e.target.value = ''; };
    const pool = $('#pool');
    pool.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); pool.classList.add('drop'); } });
    pool.addEventListener('dragleave', () => pool.classList.remove('drop'));
    pool.addEventListener('drop', e => { e.preventDefault(); pool.classList.remove('drop'); App.importFiles(e.dataTransfer.files); });
  },

  /* ---------- sample pool ---------- */

  renderPool() {
    const p = App.project, list = App.visibleSamples();
    const row = (s, kit) => {
      const buf = Engine.buffers.get(s.id);
      return U.el('div.smp', {
        draggable: true, title: 'Drag onto the playlist · double-click to add at the playhead',
        ondragstart: e => { e.dataTransfer.setData('text/x-sample', s.id); e.dataTransfer.effectAllowed = 'copy'; },
        ondblclick: () => App.addClips([s.id], Math.max(0, p.tracks.findIndex(t => t.id === App.selTrack)), Engine.position()),
      },
      U.el('button.smp-play', { html: ICON.play, title: 'Audition', onclick: e => { e.stopPropagation(); Engine.preview({ sampleId: s.id, vol: 0.9 }); } }),
      U.el('span.smp-name', { text: s.name }),
      U.el('span.smp-dur', { text: s.missing ? 'missing' : (s.bpm ? Math.round(s.bpm) + ' bpm · ' : '') + U.fmtDur(buf ? buf.duration : 0) }),
      kit ? null : U.el('button.smp-x', { html: ICON.x, title: 'Remove from project', onclick: e => { e.stopPropagation(); App.removeSample(s); } }));
    };
    this.pool.replaceChildren(
      U.el('div.pool-title', { text: 'Project' }),
      ...(list.length ? list.map(s => row(s, false)) : [U.el('div.pool-empty', { text: 'Drop WAV files here, or click Import.' })]),
      U.el('div.pool-title', { text: 'Drum kit' }),
      ...Kit.list.map(k => row(k, true)));
  },

  /* ---------- mixer ---------- */

  renderMixer() { this.renderStrips(); this.renderChain(); },

  renderStrips() {
    const p = App.project;
    this.meters.clear();
    const strip = (id, o, name, color) => {
      const meter = U.el('canvas.s-meter', { width: 5, height: 104 });
      this.meters.set(id, meter.getContext('2d'));
      const btn = (cls, text, title, on, key) => U.el('button.h-btn.' + cls + (on ? '.on' : ''), { text, title, onclick: () => App.edit(() => { o[key] = !o[key]; }, 'heads,mixer') });
      return U.el('div.strip' + (id === App.fxOwner ? '.sel' : '') + (o.bus ? '.bus' : ''), { data: { id }, style: { '--c': color }, onpointerdown: () => App.selectTrack(id) },
        U.el('div.s-name', { text: (o.bus ? '▸ ' : '') + name, title: name }),
        U.el('div.s-body', null, meter,
          UI.slider({ min: 0, max: 1.25, value: o.vol, def: id === 'master' ? 0.9 : 0.8, cls: 'vfader', title: 'Volume', oninput: (v, s) => { o.vol = v; App.mixChanged(id, s); } })),
        id === 'master'
          ? U.el('div.s-foot', null, U.el('span.s-fx', { text: o.fx.length + ' fx' }))
          : U.el('div.s-foot', null, btn('m', 'M', 'Mute', o.mute, 'mute'), btn('s', 'S', 'Solo', o.solo, 'solo')));
    };
    this.strips.replaceChildren(strip('master', p.master, 'Master', '#d7dce0'), ...p.tracks.map(t => strip(t.id, t, t.name, t.color)));
  },

  renderChain() {
    const p = App.project;
    let owner = App.fxOwner;
    if (owner !== 'master' && !p.tracks.some(t => t.id === owner)) owner = App.fxOwner = 'master';
    const tr = owner === 'master' ? null : p.tracks.find(t => t.id === owner);
    const list = Engine.fxList(p, owner), name = tr ? tr.name : 'Master', buses = p.tracks.filter(t => t.bus);

    const add = U.el('select.field.small', { onchange: e => { const type = e.target.value; if (type) App.fxEdit(owner, () => list.push(FX.make(type))); } },
      U.el('option', { value: '', text: '+ Add effect…' }),
      FX.order.map(t => U.el('option', { value: t, text: FX.defs[t].name })));

    // routing: where this track's output goes, plus one send to a bus
    const routing = [];
    if (tr && !tr.bus) {
      const opts = sel => [U.el('option', { value: '', text: sel === 'out' ? 'Master' : 'No send' }), ...buses.map(b => U.el('option', { value: b.id, text: b.name }))];
      const out = U.el('select.field.small', { title: 'Where this track goes: straight to the master, or through a bus', onchange: e => App.edit(() => { tr.out = e.target.value || null; }, 'heads,mixer') }, opts('out'));
      out.value = buses.some(b => b.id === tr.out) ? tr.out : '';
      const send = U.el('select.field.small', { title: 'Also send a copy of this track to a bus (for a shared reverb or delay)', onchange: e => App.edit(() => { tr.send.to = e.target.value || null; }, 'mixer') }, opts('send'));
      send.value = buses.some(b => b.id === tr.send.to) ? tr.send.to : '';
      routing.push(U.el('label.inline', null, 'OUT', out), U.el('label.inline', null, 'SEND', send,
        UI.slider({ min: 0, max: 1, value: tr.send.amt, def: 0.5, cls: 'sl w80', title: 'Send amount', oninput: v => { tr.send.amt = v; Engine.syncMix(); } })));
      if (!buses.length) routing.push(U.el('span.dim', { text: 'add a bus (“+ Bus” under the tracks) to use these' }));
    }

    const cards = list.map((fx, i) => {
      const def = FX.defs[fx.type];
      if (!def) return null;
      const ib = (icon, title, disabled, fn) => U.el('button.icon-btn', { html: icon, title, disabled, onclick: fn });
      return U.el('div.fx-card' + (fx.on ? '' : '.off'), null,
        U.el('div.fx-head', null,
          U.el('button.ch-led' + (fx.on ? '.on' : ''), { title: 'Bypass', onclick: () => App.fxEdit(owner, () => { fx.on = !fx.on; }) }),
          U.el('span.fx-name', { text: def.name }), fx.auto ? U.el('span.fx-auto', { text: 'auto' }) : null,
          ib(ICON.left, 'Move earlier in the chain', i === 0, () => App.fxEdit(owner, () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); })),
          ib(ICON.right, 'Move later in the chain', i === list.length - 1, () => App.fxEdit(owner, () => { list.splice(i + 1, 0, list.splice(i, 1)[0]); })),
          ib(ICON.x, 'Remove effect', false, () => App.fxEdit(owner, () => { list.splice(i, 1); }))),
        def.params.map(d => this.param(owner, fx, d)));
    });

    const cv = U.el('canvas.spec', { width: 300, height: 150, title: 'Live spectrum of this channel. With a Parametric EQ in the chain, drag the dots to shape it.' });
    this.spec = { cv, owner, drag: null };
    this.bindSpec(cv, owner, list);

    this.chain.replaceChildren(
      U.el('div.chain-head', null, U.el('b', { text: name }), U.el('span.dim', { text: ' effects' }), ...routing, U.el('span.tb-grow'),
        U.el('button.btn.small', { text: 'Presets', title: 'Save this effect chain as a preset, or load one', onclick: e => Extras.presetMenu(e, owner) }), add),
      U.el('div.fx-cards', null, U.el('div.fx-card.spec-card', null, cv), cards,
        cards.length ? null : U.el('div.empty', { text: 'No effects on ' + name + '. Add EQ, compression, reverb, delay and more from the menu above.' })));
  },

  param(owner, fx, d) {
    const val = U.el('span.val', { text: FX.fmt(d, fx.p[d.k]) });
    const apply = v => { fx.p[d.k] = v; val.textContent = FX.fmt(d, v); Engine.updateFx(owner, fx); };
    let ctl;
    if (d.opts || d.track) {
      const opts = d.track
        ? [['', 'None'], ...App.project.tracks.filter(t => t.id !== owner).map(t => [t.id, t.name])]
        : d.opts.map(o => [o, o]);
      ctl = U.el('select.field.small', { onchange: e => { App.pushUndo(); apply(e.target.value); App.touch(); } },
        opts.map(([v, t]) => U.el('option', { value: v, text: t })));
      ctl.value = opts.some(o => o[0] === fx.p[d.k]) ? fx.p[d.k] : opts[0][0];
      return U.el('label.fx-param', null, U.el('span.lbl', { text: d.label }), ctl);
    }
    if (d.log) {
      const r = Math.log(d.max / d.min);
      ctl = UI.slider({ min: 0, max: 1, step: 0.001, value: Math.log(fx.p[d.k] / d.min) / r, def: Math.log(d.def / d.min) / r, oninput: x => apply(Math.round(d.min * Math.exp(x * r))) });
    } else {
      ctl = UI.slider({ min: d.min, max: d.max, step: d.step || 0.01, value: fx.p[d.k], def: d.def, oninput: apply });
    }
    return U.el('label.fx-param', null, U.el('span.lbl', { text: d.label }), ctl, val);
  },

  /* ---------- spectrum + visual EQ ---------- */

  specX(f, W) { return W * Math.log(f / 20) / Math.log(1000); },
  specF(x, W) { return 20 * Math.pow(1000, x / W); },
  eqY(db, H) { return H / 2 - db / 18 * (H / 2 - 8); },

  // the three draggable EQ points: [param for gain, frequency, param for frequency or null]
  eqHandles(fx) { return [['low', 120, null], ['mid', fx.p.midF, 'midF'], ['high', 6000, null]]; },

  bindSpec(cv, owner, list) {
    const eq = () => list.find(f => f.type === 'eq' && f.on);
    const at = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
    cv.addEventListener('pointerdown', e => {
      const fx = eq();
      if (!fx) return;
      const [x, y] = at(e);
      const h = this.eqHandles(fx).find(([k, f]) => Math.abs(this.specX(f, cv.width) - x) < 12 && Math.abs(this.eqY(fx.p[k], cv.height) - y) < 12);
      if (!h) return;
      cv.setPointerCapture(e.pointerId);
      App.pushUndo();
      this.spec.drag = { fx, h };
    });
    cv.addEventListener('pointermove', e => {
      const d = this.spec.drag;
      if (!d) return;
      const [x, y] = at(e), H = cv.height;
      d.fx.p[d.h[0]] = Math.round(U.clamp((H / 2 - y) / (H / 2 - 8) * 18, -18, 18) * 2) / 2;
      if (d.h[2]) d.fx.p[d.h[2]] = Math.round(U.clamp(this.specF(x, cv.width), 200, 8000));
      Engine.updateFx(owner, d.fx);
    });
    cv.addEventListener('pointerup', () => { if (this.spec.drag) { this.spec.drag = null; App.touch(); this.renderChain(); } });
  },

  drawSpectrum() {
    const sp = this.spec, strip = sp && Engine.strip(sp.owner);
    if (!strip || !strip.analyser) return;
    const cv = sp.cv, g = cv.getContext('2d'), W = cv.width, H = cv.height, an = strip.analyser;
    const bins = this._bins || (this._bins = new Float32Array(1024)), hz = Engine.ctx.sampleRate / an.fftSize;
    an.getFloatFrequencyData(bins);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0b0d0e';
    g.fillRect(0, 0, W, H);
    g.font = '9px "Cascadia Mono", Consolas, monospace';
    for (const f of [100, 1000, 10000]) {
      const x = Math.round(this.specX(f, W));
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, 0, 1, H);
      g.fillStyle = '#4d565e'; g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 3, H - 4);
    }
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, H / 2, W, 1);
    // spectrum
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x < W; x += 2) {
      const i0 = Math.max(1, Math.floor(this.specF(x, W) / hz)), i1 = Math.min(1023, Math.max(i0, Math.floor(this.specF(x + 2, W) / hz)));
      let db = -140;
      for (let i = i0; i <= i1; i++) if (bins[i] > db) db = bins[i];
      g.lineTo(x, H - U.clamp((db + 100) / 90, 0, 1) * H);
    }
    g.lineTo(W, H);
    g.fillStyle = 'rgba(111,220,140,0.28)';
    g.fill();
    // EQ response
    const f = strip.fx.find(x => x.fx.type === 'eq' && x.inst.curve);
    if (!f) {
      g.fillStyle = '#4d565e';
      g.fillText('add a Parametric EQ to shape it here', 8, 12);
      return;
    }
    if (!this._freqs || this._freqs.length !== W) { this._freqs = new Float32Array(W); for (let x = 0; x < W; x++) this._freqs[x] = this.specF(x, W); }
    const resp = f.inst.curve(this._freqs);
    g.strokeStyle = '#ff8a2a'; g.lineWidth = 1.5;
    g.beginPath();
    for (let x = 0; x < W; x++) { const y = this.eqY(U.clamp(resp[x], -24, 24), H); x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
    g.fillStyle = '#fff';
    for (const [k, fr] of this.eqHandles(f.fx)) { g.beginPath(); g.arc(this.specX(fr, W), this.eqY(f.fx.p[k], H), 4, 0, Math.PI * 2); g.fill(); }
  },

  /* ---------- clip inspector ---------- */

  syncClip() { if (App.tab === 'clip') this.renderClip(); },

  renderClip() {
    const p = App.project, sel = p.clips.filter(c => App.sel.has(c.id));
    const act = (text, fn, cls, title) => U.el('button.btn.small' + (cls || ''), { text, title, onclick: fn });
    const common = [
      act('Split at playhead', () => App.splitAtPlayhead()),
      act('Duplicate', () => App.duplicateSelected()),
      act('Crossfade overlaps', () => App.crossfade(), '', 'Fade this clip into any clip it overlaps on the same track'),
      act('Transition…', () => App.transitionDialog(), '', 'Blend this clip into the next clip on its track: crossfade, dip, filter sweep or tape stop'),
      act('Delete', () => App.deleteSelected(), '.danger'),
    ];
    if (!sel.length) {
      return this.clip.replaceChildren(U.el('div.empty.pad', { text: 'Select a clip in the playlist to edit its gain, pitch, length, fades and direction. Drag clip edges to trim, drag the body to move, and use the Slice tool or S to cut.' }));
    }
    if (sel.length > 1) {
      return this.clip.replaceChildren(U.el('div.clip-ed', null,
        U.el('div.clip-info', null, U.el('b', { text: sel.length + ' clips selected' })),
        U.el('div.clip-actions', null, act('Reverse', () => App.eachSelected(c => App.reverseClip(c))), act('Normalize', () => App.eachSelected(c => App.normalizeClip(c))), act('Mute / unmute', () => App.eachSelected(c => { c.mute = !c.mute; })), ...common)));
    }

    const c = sel[0], dur = c.len / c.rate, isPat = c.kind === 'pattern';
    const redraw = () => { App.clampFades(c); Playlist.layout(); Playlist.draw(); };
    const row = (label, slider, val) => U.el('label.fx-param', null, U.el('span.lbl', { text: label }), slider, val);
    const mk = (label, o, fmt, set) => {
      const val = U.el('span.val', { text: fmt(o.value) });
      return row(label, UI.slider({ ...o, oninput: v => { set(v); val.textContent = fmt(v); redraw(); }, onchange: () => { App.clipsChanged(); if (o.rerender) this.renderClip(); } }), val);
    };
    const gain = mk('Gain', { min: -24, max: 18, step: 0.5, value: Math.max(-24, Math.round(U.gainToDb(c.gain) * 2) / 2), def: 0 },
      v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB', v => { c.gain = U.dbToGain(v); });
    const fades = [
      mk('Fade in', { min: 0, max: Math.max(0.01, dur), step: 0.01, value: c.fadeIn, def: 0 }, v => v.toFixed(2) + ' s', v => { c.fadeIn = Math.min(v, c.len / c.rate - c.fadeOut); }),
      mk('Fade out', { min: 0, max: Math.max(0.01, dur), step: 0.01, value: c.fadeOut, def: 0 }, v => v.toFixed(2) + ' s', v => { c.fadeOut = Math.min(v, c.len / c.rate - c.fadeIn); }),
    ];
    const styleSel = (key, title) => {
      const s = U.el('select.field.small', { title, onchange: e => App.eachSelected(k => { k[key] = e.target.value; }) },
        [['linear', 'Linear'], ['smooth', 'Smooth'], ['exp', 'Slow start'], ['filter', 'Filter sweep'], ...(isPat ? [] : [['tape', 'Tape']])].map(([v, t]) => U.el('option', { value: v, text: t })));
      s.value = c[key] || 'linear';
      return s;
    };
    const styles = U.el('div.fx-param', null, U.el('span.lbl', { text: 'Fade in / out style' }), styleSel('inType', 'How the fade in behaves'), styleSel('outType', 'How the fade out behaves'));
    const envBtn = c.env.length ? act('Clear gain curve', () => App.eachSelected(k => { k.env = []; })) : null;

    if (isPat) {
      const pat = p.patterns.find(x => x.id === c.patId);
      return this.clip.replaceChildren(U.el('div.clip-ed', null,
        U.el('div.clip-info', null,
          U.el('b', { text: pat ? pat.name : 'Deleted pattern' }),
          U.el('div.dim', { text: 'Live pattern clip — it follows the pattern in the Channel rack. Drag its right edge to repeat it.' }),
          U.el('div.dim', { text: 'Start ' + U.fmtTime(c.start) + '  ·  Length ' + U.fmtTime(dur) }),
          U.el('div.clip-toggles', null,
            act('Edit pattern', () => { if (pat) { p.curPat = pat.id; App.setTab('rack'); Rack.render(); } }),
            U.el('button.btn.small' + (c.mute ? '.on' : ''), { text: 'Mute', onclick: () => App.eachSelected(k => { k.mute = !k.mute; }) }))),
        U.el('div.clip-sliders', null, gain, fades, styles),
        U.el('div.clip-actions', null, common, envBtn)));
    }

    const meta = App.sampleMeta(c.orig || c.sampleId), st = Math.round(12 * Math.log2(c.rate) * 10) / 10, ts = c.ts || 1, ps = c.ps || 0;
    // length / pitch changes are rendered once when the slider is released
    const lazy = (label, o, fmt, done) => {
      const val = U.el('span.val', { text: fmt(o.value) });
      return row(label, UI.slider({ ...o, undo: false, oninput: v => { val.textContent = fmt(v); }, onchange: done }), val);
    };
    const bpmIn = U.el('input.field.small.num', {
      type: 'number', min: 40, max: 300, step: 0.01, value: meta && meta.bpm ? meta.bpm : '', placeholder: '—', title: 'Tempo of the source audio (detected on import — correct it here if it is wrong)',
      onchange: e => { if (meta) { App.pushUndo(); meta.bpm = +e.target.value || null; App.touch(); Panels.renderPool(); this.renderClip(); } },
    });
    const fit = act('Fit to ' + p.bpm + ' BPM', () => App.retime(c, meta.bpm / p.bpm, ps), '', 'Stretch this clip so its tempo matches the project, keeping its pitch');
    fit.disabled = !(meta && meta.bpm);

    this.clip.replaceChildren(U.el('div.clip-ed', null,
      U.el('div.clip-info', null,
        U.el('input.field', { value: c.name, spellcheck: false, title: 'Clip name', onchange: e => App.edit(() => { c.name = e.target.value.trim() || c.name; }, 'timeline') }),
        U.el('div.dim', { text: 'Source: ' + (meta ? meta.name : 'missing') }),
        U.el('div.dim', { text: 'Start ' + U.fmtTime(c.start) + '  ·  Length ' + U.fmtTime(dur) }),
        U.el('div.clip-toggles', null,
          U.el('button.btn.small' + (c.reverse ? '.on' : ''), { text: 'Reverse', onclick: () => App.eachSelected(k => App.reverseClip(k)) }),
          U.el('button.btn.small' + (c.mute ? '.on' : ''), { text: 'Mute', onclick: () => App.eachSelected(k => { k.mute = !k.mute; }) }),
          act('Normalize', () => App.eachSelected(k => App.normalizeClip(k))))),
      U.el('div.clip-sliders', null,
        gain,
        mk('Speed (pitch follows)', { min: -12, max: 12, step: 1, value: st, def: 0, rerender: true },
          v => (v > 0 ? '+' : '') + v + ' st', v => { c.rate = Math.pow(2, v / 12); }),
        fades, styles),
      U.el('div.clip-sliders', null,
        lazy('Length, keep pitch', { min: 50, max: 200, step: 1, value: Math.round(ts * 100), def: 100 }, v => Math.round(v) + '%', v => App.retime(c, v / 100, ps)),
        lazy('Pitch, keep length', { min: -12, max: 12, step: 1, value: ps, def: 0 }, v => (v > 0 ? '+' : '') + v + ' st', v => App.retime(c, ts, v)),
        U.el('div.fx-param', null, U.el('span.lbl', { text: 'Source tempo' }), bpmIn, U.el('span.dim', { text: 'BPM' }), U.el('span.tb-grow'), fit)),
      U.el('div.clip-actions', null, common, envBtn)));
  },
};
