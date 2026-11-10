// App state plus persistence in IndexedDB, which can hold large timetables.
const openDb = () => new Promise((res, rej) => {
  const r = indexedDB.open('count-in', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
let dbp;
const tx = async (mode, fn) => {
  const db = await (dbp ||= openDb());
  return new Promise((res, rej) => {
    const t = db.transaction('kv', mode);
    const out = fn(t.objectStore('kv'));
    t.oncomplete = () => res(out.result);
    t.onerror = () => rej(t.error);
  });
};

const PERSISTED = ['mode', 'settings', 'calendars', 'events', 'categories', 'appliedRules', 'history', 'feeds', 'demo', 'route', 'walkLog', 'places', 'myRoutes', 'lines', 'legSamples', 'routeChoices', 'trip', 'feedChanges', 'cloudBase'];

export const state = {
  mode: 'demo',
  settings: { clientId: '', weekStart: 0, theme: 'auto', quiet: { on: false, from: '22:30', to: '06:00', mode: 'earlier' }, hiddenCats: [], hiddenCals: [], transfer: 4, home: '', placeAliases: {}, skippedOps: {} },
  calendars: [], events: [], categories: [], appliedRules: null, history: [], feeds: [], demo: null, walkLog: [],
  places: [], myRoutes: [], lines: [], legSamples: [], routeChoices: {}, trip: null, feedChanges: [],
  route: { from: '', to: '', date: '', time: '', early: 5 },
  view: { page: 'calendar', cal: 'week', anchor: Date.now(), planDay: null },
  sync: { status: 'idle', at: 0, error: '' },
  // What this device and your Google Drive last agreed on, and how sharing them is going.
  cloudBase: null, cloud: { status: 'idle', at: 0, error: '' },
};

export async function loadState() {
  await Promise.all(PERSISTED.map(async k => {
    const v = await tx('readonly', s => s.get(k));
    if (v === undefined) return;
    state[k] = k === 'settings' || k === 'route' ? { ...state[k], ...v } : v;
  }));
}

const saveHooks = new Set();
export const onSave = fn => saveHooks.add(fn);

export function save(...keys) {
  if (window.COUNTIN_TEST) return; // the test page shares this site's storage with the app
  const list = keys.length ? keys : PERSISTED;
  for (const k of list) {
    tx('readwrite', s => s.put(state[k], k)).catch(e => console.error('Could not save', k, e));
  }
  saveHooks.forEach(fn => fn(list));
}

const listeners = new Set();
export const subscribe = fn => listeners.add(fn);
export const emit = () => listeners.forEach(fn => fn());
