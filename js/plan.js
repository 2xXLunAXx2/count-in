// Pure logic for the day plan: events, the travel between them, breaks, and the trip home.
import { planArrival, planDeparture } from './transit.js';
import { addDays, norm, MIN, parseClock, startOfDay } from './util.js';

const MIN_BREAK = 15;
const BREAK_TITLE = /\b(break|lunch|coffee)\b|הפסקה|ארוחת/i;

const same = (a, b) => norm(a) === norm(b);
// Your own times for an event, when you need to be there earlier than it starts or leave later
// than it ends, like a rehearsal. Clock times on the event's day, saved on the event.
const ownTime = (ev, key) => {
  const m = parseClock(ev.ext?.[key] || '');
  return m == null ? null : startOfDay(ev.startMs) + m * MIN;
};

/* When a session of `minutes` at `place`, like practice at MyTone, fits into a day: each
   quarter hour from `from` to `until` is tried as a start by planning the whole day with it,
   so the trip there, the trip on to the next event and the trip home all have to work.
   `build(events)` plans a day the way Day plan does. A start counts when it overlaps no
   commitment and adds no problem to the day, such as being late or missing the last bus.
   Starts in a row become one window, keeping the trips for each start. `missing` lists the
   routes you have none of, which kept some starts out, like MyTone to rehearsal. */
export function practiceSlots({ events, dayMs, place, minutes, title = 'Practice', from = 6 * 60, until = 21 * 60 + 30, step = 15, build }) {
  const busy = events.filter(e => !e.optional && !e.allDay);
  const before = build(events);
  const gaps = new Set(before.items.filter(i => i.kind === 'noRoute').map(i => `${i.from}>${i.to}`));
  const windows = [], missing = new Map();
  let open = null;
  for (let s = Math.ceil(from / step) * step; s + minutes <= until; s += step) {
    const start = dayMs + s * MIN, end = start + minutes * MIN;
    let fit = null;
    if (!busy.some(e => e.startMs < end && e.endMs > start)) {
      const trial = { id: 'practice-trial', calId: '', summary: title, location: place, allDay: false, startMs: start, endMs: end, ext: {} };
      const plan = build([...events, trial]);
      const at = plan.items.find(i => i.ev === trial);
      for (const i of plan.items) if (i.kind === 'noRoute' && !gaps.has(`${i.from}>${i.to}`)) missing.set(`${i.from}>${i.to}`, { from: i.from, to: i.to });
      // The trips to and from the session itself have to work, not just add up to no more problems.
      const own = plan.items.some(i => (same(i.to, place) || same(i.from, place)) && (i.kind === 'noRoute' || i.late > 0 || i.leaveEarly > 0));
      if (!own && plan.summary.problems <= before.summary.problems && at?.placed) {
        const there = plan.items.find(i => i.kind === 'travel' && same(i.to, place) && i.end <= start && i.end > start - 6 * 60 * MIN);
        const after = plan.items.find(i => (i.kind === 'travel' || i.kind === 'noRoute') && i.start >= end);
        fit = { there: there ? { from: there.from, leave: there.start, arrive: there.end } : null, next: after ? { to: after.to, leave: after.start, arrive: after.end ?? null, home: !!after.home } : null };
      }
    }
    if (fit && open && s === open.last + step) { open.last = s; open.trips[s] = fit; }
    else if (fit) windows.push(open = { first: s, last: s, trips: { [s]: fit } });
    else open = null;
  }
  return { windows, missing: [...missing.values()] };
}

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
  // The earliest arrival, but setting off only when needed for it, so waiting at a station
  // shows as free time where you are instead of as travel.
  const leaveAfter = (from, to, after) => {
    const j = departAfter(from, to, after);
    return (j && arriveBy(from, to, j.arrive, j.arrive)) || j;
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
    // Being there by your own time replaces the arrive-early margin.
    const arriveAt = nested ? null : ownTime(ev, 'arrive'), leaveAt = nested ? null : ownTime(ev, 'leave');
    if (place && cur && !same(place, cur)) {
      const startMin = toMin(arriveAt ?? start), busyMin = pinnedUntil == null ? null : toMin(pinnedUntil);
      let journey = arriveBy(cur, place, startMin - (arriveAt == null ? early : 0), startMin);
      let late = 0, leaveEarly = 0;
      if (!journey || (busyMin != null && journey.depart < busyMin)) {
        // With nothing earlier in the day this searches from midnight, which is why setting
        // off only when needed matters: otherwise the trip counts every hour since then.
        const forward = leaveAfter(cur, place, busyMin ?? 0);
        if (forward) { journey = forward; late = Math.max(0, forward.arrive - startMin); }
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
    // `from` is where you are before it, for adding travel to an event with no place yet.
    // `stay` is the time you are there, from arriving to leaving, which is never a break.
    const until = leaveAt ?? end;
    items.push({ kind: BREAK_TITLE.test(ev.summary || '') ? 'plannedBreak' : 'event', ev, start, end, nested, unresolved: unresolved || null, from: cur, placed: !!place,
      ...(arriveAt != null || leaveAt != null ? { arriveAt, leaveAt, stay: [Math.min(start, arriveAt ?? start), until] } : {}) });
    if (place) { cur = place; pinnedUntil = Math.max(pinnedUntil ?? until, until); }
    busyUntil = Math.max(busyUntil ?? until, until);
  }

  let homeAt = null;
  if (homeKnown && cur && busyUntil != null) {
    if (!same(cur, home)) {
      const j = leaveAfter(cur, home, toMin(busyUntil));
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
  for (const b of [...blocks].sort((x, y) => (x.stay?.[0] ?? x.start) - (y.stay?.[0] ?? y.start))) {
    const [from, to] = b.stay || [b.start, b.end];
    if (cover != null && from - cover >= MIN_BREAK * MIN) breaks.push({ kind: 'break', start: cover, end: from });
    cover = Math.max(cover ?? to, to);
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
