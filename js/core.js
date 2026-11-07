// Everything that changes the calendar goes through here.
import { state, save, emit } from './store.js';
import { google, NeedsSignIn, Conflict } from './google.js';
import { demo, SAMPLE_CALENDAR_IDS } from './demo.js';
import { ensureCategories, pruneCategories, computeOps, makeCtx, categoryFor, effectiveCategory, writable, withoutSkipped, opKey, GOOGLE_COLORS } from './rules.js';
import { buildNetwork, planArrival, planDeparture } from './transit.js';
import { makeRouter } from './myroutes.js';
import { addDays, startOfDay, sleep, fmtClock, norm, ymd, MIN } from './util.js';

export const backend = () => (state.mode === 'google' ? google : demo);
export const ctx = () => makeCtx({ categories: state.categories, calendars: state.calendars, quiet: state.settings.quiet, skipped: state.settings.skippedOps });
export const calById = id => state.calendars.find(c => c.id === id);
export const catOf = ev => effectiveCategory(categoryFor(ev, state.categories), state.categories);
export const colorOf = ev => ev.ext?.color || catOf(ev)?.color || (ev.colorId && GOOGLE_COLORS[ev.colorId]?.[1]) || calById(ev.calId)?.color || '#616161';
export const visibleEvents = () => {
  const hiddenCats = new Set(state.settings.hiddenCats);
  return state.events.filter(e => {
    if (calById(e.calId)?.on === false) return false;
    const c = catOf(e);
    return !hiddenCats.has(c?.id) && !hiddenCats.has(c?.parentId);
  });
};

let net = null, netKey = null;
export function network() {
  const key = `${state.feeds.map(f => f.id).join()}|${state.walkLog.map(w => w.id).join()}`;
  if (!net || key !== netKey) { net = buildNetwork(state.feeds, state.walkLog); netKey = key; }
  return net;
}

// Every place you can travel between: your own, plus stops from any timetables.
export const placeNames = () => [...new Set([...state.places.map(p => p.name), ...network().names])];
export const isKnownPlace = name => placeNames().some(n => norm(n) === norm(name));

// Your routes for a given day, falling back to timetables where you have none.
export function routerFor(dayMs) {
  const net = network(), transfer = +state.settings.transfer || 4;
  return makeRouter({
    routes: state.myRoutes, samples: state.legSamples, choices: state.routeChoices, dayKey: ymd(dayMs), weekday: new Date(dayMs).getDay(), knows: isKnownPlace,
    fallback: {
      arriveBy: (from, to, deadline) => { try { return planArrival(net, { from, to, dateMs: dayMs, arriveBy: deadline, transfer, options: 2 })[0] || null; } catch { return null; } },
      departAfter: (from, to, after) => { try { return planDeparture(net, { from, to, dateMs: dayMs, departAfter: after, transfer }); } catch { return null; } },
    },
  });
}

// "Bus 22" when the timetable just says "22"; a line already named "Bus 22" is not doubled.
export const lineName = l => {
  const word = l.mode === 'train' ? 'Train' : 'Bus';
  return l.line.toLowerCase().startsWith(word.toLowerCase()) ? l.line : `${word} ${l.line}`;
};

// Saves a journey as a calendar event that notifies you 10 minutes before you leave.
export async function addTravelEvent(journey, { dateMs, to }) {
  const cal = state.calendars.find(c => c.primary && writable(c)) || state.calendars.find(writable);
  if (!cal) throw new Error('None of your calendars can be edited.');
  const steps = journey.legs.map(l => (l.legId ? `${fmtClock(l.dep)} ${l.text}` : l.type === 'walk' ? `${fmtClock(l.dep)} Walk ${l.min} min to ${l.to}` : `${fmtClock(l.dep)} ${lineName(l)} from ${l.from}, off at ${l.to} ${fmtClock(l.arr)}`)).join('\n');
  const start = dateMs + journey.depart * MIN, end = dateMs + journey.arrive * MIN;
  return createEvent(cal.id, {
    summary: `Travel to ${to}`, description: steps, colorId: '8',
    ...timeBody(null, start, end, false),
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    extendedProperties: { private: { countinManual: '1', countinTravelTo: to } },
  });
}

const SYNC_BACK = 45, SYNC_AHEAD = 200;
let syncing = null;
let generation = 0;

// Changes between the sample and Google. A sync still running for the old one is
// abandoned, so it can never write the old calendar's data over the new one.
export function switchBackend(mode) {
  generation++;
  syncing = null;
  state.mode = mode;
}

