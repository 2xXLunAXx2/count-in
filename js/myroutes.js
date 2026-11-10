// Pure logic for personal routes: the trips you really take, step by step.
import { norm, parseClock } from './util.js';

export const LEG_KINDS = { walk: 'Walk', train: 'Train', bus: 'Bus', car: 'Lift', stop: 'Stop' };
export const isTransit = leg => leg.kind === 'train' || leg.kind === 'bus' || leg.kind === 'car';
// Time spent waiting for a ride is logged under its own id, so it never changes the ride's average.
export const waitId = legId => `${legId}~wait`;
// A step can be served by other lines too, like bus 66 and bus 69, each with its own times.
// Rides on one are logged under its own id, so each line keeps its own average.
export const altId = (legId, alt) => `${legId}~${alt}`;
export const hasAlts = leg => (leg.kind === 'bus' || leg.kind === 'train') && !!leg.alts?.length;
// Steps linked to the official timetable that have no trips yet, counted per way of riding.
export const missingTimes = routes => routes.reduce((n, r) => n + r.legs.reduce((m, l) => m + legOptions(l).filter(o => isTransit(o) && o.feed && !o.trips).length, 0), 0);

// Every way to ride a step, the step itself first, each shaped like a step of its own.
// Another way can be a lift too, and can be one you have only sometimes (`optional`, ticked
// per trip in Day plan), or only until a time (`until`), like Dad at the station before 19:00.
export const legOptions = leg => [leg, ...(hasAlts(leg) ? leg.alts.map(a => ({
  ...leg, id: altId(leg.id, a.id), label: a.name, kind: a.kind || leg.kind, minutes: a.minutes, times: a.times || '', lineId: undefined, line: null, alts: [], alt: a.id,
  // A line can have stops of its own, like a bus home that stops a street away from another.
  feed: a.feedLine ? a.feed || leg.feed : undefined, feedLine: a.feedLine, trips: a.trips || null, feedDate: a.feedDate,
  // `allTheWay`: it takes you to the end, like a lift home, so the steps after it are skipped.
  optional: !!a.optional, until: a.until || null, allTheWay: !!a.allTheWay,
})) : [])];
// The ways to ride a step on this trip: one you have only sometimes counts when ticked.
const usableOptions = (step, on = []) => legOptions(step).filter(o => !(o.alt && o.optional) || on.includes(o.id));

/* A step filled from the official timetable keeps each line's trips for the coming week,
   `trips[weekday] = [[departure, ride], ...]`, since a train's ride depends on its stops. */
const fromFeed = leg => isTransit(leg) && !!leg.trips;
const tripsOf = (leg, weekday) => (weekday == null ? Object.values(leg.trips).flat() : leg.trips[weekday] || [])
  .map(([dep, ride]) => ({ dep, ride }));
// The usual ride of a line from the timetable, for lists and rough sums.
export const typicalRide = leg => {
  const rides = Object.values(leg.trips || {}).flat().map(t => t[1]).sort((a, b) => a - b);
  return rides.length ? rides[Math.floor(rides.length / 2)] : null;
};
// What the timetable said a ride boarded at `atMin` would take, to compare a timed ride with.
export function timetabledRide(leg, weekday, atMin) {
  if (onLine(leg)) return plannedRide(leg.line, leg.board, leg.alight, weekday, atMin);
  if (!fromFeed(leg)) return null;
  const deps = tripsOf(leg, weekday);
  if (!deps.length) return typicalRide(leg);
  return deps.reduce((best, d) => (Math.abs(d.dep - atMin) < Math.abs(best.dep - atMin) ? d : best)).ride;
}

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

/* A line is a train or bus you take often: its stations in order, and the services that run
   on it, such as all stops and fast. Each service has minutes from the line's first station,
   blank where it skips a station, the same both ways. It lists departures from its own first
   stop going there and from its own last stop coming back. */
const stationIndex = (line, name) => line.stations.findIndex(s => norm(s) === norm(name));

// Every departure from `board` that stops at `alight`, with how long the ride takes.
export function lineDepartures(line, board, alight, weekday = null) {
  const b = stationIndex(line, board), a = stationIndex(line, alight);
  if (b < 0 || a < 0 || a === b) return [];
  const out = [];
  for (const s of line.services || []) {
    const m = s.minutes || [];
    if (m[b] == null || m[a] == null) continue;
    const stops = m.map((x, i) => (x == null ? null : i)).filter(i => i != null);
    const there = b < a, origin = there ? stops[0] : stops[stops.length - 1];
    let times = [];
    try { times = parseDepartures(there ? s.there : s.back, weekday); } catch { /* checked in the editor */ }
    const offset = Math.abs(m[b] - m[origin]), ride = Math.abs(m[a] - m[b]);
    for (const t of times) out.push({ dep: t + offset, ride, service: s.name || '' });
  }
  return out.sort((x, y) => x.dep - y.dep || x.ride - y.ride);
}

