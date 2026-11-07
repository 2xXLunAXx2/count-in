// The Plan page: one day from leaving home to getting back, with travel and breaks.
import { state, save, emit } from '../store.js';
import { h, addDays, startOfDay, fmt, fmtTime, fmtClock, norm, inkOn, sameDay, MIN } from '../util.js';
import { calById, catOf, colorOf, visibleEvents, network, placeNames, isKnownPlace, routerFor } from '../core.js';
import { buildDayPlan } from '../plan.js';
import { matchPlace } from '../transit.js';
import { placeFromText } from '../myroutes.js';
import { writable } from '../rules.js';
import { openEditor, openNewEvent } from './editor.js';
import { ribbon, legRow, addToCalendar } from './routes.js';
import { openRouteEditor, startTrip } from './myroutes.js';
import { toast, icon } from '../ui.js';

export const homePlace = () => state.settings.home || state.route.from || '';

// A location on the event wins, then the event's exact title, then its category.
function resolvePlace(ev) {
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

// Calculated on demand and remembered until something the plan depends on changes.
export function planFor(dayMs) {
  const s = state.settings;
  const key = JSON.stringify([state.feeds.map(f => f.id), state.walkLog.map(w => w.id), state.places, state.myRoutes, state.legSamples.map(x => x.id), state.routeChoices, homePlace(), state.route.early, s.transfer, s.placeAliases, state.categories.map(c => c.place || '')]);
  if (key !== memoKey) { memoKey = key; memo = new Map(); }
  const dayEnd = addDays(dayMs, 1);
  const events = visibleEvents()
    .filter(e => !e.allDay && !e.notAccepted && e.endMs > dayMs && e.startMs < dayEnd)
    .map(e => ({ ...e, optional: !!e.free || !writable(calById(e.calId)) }));
  const sig = events.map(e => `${e.id}|${e.startMs}|${e.endMs}|${e.location}|${e.optional}|${e.colorId}|${e.summary}`).join(';');
  const hit = memo.get(dayMs);
  if (hit && hit.sig === sig) return hit.plan;
  const plan = buildDayPlan({ events, dayMs, home: homePlace(), net: network(), router: routerFor(dayMs), resolve: resolvePlace, early: +state.route.early || 0, transfer: +s.transfer || 4 });
  memo.set(dayMs, { sig, plan });
  return plan;
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

function eventRow(i) {
  const color = colorOf(i.ev);
  return row(i, fmtTime(i.start), [
    h('button', { class: 'tl-event', style: { '--c': color, '--ink': inkOn(color) }, onclick: () => openEditor(i.ev) },
      h('span', { class: 'tl-event-title', dir: 'auto' }, i.ev.summary || 'Untitled'),
      h('span', { class: 'tl-event-meta' }, `Until ${fmtTime(i.end)} · ${dur(span(i))}`, i.ev.location ? ' · ' : '', i.ev.location ? h('bdi', null, i.ev.location) : null)),
    i.unresolved ? h('form', {
      class: 'tl-fix', onsubmit: e => { e.preventDefault(); setAlias(i.unresolved, e.target.elements.stop.value); },
    },
      h('label', { class: 'hint' }, 'To plan travel, choose the stop for ', h('bdi', null, i.unresolved), ':'),
      h('div', { class: 'row gap' }, h('input', { name: 'stop', list: 'plan-places', dir: 'auto', 'aria-label': `Stop for ${i.unresolved}`, placeholder: 'Stop or place' }), h('button', { class: 'btn ghost' }, 'Use stop'))) : null,
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
      h('bdi', null, l.label), ` (+${l.minutes} min)`)));
}

function travelRow(i, dayMs) {
  const j = i.journey;
  const transfer = +state.settings.transfer || 4;
  const route = state.myRoutes.find(r => r.id === j.routeId);
  return row(i, fmtClock(j.depart), [
    h('div', { class: 'tl-travel' },
      h('p', { class: 'tl-travel-head' }, h('b', null, i.home ? 'Travel home' : 'Travel to ', i.home ? null : h('bdi', null, i.to)), ` · ${dur(j.arrive - j.depart)}`),
      ribbon(j),
      i.late ? h('p', { class: 'tl-warn' }, `You will be ${dur(i.late)} late. The soonest arrival is ${fmtClock(j.arrive)}.`) : null,
      i.leaveEarly ? h('p', { class: 'tl-warn' }, `Leave ${dur(i.leaveEarly)} before the previous event ends to make this.`) : null,
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
      h('button', { type: 'button', class: 'btn ghost', onclick: () => openRouteEditor(null, { from: i.from, to: i.to }) }, 'Add this route')), 'travel');
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
