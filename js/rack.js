'use strict';

// Channel rack: a step sequencer. Each pattern is a set of channels (one sample each) with up to 64 steps.
// A step holds its velocity (0 = off), may roll (retrigger 2-4 times), and a channel can also carry
// piano-roll notes, which play alongside the steps.
const Rack = {
  MAX: 64,
  leds: [], cur: -1,
  graphCh: null,   // id of the channel whose velocity / roll lane is open

  init() { this.root = $('#tab-rack'); },

  newChannel(sampleId, name) {
    return { id: U.uid('h'), name, sampleId, vol: 0.8, pan: 0, pitch: 0, mute: false, steps: new Array(this.MAX).fill(0), rolls: new Array(this.MAX).fill(1), notes: [] };
  },

  newPattern(name, starter) {
    const mk = (id, on) => {
      const ch = this.newChannel(id, Kit.list.find(k => k.id === id).name);
      if (starter) for (const i of on) ch.steps[i] = 1;
      return ch;
    };
    return { id: U.uid('p'), name, steps: 16, channels: [mk('kit:kick', [0, 4, 8, 12]), mk('kit:clap', [4, 12]), mk('kit:chat', [0, 2, 4, 6, 8, 10, 12, 14]), mk('kit:snare', [])] };
  },

  render() {
    const p = App.project, pat = Engine.curPattern(p);
    const ed = (fn, parts) => App.edit(fn, parts == null ? 'rack,timeline' : parts, true);

    const patSel = U.el('select.field.small', {
      title: 'Current pattern',
      onchange: e => { p.curPat = e.target.value; App.touch(); this.render(); },
    }, p.patterns.map(x => U.el('option', { value: x.id, text: x.name, selected: x.id === pat.id })));

    const stepsSel = U.el('select.field.small', {
      title: 'Pattern length in steps (16 steps = 1 bar)',
      onchange: e => ed(() => { pat.steps = +e.target.value; }),
    }, [8, 16, 32, 64].map(n => U.el('option', { value: n, text: n + ' steps', selected: n === pat.steps })));

    const repeats = U.el('input.field.small.num', { type: 'number', min: 1, max: 64, value: this.repeats || 4, title: 'How many times to repeat the pattern in the playlist', onchange: e => { this.repeats = U.clamp(+e.target.value || 1, 1, 64); } });
    const reps = () => U.clamp(+repeats.value || 1, 1, 64);
    const swingVal = U.el('span.val', { text: Math.round(p.swing * 100) + '%' });

    const bar = U.el('div.rack-bar', null,
      patSel,
      U.el('button.btn.small', { text: 'New', title: 'New pattern', onclick: () => ed(() => { const n = this.newPattern('Pattern ' + (p.patterns.length + 1)); p.patterns.push(n); p.curPat = n.id; }) }),
      U.el('button.btn.small', { text: 'Clone', title: 'Duplicate this pattern', onclick: () => ed(() => {
        const n = JSON.parse(JSON.stringify(pat));
        n.id = U.uid('p'); n.name = pat.name + ' copy'; n.channels.forEach(c => { c.id = U.uid('h'); });
        p.patterns.push(n); p.curPat = n.id;
      }) }),
      U.el('button.btn.small', { text: 'Rename', onclick: async () => { const n = await UI.prompt('Rename pattern', pat.name); if (n) ed(() => { pat.name = n; }); } }),
      U.el('button.btn.small', { text: 'Clear', title: 'Clear all steps and notes', onclick: () => ed(() => pat.channels.forEach(c => { c.steps.fill(0); c.rolls.fill(1); c.notes = []; })) }),
      U.el('button.btn.small', { text: 'Delete', disabled: p.patterns.length < 2, title: 'Delete this pattern (and its clips in the playlist)', onclick: () => ed(() => {
        p.patterns = p.patterns.filter(x => x !== pat);
        p.clips = p.clips.filter(c => c.patId !== pat.id);
        p.curPat = p.patterns[0].id;
      }) }),
      U.el('span.tb-sep'),
      stepsSel,
      U.el('label.inline', { title: 'Swing: delays every second 16th note' }, 'SWING',
        UI.slider({ min: 0, max: 0.75, value: p.swing, def: 0, cls: 'sl w80', oninput: v => { p.swing = v; swingVal.textContent = Math.round(v * 100) + '%'; }, onchange: () => Engine.resync() }), swingVal),
      U.el('button.btn.small', { text: 'Kits', title: 'Save these channels as a drum kit, or load a saved kit', onclick: e => Extras.kitMenu(e) }),
      U.el('span.tb-grow'),
      U.el('label.inline', null, 'REPEAT ×', repeats),
      U.el('button.btn.small', { text: 'Bounce to audio', title: 'Render this pattern to an audio clip (a frozen copy)', onclick: () => App.bouncePattern(reps()) }),
      U.el('button.btn.small.accent', { text: 'Add to playlist', title: 'Place this pattern on the playlist. It stays linked: editing the pattern updates the clip', onclick: () => App.addPatternClip(reps()) }));

    this.leds = [];
    const ledRow = U.el('div.rack-row.leds', null, U.el('div.ch-ctl'),
      U.el('div.steps', null, Array.from({ length: pat.steps }, (_, i) => {
        const l = U.el('i.led' + (i % 4 === 0 ? '.beat' : ''));
        this.leds.push(l);
        return l;
      })));

    const rows = [];
    pat.channels.forEach((ch, ci) => {
      const open = this.graphCh === ch.id;
      const steps = ch.notes.length
        ? U.el('button.note-prev', { title: 'This channel plays piano-roll notes — click to edit them', onclick: () => PianoRoll.open(ch.id) }, this.notePreview(ch, pat))
        : U.el('div.steps', { data: { ch: ci } }, Array.from({ length: pat.steps }, (_, i) =>
          U.el('button.step' + (Math.floor(i / 4) % 2 ? '.alt' : '') + (ch.steps[i] ? '.on' : ''), {
            data: { i }, style: ch.steps[i] ? { opacity: 0.35 + 0.65 * ch.steps[i] } : null,
            text: ch.steps[i] && ch.rolls[i] > 1 ? ch.rolls[i] : '',
          })));
      rows.push(U.el('div.rack-row', null,
        U.el('div.ch-ctl', null,
          U.el('button.ch-led' + (ch.mute ? '' : '.on'), { title: 'Mute channel', onclick: () => ed(() => { ch.mute = !ch.mute; }) }),
          UI.slider({ min: -1, max: 1, value: ch.pan, def: 0, title: 'Pan', cls: 'sl w40', oninput: v => { ch.pan = v; }, onchange: () => Engine.resync() }),
          UI.slider({ min: 0, max: 1.25, value: ch.vol, def: 0.8, title: 'Volume', cls: 'sl w40', oninput: v => { ch.vol = v; }, onchange: () => Engine.resync() }),
          U.el('input.ch-pitch', {
            type: 'number', min: -24, max: 24, step: 1, value: ch.pitch, title: 'Pitch (semitones)',
            onchange: e => { App.pushUndo(); ch.pitch = U.clamp(Math.round(+e.target.value || 0), -24, 24); e.target.value = ch.pitch; App.touch(); Engine.resync(); },
          }),
          U.el('button.ch-name', {
            text: ch.name, title: 'Click to audition · right-click for options',
            onclick: () => Engine.preview(ch),
            oncontextmenu: e => {
              e.preventDefault();
              UI.menu(e.clientX, e.clientY, [
                { label: 'Open piano roll', onclick: () => PianoRoll.open(ch.id) },
                { label: 'Rename', onclick: async () => { const n = await UI.prompt('Rename channel', ch.name); if (n) ed(() => { ch.name = n; }); } },
                '-',
                { label: 'Fill every 2 steps', onclick: () => ed(() => ch.steps.forEach((_, i) => { ch.steps[i] = i % 2 === 0 ? 1 : 0; })) },
                { label: 'Fill every 4 steps', onclick: () => ed(() => ch.steps.forEach((_, i) => { ch.steps[i] = i % 4 === 0 ? 1 : 0; })) },
                { label: 'Clear steps and notes', onclick: () => ed(() => { ch.steps.fill(0); ch.rolls.fill(1); ch.notes = []; }) },
                '-',
                { label: 'Remove channel', danger: true, onclick: () => ed(() => pat.channels.splice(ci, 1)) },
              ]);
            },
          }),
          U.el('button.h-btn' + (ch.notes.length ? '.fx.on' : ''), { text: 'Keys', title: 'Piano roll: write melodies and basslines with this sound', onclick: () => PianoRoll.open(ch.id) }),
          U.el('button.h-btn' + (open ? '.fx.on' : ''), { text: 'Vel', title: 'Show velocity and roll controls for each step', disabled: ch.notes.length > 0, onclick: () => { this.graphCh = open ? null : ch.id; this.render(); } })),
        steps));
      if (open && !ch.notes.length) rows.push(this.graphRow(ch, ci, pat));
    });

    const add = U.el('select.field.small.add-ch', {
      onchange: e => {
        const id = e.target.value;
        if (id) ed(() => pat.channels.push(this.newChannel(id, App.sampleMeta(id).name)));
      },
    },
    U.el('option', { value: '', text: '+ Add channel…' }),
    U.el('optgroup', { label: 'Drum kit' }, Kit.list.map(k => U.el('option', { value: k.id, text: k.name }))),
    App.visibleSamples().length ? U.el('optgroup', { label: 'Project samples' }, App.visibleSamples().map(s => U.el('option', { value: s.id, text: s.name }))) : null);

    const grid = U.el('div.rack-grid', null, ledRow, rows, U.el('div.rack-row', null, U.el('div.ch-ctl', null, add)));

    // click or drag across steps to paint them on/off
    let paint = null;
    const apply = el => {
      if (!el.classList || !el.classList.contains('step')) return;
      const ch = pat.channels[+el.parentNode.dataset.ch], i = +el.dataset.i;
      if (!!ch.steps[i] === paint) return;
      ch.steps[i] = paint ? 1 : 0;
      if (!paint) ch.rolls[i] = 1;
      el.classList.toggle('on', paint);
      el.style.opacity = '';
      el.textContent = '';
    };
    grid.addEventListener('pointerdown', e => {
      const el = e.target;
      if (!el.classList.contains('step')) return;
      App.pushUndo();
      paint = !el.classList.contains('on');
      apply(el);
      App.touch();
      const up = () => {
        paint = null;
        window.removeEventListener('pointerup', up);
        Engine.resync();
        Playlist.draw();
        if (this.graphCh) this.render();
      };
      window.addEventListener('pointerup', up);
    });
    grid.addEventListener('pointerover', e => { if (paint != null) { apply(e.target); App.touch(); } });

    this.cur = -1;
    this.root.replaceChildren(bar, grid);
  },

  // Velocity bars (drag up/down) and roll buttons (click to cycle x1..x4) for one channel.
  graphRow(ch, ci, pat) {
    const bars = U.el('div.steps.vel', null, Array.from({ length: pat.steps }, (_, i) =>
      U.el('div.vel-cell' + (ch.steps[i] ? '.on' : ''), { data: { i }, title: 'Drag to set velocity' }, U.el('i', { style: { height: Math.round((ch.steps[i] || 0) * 100) + '%' } }))));
    const set = e => {
      const cell = e.target.closest('.vel-cell');
      if (!cell) return;
      const i = +cell.dataset.i, r = cell.getBoundingClientRect(), v = U.clamp(1 - (e.clientY - r.top) / r.height, 0.1, 1);
      if (!ch.steps[i]) return;
      ch.steps[i] = Math.round(v * 100) / 100;
      cell.firstChild.style.height = Math.round(v * 100) + '%';
    };
    bars.addEventListener('pointerdown', e => {
      App.pushUndo();
      set(e);
      const up = () => { bars.removeEventListener('pointermove', set); window.removeEventListener('pointerup', up); App.touch(); Engine.resync(); this.render(); };
      bars.addEventListener('pointermove', set);
      window.addEventListener('pointerup', up);
    });
    const rolls = U.el('div.steps', null, Array.from({ length: pat.steps }, (_, i) =>
      U.el('button.roll' + (ch.rolls[i] > 1 ? '.on' : ''), {
        text: ch.steps[i] ? '×' + ch.rolls[i] : '', disabled: !ch.steps[i], title: 'Roll: retrigger this step 2, 3 or 4 times',
        onclick: () => App.edit(() => { ch.rolls[i] = ch.rolls[i] % 4 + 1; }, 'rack', true),
      })));
    return U.el('div.rack-row.graph', null,
      U.el('div.ch-ctl.graph-lbl', null, U.el('span', { text: 'Velocity' }), U.el('span', { text: 'Roll' })),
      U.el('div.graph-body', null, bars, rolls));
  },

  notePreview(ch, pat) {
    const cv = U.el('canvas', { width: pat.steps * 22, height: 24 }), g = cv.getContext('2d');
    if (!ch.notes.length) return cv;
    const lo = Math.min(...ch.notes.map(n => n.pitch)), hi = Math.max(...ch.notes.map(n => n.pitch)), span = Math.max(1, hi - lo);
    g.fillStyle = '#ffb37a';
    for (const n of ch.notes) if (n.t < pat.steps) g.fillRect(n.t * 22, 20 - (n.pitch - lo) / span * 18, Math.max(3, n.len * 22 - 1), 3);
    return cv;
  },

  highlight(step) {
    if (step === this.cur) return;
    if (this.leds[this.cur]) this.leds[this.cur].classList.remove('cur');
    if (this.leds[step]) this.leds[step].classList.add('cur');
    this.cur = step;
  },
};
