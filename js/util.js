'use strict';

const $ = (s, root) => (root || document).querySelector(s);

const U = {
  uid(prefix) {
    return (prefix || '') + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7);
  },
  clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
  dbToGain(db) { return Math.pow(10, db / 20); },
  gainToDb(g) { return g <= 0.00001 ? -100 : 20 * Math.log10(g); },

  fmtTime(s) {
    s = Math.max(0, s || 0);
    const m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
  },
  fmtDur(s) {
    s = Math.max(0, s || 0);
    if (s < 10) return s.toFixed(2) + 's';
    const m = Math.floor(s / 60), r = Math.floor(s - m * 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  },
  fmtDate(ts) {
    const d = new Date(ts), now = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'Today ' + time;
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + time;
  },
  hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  },

  // el('div.cls#id', {text, onclick, style:{}, ...}, ...children)
  el(sel, props, ...kids) {
    const parts = sel.split('.');
    const [tag, id] = parts[0].split('#');
    const e = document.createElement(tag || 'div');
    if (id) e.id = id;
    if (parts.length > 1) e.className = parts.slice(1).join(' ');
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null) continue;
        if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'style') {
          for (const s in v) s.startsWith('--') ? e.style.setProperty(s, v[s]) : (e.style[s] = v[s]);
        } else if (k === 'data') Object.assign(e.dataset, v);
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k in e) e[k] = v;
        else e.setAttribute(k, v);
      }
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
    return e;
  },

  debounce(fn, ms) {
    let t;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.cancel = () => clearTimeout(t);
    return d;
  },

  // channels: Float32Array[]; bits: 16 | 24 | 32 (float)
  encodeWav(channels, sampleRate, bits) {
    const nCh = channels.length, n = channels[0].length, bps = bits / 8;
    const buf = new ArrayBuffer(44 + n * nCh * bps), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * nCh * bps, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, bits === 32 ? 3 : 1, true);
    v.setUint16(22, nCh, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * nCh * bps, true);
    v.setUint16(32, nCh * bps, true);
    v.setUint16(34, bits, true);
    str(36, 'data'); v.setUint32(40, n * nCh * bps, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nCh; c++) {
        let s = channels[c][i];
        if (bits === 32) { v.setFloat32(o, s, true); o += 4; continue; }
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        if (bits === 16) { v.setInt16(o, Math.round(s * 32767), true); o += 2; }
        else {
          const x = Math.round(s * 8388607);
          v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255);
          o += 3;
        }
      }
    }
    return buf;
  },

  download(blob, name) {
    const a = U.el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  },
};

const ICON = {
  play: '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>',
  x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  left: '<svg viewBox="0 0 16 16"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dots: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
};

const UI = {
  toast(msg, kind) {
    const t = U.el('div.toast' + (kind ? '.' + kind : ''), { text: msg });
    $('#toasts').append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, 3200);
  },

  busy(msg) {
    const b = $('#busy');
    b.hidden = !msg;
    if (msg) $('#busy-msg').textContent = msg;
  },

  // actions: [{label, kind:'accent'|'danger', onclick(close, btn)}]
  modal({ title, body, actions }) {
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    const foot = U.el('div.modal-foot', null,
      (actions || []).map(a => U.el('button.btn' + (a.kind ? '.' + a.kind : ''), {
        text: a.label, onclick: e => (a.onclick ? a.onclick(close, e.currentTarget) : close()),
      })));
    const box = U.el('div.modal', { role: 'dialog' }, U.el('h3', { text: title }), U.el('div.modal-body', null, body), foot);
    const back = U.el('div.modal-back', { onpointerdown: e => { if (e.target === back) close(); } }, box);
    $('#overlay').append(back);
    document.addEventListener('keydown', onKey, true);
    const first = box.querySelector('input,select,button');
    if (first) { first.focus(); if (first.select && first.type === 'text') first.select(); }
    return close;
  },

  confirm(title, msg, okLabel, danger) {
    return new Promise(res => {
      let done = false;
      const finish = v => { if (!done) { done = true; res(v); } };
      const close = UI.modal({
        title, body: U.el('p', { text: msg }),
        actions: [
          { label: 'Cancel', onclick: c => { c(); finish(false); } },
          { label: okLabel || 'OK', kind: danger ? 'danger' : 'accent', onclick: c => { c(); finish(true); } },
        ],
      });
      void close;
    });
  },

  prompt(title, value, okLabel) {
    return new Promise(res => {
      const inp = U.el('input.field', { type: 'text', value: value || '', spellcheck: false });
      const ok = c => { c(); res(inp.value.trim() || null); };
      const close = UI.modal({
        title, body: inp,
        actions: [{ label: 'Cancel', onclick: c => { c(); res(null); } }, { label: okLabel || 'OK', kind: 'accent', onclick: ok }],
      });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(close); });
    });
  },

  // items: [{label, onclick, danger, disabled} | '-']
  menu(x, y, items) {
    UI.closeMenu();
    const m = U.el('div.menu', null, items.map(it => it === '-'
      ? U.el('div.menu-sep')
      : U.el('button.menu-item' + (it.danger ? '.danger' : ''), {
        text: it.label, disabled: !!it.disabled,
        onclick: () => { UI.closeMenu(); it.onclick(); },
      })));
    $('#overlay').append(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
    m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
    UI._menu = m;
    setTimeout(() => document.addEventListener('pointerdown', UI._menuOff, true));
  },
  _menuOff(e) { if (UI._menu && !UI._menu.contains(e.target)) UI.closeMenu(); },
  closeMenu() {
    if (UI._menu) { UI._menu.remove(); UI._menu = null; }
    document.removeEventListener('pointerdown', UI._menuOff, true);
  },

  // Range input that records one undo step per drag gesture.
  slider({ min = 0, max = 1, step = 0.01, value, cls, title, def, oninput, onchange, undo = true }) {
    const s = U.el('input', { type: 'range', className: cls || 'sl', min, max, step, title });
    s.value = value;
    let fresh = true;
    s.addEventListener('input', () => {
      if (undo && fresh) { App.pushUndo(); fresh = false; }
      oninput(+s.value, s);
    });
    s.addEventListener('change', () => { fresh = true; App.touch(); if (onchange) onchange(+s.value); });
    if (def != null) {
      s.addEventListener('dblclick', () => {
        if (undo) App.pushUndo();
        s.value = def;
        oninput(+s.value, s);
        App.touch();
        if (onchange) onchange(+s.value);
      });
    }
    return s;
  },
};
