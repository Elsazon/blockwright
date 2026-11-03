/* Project storage — IndexedDB, because a build is far too big for localStorage. */
const DB = 'blockwright', STORE = 'projects', VER = 1;
let dbP = null;

function open() {
  if (dbP) return dbP;
  dbP = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('updated', 'updated');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbP;
}
function tx(mode) {
  return open().then(db => db.transaction(STORE, mode).objectStore(STORE));
}
function wrap(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

export async function save(p) {
  const store = await tx('readwrite');
  const rec = {
    name: p.name, W: p.W, H: p.H, L: p.L,
    palette: p.palette, states: p.states, updated: Date.now()
  };
  if (p.id != null) rec.id = p.id;
  return wrap(store.put(rec));
}
export async function list() {
  const store = await tx('readonly');
  const all = await wrap(store.getAll());
  return all
    .map(({ id, name, W, H, L, updated }) => ({ id, name, W, H, L, updated }))
    .sort((a, b) => b.updated - a.updated);
}
export async function get(id) {
  const store = await tx('readonly');
  return wrap(store.get(id));
}
export async function remove(id) {
  const store = await tx('readwrite');
  return wrap(store.delete(id));
}
export async function last() {
  const all = await list();
  if (!all.length) return null;
  return get(all[0].id);
}
