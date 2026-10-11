'use strict';

const COLORS = ['#ff8a2a', '#4fc3f7', '#7bd88f', '#e57cd8', '#f6d55c', '#ff6b6b', '#9d8cff', '#4dd0b5'];
const ALL_PARTS = 'heads,timeline,rack,mixer,clip,pool,top';

const App = {
  project: null,
  undoStack: [], redoStack: [],
  sel: new Set(),       // selected clip ids
  selTrack: null,
  fxOwner: 'master',    // strip whose effect chain is shown
  tool: 'select',
  tab: 'rack',
  clipboard: null,

  async init() {
    Home.init(); Playlist.init(); Rack.init(); Panels.init();
    this.bindTop();
    this.bindKeys();
    this.save = U.debounce(() => this.saveNow(), 700);
    window.addEventListener('beforeunload', () => { if (this.project && this.dirty) this.saveNow(); });
    document.addEventListener('mouseover', e => {
      const t = e.target.closest && e.target.closest('[title]');
      $('#hint').textContent = t ? t.title : '';
    });
    await Home.show();
    requestAnimationFrame(() => this.frame());
  },

  /* ---------- project lifecycle ---------- */

  newTrack(p, name) {
    return { id: U.uid('t'), name: name || 'Track ' + (p.tracks.length + 1), color: COLORS[p.tracks.length % COLORS.length], vol: 0.8, pan: 0, mute: false, solo: false, fx: [] };
  },

  newProject(name) {
    const pat = Rack.newPattern('Pattern 1', true);
    const p = {
      id: U.uid('proj'), name, created: Date.now(), modified: Date.now(),
      bpm: 128, swing: 0, metro: false, mode: 'song',
      loop: { on: false, start: 0, end: 0 },
      view: { pps: 60, snap: 1 },
      master: { vol: 0.9, fx: [] },
      tracks: [], clips: [], samples: [],
      patterns: [pat], curPat: pat.id,
    };
    for (let i = 0; i < 4; i++) p.tracks.push(this.newTrack(p));
    return p;
  },

  async open(id) {
    const p = await DB.get(id);
    if (!p) return UI.toast('Project not found', 'error');
    UI.busy('Loading project…');
    try {
      Engine.ensure();
      for (const s of p.samples) {
        delete s.missing;
        if (Engine.buffers.has(s.id)) continue;
        const rec = await DB.getAudio(s.id);
        try { Engine.buffers.set(s.id, await Engine.decode(rec.bytes)); } catch (e) { s.missing = true; }
      }
      this.project = p;
      this.undoStack = []; this.redoStack = [];
      this.sel.clear();
      this.selTrack = p.tracks.length ? p.tracks[0].id : null;
      this.fxOwner = 'master';
      this.dirty = false;
      Engine.halt();
      Engine.pos = 0;
      Engine.setProject(p);
      $('#home').hidden = true;
      $('#studio').hidden = false;
      document.title = p.name + ' — Tapehead';
      Playlist.resize();
      Playlist.sc.scrollLeft = Playlist.sc.scrollTop = 0;
      this.refresh();
      this.setTab(this.tab);
      this.setSaveState('Saved');
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } finally {
      UI.busy(false);
    }
  },

  async close() {
    Engine.halt();
    this.save.cancel();
    if (this.dirty) await this.saveNow();
    this.project = null;
    Home.show();
  },

  touch() {
    if (!this.project) return;
    this.dirty = true;
    this.setSaveState('Saving…');
    this.save();
  },

  async saveNow() {
    const p = this.project;
    if (!p) return;
    p.modified = Date.now();
    this.dirty = false;
    try {
      await DB.put(p);
      if (!this.dirty) this.setSaveState('Saved');
    } catch (e) {
      this.dirty = true;
      this.setSaveState('Save failed');
      UI.toast('Could not save the project (browser storage may be full)', 'error');
    }
  },

  setSaveState(text) { $('#save-state').textContent = text; },

  /* ---------- undo ---------- */

  pushUndo() {
    this.undoStack.push(JSON.stringify(this.project));
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack.length = 0;
    this.syncUndo();
  },

  undo() { this.step(this.undoStack, this.redoStack); },
  redo() { this.step(this.redoStack, this.undoStack); },

  step(from, to) {
    if (!from.length) return;
    const cur = this.project;
    to.push(JSON.stringify(cur));
    const p = JSON.parse(from.pop());
    // view and transport settings are not part of the edit history
    p.view = cur.view; p.mode = cur.mode; p.loop = cur.loop; p.metro = cur.metro;
    if (p.patterns.some(x => x.id === cur.curPat)) p.curPat = cur.curPat;
    this.project = p;
    const ids = new Set(p.clips.map(c => c.id));
    this.sel = new Set([...this.sel].filter(id => ids.has(id)));
    if (!p.tracks.some(t => t.id === this.selTrack)) this.selTrack = p.tracks.length ? p.tracks[0].id : null;
    const was = Engine.playing, at = Engine.position();
    Engine.halt();
    Engine.pos = at;
    Engine.setProject(p);
    if (was) Engine.play();
    this.refresh();
    this.touch();
  },

  syncUndo() {
    $('#btn-undo').disabled = !this.undoStack.length;
    $('#btn-redo').disabled = !this.redoStack.length;
  },

  // Run a mutation as one undoable step, then refresh the given UI parts.
  edit(fn, parts, clips) {
    this.pushUndo();
    fn();
    Engine.syncMix();
    this.refresh(parts);
    this.touch();
    if (clips) this.clipsChanged();
  },

  clipsChanged() {
    Playlist.layout();
    Engine.resync();
    this.touch();
  },

  refresh(parts) {
    const s = new Set((parts == null ? ALL_PARTS : parts).split(','));
    if (s.has('heads')) Playlist.renderHeads();
    if (s.has('timeline')) { Playlist.layout(); Playlist.draw(); }
    if (s.has('rack')) Rack.render();
    if (s.has('mixer')) Panels.renderMixer();
    if (s.has('clip')) Panels.renderClip();
    if (s.has('pool')) Panels.renderPool();
    if (s.has('top')) this.syncTop();
  },

  /* ---------- top bar ---------- */

  bindTop() {
    $('#btn-home').onclick = () => this.close();
    $('#proj-name').onchange = e => {
      const p = this.project;
      p.name = e.target.value.trim() || p.name;
      e.target.value = p.name;
      document.title = p.name + ' — Tapehead';
      this.touch();
    };
    $('#proj-name').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
    $('#mode-seg').onclick = e => { if (e.target.dataset.mode) this.setMode(e.target.dataset.mode); };
    $('#tool-seg').onclick = e => { if (e.target.dataset.tool) this.setTool(e.target.dataset.tool); };
    $('#btn-play').onclick = () => this.togglePlay();
    $('#btn-stop').onclick = () => Engine.stop();
    $('#btn-loop').onclick = () => {
      const p = this.project, l = p.loop;
      if (!l.on && l.end <= l.start) {
        const bar = 240 / p.bpm, end = Engine.songEnd(p);
        l.start = 0; l.end = end > 0 ? Math.ceil(end / bar - 1e-6) * bar : bar * 4;
      }
      l.on = !l.on;
      this.syncTop(); Playlist.draw(); this.touch();
    };
    $('#btn-metro').onclick = () => { this.project.metro = !this.project.metro; this.syncTop(); this.touch(); };
    $('#bpm').onchange = e => {
      const v = U.clamp(Math.round(+e.target.value) || this.project.bpm, 40, 300);
      e.target.value = v;
      if (v === this.project.bpm) return;
      this.edit(() => { this.project.bpm = v; }, 'timeline');
      Engine.rebuildAllFx();
      Engine.resync();
    };
    $('#snap').onchange = e => { this.project.view.snap = +e.target.value; this.touch(); };
    $('#btn-undo').onclick = () => this.undo();
    $('#btn-redo').onclick = () => this.redo();
    $('#btn-export').onclick = () => this.exportDialog();
    $('#btn-automix').onclick = () => AutoMix.dialog();

    const mv = $('#master-vol');
    let fresh = true;
    mv.oninput = () => { if (fresh) { this.pushUndo(); fresh = false; } this.project.master.vol = +mv.value; this.mixChanged('master', mv); };
    mv.onchange = () => { fresh = true; this.touch(); };

    $('#tabs').onclick = e => { if (e.target.dataset.tab) this.setTab(e.target.dataset.tab); };

    // drag the top edge of the bottom panel to resize it
    const grip = $('#bottom-grip'), bottom = $('#bottom');
    grip.onpointerdown = e => {
      grip.setPointerCapture(e.pointerId);
      const y0 = e.clientY, h0 = bottom.offsetHeight;
      grip.onpointermove = m => { bottom.style.height = U.clamp(h0 + y0 - m.clientY, 110, innerHeight * 0.7) + 'px'; };
      grip.onpointerup = () => { grip.onpointermove = grip.onpointerup = null; };
    };
  },

  syncTop() {
    const p = this.project;
    $('#proj-name').value = p.name;
    $('#bpm').value = p.bpm;
    $('#snap').value = String(p.view.snap);
    $('#master-vol').value = p.master.vol;
    $('#btn-loop').classList.toggle('on', p.loop.on);
    $('#btn-metro').classList.toggle('on', p.metro);
    for (const b of $('#mode-seg').children) b.classList.toggle('on', b.dataset.mode === p.mode);
    for (const b of $('#tool-seg').children) b.classList.toggle('on', b.dataset.tool === this.tool);
    this.syncUndo();
  },

  setTab(tab) {
    this.tab = tab;
    for (const b of $('#tabs').querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
    for (const t of ['rack', 'mixer', 'clip']) $('#tab-' + t).hidden = t !== tab;
    if (tab === 'clip') Panels.renderClip();
  },

  setTool(tool) {
    this.tool = tool;
    Playlist.sliceX = null;
    this.syncTop();
    Playlist.draw();
  },

  setMode(mode) {
    const p = this.project;
    Engine.pause();
    p.mode = Engine.mode = mode;
    this.syncTop();
    this.touch();
  },

  togglePlay() {
    if (Engine.playing) Engine.pause();
    else Engine.play();
  },

  seek(t) { Engine.seek(t); },

  /* ---------- tracks & mixer ---------- */

  selectTrack(id) {
    const selTrack = id === 'master' ? this.selTrack : id;
    if (selTrack === this.selTrack && id === this.fxOwner) return;
    this.selTrack = selTrack;
    this.fxOwner = id;
    for (const h of document.querySelectorAll('.head')) h.classList.toggle('sel', h.dataset.id === this.selTrack);
    for (const s of document.querySelectorAll('.strip')) s.classList.toggle('sel', s.dataset.id === id);
    Playlist.draw();
    Panels.renderChain();
  },

  // A volume/pan control moved: update the engine and mirror the value on the other controls.
  mixChanged(id, src) {
    Engine.syncMix();
    const p = this.project, o = id === 'master' ? p.master : p.tracks.find(t => t.id === id);
    const set = (sel, v) => { for (const n of document.querySelectorAll(sel)) if (n !== src) n.value = v; };
    if (id === 'master') return set('#master-vol, .strip[data-id="master"] .vfader', o.vol);
    set('.head[data-id="' + id + '"] .h-vol, .strip[data-id="' + id + '"] .vfader', o.vol);
    set('.head[data-id="' + id + '"] .h-pan', o.pan);
  },

  addTrack(name) {
    const p = this.project;
    let t;
    this.edit(() => { t = this.newTrack(p, name); p.tracks.push(t); }, 'heads,timeline,mixer');
    return t;
  },

  duplicateTrack(t) {
    const p = this.project;
    this.edit(() => {
      const n = JSON.parse(JSON.stringify(t));
      n.id = U.uid('t'); n.name = t.name + ' copy';
      n.fx.forEach(f => { f.id = U.uid('f'); });
      p.tracks.splice(p.tracks.indexOf(t) + 1, 0, n);
      for (const c of p.clips.filter(c => c.trackId === t.id)) p.clips.push({ ...c, id: U.uid('c'), trackId: n.id });
    }, 'heads,timeline,mixer', true);
  },

  deleteTrack(id) {
    const p = this.project;
    this.edit(() => {
      p.tracks = p.tracks.filter(t => t.id !== id);
      p.clips = p.clips.filter(c => c.trackId !== id);
      const ids = new Set(p.clips.map(c => c.id));
      this.sel = new Set([...this.sel].filter(x => ids.has(x)));
      if (this.selTrack === id) this.selTrack = p.tracks.length ? p.tracks[0].id : null;
      if (this.fxOwner === id) this.fxOwner = 'master';
    }, 'heads,timeline,mixer,clip', true);
  },

  // Structural change to an effect chain (add / remove / reorder / bypass).
  fxEdit(owner, fn) {
    this.pushUndo();
    fn();
    Engine.rebuildFx(owner);
    this.refresh('heads,mixer');
    this.touch();
  },

  /* ---------- samples & clips ---------- */

  sampleMeta(id) { return this.project.samples.find(s => s.id === id) || Kit.list.find(k => k.id === id); },

  async importFiles(fileList) {
    const files = [...fileList], p = this.project, added = [];
    if (!files.length) return added;
    UI.busy('Importing audio…');
    for (const f of files) {
      try {
        const bytes = await f.arrayBuffer(), buf = await Engine.decode(bytes), id = U.uid('s');
        await DB.putAudio(id, { bytes, name: f.name });
        Engine.buffers.set(id, buf);
        added.push({ id, name: f.name.replace(/\.[^.]+$/, ''), dur: buf.duration, ch: buf.numberOfChannels, sr: buf.sampleRate });
      } catch (e) {
        UI.toast('Could not read “' + f.name + '” — is it an audio file?', 'error');
      }
    }
    UI.busy(false);
    if (added.length) this.edit(() => p.samples.push(...added), 'pool,rack');
    return added;
  },

  async removeSample(s) {
    const p = this.project, used = p.clips.filter(c => c.sampleId === s.id).length;
    if (used && !await UI.confirm('Remove sample', '“' + s.name + '” is used by ' + used + ' clip' + (used > 1 ? 's' : '') + ' in the playlist. Remove it and those clips?', 'Remove', true)) return;
    this.edit(() => {
      p.samples = p.samples.filter(x => x.id !== s.id);
      p.clips = p.clips.filter(c => c.sampleId !== s.id);
      for (const pat of p.patterns) pat.channels = pat.channels.filter(ch => ch.sampleId !== s.id);
      const ids = new Set(p.clips.map(c => c.id));
      this.sel = new Set([...this.sel].filter(x => ids.has(x)));
    }, null, true);
  },

  makeClip(sampleId, trackId, start) {
    const buf = Engine.buffers.get(sampleId), meta = this.sampleMeta(sampleId);
    return { id: U.uid('c'), trackId, sampleId, name: meta ? meta.name : 'Clip', start, offset: 0, len: buf.duration, rate: 1, gain: 1, fadeIn: 0, fadeOut: 0, reverse: false, mute: false };
  },

  // Place samples at time t, one per track starting at the given row (tracks are created as needed).
  addClips(sampleIds, row, t) {
    const p = this.project, ids = sampleIds.filter(id => Engine.buffers.has(id));
    if (!ids.length) return;
    this.edit(() => {
      this.sel.clear();
      row = U.clamp(row, 0, p.tracks.length);
      ids.forEach((id, i) => {
        let tr = p.tracks[row + i];
        if (!tr) { tr = this.newTrack(p); p.tracks.push(tr); }
        const c = this.makeClip(id, tr.id, Math.max(0, t));
        p.clips.push(c);
        this.sel.add(c.id);
        this.selTrack = this.fxOwner = tr.id;
      });
    }, 'heads,timeline,mixer,clip', true);
  },

  selected() { return this.project.clips.filter(c => this.sel.has(c.id)); },

  eachSelected(fn) {
    if (this.sel.size) this.edit(() => this.selected().forEach(fn), 'timeline,clip', true);
  },

  clampFades(c) {
    const dur = c.len / c.rate;
    c.fadeIn = U.clamp(c.fadeIn, 0, dur);
    c.fadeOut = U.clamp(c.fadeOut, 0, dur - c.fadeIn);
  },

  reverseClip(c) {
    const buf = Engine.buffers.get(c.sampleId);
    if (!buf) return;
    c.reverse = !c.reverse;
    c.offset = Math.max(0, buf.duration - (c.offset + c.len));
  },

  normalizeClip(c) {
    const peak = Engine.peakOf(c.sampleId, c.reverse, c.offset, c.len);
    if (peak > 0.0005) c.gain = Math.min(8, 0.98 / peak);
  },

  splitClips(clips, t) {
    const p = this.project, hits = clips.filter(c => t > c.start + 0.005 && t < c.start + c.len / c.rate - 0.005);
    if (!hits.length) return;
    this.edit(() => {
      for (const c of hits) {
        const cut = (t - c.start) * c.rate;
        const right = { ...c, id: U.uid('c'), start: t, offset: c.offset + cut, len: c.len - cut, fadeIn: 0 };
        c.len = cut; c.fadeOut = 0;
        this.clampFades(c); this.clampFades(right);
        p.clips.push(right);
        if (this.sel.has(c.id)) this.sel.add(right.id);
      }
    }, 'timeline,clip', true);
  },

  splitAtPlayhead() {
    const t = Engine.position();
    this.splitClips(this.sel.size ? this.selected() : this.project.clips, t);
  },

  deleteSelected() {
    const p = this.project;
    if (!this.sel.size) return;
    this.edit(() => { p.clips = p.clips.filter(c => !this.sel.has(c.id)); this.sel.clear(); }, 'timeline,clip', true);
  },

  duplicateSelected() {
    const p = this.project, src = this.selected();
    if (!src.length) return;
    const a = Math.min(...src.map(c => c.start)), b = Math.max(...src.map(c => c.start + c.len / c.rate));
    this.edit(() => {
      this.sel.clear();
      for (const c of src) { const n = { ...c, id: U.uid('c'), start: c.start + (b - a) }; p.clips.push(n); this.sel.add(n.id); }
    }, 'timeline,clip', true);
  },

  copy() {
    const src = this.selected();
    if (src.length) { this.clipboard = JSON.parse(JSON.stringify(src)); UI.toast(src.length + (src.length > 1 ? ' clips' : ' clip') + ' copied'); }
  },

  paste() {
    const p = this.project, cb = this.clipboard;
    if (!cb || !cb.length || !p.tracks.length) return;
    const a = Math.min(...cb.map(c => c.start)), at = Playlist.snap(Engine.position());
    this.edit(() => {
      this.sel.clear();
      for (const c of cb) {
        if (!Engine.buffers.has(c.sampleId)) continue;
        const trackId = p.tracks.some(t => t.id === c.trackId) ? c.trackId : (this.selTrack || p.tracks[0].id);
        const n = { ...c, id: U.uid('c'), trackId, start: at + c.start - a };
        p.clips.push(n);
        this.sel.add(n.id);
      }
    }, 'timeline,clip', true);
  },

  /* ---------- beat -> playlist ---------- */

  async bouncePattern(repeats) {
    const p = this.project, pat = Engine.curPattern(p);
    if (!pat.channels.some(ch => !ch.mute && ch.steps.slice(0, pat.steps).some(Boolean))) return UI.toast('This pattern has no steps yet — click some steps first');
    const { buf, loopLen } = await Engine.renderPattern(p, pat, repeats);
    const id = U.uid('s'), name = pat.name + (repeats > 1 ? ' ×' + repeats : '');
    await DB.putAudio(id, { bytes: U.encodeWav([buf.getChannelData(0), buf.getChannelData(1)], buf.sampleRate, 32), name });
    Engine.buffers.set(id, buf);

    const bar = 240 / p.bpm;
    let at;
    this.edit(() => {
      p.samples.push({ id, name, dur: buf.duration, ch: 2, sr: buf.sampleRate });
      let tr = p.tracks.find(t => t.name === 'Beats');
      if (!tr) { tr = this.newTrack(p, 'Beats'); p.tracks.push(tr); }
      // drop it at the playhead's bar, or after the last beat clip if that spot is taken
      const mine = p.clips.filter(c => c.trackId === tr.id);
      at = Math.floor(Engine.position() / bar + 1e-6) * bar;
      if (mine.some(c => c.start < at + loopLen - 0.001 && c.start + c.len / c.rate > at + 0.001)) {
        at = Math.ceil(Math.max(...mine.map(c => c.start + c.len / c.rate)) / bar - 1e-6) * bar;
      }
      const c = this.makeClip(id, tr.id, at);
      c.len = loopLen;   // hide the rendered tail so repeats butt together cleanly
      p.clips.push(c);
      this.sel = new Set([c.id]);
      this.selTrack = tr.id;
    }, null, true);
    UI.toast('“' + name + '” added to the Beats track at bar ' + (Math.round(at / bar) + 1) + ' — switch to SONG to hear it in the mix');
  },

  /* ---------- export ---------- */

  exportDialog() {
    const p = this.project, end = Engine.songEnd(p);
    if (end <= 0) return UI.toast('Nothing to export yet — add clips to the playlist (use “Add to playlist” for beats)');
    const hasLoop = p.loop.end > p.loop.start + 0.05;
    const f = {
      name: U.el('input.field', { type: 'text', value: p.name, spellcheck: false }),
      range: U.el('select.field', null, U.el('option', { value: 'song', text: 'Whole song (' + U.fmtTime(end) + ')' }),
        hasLoop ? U.el('option', { value: 'loop', text: 'Loop region (' + U.fmtTime(p.loop.end - p.loop.start) + ')' }) : null),
      sr: U.el('select.field', null, [44100, 48000, 96000].map(r => U.el('option', { value: r, text: r / 1000 + ' kHz', selected: r === 44100 }))),
      bits: U.el('select.field', null, U.el('option', { value: 16, text: '16-bit PCM' }), U.el('option', { value: 24, text: '24-bit PCM', selected: true }), U.el('option', { value: 32, text: '32-bit float' })),
      tail: U.el('input.field', { type: 'number', min: 0, max: 30, step: 0.5, value: 2 }),
      norm: U.el('input', { type: 'checkbox' }),
    };
    const row = (label, ctl) => U.el('label.form-row', null, U.el('span', { text: label }), ctl);
    const status = U.el('div.dim.form-status');
    UI.modal({
      title: 'Export WAV',
      body: U.el('div.form', null,
        row('File name', f.name), row('Range', f.range), row('Sample rate', f.sr), row('Bit depth', f.bits),
        row('Effect tail (seconds)', f.tail), row('Normalize peak to −0.3 dB', f.norm), status),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Render & download', kind: 'accent', onclick: async (close, btn) => {
            btn.disabled = true;
            status.textContent = 'Rendering…';
            try {
              const loop = f.range.value === 'loop', bits = +f.bits.value, sampleRate = +f.sr.value;
              const buf = await Engine.renderSong(p, {
                sampleRate, from: loop ? p.loop.start : 0, to: loop ? p.loop.end : end,
                tail: U.clamp(+f.tail.value || 0, 0, 30),
              });
              const ch = [buf.getChannelData(0), buf.getChannelData(1)];
              let peak = 0;
              for (const d of ch) for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; }
              if (f.norm.checked && peak > 0) {
                const k = U.dbToGain(-0.3) / peak;
                for (const d of ch) for (let i = 0; i < d.length; i++) d[i] *= k;
              }
              const file = (f.name.value.trim() || 'export').replace(/[\\/:*?"<>|]/g, '_') + '.wav';
              U.download(new Blob([U.encodeWav(ch, sampleRate, bits)], { type: 'audio/wav' }), file);
              close();
              if (!f.norm.checked && bits !== 32 && peak > 1) UI.toast('Exported, but the mix peaks ' + U.gainToDb(peak).toFixed(1) + ' dB over full scale and was clipped. Lower the master or enable Normalize.', 'error');
              else UI.toast('Exported ' + file);
            } catch (e) {
              console.error(e);
              btn.disabled = false;
              status.textContent = 'Export failed: ' + e.message;
            }
          },
        },
      ],
    });
  },

  /* ---------- keyboard ---------- */

  bindKeys() {
    const typing = t => t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox');
    document.addEventListener('keyup', e => { if (e.key === ' ' && this.project && !typing(e.target)) e.preventDefault(); });
    document.addEventListener('keydown', e => {
      if (!this.project || $('#overlay').childElementCount || !$('#busy').hidden || typing(e.target)) return;
      const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
      let ok = true;
      if (k === ' ') this.togglePlay();
      else if (mod && k === 'z') e.shiftKey ? this.redo() : this.undo();
      else if (mod && k === 'y') this.redo();
      else if (mod && k === 'c') this.copy();
      else if (mod && k === 'x') { this.copy(); this.deleteSelected(); }
      else if (mod && k === 'v') this.paste();
      else if (mod && k === 'd') this.duplicateSelected();
      else if (mod && k === 'a') { this.sel = new Set(this.project.clips.map(c => c.id)); this.refresh('timeline,clip'); }
      else if (mod && k === 's') { this.save.cancel(); this.saveNow().then(() => UI.toast('Project saved')); }
      else if (mod) ok = false;
      else if (k === 'delete' || k === 'backspace') this.deleteSelected();
      else if (k === 's') this.splitAtPlayhead();
      else if (k === 'v') this.setTool('select');
      else if (k === 'c') this.setTool('slice');
      else if (k === 't') this.setTool('mute');
      else if (k === 'd') this.setTool('delete');
      else if (k === 'home') this.seek(0);
      else if (k === '=' || k === '+') Playlist.zoom(1.4);
      else if (k === '-') Playlist.zoom(1 / 1.4);
      else if (k === 'escape') { this.sel.clear(); this.refresh('timeline,clip'); }
      else ok = false;
      if (ok) e.preventDefault();
    });
  },

  /* ---------- per-frame UI ---------- */

  frame() {
    requestAnimationFrame(() => this.frame());
    const p = this.project;
    if (!p || !Engine.graph) return;
    const pos = Engine.position(), song = Engine.playing && Engine.mode === 'song';
    if (song) Playlist.follow(pos);
    Playlist.updatePlayhead(pos);
    if (pos !== this._pos) {
      this._pos = pos;
      const beats = pos / (60 / p.bpm) + 1e-6;
      $('#lcd-time').textContent = U.fmtTime(pos);
      $('#lcd-bar').textContent = (Math.floor(beats / 4) + 1) + '.' + (Math.floor(beats % 4) + 1);
    }
    if (Engine.playing !== this._playing) {
      this._playing = Engine.playing;
      const b = $('#btn-play');
      b.innerHTML = Engine.playing ? ICON.pause : ICON.play;
      b.classList.toggle('on', Engine.playing);
    }
    Rack.highlight(Engine.playing && Engine.mode === 'pat' ? Engine.currentStep() : -1);

    this.meter($('#master-meter').getContext('2d'), Engine.level(Engine.graph.master), true);
    for (const [id, strip] of Engine.graph.tracks) {
      const lv = Engine.level(strip), a = Playlist.meters.get(id), b = Panels.meters.get(id);
      if (a) this.meter(a, lv);
      if (b && this.tab === 'mixer') this.meter(b, lv);
    }
    const mm = Panels.meters.get('master');
    if (mm && this.tab === 'mixer') this.meter(mm, Engine.graph.master.level);
  },

  meter(g, lv, horizontal) {
    const W = g.canvas.width, H = g.canvas.height, v = Math.min(1, lv), col = lv > 1 ? '#ff5d5d' : lv > 0.86 ? '#f6d55c' : '#6fdc8c';
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(0, 0, W, H);
    g.fillStyle = col;
    if (horizontal) g.fillRect(0, 0, W * v, H);
    else g.fillRect(0, H * (1 - v), W, H * v);
  },
};

App.init();
