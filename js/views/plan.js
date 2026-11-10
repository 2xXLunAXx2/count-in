// The Plan page: one day from leaving home to getting back, with travel and breaks.
import { state, save, emit } from '../store.js';
import { h, addDays, startOfDay, fmt, fmtTime, fmtClock, norm, inkOn, sameDay, ymd, MIN } from '../util.js';
import { calById, catOf, colorOf, visibleEvents, network, placeNames, isKnownPlace, routerFor, createEvent, timeBody } from '../core.js';
import { buildDayPlan, practiceSlots } from '../plan.js';
import { matchPlace } from '../transit.js';
import { placeFromText } from '../myroutes.js';
import { writable } from '../rules.js';
import { openEditor, openNewEvent } from './editor.js';
import { ribbon, legRow, addToCalendar } from './routes.js';
import { openRouteEditor, startTrip, missingTimesHelp, changesCard, timedOn } from './myroutes.js';
import { toast, icon } from '../ui.js';

export const homePlace = () => state.settings.home || state.route.from || '';

// A one-time route made for the event wins, then a location on the event, then the event's
// exact title, then its category.
function resolvePlace(ev) {
  const bound = state.myRoutes.find(r => r.day && r.forEvent === ev.id);
  if (bound) return { place: bound.to };
  const net = network();
  const cat = catOf(ev);
  if (ev.location) {
    const alias = state.settings.placeAliases?.[norm(ev.location)];
    if (alias && isKnownPlace(alias)) return { place: alias };
    const found = placeFromText(state.places, ev.location) || matchPlace(net, ev.location);
    if (found) return { place: found };
  }
  const byTitle = placeFromText(state.places, ev.summary, { exact: true });
  if (byTitle) return { place: byTitle };
  if (cat?.place && isKnownPlace(cat.place)) return { place: cat.place };
  return { place: null, unresolved: ev.location || null };
}

let memoKey = '', memo = new Map();

// The events Day plan counts for a day.
const dayEvents = dayMs => visibleEvents()
  .filter(e => !e.allDay && !e.notAccepted && e.endMs > dayMs && e.startMs < addDays(dayMs, 1))
  .map(e => ({ ...e, optional: !!e.free || !writable(calById(e.calId)) }));

// Plans a day from a list of events, as Day plan does.
const planner = dayMs => {
  const router = routerFor(dayMs), net = network();
  return events => buildDayPlan({ events, dayMs, home: homePlace(), net, router, resolve: resolvePlace, early: +state.route.early || 0, transfer: +state.settings.transfer || 4 });
};

// Calculated on demand and remembered until something the plan depends on changes.
export function planFor(dayMs) {
  const s = state.settings;
  const key = JSON.stringify([state.feeds.map(f => f.id), state.walkLog.map(w => w.id), state.places, state.myRoutes, state.legSamples.map(x => x.id), state.routeChoices, homePlace(), state.route.early, s.transfer, s.placeAliases, state.categories.map(c => c.place || '')]);
  if (key !== memoKey) { memoKey = key; memo = new Map(); }
  const events = dayEvents(dayMs);
  const sig = events.map(e => `${e.id}|${e.startMs}|${e.endMs}|${e.location}|${e.optional}|${e.colorId}|${e.summary}|${e.ext?.arrive || ''}|${e.ext?.leave || ''}`).join(';');
  const hit = memo.get(dayMs);
  if (hit && hit.sig === sig) return hit.plan;
  const plan = planner(dayMs)(events);
  memo.set(dayMs, { sig, plan });
  return plan;
}

/* ---------- Find practice time ---------- */
// Like Music Room's free time, but with the trip to the practice place and on from it.
const finder = { results: null, busy: false, open: false };
const PRACTICE = () => ({ minutes: 120, place: 'MyTone', title: 'Drum Practice', ...state.settings.practice });

