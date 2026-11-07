// Keeps your routes, places, categories and timed trips the same on your phone and computer,
// through a hidden file in your Google Drive that only Count-in can open.
import { state, save, emit, onSave } from './store.js';
import { google, drive, NeedsSignIn, NeedsScope } from './google.js';

const FILE = 'count-in-sync.json';
const KEYS = ['categories', 'appliedRules', 'places', 'myRoutes', 'legSamples', 'routeChoices', 'trip', 'route'];
// Settings that describe your life rather than this screen. Theme and filters stay per device.
const SETTINGS = ['home', 'placeAliases', 'routeVersions', 'importedRoutes', 'skippedOps', 'quiet', 'transfer', 'placesAdded', 'doctorsAdded'];
// Merged field by field, so a change made on each device survives.
const BY_FIELD = new Set(['settings', 'routeChoices', 'route']);

// The same text for the same content, whatever order its fields were written in.
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x));
const same = (a, b) => canon(a) === canon(b);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isIdList = v => Array.isArray(v) && v.every(x => isPlain(x) && 'id' in x);

// Three-way merge against `base`, the copy both devices last agreed on. When both
// devices changed the same thing, the change made on this device wins.
export function merge3(base, local, remote, byField = false) {
  if (same(local, base) || same(local, remote)) return remote;
  if (same(remote, base)) return local;
  if (isIdList(local) && isIdList(remote)) return mergeList(base, local, remote);
  if (byField && isPlain(local) && isPlain(remote)) {
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const v = merge3(base?.[k], local[k], remote[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return local;
}

// Lists of things with ids, like routes and timed steps, merge item by item.
function mergeList(base, local, remote) {
  const was = new Map((isIdList(base) ? base : []).map(x => [x.id, x]));
  const mine = new Map(local.map(x => [x.id, x])), theirs = new Map(remote.map(x => [x.id, x]));
  return [...new Set([...theirs.keys(), ...mine.keys()])].flatMap(id => {
    const m = mine.get(id), t = theirs.get(id), b = was.get(id);
    if (m && t) return [merge3(b, m, t)];
    // Shared before and now missing on one side means it was removed there,
    // unless the other side has changed it since.
    return b && same(m || t, b) ? [] : [m || t];
  });
}

const pickSettings = s => Object.fromEntries(SETTINGS.filter(k => k in s).map(k => [k, s[k]]));
const snapshot = () => clone({ ...Object.fromEntries(KEYS.map(k => [k, state[k]])), settings: pickSettings(state.settings) });
const hasData = d => !!(d?.myRoutes?.length || d?.legSamples?.length);
const current = k => (k === 'settings' ? pickSettings(state.settings) : state[k]);

// The first time a device syncs there is nothing to compare with. A device with
// routes of its own never gives them up for an empty copy, and a new device with
// nothing yet takes what is in Drive instead of filling it with starter places.
function firstMerge(local, remote) {
  if (remote && (hasData(remote) || !hasData(local))) return { ...local, ...remote };
  return hasData(local) ? local : null;
}

let applying = false;

// Returns what both sides now agree on. A key changed while syncing is left alone,
// and compared again on the next sync.
function apply(merged, local) {
  const agreed = { ...merged }, changed = [];
  for (const k of Object.keys(merged)) {
    if (same(merged[k], local[k])) continue;
    if (!same(current(k), local[k])) { agreed[k] = local[k]; continue; }
    if (k === 'settings') Object.assign(state.settings, clone(merged.settings)); else state[k] = clone(merged[k]);
    changed.push(k);
  }
  if (changed.length) {
    applying = true;
    try { save(...changed); } finally { applying = false; }
    emit();
  }
  return agreed;
}

const setStatus = (status, error = '') => {
  state.cloud = { status, error, at: status === 'ok' ? Date.now() : state.cloud.at };
  emit();
};

async function run() {
  if (state.mode !== 'google' || !google.hasSession()) return;
  setStatus('syncing');
  try {
    const id = await drive.find(FILE);
    const remote = id ? (await drive.read(id))?.data || null : null;
    const local = snapshot(), base = state.cloudBase;
    const merged = !base ? firstMerge(local, remote)
      : !remote ? local
      : Object.fromEntries([...new Set([...Object.keys(local), ...Object.keys(remote)])].map(k => [k, merge3(base[k], local[k], remote[k], BY_FIELD.has(k))]));
    if (!merged) { setStatus('waiting'); return; }
    const agreed = apply(merged, local);
    if (!remote || !same(merged, remote)) await drive.write(id, FILE, { version: 1, savedAt: Date.now(), data: merged });
    state.cloudBase = agreed;
    applying = true;
    try { save('cloudBase'); } finally { applying = false; }
    setStatus('ok');
  } catch (e) {
    setStatus(e instanceof NeedsSignIn ? 'signin' : e instanceof NeedsScope ? 'scope' : 'error', e.message);
  }
}

let running = null, again = false;
export function cloudSync() {
  if (running) { again = true; return running; }
  running = run().finally(() => {
    running = null;
    if (again) { again = false; cloudSync(); }
  });
  return running;
}

// Changes go up a couple of seconds after you make them, so a burst of edits is one upload.
let timer = null;
onSave(keys => {
  if (applying || !keys.some(k => k === 'settings' || KEYS.includes(k))) return;
  clearTimeout(timer);
  timer = setTimeout(cloudSync, 2000);
});
