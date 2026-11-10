// Plan a trip on the whole official timetable, like Moovit, from any stop or one of your places.
// The search runs in the helper on the computer (planner.py), so this shows only there.
import { state, save, emit } from '../store.js';
import { h, uid, norm, ymd, fmtClock, parseClock } from '../util.js';
import { isTransit } from '../myroutes.js';
import { planTrip, lineLabel } from '../feed.js';
import { dialog, toast, icon } from '../ui.js';
import { stopPicker, syncTimetable } from './myroutes.js';

const trip = { from: null, to: null, date: '', time: '', arriveBy: false, results: null, busy: false, error: '' };

// The stops a place is reached from, learned from your routes: the first stop a route from it
// uses, with the walk before it, and the last stop of a route to it, with the walk after.
export function placeStops(routes, place) {
  const out = new Map();
  const add = (stop, walk) => { if (stop && !(out.get(stop.key)?.walk <= walk)) out.set(stop.key, { key: stop.key, name: stop.name, walk }); };
  // Only stops you walk to count: one reached by a lift or a taxi is not near the place.
  const walked = legs => (legs.every(l => l.kind === 'walk') ? legs.reduce((m, l) => m + (+l.minutes || 0), 0) : null);
  for (const r of routes) {
    const fed = (l, side) => [l, ...(l.alts || [])].map(o => (o.feed || l.feed)?.[side]).filter(Boolean);
    if (norm(r.from) === norm(place)) {
      const i = r.legs.findIndex(l => l.feed), walk = i >= 0 ? walked(r.legs.slice(0, i)) : null;
      if (walk != null) for (const s of fed(r.legs[i], 'from')) add(s, walk);
    }
    if (norm(r.to) === norm(place)) {
      const i = r.legs.map(l => !!l.feed).lastIndexOf(true), walk = i >= 0 ? walked(r.legs.slice(i + 1)) : null;
      if (walk != null) for (const s of fed(r.legs[i], 'to')) add(s, walk);
    }
  }
  return [...out.values()];
}

// Your places with known stops, for one tap.
const knownPlaces = () => state.places.map(p => p.name).filter(n => placeStops(state.myRoutes, n).length);

// A finished trip as one of your routes, each ride linked to the official timetable.
export function journeyRoute(j, fromName, toName) {
  const legs = j.legs.map((l, i) => (l.type === 'walk'
    ? { id: uid(), kind: 'walk', label: i === 0 ? 'Walk to the stop' : i === j.legs.length - 1 ? `Walk to ${toName}` : 'Walk to the next stop', minutes: l.minutes, times: '', optional: false }
    : { id: uid(), kind: l.mode, label: lineLabel({ mode: l.mode, name: l.line }), minutes: l.arr - l.dep, times: '', optional: false, feedLine: l.lineId, feed: { from: l.from, to: l.to } }));
  return { id: uid(), from: fromName, to: toName, name: legs.filter(isTransit).map(l => l.label).join(', '), preferred: false, legs };
}

function endPicker(side, label) {
  const chosen = trip[side];
  const places = knownPlaces();
  return h('div', { class: 'field grow trip-end' },
    places.length ? h('div', { class: 'chips' }, h('span', { class: 'field-label' }, label),
      places.map(name => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(chosen?.place === name), onclick: () => {
        trip[side] = { place: name, name, ends: placeStops(state.myRoutes, name) };
        trip.results = null;
        emit();
      } }, name))) : null,
    stopPicker(places.length ? 'Or a stop' : label, chosen && !chosen.place ? chosen.stop : null, s => {
      trip[side] = s ? { stop: s, name: s.en || s.name, ends: [{ key: s.key, walk: 0 }] } : null;
      trip.results = null;
    }));
}

async function search(later = null) {
  if (!trip.from || !trip.to) { trip.error = 'Choose where from and where to.'; emit(); return; }
  const date = trip.date || ymd(Date.now());
  const now = new Date();
  const time = later ?? parseClock(trip.time) ?? now.getHours() * 60 + now.getMinutes();
  Object.assign(trip, { busy: true, error: '' });
  emit();
  try {
    const { journeys } = await planTrip({ from: trip.from.ends, to: trip.to.ends, date, time, arriveBy: later == null && trip.arriveBy });
    trip.results = later == null ? journeys : [...(trip.results || []), ...journeys.filter(j => !(trip.results || []).some(r => r.depart === j.depart && r.arrive === j.arrive))];
    trip.searchedFor = { date };
  } catch (x) {
    trip.error = x.message;
  }
  trip.busy = false;
  emit();
}