export async function findPracticeTime(now = Date.now()) {
  const p = PRACTICE();
  Object.assign(finder, { busy: true, open: true }); emit();
  const days = [];
  const today = startOfDay(now);
  for (let i = 0; i < 7; i++) {
    const dayMs = addDays(today, i);
    // Today starts from now, with a quarter of an hour to get going.
    const from = i === 0 ? Math.max(6 * 60, Math.ceil(((now - dayMs) / MIN + 15) / 15) * 15) : 6 * 60;
    const events = dayEvents(dayMs);
    const { windows, missing } = practiceSlots({ events, dayMs, place: p.place, minutes: +p.minutes || 60, title: p.title, from, build: planner(dayMs) });
    const set = events.filter(e => norm(e.summary) === norm(p.title)).map(e => `${fmtTime(e.startMs)}–${fmtTime(e.endMs)}`);
    days.push({ dayMs, windows, missing, set });
    await new Promise(r => setTimeout(r)); // lets the page stay responsive between days
  }
  Object.assign(finder, { results: { days, for: p }, busy: false });
  emit();
}

async function addPractice(dayMs, startMin) {
  const p = finder.results.for;
  const cal = state.calendars.find(c => c.primary && writable(c)) || state.calendars.find(writable);
  if (!cal) { toast('None of your calendars can be edited.', { error: true }); return; }
  const start = dayMs + startMin * MIN, end = start + p.minutes * MIN;
  try {
    await createEvent(cal.id, { summary: p.title, location: p.place, ...timeBody(null, start, end, false) });
    toast(`Added ${p.title}, ${fmt(dayMs, { weekday: 'short', day: 'numeric', month: 'short' })} ${fmtClock(startMin)}–${fmtClock(startMin + p.minutes)}`);
    findPracticeTime();
  } catch (e) { toast(e.message, { error: true }); }
}

function practiceCard() {
  const p = PRACTICE(), r = finder.results;
  const set = patch => { state.settings.practice = { ...PRACTICE(), ...patch }; save('settings'); };
  const where = r ? r.for : p;
  const windowRow = (d, w) => {
    const starts = [];
    for (let s = w.first; s <= w.last; s += 15) starts.push(s);
    // The trips shown are for the start picked, so each choice says when to leave.
    const trips = h('div', { class: 'practice-trips' });
    const show = s => {
      const f = w.trips[s];
      trips.replaceChildren(...[
        f.there ? h('p', { class: 'hint' }, 'Leave ', h('bdi', null, f.there.from), ` at ${fmtTime(f.there.leave)}, there by ${fmtTime(f.there.arrive)}`) : h('p', { class: 'hint' }, 'You are already there'),
        f.next ? h('p', { class: 'hint' }, f.next.home ? 'Then home' : ['Then on to ', h('bdi', null, f.next.to)], f.next.arrive ? ` by ${fmtTime(f.next.arrive)}` : '') : null,
      ].filter(Boolean));
    };
    const pick = h('select', { class: 'practice-start', 'aria-label': 'Start at', onchange: e => show(+e.target.value) }, starts.map(s => h('option', { value: s }, `${fmtClock(s)}–${fmtClock(s + where.minutes)}`)));
    show(w.first);
    return h('li', { class: 'practice-window' },
      h('div', null, h('b', null, w.last > w.first ? `Start ${fmtClock(w.first)} to ${fmtClock(w.last)}` : `${fmtClock(w.first)}–${fmtClock(w.first + where.minutes)}`), trips),
      h('div', { class: 'row gap' }, pick, h('button', { type: 'button', class: 'btn ghost add-practice', onclick: () => addPractice(d.dayMs, +pick.value) }, 'Add to calendar')));
  };
  return h('details', { class: 'card practice-finder', open: finder.open, ontoggle: e => { finder.open = e.target.open; } },
    h('summary', null, h('b', null, 'Find practice time'), h('span', { class: 'hint' }, ' with the trip there and back')),
    h('div', { class: 'row gap wrap practice-form' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Minutes'), h('input', { type: 'number', min: 15, max: 600, step: 15, class: 'practice-minutes', value: p.minutes, oninput: e => set({ minutes: Math.max(15, +e.target.value || 60) }) })),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Where'), h('select', { class: 'practice-place', onchange: e => set({ place: e.target.value }) }, state.places.map(x => h('option', { value: x.name, selected: norm(x.name) === norm(p.place) }, x.name)))),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Title in the calendar'), h('input', { dir: 'auto', class: 'practice-title', value: p.title, oninput: e => set({ title: e.target.value.trim() || 'Practice' }) })),
      h('button', { type: 'button', class: 'btn primary find-practice', disabled: finder.busy, onclick: () => findPracticeTime() }, finder.busy ? 'Looking' : 'Find times')),
    h('p', { class: 'hint' }, 'The next 7 days, between 06:00 and 21:30. Each time leaves room for the trip there, your next event or the trip home, and your arrive-early margin.'),
    r ? h('ol', { class: 'practice-days' }, r.days.map(d => h('li', null,
      h('h3', null, fmt(d.dayMs, { weekday: 'long', day: 'numeric', month: 'short' })),
      d.set.length ? h('p', { class: 'hint' }, `${r.for.title} already planned: ${d.set.join(', ')}`) : null,
      d.windows.length ? h('ul', { class: 'practice-windows' }, d.windows.map(w => windowRow(d, w))) : h('p', { class: 'hint' }, `No ${r.for.minutes}-minute gap fits with the travel.`),
      d.missing.length ? h('div', { class: 'practice-missing' },
        h('p', { class: 'tl-warn' }, 'More times would fit with a route ', d.missing.map((m, i) => [i ? ' and ' : '', 'from ', h('bdi', null, m.from), ' to ', h('bdi', null, m.to)]),
          '. Plan a trip on Routes can find one and save it.'),
        d.missing.map(m => h('button', { type: 'button', class: 'link', onclick: () => openRouteEditor(null, { from: m.from, to: m.to }) }, 'Add ', h('bdi', null, m.from), ' → ', h('bdi', null, m.to)))) : null))) : null);
}