// Clears sample data saved alongside a Google connection, without needing a live sign-in.
export function dropSampleData() {
  if (state.mode !== 'google') return;
  const sample = new Set(SAMPLE_CALENDAR_IDS);
  state.calendars = state.calendars.filter(c => !sample.has(c.id));
  state.events = state.events.filter(e => !sample.has(e.calId));
  state.categories = pruneCategories(state.categories, state.calendars);
  save('calendars', 'events', 'categories');
}

export function sync() {
  if (syncing) return syncing;
  const gen = generation;
  const run = (async () => {
    state.sync = { ...state.sync, status: 'syncing', error: '' };
    emit();
    try {
      const b = backend();
      const prev = new Map(state.calendars.map(c => [c.id, c.on]));
      const calendars = await b.listCalendars();
      const from = addDays(startOfDay(Date.now()), -SYNC_BACK), to = addDays(startOfDay(Date.now()), SYNC_AHEAD);
      const merged = calendars.map(c => ({ ...c, on: prev.has(c.id) ? prev.get(c.id) : c.on !== false }));
      const lists = await Promise.all(merged.filter(c => c.on).map(c => b.listEvents(c.id, from, to)));
      if (gen !== generation) return;
      state.calendars = merged;
      state.events = lists.flat().sort((x, y) => x.startMs - y.startMs);
      state.categories = ensureCategories(state.events, state.calendars, pruneCategories(state.categories, state.calendars));
      state.sync = { status: 'ok', at: Date.now(), error: '' };
      save('calendars', 'events', 'categories');
    } catch (e) {
      if (gen !== generation) return;
      state.sync = { ...state.sync, status: e instanceof NeedsSignIn ? 'signin' : 'error', error: e.message };
    }
    syncing = null;
    emit();
  })();
  syncing = run;
  return run;
}

function replaceLocal(ev) {
  const i = state.events.findIndex(e => e.id === ev.id && e.calId === ev.calId);
  if (i >= 0) state.events[i] = ev; else state.events.push(ev);
  state.events.sort((x, y) => x.startMs - y.startMs);
  save('events');
}

