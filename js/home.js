'use strict';

// Project manager screen.
const Home = {
  projects: [],

  init() {
    $('#home-new').onclick = () => this.create();
    $('#home-search').oninput = () => this.render();
  },

  async show() {
    $('#studio').hidden = true;
    $('#home').hidden = false;
    document.title = 'Tapehead — projects';
    this.projects = (await DB.list()).sort((a, b) => b.modified - a.modified);
    this.render();
  },

  async create() {
    const name = await UI.prompt('New project', 'Untitled project', 'Create');
    if (!name) return;
    const p = App.newProject(name);
    await DB.put(p);
    App.open(p.id);
  },

  render() {
    const q = $('#home-search').value.trim().toLowerCase();
    const list = this.projects.filter(p => !q || p.name.toLowerCase().includes(q));
    $('#home-count').textContent = this.projects.length ? list.length + (list.length === 1 ? ' project' : ' projects') : '';
    const grid = $('#home-grid');
    if (!this.projects.length) {
      return grid.replaceChildren(U.el('div.home-empty', null,
        U.el('h2', { text: 'No projects yet' }),
        U.el('p', { text: 'Create a project, drop in your WAV files, then cut, arrange, add effects and export. Everything is saved in this browser automatically.' }),
        U.el('button.btn.accent', { text: 'Create your first project', onclick: () => this.create() })));
    }
    grid.replaceChildren(
      U.el('button.card.new', { onclick: () => this.create() }, U.el('span.plus', { html: ICON.plus }), U.el('span', { text: 'New project' })),
      ...list.map(p => this.card(p)),
      ...(list.length ? [] : [U.el('div.dim', { text: 'No projects match “' + q + '”.' })]));
  },

  card(p) {
    const end = Engine.songEnd(p), thumb = U.el('canvas.card-thumb', { width: 520, height: 132 });
    this.thumb(thumb, p, end);
    const menu = e => {
      e.stopPropagation(); e.preventDefault();
      UI.menu(e.clientX, e.clientY, [
        { label: 'Open', onclick: () => App.open(p.id) },
        { label: 'Rename', onclick: () => this.rename(p) },
        { label: 'Duplicate', onclick: () => this.duplicate(p) },
        '-',
        { label: 'Delete', danger: true, onclick: () => this.remove(p) },
      ]);
    };
    return U.el('div.card', { tabIndex: 0, onclick: () => App.open(p.id), oncontextmenu: menu, onkeydown: e => { if (e.key === 'Enter') App.open(p.id); } },
      thumb,
      U.el('div.card-body', null,
        U.el('div.card-name', { text: p.name, title: p.name }),
        U.el('div.card-meta', { text: p.bpm + ' BPM  ·  ' + p.tracks.length + ' tracks  ·  ' + (end ? U.fmtDur(end) : 'empty') }),
        U.el('div.card-date', { text: 'Edited ' + U.fmtDate(p.modified) })),
      U.el('button.icon-btn.card-menu', { html: ICON.dots, title: 'Project options', onclick: menu }));
  },

  // Miniature of the arrangement: one bar per clip, coloured by track.
  thumb(cv, p, end) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, n = Math.max(4, p.tracks.length), rh = H / n;
    g.fillStyle = '#121416';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.025)';
    for (let i = 0; i < n; i += 2) g.fillRect(0, i * rh, W, rh);
    if (!end) return;
    p.tracks.forEach((t, i) => {
      g.fillStyle = t.color;
      for (const c of p.clips) {
        if (c.trackId !== t.id) continue;
        g.globalAlpha = c.mute ? 0.3 : 0.9;
        g.fillRect(c.start / end * W, i * rh + 2, Math.max(2, c.len / c.rate / end * W - 1), rh - 4);
      }
    });
    g.globalAlpha = 1;
  },

  async rename(p) {
    const name = await UI.prompt('Rename project', p.name, 'Rename');
    if (!name) return;
    p.name = name;
    await DB.put(p);
    this.render();
  },

  async duplicate(p) {
    const copy = JSON.parse(JSON.stringify(p));
    copy.id = U.uid('proj');
    copy.name = p.name + ' copy';
    copy.created = copy.modified = Date.now();
    await DB.put(copy);
    this.show();
  },

  async remove(p) {
    if (!await UI.confirm('Delete project', '“' + p.name + '” and any audio only it uses will be removed from this browser. This cannot be undone.', 'Delete', true)) return;
    await DB.del(p.id);
    await DB.gc();
    this.show();
  },
};