// The ride on each service that stops at both stations, slowest first.
export function lineRides(line, board, alight) {
  const b = stationIndex(line, board), a = stationIndex(line, alight);
  if (b < 0 || a < 0 || a === b) return [];
  return (line.services || []).filter(s => s.minutes?.[b] != null && s.minutes?.[a] != null)
    .map(s => ({ service: s.name || '', ride: Math.abs(s.minutes[a] - s.minutes[b]) })).sort((x, y) => y.ride - x.ride);
}

// The ride a departure close to `atMin` was timetabled to take, for comparing with a timed ride.
export function plannedRide(line, board, alight, weekday, atMin) {
  const deps = lineDepartures(line, board, alight, weekday);
  if (!deps.length) return lineRides(line, board, alight)[0]?.ride ?? null;
  return deps.reduce((best, d) => (Math.abs(d.dep - atMin) < Math.abs(best.dep - atMin) ? d : best)).ride;
}

// Gives steps that use a line their line, which routes only store by id.
export const withLines = (routes, lines = []) => routes.map(r => (r.legs.some(l => l.lineId)
  ? { ...r, legs: r.legs.map(l => (l.lineId ? { ...l, line: lines.find(x => x.id === l.lineId) || null } : l)) } : r));
const onLine = leg => isTransit(leg) && !!leg.line && !!leg.board && !!leg.alight;

// null means no schedule, so no waiting. An empty list means no service that day.
const departuresOf = (leg, weekday, stats) => {
  if (onLine(leg)) {
    const late = stats.get(leg.id)?.late ?? 0;
    return lineDepartures(leg.line, leg.board, leg.alight, weekday ?? null).map(d => ({ ...d, ride: Math.max(1, d.ride + late) }));
  }
  if (fromFeed(leg)) {
    const late = stats.get(leg.id)?.late ?? 0;
    return tripsOf(leg, weekday ?? null).map(d => ({ ...d, ride: Math.max(1, d.ride + late) }));
  }
  if (!isTransit(leg) || !leg.times?.trim()) return null;
  const ride = legMinutes(leg, stats);
  try { return parseDepartures(leg.times, weekday ?? null).map(dep => ({ dep, ride })); } catch { return null; }
};

// Average logged minutes per step, rounded up so estimates lean toward being on time. Rides
// on a line also keep how far they ran from the timetable, `late`, since the timetable
// already knows a fast train from a slow one.
// A time marked `unusual`, like a walk with heavy bags, is kept with its note but left out.
export function legStats(samples = []) {
  const totals = new Map();
  for (const s of samples) {
    if (s.unusual) continue;
    const t = totals.get(s.legId) || { sum: 0, count: 0, over: 0, timed: 0 };
    t.sum += s.minutes; t.count++;
    if (s.planned != null) { t.over += s.minutes - s.planned; t.timed++; }
    totals.set(s.legId, t);
  }
  return new Map([...totals].map(([id, t]) => [id, { avg: Math.ceil(t.sum / t.count), count: t.count, ...(t.timed ? { late: Math.ceil(t.over / t.timed), timed: t.timed } : {}) }]));
}

// A step on a line counts its slowest service, as a typical figure for lists.
export const legMinutes = (leg, stats) => {
  if (onLine(leg)) {
    const ride = lineRides(leg.line, leg.board, leg.alight)[0]?.ride;
    if (ride != null) return Math.max(1, ride + (stats.get(leg.id)?.late ?? 0));
  }
  // From the official timetable, the usual ride, adjusted by how late timed rides ran.
  if (fromFeed(leg) && typicalRide(leg) != null) return Math.max(1, typicalRide(leg) + (stats.get(leg.id)?.late ?? 0));
  return stats.get(leg.id)?.avg ?? (+leg.minutes || 0);
};
const activeLegs = (route, on = []) => route.legs.filter(l => !l.optional || on.includes(l.id));

export const legLabel = leg => leg.label?.trim() || LEG_KINDS[leg.kind];