export function openPlan(dayMs) {
  state.view.planDay = dayMs;
  state.view.page = 'plan';
  history.replaceState(null, '', '#plan');
  emit();
}

const dur = m => {
  const x = Math.round(m);
  if (x < 60) return `${x} min`;
  return x % 60 ? `${Math.floor(x / 60)} hr ${x % 60} min` : `${Math.floor(x / 60)} hr`;
};
const span = i => Math.round((i.end - i.start) / MIN);

const placeList = id => h('datalist', { id }, placeNames().map(n => h('option', { value: n })));

function setAlias(text, value) {
  if (!isKnownPlace(value)) { toast(`"${value}" is not one of your places. Pick one from the list.`, { error: true }); return; }
  state.settings.placeAliases = { ...state.settings.placeAliases, [norm(text)]: value };
  save('settings');
  emit();
}

function row(i, time, body, cls = '') {
  return h('li', { class: `tl-row ${cls}` }, h('span', { class: 'tl-time' }, time), h('div', { class: 'tl-body' }, body));
}

// A trip for one day only, tied to this event, so it needs no place of its own.
const addOneTime = i => openRouteEditor(null, { from: i.from, to: i.ev.location || '', day: ymd(i.start), oneTime: true, forEvent: i.ev.id });

function eventRow(i) {
  const color = colorOf(i.ev);
  return row(i, fmtTime(i.start), [
    h('button', { class: 'tl-event', style: { '--c': color, '--ink': inkOn(color) }, onclick: () => openEditor(i.ev) },
      h('span', { class: 'tl-event-title', dir: 'auto' }, i.ev.summary || 'Untitled'),
      h('span', { class: 'tl-event-meta' }, `Until ${fmtTime(i.end)} · ${dur(span(i))}`, i.ev.location ? ' · ' : '', i.ev.location ? h('bdi', null, i.ev.location) : null),
      i.arriveAt != null || i.leaveAt != null ? h('span', { class: 'tl-event-meta own-times' },
        [i.arriveAt != null ? `Be there by ${fmtTime(i.arriveAt)}` : null, i.leaveAt != null ? `leaving at ${fmtTime(i.leaveAt)}` : null].filter(Boolean).join(', ')) : null),
    i.unresolved ? h('form', {
      class: 'tl-fix', onsubmit: e => { e.preventDefault(); setAlias(i.unresolved, e.target.elements.stop.value); },
    },
      h('label', { class: 'hint' }, 'To plan travel, choose the stop for ', h('bdi', null, i.unresolved), ':'),
      h('div', { class: 'row gap' }, h('input', { name: 'stop', list: 'plan-places', dir: 'auto', 'aria-label': `Stop for ${i.unresolved}`, placeholder: 'Stop or place' }), h('button', { class: 'btn ghost' }, 'Use stop'))) : null,
    !i.placed && !i.nested && i.from ? h('button', { type: 'button', class: 'link tl-add-travel', onclick: () => addOneTime(i) }, i.unresolved ? 'Or add a one-time route there' : 'Add travel to this') : null,
  ], i.nested ? 'nested' : '');
}

