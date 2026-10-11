'use strict';

// Channel rack: a step sequencer. Each pattern is a set of channels (one sample each) with up to 64 steps.
const Rack = {
  MAX: 64,
  leds: [], cur: -1,

  init() { this.root = $('#tab-rack'); },

  newChannel(sampleId, name) {
    return { id: U.uid('h'), name, sampleId, vol: 0.8, pan: 0, pitch: 0, mute: false, steps: new Array(this.MAX).fill(0) };
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
    const ed = (fn, parts) => App.edit(fn, parts == null ? 'rack' : parts);

    const patSel = U.el('select.field.small', {
      title: 'Current pattern',
      onchange: e => { p.curPat = e.target.value; App.touch(); this.render(); },
    }, p.patterns.map(x => U.el('option', { value: x.id, text: x.name, selected: x.id === pat.id })));

    const stepsSel = U.el('select.field.small', {
      title: 'Pattern length in steps (16 steps = 1 bar)',
      onchange: e => ed(() => { pat.steps = +e.target.value; }),
    }, [8, 16, 32, 64].map(n => U.el('option', { value: n, text: n + ' steps', selected: n === pat.steps })));

    const repeats = U.el('input.field.small.num', { type: 'number', min: 1, max: 32, value: this.repeats || 4, title: 'How many times to repeat the pattern in the playlist', onchange: e => { this.repeats = U.clamp(+e.target.value || 1, 1, 32); } });
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
      U.el('button.btn.small', { text: 'Clear', title: 'Clear all steps', onclick: () => ed(() => pat.channels.forEach(c => c.steps.fill(0))) }),
      U.el('button.btn.small', { text: 'Delete', disabled: p.patterns.length < 2, onclick: () => ed(() => { p.patterns = p.patterns.filter(x => x !== pat); p.curPat = p.patterns[0].id; }) }),
      U.el('span.tb-sep'),
      stepsSel,
      U.el('label.inline', { title: 'Swing: delays every second 16th note' }, 'SWING',
        UI.slider({ min: 0, max: 0.75, value: p.swing, def: 0, cls: 'sl w80', oninput: v => { p.swing = v; swingVal.textContent = Math.round(v * 100) + '%'; } }), swingVal),
      U.el('span.tb-grow'),
      U.el('label.inline', null, 'REPEAT ×', repeats),
      U.el('button.btn.small.accent', { text: 'Add to playlist', title: 'Render this pattern to audio and place it on the playlist', onclick: () => App.bouncePattern(U.clamp(+repeats.value || 1, 1, 32)) }));

    this.leds = [];
    const ledRow = U.el('div.rack-row.leds', null, U.el('div.ch-ctl'),
      U.el('div.steps', null, Array.from({ length: pat.steps }, (_, i) => {
        const l = U.el('i.led' + (i % 4 === 0 ? '.beat' : ''));
        this.leds.push(l);
        return l;
      })));

    const rows = pat.channels.map((ch, ci) => U.el('div.rack-row', null,
      U.el('div.ch-ctl', null,
        U.el('button.ch-led' + (ch.mute ? '' : '.on'), { title: 'Mute channel', onclick: () => ed(() => { ch.mute = !ch.mute; }) }),
        UI.slider({ min: -1, max: 1, value: ch.pan, def: 0, title: 'Pan', cls: 'sl w40', oninput: v => { ch.pan = v; } }),
        UI.slider({ min: 0, max: 1.25, value: ch.vol, def: 0.8, title: 'Volume', cls: 'sl w40', oninput: v => { ch.vol = v; } }),
        U.el('input.ch-pitch', {
          type: 'number', min: -24, max: 24, step: 1, value: ch.pitch, title: 'Pitch (semitones)',
          onchange: e => { App.pushUndo(); ch.pitch = U.clamp(Math.round(+e.target.value || 0), -24, 24); e.target.value = ch.pitch; App.touch(); },
        }),
        U.el('button.ch-name', {
          text: ch.name, title: 'Click to audition · right-click for options',
          onclick: () => Engine.preview(ch),
          oncontextmenu: e => {
            e.preventDefault();
            UI.menu(e.clientX, e.clientY, [
              { label: 'Rename', onclick: async () => { const n = await UI.prompt('Rename channel', ch.name); if (n) ed(() => { ch.name = n; }); } },
              { label: 'Fill every 2 steps', onclick: () => ed(() => ch.steps.forEach((_, i) => { ch.steps[i] = i % 2 === 0 ? 1 : 0; })) },
              { label: 'Fill every 4 steps', onclick: () => ed(() => ch.steps.forEach((_, i) => { ch.steps[i] = i % 4 === 0 ? 1 : 0; })) },
              { label: 'Clear steps', onclick: () => ed(() => ch.steps.fill(0)) },
              '-',
              { label: 'Remove channel', danger: true, onclick: () => ed(() => pat.channels.splice(ci, 1)) },
            ]);
          },
        })),
      U.el('div.steps', { data: { ch: ci } }, Array.from({ length: pat.steps }, (_, i) =>
        U.el('button.step' + (Math.floor(i / 4) % 2 ? '.alt' : '') + (ch.steps[i] ? '.on' : ''), { data: { i } })))));

    const add = U.el('select.field.small.add-ch', {
      onchange: e => {
        const id = e.target.value;
        if (id) ed(() => pat.channels.push(this.newChannel(id, App.sampleMeta(id).name)));
      },
    },
    U.el('option', { value: '', text: '+ Add channel…' }),
    U.el('optgroup', { label: 'Drum kit' }, Kit.list.map(k => U.el('option', { value: k.id, text: k.name }))),
    p.samples.length ? U.el('optgroup', { label: 'Project samples' }, p.samples.map(s => U.el('option', { value: s.id, text: s.name }))) : null);

    const grid = U.el('div.rack-grid', null, ledRow, rows, U.el('div.rack-row', null, U.el('div.ch-ctl', null, add)));

    // click or drag across steps to paint them on/off
    let paint = null;
    const apply = el => {
      if (!el.classList || !el.classList.contains('step')) return;
      const ch = pat.channels[+el.parentNode.dataset.ch], i = +el.dataset.i;
      if (!!ch.steps[i] === paint) return;
      ch.steps[i] = paint ? 1 : 0;
      el.classList.toggle('on', paint);
    };
    grid.addEventListener('pointerdown', e => {
      const el = e.target;
      if (!el.classList.contains('step')) return;
      App.pushUndo();
      paint = !el.classList.contains('on');
      apply(el);
      App.touch();
      const up = () => { paint = null; window.removeEventListener('pointerup', up); };
      window.addEventListener('pointerup', up);
    });
    grid.addEventListener('pointerover', e => { if (paint != null) { apply(e.target); App.touch(); } });

    this.cur = -1;
    this.root.replaceChildren(bar, grid);
  },

  highlight(step) {
    if (step === this.cur) return;
    if (this.leds[this.cur]) this.leds[this.cur].classList.remove('cur');
    if (this.leds[step]) this.leds[step].classList.add('cur');
    this.cur = step;
  },
};