const timeBody = (ev, startMs, endMs, allDay) => {
  if (allDay) {
    const d = t => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    return { start: { date: d(startMs) }, end: { date: d(endMs) } };
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { start: { dateTime: new Date(startMs).toISOString(), timeZone }, end: { dateTime: new Date(endMs).toISOString(), timeZone } };
};
export { timeBody };

let renewer = null;
export const setSessionRenewer = fn => { renewer = fn; };

// A change made after Google's hourly sign-in ran out waits for a new one and retries,
// so it is saved, or else clearly reported as not saved.
async function withSession(call) {
  try { return await call(); } catch (e) {
    if (!(e instanceof NeedsSignIn) || !renewer) throw e;
  }
  await renewer();
  try { return await call(); } catch (e) {
    if (!(e instanceof NeedsSignIn)) throw e;
    state.sync = { ...state.sync, status: 'signin', error: e.message };
    emit();
    throw new Error('Not saved: your Google sign-in ended. Click Reconnect, then save again.');
  }
}

// Saves a change to one event, or to its whole series.
export async function patchEvent(ev, patch, scope = 'one') {
  const b = backend();
  if (scope === 'series' && ev.recurringEventId) {
    const body = { ...patch };
    if (patch._startMs !== undefined) {
      // Shift the series by the same amount this instance moved, keeping its first date.
      const master = await withSession(() => b.getEvent(ev.calId, ev.recurringEventId));
      const delta = patch._startMs - ev.startMs, dur = patch._endMs - patch._startMs;
      const ms = Date.parse(master.start.dateTime) + delta;
      Object.assign(body, timeBody(ev, ms, ms + dur, false));
    }
    delete body._startMs; delete body._endMs;
    await withSession(() => b.patchEvent(ev.calId, ev.recurringEventId, body));
    await sync();
    return;
  }
  const body = { ...patch };
  if (patch._startMs !== undefined) Object.assign(body, timeBody(ev, patch._startMs, patch._endMs, patch._allDay ?? ev.allDay));
  delete body._startMs; delete body._endMs; delete body._allDay;
  try {
    replaceLocal(await withSession(() => b.patchEvent(ev.calId, ev.id, body, ev.etag)));
    state.categories = ensureCategories(state.events, state.calendars, state.categories);
    save('categories');
  } catch (e) {
    if (e instanceof Conflict) await sync();
    throw e;
  }
  emit();
}

export async function createEvent(calId, body) {
  const ev = await withSession(() => backend().createEvent(calId, body));
  // Google answers a repeating event with the series itself, so the dates come from a sync.
  if (body.recurrence) { await sync(); return ev; }
  replaceLocal(ev);
  state.categories = ensureCategories(state.events, state.calendars, state.categories);
  save('categories');
  emit();
  return ev;
}

export async function deleteEvent(ev, scope = 'one') {
  await withSession(() => backend().deleteEvent(ev.calId, scope === 'series' ? ev.recurringEventId : ev.id));
  if (scope === 'series') await sync();
  else {
    state.events = state.events.filter(e => !(e.id === ev.id && e.calId === ev.calId));
    save('events');
    emit();
  }
}

export async function setCalendarDefaults(calId, minutes) {
  await backend().setCalendarDefaults(calId, minutes);
  await sync();
}

const allOps = () => computeOps(state.events, ctx(), Date.now());
export const pendingOps = () => withoutSkipped(allOps(), state.settings.skippedOps);
export const skippedCount = () => allOps().length - pendingOps().length;

// Stops offering a change until the rule asks for something different.
export function skipOp(op) {
  state.settings.skippedOps = { ...state.settings.skippedOps, [op.targetId]: opKey(op) };
  save('settings');
  emit();
}

export function clearSkipped() {
  state.settings.skippedOps = {};
  save('settings');
  emit();
}

// Writes the rules to Google. Every write is recorded first, so the batch can be undone.
export async function applyOps(ops, onProgress = () => {}) {
  const b = backend();
  const entry = { at: Date.now(), done: [], colors: state.categories.map(c => ({ id: c.id, colorId: c.colorId, pendingColorId: c.pendingColorId })) };
  let failed = 0, firstError = '';
  const run = async list => {
    for (const op of list) {
      try {
        await b.patchEvent(op.calId, op.targetId, op.patch);
        entry.done.push({ calId: op.calId, targetId: op.targetId, undo: { ...(op.patch.reminders ? { reminders: op.undo.reminders } : {}), ...(op.patch.colorId ? { colorId: op.undo.colorId } : {}) } });
      } catch (e) {
        if (e instanceof NeedsSignIn) { failed += list.length; firstError = e.message; break; }
        failed++;
        firstError ||= `${op.title}: ${e.message}`;
      }
      onProgress(entry.done.length + failed);
      await sleep(state.mode === 'google' ? 110 : 0);
    }
  };
  await run(ops);
  await sync();
  // A series write does not reach individually edited instances, so catch those now,
  // but only in the series you chose to save.
  if (!failed) {
    const chosenSeries = new Set(ops.filter(o => o.isSeries).map(o => o.targetId));
    const leftovers = computeOps(state.events, ctx(), Date.now(), { instanceOnly: true }).filter(o => chosenSeries.has(o.seriesId));
    if (leftovers.length) { await run(leftovers); await sync(); }
  }
  if (!failed) {
    // A color change is finished only once no event is still waiting for it.
    const waiting = new Set(allOps().map(o => o.color).filter(Boolean));
    for (const c of state.categories) {
      if (!c.pendingColorId || waiting.has(c.pendingColorId)) continue;
      if (c.colorId) c.colorId = c.pendingColorId;
      c.pendingColorId = null;
    }
  }
  if (entry.done.length) state.history = [entry, ...state.history].slice(0, 5);
  save('categories', 'history');
  emit();
  return { done: entry.done.length, failed, error: firstError };
}

export async function undoLastApply() {
  const entry = state.history[0];
  if (!entry) return { done: 0, failed: 0 };
  let done = 0, failed = 0;
  for (const u of entry.done) {
    try { await backend().patchEvent(u.calId, u.targetId, u.undo); done++; } catch { failed++; }
    await sleep(state.mode === 'google' ? 110 : 0);
  }
  state.history = state.history.slice(1);
  // Only the calendar goes back, plus which color each category follows so its events still
  // match. Your rules, names and sub-categories stay, and the undone changes are offered again.
  for (const saved of entry.colors || []) {
    const c = state.categories.find(x => x.id === saved.id);
    if (c) { c.colorId = saved.colorId; c.pendingColorId = saved.pendingColorId; }
  }
  save('history', 'categories');
  await sync();
  return { done, failed };
}