function setChoice(key, patch) {
  state.routeChoices = { ...state.routeChoices, [key]: { ...state.routeChoices[key], ...patch } };
  save('routeChoices');
  emit();
}

// Picking between your routes and optional stops applies to this one trip on this one day.
function tripChoices(j) {
  if (!j.choiceKey) return null;
  const others = j.alternatives.length > 1;
  if (!others && !j.optionalLegs.length) return null;
  return h('div', { class: 'tl-choices' },
    others ? h('div', { class: 'seg wide', role: 'group', 'aria-label': 'Choose a route' }, j.alternatives.map(a => h('button', {
      type: 'button', class: 'seg-btn tl-route', 'aria-pressed': String(a.chosen), onclick: () => setChoice(j.choiceKey, { routeId: a.routeId }),
    }, h('bdi', null, a.name), h('span', { class: 'tl-route-time' }, `${fmtClock(a.depart)}–${fmtClock(a.arrive)}`)))) : null,
    j.optionalLegs.map(l => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: l.on, onchange: e => {
        const on = (state.routeChoices[j.choiceKey]?.on || []).filter(x => x !== l.id);
        setChoice(j.choiceKey, { on: e.target.checked ? [...on, l.id] : on });
      } }),
      h('bdi', null, l.label), l.way ? [' instead of ', h('bdi', null, l.instead), l.until ? `, if you are there by ${l.until}` : ''] : ` (+${l.minutes} min)`)));
}

function travelRow(i, dayMs) {
  const j = i.journey;
  const transfer = +state.settings.transfer || 4;
  const route = state.myRoutes.find(r => r.id === j.routeId);
  // A trip you already timed happened as timed, so it is not planned again with warnings.
  const timed = route ? timedOn(route, ymd(dayMs)) : null;
  return row(i, fmtClock(j.depart), [
    h('div', { class: 'tl-travel' },
      h('p', { class: 'tl-travel-head' }, h('b', null, i.home ? 'Travel home' : 'Travel to ', i.home ? null : h('bdi', null, i.to)), ` · ${dur(j.arrive - j.depart)}`),
      ribbon(j),
      timed ? h('p', { class: 'hint timed-trip' }, timed.left ? `You timed this trip: left ${fmtTime(timed.left)}, arrived ${fmtTime(timed.arrived)}.` : 'You timed this trip.',
        timed.note ? [' ', h('bdi', null, timed.note)] : '') : null,
      i.late && !timed ? h('p', { class: 'tl-warn' }, `You will be ${dur(i.late)} late. The soonest arrival is ${fmtClock(j.arrive)}.`) : null,
      i.leaveEarly && !timed ? h('p', { class: 'tl-warn' }, `Leave ${dur(i.leaveEarly)} before the previous event ends to make this.`) : null,
      j.fallback ? h('p', { class: 'tl-warn' }, `No usual route works at this hour, so this is "${j.name}".`) : null,
      j.legs.some(l => l.noTimes) ? h('p', { class: 'tl-warn no-times' }, `${j.legs.filter(l => l.noTimes).map(l => l.label).join(', ')}: departure times have not loaded, so these times are guesses. `, missingTimesHelp()) : null,
      tripChoices(j),
      route ? h('button', { type: 'button', class: 'btn ghost tl-timer', onclick: () => startTrip(route) }, 'Start timer') : null,
      h('details', { class: 'j-details' },
        h('summary', null, `Arrive ${fmtClock(j.arrive)} · ${j.rides <= 1 ? 'no changes' : `${j.rides - 1} change${j.rides > 2 ? 's' : ''}`}`),
        h('ol', { class: 'legs' }, j.legs.map((l, k) => legRow(l, j.legs[k + 1], transfer, dayMs))),
        h('button', { class: 'btn ghost j-add', onclick: () => addToCalendar(j, { dateMs: dayMs, to: i.to }) }, 'Add travel to calendar'))),
  ], 'travel');
}

