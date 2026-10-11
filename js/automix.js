'use strict';

// Auto mix & master. Measurement-driven, no guesswork about genre:
//  1. render each track on its own and measure loudness, peak and low/high balance
//  2. classify it (drums / bass / melodic / bright) and add corrective EQ + compression
//  3. balance the faders against per-role targets and spread the non-anchor tracks in stereo
//  4. put EQ, glue compression and a limiter on the master, then trim gain until the
//     rendered mix reaches the loudness target without exceeding the peak ceiling
// Effects it adds are flagged `auto` so running it again replaces them instead of stacking.
const AutoMix = {
  ROLE: {
    drums: { label: 'Drums', offset: 0, eq: { hp: 30, low: 1, mid: -1.5, midF: 400, high: 1.5 }, comp: { ratio: 3, att: 15, rel: 120 } },
    bass: { label: 'Bass', offset: -1, eq: { hp: 28, low: 1, mid: -2, midF: 300, high: 0 }, comp: { ratio: 4, att: 10, rel: 160 } },
    mid: { label: 'Melodic', offset: -3, eq: { hp: 100, low: 0, mid: 1, midF: 2500, high: 1 }, comp: { ratio: 2.5, att: 8, rel: 150 } },
    bright: { label: 'Bright', offset: -8, eq: { hp: 300, low: 0, mid: 0, midF: 1000, high: 1 }, comp: { ratio: 2, att: 5, rel: 100 } },
  },
  PEAK_CEIL: -0.5,   // dBFS the finished master must stay under

  dialog() {
    const p = App.project;
    if (!p.clips.some(c => !c.mute)) return UI.toast('Nothing to mix yet — add clips to the playlist first');
    const check = on => U.el('input', { type: 'checkbox', checked: on });
    const f = {
      target: U.el('select.field', null,
        U.el('option', { value: -14, text: 'Streaming (−14 LUFS)' }),
        U.el('option', { value: -10, text: 'Loud (−10 LUFS)' }),
        U.el('option', { value: -16, text: 'Dynamic (−16 LUFS)' })),
      levels: check(true), pan: check(true), trackFx: check(true), master: check(true),
    };
    const row = (label, ctl) => U.el('label.form-row', null, U.el('span', { text: label }), ctl);
    UI.modal({
      title: 'Auto mix & master',
      body: U.el('div.form', null,
        U.el('p', { text: 'Analyses every track, then sets levels, panning and effects for you. Your own effects are kept. The whole thing is one undo step.' }),
        row('Balance track levels', f.levels), row('Pan tracks across the stereo field', f.pan),
        row('Add EQ and compression per track', f.trackFx), row('Master: EQ, glue compressor, limiter', f.master),
        row('Loudness target', f.target)),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Analyse & apply', kind: 'accent', onclick: async close => {
            close();
            try {
              const rep = await this.run({ target: +f.target.value, levels: f.levels.checked, pan: f.pan.checked, trackFx: f.trackFx.checked, master: f.master.checked });
              this.report(rep);
            } catch (e) {
              console.error(e);
              UI.toast('Auto mix failed: ' + e.message, 'error');
            } finally {
              UI.busy(false);
            }
          },
        },
      ],
    });
  },

  fx(type, params) {
    const f = FX.make(type);
    Object.assign(f.p, params);
    f.auto = true;
    return f;
  },

  solo(w, t, end, withFx) {
    const p = { ...w, tracks: [{ ...t, vol: 1, pan: 0, mute: false, solo: false, fx: withFx ? t.fx : [] }], clips: w.clips.filter(c => c.trackId === t.id), master: { vol: 1, fx: [] } };
    return Engine.renderSong(p, { sampleRate: 22050, from: 0, to: end, tail: 0 });
  },

  // Loudness of the sounding parts (silence is gated out), peak, and how the energy splits by band.
  stats(buf) {
    const n = buf.length, sr = buf.sampleRate, chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    const aL = 1 - Math.exp(-2 * Math.PI * 180 / sr), aH = 1 - Math.exp(-2 * Math.PI * 5000 / sr), B = Math.floor(sr * 0.05);
    let yl = 0, yh = 0, eLow = 0, eHigh = 0, eTot = 0, peak = 0, acc = 0, cnt = 0, sum = 0, active = 0;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < chs.length; c++) x += chs[c][i];
      x /= chs.length;
      const ax = x < 0 ? -x : x;
      if (ax > peak) peak = ax;
      yl += aL * (x - yl); yh += aH * (x - yh);
      const hi = x - yh;
      eLow += yl * yl; eHigh += hi * hi; eTot += x * x; acc += x * x;
      if (++cnt === B) { if (acc / B > 1e-5) { sum += acc / B; active++; } acc = cnt = 0; }
    }
    if (!active || peak < 0.001) return null;
    const rmsDb = U.gainToDb(Math.sqrt(sum / active)), peakDb = U.gainToDb(peak);
    return { rmsDb, peakDb, crest: peakDb - rmsDb, low: eLow / eTot, high: eHigh / eTot };
  },

  classify(name, s) {
    if (/kick|bass|808|sub/i.test(name) && s.low > 0.35) return 'bass';
    if (/beat|drum|perc|snare|clap|loop/i.test(name)) return 'drums';
    if (/hat|cymbal|shaker|ride/i.test(name)) return 'bright';
    if (s.low > 0.6 && s.high < 0.02) return 'bass';
    if (s.crest > 13) return s.high > 0.5 ? 'bright' : 'drums';
    if (s.low > 0.6) return 'bass';
    return s.high > 0.4 ? 'bright' : 'mid';
  },

  // Integrated loudness (ITU-R BS.1770 style: K-weighting, 400 ms blocks, absolute and relative gates) plus sample peak.
  async lufs(buf) {
    const off = new OfflineAudioContext(buf.numberOfChannels, buf.length, buf.sampleRate);
    const src = off.createBufferSource(), shelf = off.createBiquadFilter(), hp = off.createBiquadFilter();
    src.buffer = buf;
    shelf.type = 'highshelf'; shelf.frequency.value = 1681; shelf.gain.value = 4;
    hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = -6;
    src.connect(shelf); shelf.connect(hp); hp.connect(off.destination);
    src.start();
    const k = await off.startRendering();

    let peak = 0;
    const hop = Math.floor(buf.sampleRate * 0.1), nh = Math.floor(buf.length / hop), ms = new Float64Array(Math.max(1, nh));
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const raw = buf.getChannelData(c), d = k.getChannelData(c);
      for (let i = 0; i < raw.length; i++) { const v = raw[i] < 0 ? -raw[i] : raw[i]; if (v > peak) peak = v; }
      for (let h = 0; h < nh; h++) { let s = 0; for (let i = h * hop, e = i + hop; i < e; i++) s += d[i] * d[i]; ms[h] += s / hop; }
    }
    const z = [];
    for (let h = 0; h + 4 <= nh; h++) z.push((ms[h] + ms[h + 1] + ms[h + 2] + ms[h + 3]) / 4);
    if (!z.length) z.push(ms.reduce((a, b) => a + b, 0) / ms.length);
    // -0.44 rather than the standard -0.691: calibrated so these Web Audio filters read 1 kHz correctly
    const L = v => -0.44 + 10 * Math.log10(v), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const abs = z.filter(v => v > 0 && L(v) > -70);
    if (!abs.length) return { lufs: -100, peakDb: U.gainToDb(peak) };
    const rel = L(mean(abs)) - 10, gated = abs.filter(v => L(v) > rel);
    return { lufs: L(mean(gated.length ? gated : abs)), peakDb: U.gainToDb(peak) };
  },

  async run(o) {
    const src = App.project, w = JSON.parse(JSON.stringify(src)), end = Engine.songEnd(w), R = this.ROLE;
    const mixdown = () => Engine.renderSong(w, { sampleRate: 44100, from: 0, to: end, tail: 1 });
    const anySolo = w.tracks.some(t => t.solo);
    const live = w.tracks.filter(t => !t.mute && (!anySolo || t.solo) && w.clips.some(c => c.trackId === t.id && !c.mute));

    UI.busy('Measuring the current mix…');
    const before = await this.lufs(await mixdown());

    if (o.trackFx) for (const t of live) t.fx = t.fx.filter(f => !f.auto);
    if (o.master) w.master.fx = w.master.fx.filter(f => !f.auto);

    const rows = [];
    for (let i = 0; i < live.length; i++) {
      const t = live[i];
      UI.busy('Analysing “' + t.name + '” (' + (i + 1) + ' of ' + live.length + ')…');
      const s = this.stats(await this.solo(w, t, end, false));
      if (s) rows.push({ t, s, role: this.classify(t.name, s) });
    }
    if (!rows.length) throw new Error('no audible tracks to analyse');

    if (o.trackFx) {
      for (const r of rows) {
        const role = R[r.role], thr = U.clamp(Math.round(r.s.rmsDb + r.s.crest * 0.5), -45, -6);
        r.t.fx.push(this.fx('eq', role.eq), this.fx('comp', { ...role.comp, thr, knee: 10, makeup: 0 }));
      }
    }

    if (o.levels) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        UI.busy('Balancing levels (' + (i + 1) + ' of ' + rows.length + ')…');
        const s = r.t.fx.some(f => f.on) ? this.stats(await this.solo(w, r.t, end, true)) || r.s : r.s;
        // percussive material reads quieter than it sounds on RMS alone, so credit part of its crest factor
        r.want = R[r.role].offset - (s.rmsDb + 0.5 * Math.max(0, s.crest - 12));
      }
      const top = Math.max(...rows.map(r => r.want));
      for (const r of rows) r.t.vol = Math.round(U.clamp(U.dbToGain(r.want - top), 0.05, 1) * 100) / 100;
    }

    if (o.pan) {
      const sides = rows.filter(r => r.role === 'mid' || r.role === 'bright');
      for (const r of rows) r.t.pan = 0;
      if (sides.length > 1) sides.forEach((r, i) => { r.t.pan = (i % 2 ? 1 : -1) * Math.min(0.6, 0.22 + 0.16 * Math.floor(i / 2)); });
    }

    let after = null;
    if (o.master) {
      UI.busy('Setting up the master chain…');
      w.master.vol = 1;
      const pre = this.stats(await mixdown());
      const trim = this.fx('utility', { gain: 0 });
      w.master.fx.push(
        this.fx('eq', { hp: 25, low: 0.5, mid: 0, high: 1 }),
        this.fx('comp', { thr: U.clamp(Math.round(pre.rmsDb + 4), -40, -6), ratio: 2, att: 30, rel: 250, knee: 12, makeup: 0 }),
        trim,
        this.fx('limiter', { gain: 0, ceil: -2, rel: 80 }));
      // The limiter is not a brick wall, so verify by rendering: push gain towards the loudness
      // target, and back off whenever the rendered peak crosses the ceiling.
      let capped = false;
      for (let i = 0; i < 6; i++) {
        UI.busy('Mastering — pass ' + (i + 1) + '…');
        after = await this.lufs(await mixdown());
        if (i === 5) break;
        const over = after.peakDb - this.PEAK_CEIL, diff = o.target - after.lufs;
        let g = trim.p.gain;
        if (over > 0) { g -= over + 0.3; capped = true; }
        else if (Math.abs(diff) >= 0.4 && !(capped && diff > 0)) g += diff;
        g = U.clamp(Math.round(g * 2) / 2, -24, 24);
        if (g === trim.p.gain) break;
        trim.p.gain = g;
      }
    } else {
      UI.busy('Measuring the result…');
      after = await this.lufs(await mixdown());
    }

    App.pushUndo();
    for (const t of w.tracks) {
      const d = src.tracks.find(x => x.id === t.id);
      if (d) { d.vol = t.vol; d.pan = t.pan; d.fx = t.fx; }
    }
    src.master.fx = w.master.fx;
    src.master.vol = w.master.vol;
    Engine.rebuildAllFx();
    Engine.syncMix();
    App.refresh('heads,mixer,top');
    App.touch();
    return { rows, before, after, o };
  },

  report({ rows, before, after, o }) {
    const db = v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
    const pan = v => (Math.abs(v) < 0.01 ? 'Centre' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100));
    const cell = (tag, text) => U.el(tag, { text });
    const table = U.el('table.report', null,
      U.el('tr', null, ['Track', 'Detected as', 'Fader', 'Pan'].map(h => cell('th', h))),
      rows.map(r => U.el('tr', null, cell('td', r.t.name), cell('td', this.ROLE[r.role].label), cell('td', db(U.gainToDb(r.t.vol))), cell('td', pan(r.t.pan)))));
    const short = o.master && after.lufs < o.target - 1;
    UI.modal({
      title: 'Auto mix & master — done',
      body: U.el('div.form', null,
        table,
        U.el('div.report-sum', null,
          cell('span', 'Loudness'), cell('b', before.lufs.toFixed(1) + ' → ' + after.lufs.toFixed(1) + ' LUFS'),
          cell('span', 'Peak'), cell('b', db(before.peakDb) + ' → ' + db(after.peakDb))),
        short ? U.el('p', { text: 'The mix stopped ' + (o.target - after.lufs).toFixed(1) + ' dB short of the target: pushing harder would have clipped. It has a lot of peak energy — more compression on the loudest track would let it go louder.' }) : null,
        U.el('p', { text: 'Added effects are marked “auto” in the Mixer tab and can be tweaked or removed. Press Ctrl+Z to revert everything.' })),
      actions: [{ label: 'Undo', onclick: c => { c(); App.undo(); } }, { label: 'Keep', kind: 'accent' }],
    });
  },
};