// `leg` is the way chosen to ride `step`. `choices` lists them all, for logging the one taken.
function toLeg(leg, dep, arr, stats, route, d, step = leg) {
  const label = legLabel(leg);
  const base = { legId: leg.id, routeId: route.id, dep, arr, min: arr - dep, label, from: '', to: '', logged: stats.get(leg.id)?.count || 0, optional: !!leg.optional,
    ...(hasAlts(step) ? { choices: legOptions(step).map(o => ({ id: o.id, name: legLabel(o) })) } : {}) };
  if (onLine(leg)) {
    const service = (leg.line.services || []).length > 1 ? d?.service || '' : '';
    const named = service ? `${label} (${service})` : label;
    return { ...base, type: 'ride', mode: leg.kind, line: label, from: leg.board, to: leg.alight, service, onLine: true, planned: d ? d.ride - (stats.get(leg.id)?.late ?? 0) : null,
      text: `${named} from ${leg.board}, off at ${leg.alight}, ${arr - dep} min` };
  }
  if (fromFeed(leg) && leg.feed) {
    const { from, to } = leg.feed;
    return { ...base, type: 'ride', mode: leg.kind, line: label, from: from.name, to: to.name, onLine: true, planned: d ? d.ride - (stats.get(leg.id)?.late ?? 0) : null,
      text: `${label} from ${from.name}, off at ${to.name}, ${arr - dep} min` };
  }
  // Linked to the official timetable, but its trips have not arrived, so it cannot wait for a departure.
  if (isTransit(leg) && leg.feed) return { ...base, type: 'ride', mode: leg.kind, line: label, noTimes: true, text: `${label}, ${arr - dep} min, departure times not loaded yet` };
  if (isTransit(leg)) return { ...base, type: 'ride', mode: leg.kind, line: label, text: `${label}, ${arr - dep} min` };
  if (leg.kind === 'stop') return { ...base, type: 'stop', text: `${label}, ${arr - dep} min` };
  return { ...base, type: 'walk', text: `${label}, ${arr - dep} min` };
}

// Follows a route from a start time, waiting wherever a departure time is set. Where two
// services or lines leave, the one that gets there first is taken.
// A way that takes you all the way, like a lift home, is weighed against finishing the route
// the usual way, since the usual way still has its steps after this one.
export function travelFrom(route, start, stats, on, weekday) {
  const steps = activeLegs(route, on);
  const earliest = (leg, t) => {
    const deps = departuresOf(leg, weekday, stats), until = parseClock(leg.until) ?? Infinity;
    const d = deps ? deps.filter(x => x.dep >= t && x.dep <= until).reduce((b, x) => (!b || x.dep + x.ride < b.dep + b.ride ? x : b), null)
      : t <= until ? { dep: t, ride: legMinutes(leg, stats) } : null;
    return d && { leg, d, timed: !!deps };
  };
  const from = (i, t) => {
    if (i === steps.length) return { arrive: t, legs: [] };
    const step = steps[i], options = usableOptions(step, on).map(leg => earliest(leg, t)).filter(Boolean);
    const add = ({ leg, d, timed }, rest) => rest && { arrive: rest.arrive, legs: [toLeg(leg, d.dep, d.dep + d.ride, stats, route, timed ? d : null, step), ...rest.legs] };
    const onward = options.filter(o => !o.leg.allTheWay).reduce((b, o) => (!b || o.d.dep + o.d.ride < b.d.dep + b.d.ride ? o : b), null);
    const ways = [
      onward && add(onward, from(i + 1, onward.d.dep + onward.d.ride)),
      ...options.filter(o => o.leg.allTheWay).map(o => add(o, { arrive: o.d.dep + o.d.ride, legs: [] })),
    ].filter(Boolean);
    return ways.reduce((b, w) => (!b || w.arrive < b.arrive ? w : b), null);
  };
  const best = from(0, start);
  if (!best?.legs.length) return null;
  const { legs, arrive } = best;
  return { routeId: route.id, name: route.name, depart: legs[0].dep, arrive, legs, rides: legs.filter(l => l.type === 'ride').length };
}

// The last moment to set off and still arrive by the deadline.
export function latestStart(route, deadline, stats, on, weekday) {
  let t = deadline;
  for (const step of [...activeLegs(route, on)].reverse()) {
    let latest = null;
    for (const leg of usableOptions(step, on)) {
      const deps = departuresOf(leg, weekday, stats), until = parseClock(leg.until) ?? Infinity;
      const by = leg.allTheWay ? deadline : t;
      const d = deps ? deps.filter(x => x.dep + x.ride <= by && x.dep <= until).reduce((b, x) => (b == null || x.dep > b ? x.dep : b), null)
        : Math.min(by - legMinutes(leg, stats), until);
      if (d != null && (latest == null || d > latest)) latest = d;
    }
    if (latest == null) return null;
    t = latest;
  }
  return t;
}