function renderItem(i, dayMs) {
  switch (i.kind) {
    case 'event': return eventRow(i);
    case 'travel': return travelRow(i, dayMs);
    case 'savedTravel': return row(i, fmtTime(i.start), h('button', { class: 'tl-travel saved', onclick: () => openEditor(i.ev) },
      h('p', { class: 'tl-travel-head' }, h('b', null, i.ev.summary), ` · ${dur(span(i))}`),
      h('p', { class: 'hint' }, `Arrive ${fmtTime(i.end)}. Saved in your calendar.`)), 'travel');
    case 'noRoute': return row(i, fmtTime(i.start), h('div', { class: 'tl-travel missing' },
      h('p', { class: 'tl-warn' }, 'No route fits: ', h('bdi', null, i.from), ' to ', h('bdi', null, i.to), '.'),
      h('p', { class: 'hint' }, state.myRoutes.some(r => norm(r.from) === norm(i.from) && norm(r.to) === norm(i.to)) ? 'Your routes between these places have no departure in time.' : 'Travel time is missing until you add this route.'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => openRouteEditor(null, {
        // One-time unless both ends are places you go to regularly.
        from: i.from, to: i.to, day: ymd(dayMs), oneTime: ![i.from, i.to].every(n => state.places.some(p => norm(p.name) === norm(n))),
      }) }, 'Add this route')), 'travel');
    case 'break': return row(i, fmtTime(i.start), h('button', {
      class: 'tl-break', 'aria-label': `Add an event during this ${dur(span(i))} break`, onclick: () => openNewEvent(i.start, Math.min(i.end, i.start + 60 * MIN)),
    }, h('span', null, `Break · ${dur(span(i))}`), h('span', { class: 'tl-break-until' }, `until ${fmtTime(i.end)}`)), 'break');
    case 'plannedBreak': return row(i, fmtTime(i.start), h('button', { class: 'tl-break planned', onclick: () => openEditor(i.ev) },
      h('span', { dir: 'auto' }, `${i.ev.summary} · ${dur(span(i))}`), h('span', { class: 'tl-break-until' }, `until ${fmtTime(i.end)}`)), 'break');
    default: return row(i, fmtTime(i.start), h('button', { class: 'tl-optional', style: { '--c': colorOf(i.ev) }, onclick: () => openEditor(i.ev) },
      h('span', { class: 'def-dot' }), h('span', { dir: 'auto' }, i.ev.summary || 'Untitled')), 'optional');
  }
}

function summaryBar(plan) {
  const s = plan.summary;
  const stat = (label, value) => h('div', { class: 'plan-stat' }, h('span', { class: 'eyebrow' }, label), h('span', { class: 'plan-stat-value' }, value));
  return h('section', { class: 'plan-summary' },
    s.leaveAt != null ? stat('Leave home', fmtTime(s.leaveAt)) : s.firstAt != null ? stat('Day starts', fmtTime(s.firstAt)) : null,
    s.homeAt != null ? stat('Home by', fmtTime(s.homeAt)) : null,
    stat('Travel', s.travelMin ? dur(s.travelMin) : 'None'),
    stat('Breaks', s.breakMin ? dur(s.breakMin) : 'None'));
}

