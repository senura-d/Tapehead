'use strict';

// Second half of the app: project upgrades, stretching, pattern clips, buses, markers,
// recording, project files, stems / MP3, kits, presets, help. Loaded last; starts the app.

Object.assign(App, {
  // Bring a project saved by an older version up to the current shape. Never removes anything.
  migrate(p) {
    p.v = 2;
    p.markers = p.markers || [];
    for (const t of p.tracks) {
      t.bus = !!t.bus;
      t.out = t.out || null;
      t.send = t.send || { to: null, amt: 0.5 };
      t.auto = t.auto || { vol: [], pan: [] };
    }
    for (const c of p.clips) { c.kind = c.kind || 'audio'; c.env = c.env || []; }
    for (const pat of p.patterns) {
      for (const ch of pat.channels) { ch.rolls = ch.rolls || new Array(Rack.MAX).fill(1); ch.notes = ch.notes || []; }
    }
    return p;
  },

  visibleSamples() { return this.project.samples.filter(s => !s.hidden); },

  mainMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    UI.menu(r.left, r.bottom + 4, [
      { label: 'Back to projects', onclick: () => this.close() },
      '-',
      { label: 'Save project file (.tapehead)…', onclick: () => ProjectFile.exportProject(this.project) },
      { label: 'Export stems (one WAV per track)…', onclick: () => ProjectFile.stems() },
      '-',
      { label: 'Keyboard shortcuts', onclick: () => Extras.shortcuts() },
      { label: 'Show the walkthrough', onclick: () => Extras.tour() },
    ]);
  },

  addBus() {
    const p = this.project;
    this.edit(() => {
      const t = this.newTrack(p, 'Bus ' + (p.tracks.filter(x => x.bus).length + 1));
      t.bus = true; t.color = '#9d8cff';
      p.tracks.push(t);
    }, 'heads,timeline,mixer');
  },

  addMarker(t) {
    const p = this.project;
    UI.prompt('New marker', ['Intro', 'Verse', 'Chorus', 'Drop', 'Bridge', 'Outro'][p.markers.length] || 'Marker ' + (p.markers.length + 1), 'Add').then(name => {
      if (name) this.edit(() => { p.markers.push({ id: U.uid('m'), t: Math.max(0, t), name }); }, 'timeline');
    });
  },

  // Fade each selected clip into / out of the clips it overlaps on the same track.
  crossfade() {
    const p = this.project, sel = this.selected(), dur = c => c.len / c.rate;
    const pairs = [];
    for (const c of sel) {
      for (const o of p.clips) {
        if (o === c || o.trackId !== c.trackId) continue;
        const [a, b] = c.start <= o.start ? [c, o] : [o, c], ov = a.start + dur(a) - b.start;
        if (ov > 0.005 && b.start > a.start && !pairs.some(x => x[0] === a && x[1] === b)) pairs.push([a, b, ov]);
      }
    }
    if (!pairs.length) return UI.toast(sel.length ? 'The selected clips do not overlap another clip on their track' : 'Select a clip that overlaps another one first');
    this.edit(() => {
      for (const [a, b, ov] of pairs) {
        a.fadeOut = Math.min(ov, dur(a) - a.fadeIn);
        b.fadeIn = Math.min(ov, dur(b) - b.fadeOut);
      }
    }, 'timeline,clip', true);
    UI.toast(pairs.length + (pairs.length > 1 ? ' crossfades' : ' crossfade') + ' created');
  },

  // Where a new beat clip goes: the Beats track, at the playhead's bar or after the last clip there.
  beatSlot(len) {
    const p = this.project, bar = 240 / p.bpm;
    let tr = p.tracks.find(t => t.name === 'Beats' && !t.bus);
    if (!tr) { tr = this.newTrack(p, 'Beats'); p.tracks.push(tr); }
    const mine = p.clips.filter(c => c.trackId === tr.id);
    let at = Math.floor(Engine.position() / bar + 1e-6) * bar;
    if (mine.some(c => c.start < at + len - 0.001 && c.start + c.len / c.rate > at + 0.001)) {
      at = Math.ceil(Math.max(...mine.map(c => c.start + c.len / c.rate)) / bar - 1e-6) * bar;
    }
    return { tr, at, bar };
  },

  // Put the current pattern on the playlist as a live clip that follows later edits to the pattern.
  addPatternClip(repeats) {
    const p = this.project, pat = Engine.curPattern(p), len = pat.steps * (60 / p.bpm / 4) * repeats;
    let at, bar;
    this.edit(() => {
      const slot = this.beatSlot(len);
      at = slot.at; bar = slot.bar;
      const c = { id: U.uid('c'), kind: 'pattern', patId: pat.id, trackId: slot.tr.id, name: pat.name, start: at, offset: 0, len, rate: 1, gain: 1, fadeIn: 0, fadeOut: 0, reverse: false, mute: false, env: [] };
      p.clips.push(c);
      this.sel = new Set([c.id]);
      this.selTrack = slot.tr.id;
    }, null, true);
    UI.toast('“' + pat.name + '” added to the Beats track at bar ' + (Math.round(at / bar) + 1) + ' — switch to SONG to hear it in the mix');
  },

  // Change a clip's length without changing pitch (time) and/or its pitch without changing length (semis).
  // The stretched audio is rendered once and stored like any other sample.
  async retime(c, time, semis) {
    const p = this.project, orig = c.orig || c.sampleId, src = Engine.buffers.get(orig), meta = this.sampleMeta(orig);
    if (!src || c.kind === 'pattern') return;
    time = U.clamp(time, 0.25, 4);
    const plain = Math.abs(time - 1) < 1e-3 && !semis, id = plain ? orig : orig + '~' + time.toFixed(4) + '_' + semis;
    if (!Engine.buffers.has(id)) {
      UI.busy('Stretching audio…');
      await new Promise(r => setTimeout(r, 40));
      try {
        const buf = await Stretch.make(src, time, semis), chs = [];
        for (let i = 0; i < buf.numberOfChannels; i++) chs.push(buf.getChannelData(i));
        await DB.putAudio(id, { bytes: U.encodeWav(chs, buf.sampleRate, 32), name: (meta ? meta.name : 'audio') + ' (stretched)' });
        Engine.buffers.set(id, buf);
      } catch (e) {
        console.error(e);
        return UI.toast('Could not stretch this clip: ' + e.message, 'error');
      } finally {
        UI.busy(false);
      }
    }
    const k = time / (c.ts || 1), buf = Engine.buffers.get(id);
    this.edit(() => {
      if (!plain && !p.samples.some(s => s.id === id)) p.samples.push({ id, name: meta ? meta.name : 'audio', dur: buf.duration, ch: buf.numberOfChannels, sr: buf.sampleRate, hidden: true });
      c.sampleId = id; c.orig = orig; c.ts = time; c.ps = semis;
      c.offset = Math.min(c.offset * k, Math.max(0, buf.duration - 0.01));
      c.len = Math.min(c.len * k, buf.duration - c.offset);
      c.fadeIn *= k; c.fadeOut *= k;
      for (const pt of c.env) pt.t *= k;
      this.clampFades(c);
    }, 'timeline,clip', true);
  },

  /* ---------- microphone recording ---------- */

  async toggleRecord() {
    if (this.rec) return this.stopRecord();
    const p = this.project, ctx = Engine.ensure();
    await Engine.ready;
    if (!ctx._tp || !navigator.mediaDevices) return UI.toast('Recording is not available here', 'error');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      return UI.toast('Could not open the microphone: ' + e.message, 'error');
    }
    const src = ctx.createMediaStreamSource(stream), node = new AudioWorkletNode(ctx, 'tp-recorder', { numberOfInputs: 1, numberOfOutputs: 1 }), mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    const chunks = [];
    node.port.onmessage = e => chunks.push(e.data);
    if (Engine.mode !== 'song') this.setMode('song');
    Engine.recording = true;
    if (!Engine.playing) Engine.play();
    const tr = p.tracks.find(t => t.id === this.selTrack && !t.bus);
    this.rec = { stream, src, node, mute, chunks, start: Engine.position(), trackId: tr ? tr.id : null };
    $('#btn-rec').classList.add('on');
    UI.toast('Recording — press the record button or R to stop');
  },

  async stopRecord() {
    const r = this.rec, p = this.project, ctx = Engine.ctx;
    this.rec = null;
    Engine.recording = false;
    Engine.pause();
    $('#btn-rec').classList.remove('on');
    r.node.port.onmessage = null;
    r.src.disconnect(); r.node.disconnect(); r.mute.disconnect();
    r.stream.getTracks().forEach(t => t.stop());
    const total = r.chunks.reduce((n, c) => n + c[0].length, 0);
    if (!total) return UI.toast('Nothing was recorded', 'error');
    const nCh = Math.min(2, r.chunks[0].length), buf = ctx.createBuffer(nCh, total, ctx.sampleRate), chs = [];
    for (let c = 0; c < nCh; c++) {
      const d = buf.getChannelData(c);
      let o = 0;
      for (const ck of r.chunks) { d.set(ck[c] || ck[0], o); o += ck[0].length; }
      chs.push(d);
    }
    const id = U.uid('s'), name = 'Recording ' + (p.samples.filter(s => /^Recording /.test(s.name)).length + 1);
    await DB.putAudio(id, { bytes: U.encodeWav(chs, ctx.sampleRate, 32), name });
    Engine.buffers.set(id, buf);
    // what was played back reached the ears late, so shift the take earlier by the output latency
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    this.edit(() => {
      p.samples.push({ id, name, dur: buf.duration, ch: nCh, sr: ctx.sampleRate });
      let tr = p.tracks.find(t => t.id === r.trackId);
      if (!tr) { tr = this.newTrack(p, 'Recording'); p.tracks.push(tr); }
      const c = this.makeClip(id, tr.id, Math.max(0, r.start - lat));
      p.clips.push(c);
      this.sel = new Set([c.id]);
    }, null, true);
  },
});

