'use strict';

// IndexedDB: 'projects' holds project JSON, 'audio' holds the raw file bytes keyed by sample id,
// 'kits' holds saved drum kits. Upgrades only ever add stores, so existing projects are kept.
const DB = {
  _open: null,

  open() {
    if (!this._open) {
      this._open = new Promise((res, rej) => {
        const r = indexedDB.open('tapehead', 2);
        r.onupgradeneeded = () => {
          const db = r.result, has = n => db.objectStoreNames.contains(n);
          if (!has('projects')) db.createObjectStore('projects', { keyPath: 'id' });
          if (!has('audio')) db.createObjectStore('audio');
          if (!has('kits')) db.createObjectStore('kits', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return this._open;
  },

  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const rq = fn(t.objectStore(store));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  },

  list() { return this.tx('projects', 'readonly', s => s.getAll()); },
  get(id) { return this.tx('projects', 'readonly', s => s.get(id)); },
  put(p) { return this.tx('projects', 'readwrite', s => s.put(p)); },
  del(id) { return this.tx('projects', 'readwrite', s => s.delete(id)); },

  putAudio(id, rec) { return this.tx('audio', 'readwrite', s => s.put(rec, id)); },
  getAudio(id) { return this.tx('audio', 'readonly', s => s.get(id)); },

  kits() { return this.tx('kits', 'readonly', s => s.getAll()); },
  putKit(k) { return this.tx('kits', 'readwrite', s => s.put(k)); },
  delKit(id) { return this.tx('kits', 'readwrite', s => s.delete(id)); },

  // Drop audio that no remaining project or kit references.
  async gc() {
    const used = new Set();
    for (const p of await this.list()) for (const s of p.samples) used.add(s.id);
    for (const k of await this.kits()) for (const it of k.items) used.add(it.sampleId);
    const keys = await this.tx('audio', 'readonly', s => s.getAllKeys());
    for (const k of keys) if (!used.has(k)) await this.tx('audio', 'readwrite', s => s.delete(k));
  },
};
