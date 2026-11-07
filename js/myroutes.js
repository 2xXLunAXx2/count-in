// Pure logic for personal routes: the trips you really take, step by step.
import { norm, parseClock } from './util.js';

export const LEG_KINDS = { walk: 'Walk', train: 'Train', bus: 'Bus', car: 'Lift', stop: 'Stop' };
export const isTransit = leg => leg.kind === 'train' || leg.kind === 'bus' || leg.kind === 'car';
// Time spent waiting for a ride is logged under its own id, so it never changes the ride's average.
export const waitId = legId => `${legId}~wait`;

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function daysFromLabel(label) {
  const days = new Set();
  for (const part of label.toLowerCase().split(',').map(p => p.trim())) {
    const [a, b] = part.split(/\s*-\s*/).map(x => DAY_NAMES.indexOf(x.slice(0, 3)));
    if (a < 0 || (b !== undefined && b < 0)) throw new Error(`"${part}" is not a day. Use sun, mon, tue, wed, thu, fri or sat.`);
    if (b === undefined) days.add(a);
    else for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break; }
  }
  return days;
}

// Lines can start with days, as in "sun-thu: 07:12, 07:42" and "fri: 08:00". A day no line
// mentions has no service. Times with no days apply to every day. With no weekday given,
// every line is checked and all its times returned.
export function parseDepartures(text, weekday = null) {
  const lines = (text || '').split(/[\n;]+/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const labelled = /^([a-z][a-z\s,-]*):\s*(.*)$/i.exec(line);
    const days = labelled ? daysFromLabel(labelled[1]) : null;
    const times = parseTimes(labelled ? labelled[2] : line);
    if (weekday === null || !days || days.has(weekday)) out.push(...times);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Accepts "07:12, 07:42" or "every 30 from 07:12 to 22:00".
function parseTimes(text) {
  const s = (text || '').trim();
  if (!s) return [];
  const every = /^every\s+(\d+)\s*(?:min\w*)?\s+from\s+(\d{1,2}:\d{2})(?:\s+(?:to|until)\s+(\d{1,2}:\d{2}))?$/i.exec(s);
  if (every) {
    const gap = +every[1], from = parseClock(every[2]), to = every[3] ? parseClock(every[3]) : 1439;
    if (gap < 1) throw new Error('The gap between departures has to be at least 1 minute.');
    const out = [];
    for (let t = from; t <= to; t += gap) out.push(t);
    return out;
  }
  const times = s.split(/[,\s]+/).filter(Boolean).map(part => {
    const t = parseClock(part);
    if (t == null) throw new Error(`"${part}" is not a time. Write times like 07:12, 07:42 or "every 30 from 07:12".`);
    return t;
  });
  return times.sort((a, b) => a - b);
}

// null means no schedule, so no waiting. An empty list means no service that day.
const departuresOf = (leg, weekday) => {
  if (!isTransit(leg) || !leg.times?.trim()) return null;
  try { return parseDepartures(leg.times, weekday ?? null); } catch { return null; }
};

// Average logged minutes per step, rounded up so estimates lean toward being on time.
export function legStats(samples = []) {
  const totals = new Map();
  for (const s of samples) {
    const t = totals.get(s.legId) || { sum: 0, count: 0 };
    t.sum += s.minutes; t.count++;
    totals.set(s.legId, t);
  }
  return new Map([...totals].map(([id, t]) => [id, { avg: Math.ceil(t.sum / t.count), count: t.count }]));
}

export const legMinutes = (leg, stats) => stats.get(leg.id)?.avg ?? (+leg.minutes || 0);
const activeLegs = (route, on = []) => route.legs.filter(l => !l.optional || on.includes(l.id));

export const legLabel = leg => leg.label?.trim() || LEG_KINDS[leg.kind];

function toLeg(leg, dep, arr, stats, route) {
  const label = legLabel(leg);
  const base = { legId: leg.id, routeId: route.id, dep, arr, min: arr - dep, label, from: '', to: '', logged: stats.get(leg.id)?.count || 0, optional: !!leg.optional };
  if (isTransit(leg)) return { ...base, type: 'ride', mode: leg.kind, line: label, text: `${label}, ${arr - dep} min` };
  if (leg.kind === 'stop') return { ...base, type: 'stop', text: `${label}, ${arr - dep} min` };
  return { ...base, type: 'walk', text: `${label}, ${arr - dep} min` };
}

// Follows a route from a start time, waiting wherever a departure time is set.
export function travelFrom(route, start, stats, on, weekday) {
  let t = start;
  const legs = [];
  for (const leg of activeLegs(route, on)) {
    const m = legMinutes(leg, stats);
    const deps = departuresOf(leg, weekday);
    const dep = deps ? deps.find(d => d >= t) : t;
    if (dep === undefined) return null;
    legs.push(toLeg(leg, dep, dep + m, stats, route));
    t = dep + m;
  }
  if (!legs.length) return null;
  return { routeId: route.id, name: route.name, depart: legs[0].dep, arrive: t, legs, rides: legs.filter(l => l.type === 'ride').length };
}

// The last moment to set off and still arrive by the deadline.
export function latestStart(route, deadline, stats, on, weekday) {
  let t = deadline;
  for (const leg of [...activeLegs(route, on)].reverse()) {
    const m = legMinutes(leg, stats);
    const deps = departuresOf(leg, weekday);
    if (deps) {
      const d = [...deps].reverse().find(x => x + m <= t);
      if (d === undefined) return null;
      t = d;
    } else t -= m;
  }
  return t;
}

export const routesBetween = (routes, from, to) => routes.filter(r => norm(r.from) === norm(from) && norm(r.to) === norm(to));

export const reversedRoute = (route, makeId) => ({
  id: makeId(), from: route.to, to: route.from, name: route.name, preferred: false,
  legs: [...route.legs].reverse().map(l => ({ ...l, id: makeId(), times: '' })),
});

// Picks between your routes, then falls back to timetables for places with none.
// `choices` holds what you chose for a particular day and trip.
export function makeRouter({ routes = [], samples = [], choices = {}, dayKey = '', weekday, knows = () => false, fallback = null }) {
  const stats = legStats(samples);
  const keyOf = (from, to) => `${dayKey}|${norm(from)}>${norm(to)}`;
  const decorate = (from, to, journeys, best) => {
    const key = keyOf(from, to);
    const on = choices[key]?.on || [];
    const route = routes.find(r => r.id === best.routeId);
    return {
      ...best, choiceKey: key,
      alternatives: journeys.map(j => ({ routeId: j.routeId, name: j.name, depart: j.depart, arrive: j.arrive, chosen: j.routeId === best.routeId })),
      optionalLegs: route.legs.filter(l => l.optional).map(l => ({ id: l.id, label: legLabel(l), minutes: legMinutes(l, stats), on: on.includes(l.id) })),
    };
  };
  // Order: your choice for this trip, then a route made for this time of day, then your usual, then the best.
  const pick = (from, to, journeys, better) => {
    const chosenId = choices[keyOf(from, to)]?.routeId;
    const ofJourney = j => routes.find(r => r.id === j.routeId);
    const preferred = routes.find(r => r.preferred && journeys.some(j => j.routeId === r.id));
    return journeys.find(j => j.routeId === chosenId) || journeys.find(j => ofJourney(j)?.arriveBefore)
      || journeys.find(j => j.routeId === preferred?.id) || [...journeys].sort(better)[0];
  };
  // `eventStart` is when the event begins, which can be later than the deadline when arriving early.
  const arriveOptions = (from, to, deadline, eventStart = deadline) => {
    const on = choices[keyOf(from, to)]?.on || [];
    return routesBetween(routes, from, to).map(r => {
      const limit = parseClock(r.arriveBefore);
      if (limit != null && eventStart >= limit) return null;
      // A route made for this time of day only has to beat the event itself. Missing the
      // arrive-early margin by a minute should not mean a bus an hour sooner.
      const start = latestStart(r, limit != null ? eventStart : deadline, stats, on, weekday);
      return start == null ? null : travelFrom(r, start, stats, on, weekday);
    }).filter(Boolean);
  };
  return {
    knows,
    arriveOptions,
    arriveBy(from, to, deadline, eventStart) {
      const list = arriveOptions(from, to, deadline, eventStart);
      if (list.length) return decorate(from, to, list, pick(from, to, list, (a, b) => b.depart - a.depart));
      return routesBetween(routes, from, to).length ? null : (fallback?.arriveBy(from, to, deadline) ?? null);
    },
    departAfter(from, to, after) {
      const on = choices[keyOf(from, to)]?.on || [];
      const list = routesBetween(routes, from, to).map(r => {
        const j = travelFrom(r, after, stats, on, weekday);
        const limit = parseClock(r.arriveBefore);
        return j && (limit == null || j.arrive < limit) ? j : null;
      }).filter(Boolean);
      if (list.length) return decorate(from, to, list, pick(from, to, list, (a, b) => a.arrive - b.arrive));
      return routesBetween(routes, from, to).length ? null : (fallback?.departAfter(from, to, after) ?? null);
    },
  };
}

// Finds which of your places a calendar location or title refers to.
export function placeFromText(places, text, { exact = false } = {}) {
  const t = norm(text);
  if (!t) return '';
  const namesOf = p => [p.name, ...(p.aliases || [])].map(norm).filter(Boolean);
  const hit = places.find(p => namesOf(p).includes(t));
  if (hit || exact) return hit?.name || '';
  return places.find(p => namesOf(p).some(n => t.includes(n)))?.name || '';
}