/* ---------- project files, stems, MP3 ---------- */

const ProjectFile = {
  safeName(n) { return (n || 'project').replace(/[\\/:*?"<>|]/g, '_'); },

  // .tapehead = "TPHD" + version byte + JSON length (uint32) + JSON {project, audio index} + the audio files back to back
  async exportProject(p) {
    UI.busy('Packing project…');
    try {
      if (p === App.project) { App.save.cancel(); await App.saveNow(); }
      const audio = [], parts = [];
      for (const s of p.samples) {
        const rec = await DB.getAudio(s.id);
        if (!rec) continue;
        audio.push({ id: s.id, name: rec.name, size: rec.bytes.byteLength });
        parts.push(rec.bytes);
      }
      const json = new TextEncoder().encode(JSON.stringify({ format: 'tapehead-project', version: 1, project: p, audio }));
      const head = new DataView(new ArrayBuffer(9));
      'TPHD'.split('').forEach((ch, i) => head.setUint8(i, ch.charCodeAt(0)));
      head.setUint8(4, 1);
      head.setUint32(5, json.length, true);
      U.download(new Blob([head, json, ...parts], { type: 'application/octet-stream' }), this.safeName(p.name) + '.tapehead');
      UI.toast('Project file saved — keep it somewhere safe as a backup');
    } finally {
      UI.busy(false);
    }
  },

  async importProject(file) {
    const buf = await file.arrayBuffer(), v = new DataView(buf);
    if (buf.byteLength < 9 || String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)) !== 'TPHD') throw new Error('this is not a Tapehead project file');
    if (v.getUint8(4) !== 1) throw new Error('this project file was made by a newer version of Tapehead');
    const n = v.getUint32(5, true), data = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 9, n)));
    let off = 9 + n;
    for (const a of data.audio) {
      await DB.putAudio(a.id, { bytes: buf.slice(off, off + a.size), name: a.name });
      off += a.size;
    }
    const p = App.migrate(data.project), names = new Set((await DB.list()).map(x => x.name));
    p.id = U.uid('proj');
    p.modified = Date.now();
    if (names.has(p.name)) p.name += ' (imported)';
    await DB.put(p);
    return p;
  },

  // Minimal ZIP writer (stored, no compression — WAV does not compress well anyway).
  zip(files) {
    const table = this._crc || (this._crc = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; } return t; })());
    const crc = d => { let c = -1; for (let i = 0; i < d.length; i++) c = table[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = new Uint8Array(f.data), sum = crc(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint32(14, sum, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, sum, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      parts.push(lh, name, data);
      central.push(ch, name);
      off += 30 + name.length + data.length;
    }
    const cSize = central.reduce((n, x) => n + x.byteLength, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cSize, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  },

  // One WAV per audible track: its own clips, effects, fader and pan — no bus or master processing.
  async stems() {
    const p = App.project, end = Engine.songEnd(p);
    const tracks = p.tracks.filter(t => !t.bus && !t.mute && p.clips.some(c => c.trackId === t.id && !c.mute));
    if (!tracks.length || end <= 0) return UI.toast('Nothing to export yet — add clips to the playlist first');
    const files = [];
    try {
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        UI.busy('Rendering stem ' + (i + 1) + ' of ' + tracks.length + ' — ' + t.name);
        const solo = { ...p, tracks: [{ ...t, out: null, solo: false, send: { to: null, amt: 0 } }], clips: p.clips.filter(c => c.trackId === t.id), master: { vol: 1, fx: [] } };
        const buf = await Engine.renderSong(solo, { sampleRate: 44100, from: 0, to: end, tail: 2 });
        files.push({ name: String(i + 1).padStart(2, '0') + ' ' + this.safeName(t.name) + '.wav', data: U.encodeWav([buf.getChannelData(0), buf.getChannelData(1)], 44100, 24) });
      }
      U.download(this.zip(files), this.safeName(p.name) + ' stems.zip');
      UI.toast(files.length + ' stems exported');
    } catch (e) {
      console.error(e);
      UI.toast('Stem export failed: ' + e.message, 'error');
    } finally {
      UI.busy(false);
    }
  },

  async mp3(chs, sampleRate, kbps) {
    if (typeof lamejs === 'undefined') throw new Error('the MP3 encoder did not load');
    const enc = new lamejs.Mp3Encoder(2, sampleRate, kbps), n = chs[0].length, B = 1152 * 32, out = [];
    const l = new Int16Array(B), r = new Int16Array(B), R = chs[1] || chs[0];
    for (let o = 0, block = 0; o < n; o += B, block++) {
      const len = Math.min(B, n - o);
      for (let i = 0; i < len; i++) {
        const a = chs[0][o + i], b = R[o + i];
        l[i] = (a < -1 ? -1 : a > 1 ? 1 : a) * 32767;
        r[i] = (b < -1 ? -1 : b > 1 ? 1 : b) * 32767;
      }
      const d = enc.encodeBuffer(l.subarray(0, len), r.subarray(0, len));
      if (d.length) out.push(new Uint8Array(d));
      if (block % 8 === 7) await new Promise(res => setTimeout(res));   // let the page breathe
    }
    const tail = enc.flush();
    if (tail.length) out.push(new Uint8Array(tail));
    return new Blob(out, { type: 'audio/mpeg' });
  },
};

/* ---------- kits, presets, help ---------- */

const Extras = {
  presets() { try { return JSON.parse(localStorage.getItem('tapehead.fxPresets')) || []; } catch (e) { return []; } },
  savePresets(list) { try { localStorage.setItem('tapehead.fxPresets', JSON.stringify(list)); } catch (e) { UI.toast('Could not save the preset', 'error'); } },

  presetMenu(e, owner) {
    const r = e.currentTarget.getBoundingClientRect(), p = App.project, list = Engine.fxList(p, owner), all = this.presets();
    UI.menu(r.left, r.bottom + 4, [
      {
        label: 'Save this chain as a preset…', disabled: !list.length, onclick: async () => {
          const name = await UI.prompt('Preset name', 'My chain', 'Save');
          if (!name) return;
          this.savePresets([...all.filter(x => x.name !== name), { name, fx: list.map(f => ({ type: f.type, on: f.on, p: { ...f.p } })) }]);
          UI.toast('Preset “' + name + '” saved');
        },
      },
      ...(all.length ? ['-'] : []),
      ...all.map(pr => ({
        label: 'Load: ' + pr.name, onclick: () => App.fxEdit(owner, () => {
          list.length = 0;
          for (const f of pr.fx) if (FX.defs[f.type]) list.push({ id: U.uid('f'), type: f.type, on: f.on, p: { ...FX.make(f.type).p, ...f.p, ...(f.type === 'duck' ? { src: '' } : {}) } });
        }),
      })),
      ...(all.length ? ['-'] : []),
      ...all.map(pr => ({ label: 'Delete: ' + pr.name, danger: true, onclick: () => { this.savePresets(all.filter(x => x !== pr)); UI.toast('Preset deleted'); } })),
    ]);
  },

  async kitMenu(e) {
    const r = e.currentTarget.getBoundingClientRect(), p = App.project, pat = Engine.curPattern(p), kits = await DB.kits();
    UI.menu(r.left, r.bottom + 4, [
      {
        label: 'Save these channels as a kit…', disabled: !pat.channels.length, onclick: async () => {
          const name = await UI.prompt('Kit name', 'My kit', 'Save');
          if (!name) return;
          await DB.putKit({ id: U.uid('k'), name, items: pat.channels.map(c => ({ name: c.name, sampleId: c.sampleId, vol: c.vol, pan: c.pan, pitch: c.pitch })) });
          UI.toast('Kit “' + name + '” saved — it is available in every project');
        },
      },
      ...(kits.length ? ['-'] : []),
      ...kits.map(k => ({ label: 'Load: ' + k.name, onclick: () => this.loadKit(k) })),
      ...(kits.length ? ['-'] : []),
      ...kits.map(k => ({ label: 'Delete: ' + k.name, danger: true, onclick: async () => { await DB.delKit(k.id); UI.toast('Kit deleted'); } })),
    ]);
  },

  // Swap the current pattern's sounds for the kit's, keeping the steps already programmed row by row.
  async loadKit(kit) {
    const p = App.project, pat = Engine.curPattern(p), add = [];
    for (const it of kit.items) {
      if (Engine.buffers.has(it.sampleId)) { if (!it.sampleId.startsWith('kit:') && !p.samples.some(s => s.id === it.sampleId)) add.push(it); continue; }
      const rec = await DB.getAudio(it.sampleId);
      if (!rec) continue;
      try { Engine.buffers.set(it.sampleId, await Engine.decode(rec.bytes)); add.push(it); } catch (e) { /* unreadable */ }
    }
    App.edit(() => {
      for (const it of add) {
        const buf = Engine.buffers.get(it.sampleId);
        p.samples.push({ id: it.sampleId, name: it.name, dur: buf.duration, ch: buf.numberOfChannels, sr: buf.sampleRate });
      }
      const usable = kit.items.filter(it => Engine.buffers.has(it.sampleId));
      pat.channels = usable.map((it, i) => {
        const old = pat.channels[i], ch = Rack.newChannel(it.sampleId, it.name);
        Object.assign(ch, { vol: it.vol, pan: it.pan, pitch: it.pitch });
        if (old) { ch.steps = old.steps; ch.rolls = old.rolls; ch.notes = old.notes; }
        return ch;
      });
    }, null, true);
    UI.toast('Kit “' + kit.name + '” loaded');
  },

  shortcuts() {
    const rows = [
      ['Space', 'Play / pause'], ['R', 'Record from the microphone'], ['Home', 'Go to the start'],
      ['V  C  T  D  A', 'Tools: select, slice, mute, delete, automate'], ['S', 'Split clips at the playhead'],
      ['X', 'Crossfade the selected clip with clips it overlaps'], ['M', 'Add a marker at the playhead'],
      ['Ctrl + C / X / V', 'Copy / cut / paste clips'], ['Ctrl + D', 'Duplicate the selection'], ['Ctrl + A', 'Select all clips'],
      ['Delete', 'Delete the selection'], ['Ctrl + Z / Y', 'Undo / redo'], ['Ctrl + S', 'Save now'],
      ['+  −', 'Zoom in / out'], ['Ctrl + wheel', 'Zoom at the pointer'], ['Shift + drag ruler', 'Set the loop region'],
      ['Double-click ruler', 'Add a marker'], ['Alt while dragging', 'Ignore snap'], ['Esc', 'Clear the selection'], ['?', 'This list'],
    ];
    UI.modal({
      title: 'Keyboard shortcuts',
      body: U.el('table.report.keys', null, rows.map(([k, d]) => U.el('tr', null, U.el('td', null, U.el('kbd', { text: k })), U.el('td', { text: d })))),
      actions: [{ label: 'Close', kind: 'accent' }],
    });
  },

  firstRun() {
    try { if (localStorage.getItem('tapehead.tour')) return; localStorage.setItem('tapehead.tour', '1'); } catch (e) { return; }
    this.tour();
  },

  tour(i) {
    const steps = [
      ['Welcome to Tapehead', 'A quick look at how a session comes together. You can reopen this any time from the menu button at the top left.'],
      ['1 · Bring in audio', 'Drag WAV files from your computer onto the playlist, or click Import in the Samples panel. Each file lands on its own track. You can also press R to record from a microphone.'],
      ['2 · Arrange and edit', 'Drag clips to move them and drag their edges to trim. S splits at the playhead, the white squares set fades, and the Clip tab changes gain, pitch and length — including fitting a loop to the project tempo.'],
      ['3 · Make a beat', 'In the Channel rack, click steps to program drums and press Keys on a channel to write notes in the piano roll. “Add to playlist” places the pattern as a clip that stays linked to it.'],
      ['4 · Mix', 'Open Mixer & effects, pick a track and add effects. The Automate tool draws volume and pan changes over time. “Auto mix” sets levels, effects and master loudness for you.'],
      ['5 · Save and export', 'Projects save automatically. Use the menu at the top left to save a .tapehead project file as a backup you can move between computers, and Export for WAV or MP3.'],
    ];
    i = i || 0;
    const [title, text] = steps[i], last = i === steps.length - 1;
    UI.modal({
      title, body: U.el('div.form', null, U.el('p', { text }), U.el('div.dim', { text: (i + 1) + ' of ' + steps.length })),
      actions: [
        ...(last ? [] : [{ label: 'Skip' }]),
        ...(i ? [{ label: 'Back', onclick: c => { c(); this.tour(i - 1); } }] : []),
        { label: last ? 'Start' : 'Next', kind: 'accent', onclick: c => { c(); if (!last) this.tour(i + 1); } },
      ],
    });
  },
};

// offline support for the hosted web version (the desktop app does not need it)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

App.init();
