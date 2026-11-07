// Pure logic for the day plan: events, the travel between them, breaks, and the trip home.
import { planArrival, planDeparture } from './transit.js';
import { addDays, norm, MIN } from './util.js';

const MIN_BREAK = 15;
const BREAK_TITLE = /\b(break|lunch|coffee)\b|הפסקה|ארוחת/i;

const same = (a, b) => norm(a) === norm(b);

// `resolve(ev)` returns { place, unresolved }. `ev.optional` marks events that do not
// commit you to being anywhere, such as reminders and subscribed calendars.
export function buildDayPlan({ events, dayMs, home, net, router, resolve, early = 0, transfer = 4 }) {
  const dayEnd = addDays(dayMs, 1);
  const toMin = ms => (ms - dayMs) / MIN, toMs = m => dayMs + m * MIN;
  const homeKnown = !!home && (router ? router.knows(home) : net.ids.has(norm(home)));
  const todays = events.filter(e => !e.allDay && e.endMs > dayMs && e.startMs < dayEnd).sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  const items = [];
  const clamp = e => ({ start: Math.max(e.startMs, dayMs), end: Math.min(e.endMs, dayEnd) });

  for (const ev of todays.filter(e => e.optional)) items.push({ kind: 'optional', ev, ...clamp(ev) });

  const arriveBy = (from, to, deadline, eventStart) => {
    if (router) return router.arriveBy(from, to, deadline, eventStart);
    try { return planArrival(net, { from, to, dateMs: dayMs, arriveBy: deadline, transfer, options: 2 })[0] || null; } catch { return null; }
  };
  const departAfter = (from, to, after) => {
    if (router) return router.departAfter(from, to, after);
    try { return planDeparture(net, { from, to, dateMs: dayMs, departAfter: after, transfer }); } catch { return null; }
  };

  let cur = homeKnown ? home : null;
  let busyUntil = null;
  // Only events with a known place pin you down. Anything else could happen wherever you are,
  // so it never forces a warning about leaving too early.
  let pinnedUntil = null;
  let left = false;
  for (const ev of todays.filter(e => !e.optional)) {
    const { start, end } = clamp(ev);
    const nested = busyUntil != null && start < busyUntil;
    if (ev.ext?.travelTo) {
      items.push({ kind: 'savedTravel', ev, start, end, to: ev.ext.travelTo });
      cur = ev.ext.travelTo;
      left = true;
      busyUntil = Math.max(busyUntil ?? end, end);
      pinnedUntil = Math.max(pinnedUntil ?? end, end);
      continue;
    }
    const { place, unresolved } = nested ? {} : resolve(ev);
    if (place && cur && !same(place, cur)) {
      const startMin = toMin(start), busyMin = pinnedUntil == null ? null : toMin(pinnedUntil);
      let journey = arriveBy(cur, place, startMin - early, startMin);
      let late = 0, leaveEarly = 0;
      if (!journey || (busyMin != null && journey.depart < busyMin)) {
        const forward = departAfter(cur, place, busyMin ?? 0);
        if (forward) {
          // With nothing earlier in the day, the search starts at midnight. Set off only when
          // needed for that arrival, or the trip would count every hour since midnight.
          journey = (busyMin == null && arriveBy(cur, place, forward.arrive, forward.arrive)) || forward;
          late = Math.max(0, journey.arrive - startMin);
        }
        else if (journey) leaveEarly = busyMin - journey.depart;
      }
      if (journey) {
        items.push({ kind: 'travel', from: cur, to: place, journey, late, leaveEarly, start: toMs(journey.depart), end: toMs(journey.arrive) });
        busyUntil = Math.max(busyUntil ?? 0, toMs(journey.arrive));
        pinnedUntil = Math.max(pinnedUntil ?? 0, toMs(journey.arrive));
        left = true;
      } else {
        items.push({ kind: 'noRoute', from: cur, to: place, start, end: start });
      }
    }
    items.push({ kind: BREAK_TITLE.test(ev.summary || '') ? 'plannedBreak' : 'event', ev, start, end, nested, unresolved: unresolved || null });
    if (place) { cur = place; pinnedUntil = Math.max(pinnedUntil ?? end, end); }
    busyUntil = Math.max(busyUntil ?? end, end);
  }

  let homeAt = null;
  if (homeKnown && cur && busyUntil != null) {
    if (!same(cur, home)) {
      const j = departAfter(cur, home, toMin(busyUntil));
      if (j) {
        items.push({ kind: 'travel', from: cur, to: home, home: true, journey: j, late: 0, leaveEarly: 0, start: toMs(j.depart), end: toMs(j.arrive) });
        homeAt = toMs(j.arrive);
      } else {
        items.push({ kind: 'noRoute', from: cur, to: home, home: true, start: busyUntil, end: busyUntil });
      }
    } else if (left) {
      homeAt = busyUntil;
    }
  }

  // Free time between commitments, with planned breaks and travel counted as occupied.
  const blocks = items.filter(i => i.kind !== 'optional' && i.kind !== 'noRoute').sort((a, b) => a.start - b.start);
  let cover = null;
  const breaks = [];
  for (const b of blocks) {
    if (cover != null && b.start - cover >= MIN_BREAK * MIN) breaks.push({ kind: 'break', start: cover, end: b.start });
    cover = Math.max(cover ?? b.end, b.end);
  }
  items.push(...breaks);
  const order = { break: 0, travel: 1, savedTravel: 1, noRoute: 1, event: 2, plannedBreak: 2, optional: 3 };
  items.sort((a, b) => a.start - b.start || order[a.kind] - order[b.kind]);

  const minutes = list => Math.round(list.reduce((s, i) => s + (i.end - i.start), 0) / MIN);
  const travels = items.filter(i => i.kind === 'travel' || i.kind === 'savedTravel');
  return {
    items,
    summary: {
      firstAt: blocks[0]?.start ?? null,
      leaveAt: travels[0]?.start ?? null,
      homeAt,
      travelMin: minutes(travels),
      breakMin: minutes(items.filter(i => i.kind === 'break' || i.kind === 'plannedBreak')),
      problems: items.filter(i => i.kind === 'noRoute' || i.late > 0 || i.leaveEarly > 0 || i.unresolved).length,
    },
  };
}
