'use strict';

// Side and bottom panels: sample pool, mixer + effect chain, clip inspector.
const Panels = {
  meters: new Map(),

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
    const p = App.project;
    const row = (s, kit) => U.el('div.smp', {
      draggable: true, title: 'Drag onto the playlist · double-click to add at the playhead',
      ondragstart: e => { e.dataTransfer.setData('text/x-sample', s.id); e.dataTransfer.effectAllowed = 'copy'; },
      ondblclick: () => App.addClips([s.id], Math.max(0, p.tracks.findIndex(t => t.id === App.selTrack)), Engine.position()),
    },
    U.el('button.smp-play', { html: ICON.play, title: 'Audition', onclick: e => { e.stopPropagation(); Engine.preview({ sampleId: s.id, vol: 0.9 }); } }),
    U.el('span.smp-name', { text: s.name }),
    U.el('span.smp-dur', { text: s.missing ? 'missing' : U.fmtDur(Engine.buffers.get(s.id) ? Engine.buffers.get(s.id).duration : 0) }),
    kit ? null : U.el('button.smp-x', { html: ICON.x, title: 'Remove from project', onclick: e => { e.stopPropagation(); App.removeSample(s); } }));

    this.pool.replaceChildren(
      U.el('div.pool-title', { text: 'Project' }),
      ...(p.samples.length ? p.samples.map(s => row(s, false)) : [U.el('div.pool-empty', { text: 'Drop WAV files here, or click Import.' })]),
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
      return U.el('div.strip' + (id === App.fxOwner ? '.sel' : ''), { data: { id }, style: { '--c': color }, onpointerdown: () => App.selectTrack(id) },
        U.el('div.s-name', { text: name, title: name }),
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
    const list = Engine.fxList(p, owner), name = owner === 'master' ? 'Master' : p.tracks.find(t => t.id === owner).name;

    const add = U.el('select.field.small', { onchange: e => { const type = e.target.value; if (type) App.fxEdit(owner, () => list.push(FX.make(type))); } },
      U.el('option', { value: '', text: '+ Add effect…' }),
      FX.order.map(t => U.el('option', { value: t, text: FX.defs[t].name })));

    const cards = list.map((fx, i) => {
      const def = FX.defs[fx.type];
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

    this.chain.replaceChildren(
      U.el('div.chain-head', null, U.el('b', { text: name }), U.el('span.dim', { text: ' effects — signal flows left to right' }), U.el('span.tb-grow'), add),
      U.el('div.fx-cards', null, cards.length ? cards : U.el('div.empty', { text: 'No effects on ' + name + '. Add EQ, compression, reverb, delay and more from the menu above.' })));
  },

  param(owner, fx, d) {
    const val = U.el('span.val', { text: FX.fmt(d, fx.p[d.k]) });
    const apply = v => { fx.p[d.k] = v; val.textContent = FX.fmt(d, v); Engine.updateFx(owner, fx); };
    let ctl;
    if (d.opts) {
      ctl = U.el('select.field.small', { onchange: e => { App.pushUndo(); apply(e.target.value); App.touch(); } },
        d.opts.map(o => U.el('option', { value: o, text: o, selected: o === fx.p[d.k] })));
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

  /* ---------- clip inspector ---------- */

  syncClip() { if (App.tab === 'clip') this.renderClip(); },

  renderClip() {
    const p = App.project, sel = p.clips.filter(c => App.sel.has(c.id));
    const act = (text, fn, cls) => U.el('button.btn.small' + (cls || ''), { text, onclick: fn });
    const common = [
      act('Split at playhead', () => App.splitAtPlayhead()),
      act('Duplicate', () => App.duplicateSelected()),
      act('Normalize', () => App.eachSelected(c => App.normalizeClip(c))),
      act('Delete', () => App.deleteSelected(), '.danger'),
    ];
    if (!sel.length) {
      return this.clip.replaceChildren(U.el('div.empty.pad', { text: 'Select a clip in the playlist to edit its gain, pitch, fades and direction. Drag clip edges to trim, drag the body to move, and use the Slice tool or S to cut.' }));
    }
    if (sel.length > 1) {
      return this.clip.replaceChildren(U.el('div.clip-ed', null,
        U.el('div.clip-info', null, U.el('b', { text: sel.length + ' clips selected' })),
        U.el('div.clip-actions', null, act('Reverse', () => App.eachSelected(c => App.reverseClip(c))), act('Mute / unmute', () => App.eachSelected(c => { c.mute = !c.mute; })), ...common)));
    }

    const c = sel[0], dur = c.len / c.rate, meta = App.sampleMeta(c.sampleId);
    const redraw = () => { App.clampFades(c); Playlist.layout(); Playlist.draw(); };
    const row = (label, slider, val) => U.el('label.fx-param', null, U.el('span.lbl', { text: label }), slider, val);
    const mk = (label, o, fmt, set) => {
      const val = U.el('span.val', { text: fmt(o.value) });
      return row(label, UI.slider({ ...o, oninput: v => { set(v); val.textContent = fmt(v); redraw(); }, onchange: () => { App.clipsChanged(); if (o.rerender) this.renderClip(); } }), val);
    };
    const st = Math.round(12 * Math.log2(c.rate) * 10) / 10;

    this.clip.replaceChildren(U.el('div.clip-ed', null,
      U.el('div.clip-info', null,
        U.el('input.field', { value: c.name, spellcheck: false, title: 'Clip name', onchange: e => App.edit(() => { c.name = e.target.value.trim() || c.name; }, 'timeline') }),
        U.el('div.dim', { text: 'Source: ' + (meta ? meta.name : 'missing') }),
        U.el('div.dim', { text: 'Start ' + U.fmtTime(c.start) + '  ·  Length ' + U.fmtTime(dur) }),
        U.el('div.clip-toggles', null,
          U.el('button.btn.small' + (c.reverse ? '.on' : ''), { text: 'Reverse', onclick: () => App.eachSelected(k => App.reverseClip(k)) }),
          U.el('button.btn.small' + (c.mute ? '.on' : ''), { text: 'Mute', onclick: () => App.eachSelected(k => { k.mute = !k.mute; }) }))),
      U.el('div.clip-sliders', null,
        mk('Gain', { min: -24, max: 18, step: 0.5, value: Math.max(-24, Math.round(U.gainToDb(c.gain) * 2) / 2), def: 0 },
          v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB', v => { c.gain = U.dbToGain(v); }),
        mk('Pitch / speed', { min: -12, max: 12, step: 1, value: st, def: 0, rerender: true },
          v => (v > 0 ? '+' : '') + v + ' st', v => { c.rate = Math.pow(2, v / 12); }),
        mk('Fade in', { min: 0, max: Math.max(0.01, dur), step: 0.01, value: c.fadeIn, def: 0 },
          v => v.toFixed(2) + ' s', v => { c.fadeIn = Math.min(v, c.len / c.rate - c.fadeOut); }),
        mk('Fade out', { min: 0, max: Math.max(0.01, dur), step: 0.01, value: c.fadeOut, def: 0 },
          v => v.toFixed(2) + ' s', v => { c.fadeOut = Math.min(v, c.len / c.rate - c.fadeIn); })),
      U.el('div.clip-actions', null, common)));
  },
};