function saveDialog(j) {
  const names = { from: trip.from.place || trip.from.name, to: trip.to.place || trip.to.name };
  const list = 'trip-save-places';
  const { close } = dialog(h('form', { class: 'confirm', onsubmit: e => {
    e.preventDefault();
    if (!names.from.trim() || !names.to.trim() || norm(names.from) === norm(names.to)) return;
    const route = journeyRoute(j, names.from.trim(), names.to.trim());
    state.myRoutes = [...state.myRoutes, route];
    for (const n of [route.from, route.to]) if (!state.places.some(p => norm(p.name) === norm(n))) state.places = [...state.places, { id: uid(), name: n, aliases: [] }];
    save('myRoutes', 'places');
    emit();
    close();
    syncTimetable();
    toast(`Added "${route.name}" to your routes. Its times arrive in a minute.`);
  } },
    h('h2', null, 'Save as a route'),
    h('p', { class: 'hint' }, 'Name the two places, so Day plan can use it for your events there.'),
    h('datalist', { id: list }, state.places.map(p => h('option', { value: p.name }))),
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'From'), h('input', { list, dir: 'auto', value: names.from, oninput: e => { names.from = e.target.value; } })),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'To'), h('input', { list, dir: 'auto', value: names.to, oninput: e => { names.to = e.target.value; } }))),
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary' }, 'Save route'))));
}

const duration = m => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

function journeyCard(j) {
  const changes = Math.max(0, j.rides - 1);
  return h('li', { class: 'trip-result' },
    h('div', { class: 'row between' },
      h('b', null, `${fmtClock(j.depart)} → ${fmtClock(j.arrive)}`),
      h('span', { class: 'hint' }, `${duration(j.arrive - j.depart)} · ${j.rides ? (changes ? `${changes} change${changes > 1 ? 's' : ''}` : 'no changes') : 'walk'}`)),
    h('ol', { class: 'trip-legs' }, j.legs.map(l => (l.type === 'walk'
      ? h('li', { class: 'hint' }, `${fmtClock(l.dep)} walk ${l.minutes} min`, l.toStop ? [' to ', h('bdi', null, l.toStop.name)] : '')
      : h('li', { class: `ride ${l.mode}` }, `${fmtClock(l.dep)} `, h('b', null, lineLabel({ mode: l.mode, name: l.line })), ' from ', h('bdi', null, l.from.name),
        ', off at ', h('bdi', null, l.to.name), ` ${fmtClock(l.arr)}`, l.headsign && !/^\d+$/.test(l.headsign) ? h('span', { class: 'hint' }, ' toward ', h('bdi', null, l.headsign.replace(/_/g, ' '))) : '')))),
    h('button', { type: 'button', class: 'link save-trip', onclick: () => saveDialog(j) }, 'Save as a route'));
}

export function tripPlannerCard() {
  if (!state.view.feed) return null;
  const ready = state.view.feed.planner?.ready !== false || trip.results;
  return h('section', { class: 'card trip-planner' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'Plan a trip'),
      h('p', { class: 'hint' }, 'Any stop to any stop on the official timetable, with changes and short walks, like Moovit. On this computer only.'))),
    h('div', { class: 'row gap wrap' }, endPicker('from', 'From'), endPicker('to', 'To')),
    h('div', { class: 'row gap wrap trip-when' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Leave or arrive' },
        h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(!trip.arriveBy), onclick: () => { trip.arriveBy = false; emit(); } }, 'Leave after'),
        h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(trip.arriveBy), onclick: () => { trip.arriveBy = true; emit(); } }, 'Arrive by')),
      h('input', { type: 'time', class: 'trip-time', value: trip.time, 'aria-label': 'Time', oninput: e => { trip.time = e.target.value; } }),
      h('input', { type: 'date', class: 'trip-date', value: trip.date || ymd(Date.now()), 'aria-label': 'Day', oninput: e => { trip.date = e.target.value; } }),
      h('button', { type: 'button', class: 'btn primary find-trips', disabled: trip.busy, onclick: () => search() }, trip.busy ? 'Searching' : 'Find trips')),
    !ready && !trip.busy ? h('p', { class: 'hint' }, state.view.feed.planner?.message || 'Preparing the trip planner.') : null,
    trip.error ? h('p', { class: 'form-error', role: 'alert' }, trip.error) : null,
    trip.results ? (trip.results.length
      ? [h('ol', { class: 'trip-results' }, trip.results.map(journeyCard)),
        h('button', { type: 'button', class: 'btn ghost later-trips', disabled: trip.busy, onclick: () => {
          const firstRide = j => j.legs.find(l => l.type === 'ride')?.dep ?? j.depart;
          search(Math.max(...trip.results.map(firstRide)) + 1);
        } }, 'Later trips')]
      : h('p', { class: 'hint' }, 'Nothing gets there within 5 hours of that time. Try another time or a nearby stop.')) : null);
}

// For tests: start over.
export const resetTrip = () => Object.assign(trip, { from: null, to: null, date: '', time: '', arriveBy: false, results: null, busy: false, error: '' });
export const tripState = trip;