function placesCard() {
  const now = Date.now();
  const used = new Set(state.events.filter(e => e.endMs > now && !e.free && writable(calById(e.calId))).map(e => catOf(e)?.id));
  const cats = state.categories.filter(c => used.has(c.id));
  const setPlace = (cat, value, input) => {
    const v = value.trim();
    if (v && !isKnownPlace(v)) { toast(`"${v}" is not one of your places. Add it under Routes, or pick one from the list.`, { error: true }); input.value = cat.place || ''; return; }
    cat.place = v || null;
    save('categories');
    emit();
  };
  return h('section', { class: 'card' },
    h('h2', null, 'Where things happen'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Home'),
      h('input', { list: 'plan-places', dir: 'auto', value: homePlace(), placeholder: 'Your home or nearest stop', onchange: e => {
        const v = e.target.value.trim();
        if (v && !isKnownPlace(v)) { toast(`"${v}" is not one of your places. Add it under Routes, or pick one from the list.`, { error: true }); e.target.value = homePlace(); return; }
        state.settings.home = v;
        save('settings');
        emit();
      } })),
    h('p', { class: 'hint' }, 'A place written on an event always wins. An event titled exactly like a place, such as WIS, goes there next. Otherwise set a place for a whole category here, and leave it blank when an activity does not move you.'),
    cats.length ? h('ul', { class: 'place-list' }, cats.map(c => h('li', { class: 'place-row' },
      h('span', { class: 'def-dot', style: { '--c': c.color } }),
      h('span', { class: 'place-name', dir: 'auto' }, c.name),
      h('input', { list: 'plan-places', dir: 'auto', value: c.place || '', placeholder: 'No fixed place', 'aria-label': `Place for ${c.name}`, onchange: e => setPlace(c, e.target.value, e.target) })))) : null);
}

export function renderPlan() {
  const dayMs = startOfDay(state.view.planDay ?? Date.now());
  const plan = planFor(dayMs);
  const allDay = visibleEvents().filter(e => e.allDay && !e.notAccepted && e.endMs > dayMs && e.startMs < addDays(dayMs, 1));
  const go = d => { state.view.planDay = d; emit(); };
  const firstGap = plan.items.find(i => i.kind === 'break' && i.start > Date.now()) || plan.items.find(i => i.kind === 'break');
  return h('section', { class: 'plan-page' },
    placeList('plan-places'),
    h('header', { class: 'plan-head' },
      h('h1', { class: 'page-title' }, fmt(dayMs, { weekday: 'long', day: 'numeric', month: 'long' })),
      h('div', { class: 'cal-actions' },
        sameDay(dayMs, Date.now()) ? null : h('button', { class: 'btn ghost', onclick: () => go(startOfDay(Date.now())) }, 'Today'),
        h('div', { class: 'pager' },
          h('button', { class: 'icon-btn', 'aria-label': 'Previous day', onclick: () => go(addDays(dayMs, -1)), html: icon('left') }),
          h('button', { class: 'icon-btn', 'aria-label': 'Next day', onclick: () => go(addDays(dayMs, 1)), html: icon('right') })),
        h('button', { class: 'btn ghost', onclick: () => {
          const noon = dayMs + 13 * 60 * MIN;
          firstGap ? openNewEvent(firstGap.start, Math.min(firstGap.end, firstGap.start + 30 * MIN), 'Break') : openNewEvent(noon, noon + 30 * MIN, 'Break');
        } }, 'Add break'))),
    summaryBar(plan),
    changesCard(),
    practiceCard(),
    allDay.length ? h('p', { class: 'plan-allday', dir: 'auto' }, `All day: ${allDay.map(e => e.summary).join(', ')}`) : null,
    plan.items.length ? h('ol', { class: 'timeline' }, (() => {
      const { homeAt } = plan.summary;
      const homeRow = homeAt != null ? row(null, fmtTime(homeAt), h('p', { class: 'tl-home' }, 'Home'), 'home') : null;
      const after = homeAt == null ? [] : plan.items.filter(i => i.start >= homeAt && i.kind === 'optional');
      return [plan.items.filter(i => !after.includes(i)).map(i => renderItem(i, dayMs)), homeRow, after.map(i => renderItem(i, dayMs))];
    })())
      : h('div', { class: 'route-empty' }, h('p', null, 'Nothing scheduled this day.')),
    placesCard());
}