export const routesBetween = (routes, from, to) => routes.filter(r => norm(r.from) === norm(from) && norm(r.to) === norm(to));

export const reversedRoute = (route, makeId) => ({
  id: makeId(), from: route.to, to: route.from, name: route.name, preferred: false, ...(route.day ? { day: route.day } : {}),
  // A step on a line keeps its line, so the way back has the line's return times.
  // A step from the official timetable swaps its stops, and gets its trips at the next refresh.
  legs: [...route.legs].reverse().map(l => ({ ...l, id: makeId(), times: '', ...(l.lineId ? { board: l.alight, alight: l.board } : {}),
    ...(l.feed ? { feed: { from: l.feed.to, to: l.feed.from }, trips: null, feedDate: null } : {}),
    ...(l.alts ? { alts: l.alts.map(a => ({ ...a, times: '', ...(a.trips ? { trips: null, feedDate: null } : {}), ...(a.feed ? { feed: { from: a.feed.to, to: a.feed.from } } : {}) })) } : {}) })),
});

// Picks between your routes, then falls back to timetables for places with none.
// `choices` holds what you chose for a particular day and trip. A route with a `day` is a
// one-time trip, used only on that date.
export function makeRouter({ routes: all = [], lines = [], samples = [], choices = {}, dayKey = '', weekday, knows = () => false, fallback = null }) {
  const routes = withLines(all.filter(r => !r.day || r.day === dayKey), lines);
  const stats = legStats(samples);
  const keyOf = (from, to) => `${dayKey}|${norm(from)}>${norm(to)}`;
  const decorate = (from, to, journeys, best) => {
    const key = keyOf(from, to);
    const on = choices[key]?.on || [];
    const route = routes.find(r => r.id === best.routeId);
    return {
      ...best, choiceKey: key,
      alternatives: journeys.map(j => ({ routeId: j.routeId, name: j.name, depart: j.depart, arrive: j.arrive, chosen: j.routeId === best.routeId })),
      optionalLegs: [...route.legs.filter(l => l.optional).map(l => ({ id: l.id, label: legLabel(l), minutes: legMinutes(l, stats), on: on.includes(l.id) })),
        // Other ways you have only sometimes, like a lift, ticked the same way.
        ...route.legs.flatMap(l => legOptions(l).filter(o => o.alt && o.optional).map(o => ({ id: o.id, label: legLabel(o), minutes: legMinutes(o, stats), on: on.includes(o.id), way: true, instead: legLabel(l), until: o.until })))],
    };
  };
  // Order: your choice for this trip, then one made for this day, then one for this time
  // of day, then your usual, then the best.
  const pick = (from, to, journeys, better) => {
    const chosenId = choices[keyOf(from, to)]?.routeId;
    const ofJourney = j => routes.find(r => r.id === j.routeId);
    const preferred = routes.find(r => r.preferred && journeys.some(j => j.routeId === r.id));
    return journeys.find(j => j.routeId === chosenId) || journeys.find(j => ofJourney(j)?.day) || journeys.find(j => ofJourney(j)?.arriveBefore)
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
  // A route marked `fallback`, like a taxi for the last bit, counts only when no other route
  // works, so it never wins just by being faster. A trip you chose for the day still counts.
  const firstChoice = (from, to, list) => {
    const chosenId = choices[keyOf(from, to)]?.routeId;
    const isFallback = j => routes.find(r => r.id === j.routeId)?.fallback && j.routeId !== chosenId;
    const usual = list.filter(j => !isFallback(j));
    return (usual.length ? usual : list).map(j => (isFallback(j) ? { ...j, fallback: true } : j));
  };
  return {
    knows,
    arriveOptions,
    arriveBy(from, to, deadline, eventStart) {
      const list = firstChoice(from, to, arriveOptions(from, to, deadline, eventStart));
      if (list.length) return decorate(from, to, list, pick(from, to, list, (a, b) => b.depart - a.depart));
      return routesBetween(routes, from, to).length ? null : (fallback?.arriveBy(from, to, deadline) ?? null);
    },
    departAfter(from, to, after) {
      const on = choices[keyOf(from, to)]?.on || [];
      const list = firstChoice(from, to, routesBetween(routes, from, to).map(r => {
        const j = travelFrom(r, after, stats, on, weekday);
        const limit = parseClock(r.arriveBefore);
        return j && (limit == null || j.arrive < limit) ? j : null;
      }).filter(Boolean));
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
