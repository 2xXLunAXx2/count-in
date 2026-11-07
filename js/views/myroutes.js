// Your places, your routes, and the stopwatch that keeps their times honest.
import { state, save, emit } from '../store.js';
import { h, uid, norm, ymd, parseYmd, fmt, pad } from '../util.js';
import { placeNames } from '../core.js';
import { LEG_KINDS, isTransit, legStats, legMinutes, legLabel, parseDepartures, reversedRoute, travelFrom } from '../myroutes.js';
import { dialog, toast, icon, confirmDialog } from '../ui.js';

const persist = (...keys) => { save(...keys); emit(); };
const sampleDay = () => ymd(Date.now());

export const STARTER_PLACES = [
  { name: 'Home' }, { name: 'MyTone' }, { name: 'WIS' },
  { name: 'BIU', aliases: ['Bar-Ilan University', 'Bar Ilan', 'בר אילן'] }, { name: 'Band rehearsal' },
];

export function ensureStarterPlaces() {
  if (state.settings.placesAdded) return;
  state.settings.placesAdded = true;
  state.places = STARTER_PLACES.map(p => ({ id: uid(), aliases: [], ...p }));
  if (!state.settings.home) state.settings.home = 'Home';
  save('places', 'settings');
}

/* ---------- Places ---------- */
function placesCard() {
  const input = h('input', { dir: 'auto', placeholder: 'Add a place', 'aria-label': 'New place name' });
  return h('section', { class: 'card' },
    h('h2', null, 'Your places'),
    h('p', { class: 'hint' }, 'Write one of these in an event\'s location and travel is planned for it. An event called exactly the same as a place, like WIS, counts too.'),
    h('div', { class: 'chips' }, state.places.map(p => h('button', { class: 'chip place-chip', dir: 'auto', onclick: () => openPlaceEditor(p) }, p.name))),
    h('form', { class: 'row gap', onsubmit: e => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      if (state.places.some(p => norm(p.name) === norm(name))) { toast(`You already have "${name}".`, { error: true }); return; }
      state.places = [...state.places, { id: uid(), name, aliases: [] }];
      persist('places');
    } }, input, h('button', { class: 'btn ghost' }, 'Add place')));
}

function openPlaceEditor(place) {
  const name = h('input', { dir: 'auto', value: place.name });
  const aliases = h('input', { dir: 'auto', value: (place.aliases || []).join(', '), placeholder: 'Bar-Ilan University, בר אילן' });
  const used = state.myRoutes.some(r => norm(r.from) === norm(place.name) || norm(r.to) === norm(place.name));
  const { close } = dialog(h('form', { class: 'confirm', onsubmit: e => {
    e.preventDefault();
    const next = name.value.trim();
    if (!next) return;
    const was = place.name;
    place.name = next;
    place.aliases = aliases.value.split(/[,،]/).map(a => a.trim()).filter(Boolean);
    for (const r of state.myRoutes) { if (norm(r.from) === norm(was)) r.from = next; if (norm(r.to) === norm(was)) r.to = next; }
    if (norm(state.settings.home) === norm(was)) state.settings.home = next;
    close();
    persist('places', 'myRoutes', 'settings');
  } },
    h('h2', { dir: 'auto' }, place.name),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Other ways your events write it'), aliases,
      h('span', { class: 'field-hint' }, 'Separate them with commas.')),
    h('div', { class: 'row end' },
      h('button', { type: 'button', class: 'btn danger-ghost', disabled: used, title: used ? 'Routes still use this place' : null, onclick: () => { state.places = state.places.filter(p => p !== place); close(); persist('places'); } }, 'Remove'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary' }, 'Save'))));
}

/* ---------- Route editor ---------- */
const STARTER_LEGS = () => [
  { id: uid(), kind: 'walk', label: 'Walk to the station', minutes: 10, times: '', optional: false },
  { id: uid(), kind: 'train', label: 'Train', minutes: 20, times: '', optional: false },
  { id: uid(), kind: 'walk', label: 'Walk there', minutes: 10, times: '', optional: false },
];

export function openRouteEditor(existing, preset = {}) {
  const draft = existing ? JSON.parse(JSON.stringify(existing)) : { id: uid(), from: preset.from || '', to: preset.to || '', name: '', preferred: false, legs: STARTER_LEGS() };
  const listId = 'route-places';
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const legsRoot = h('ol', { class: 'leg-editor' });
  const move = (i, d) => { const [l] = draft.legs.splice(i, 1); draft.legs.splice(i + d, 0, l); draw(); };
  const draw = () => {
    legsRoot.replaceChildren(...draft.legs.map((l, i) => h('li', { class: 'leg-edit' },
      h('div', { class: 'leg-edit-top' },
        h('select', { 'aria-label': 'Kind of step', onchange: e => { l.kind = e.target.value; draw(); } },
          Object.entries(LEG_KINDS).map(([k, name]) => h('option', { value: k, selected: l.kind === k }, name))),
        h('input', { dir: 'auto', value: l.label, placeholder: l.kind === 'stop' ? 'Store' : LEG_KINDS[l.kind], 'aria-label': 'What this step is', oninput: e => { l.label = e.target.value; } }),
        h('label', { class: 'leg-min' }, h('input', { type: 'number', min: 0, max: 600, value: l.minutes, 'aria-label': 'Minutes', oninput: e => { l.minutes = Math.max(0, +e.target.value || 0); } }), h('span', { class: 'hint' }, 'min')),
        h('button', { type: 'button', class: 'icon-btn', disabled: i === 0, 'aria-label': 'Move up', onclick: () => move(i, -1), html: '↑' }),
        h('button', { type: 'button', class: 'icon-btn', disabled: i === draft.legs.length - 1, 'aria-label': 'Move down', onclick: () => move(i, 1), html: '↓' }),
        h('button', { type: 'button', class: 'icon-btn', disabled: draft.legs.length === 1, 'aria-label': 'Remove step', onclick: () => { draft.legs.splice(i, 1); draw(); }, html: icon('x') })),
      isTransit(l) ? h('textarea', { dir: 'ltr', rows: 2, class: 'leg-times', value: l.times || '', placeholder: 'Departures (optional)\nsun-thu: 07:12, 07:42\nfri: every 30 from 08:00 to 14:00', 'aria-label': 'Departure times', oninput: e => { l.times = e.target.value; } }) : null,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!l.optional, onchange: e => { l.optional = e.target.checked; } }), 'Only sometimes, like going through the store'))));
  };
  const submit = e => {
    e.preventDefault();
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    if (!draft.from.trim() || !draft.to.trim()) return fail('Choose where the route starts and ends.');
    if (norm(draft.from) === norm(draft.to)) return fail('Start and end have to be different places.');
    for (const l of draft.legs) {
      try { if (isTransit(l)) parseDepartures(l.times); } catch (x) { return fail(`${legLabel(l)}: ${x.message}`); }
    }
    if (!draft.name.trim()) draft.name = draft.legs.filter(isTransit).map(legLabel).join(' + ') || 'Walk';
    for (const name of [draft.from, draft.to]) {
      if (!state.places.some(p => norm(p.name) === norm(name))) state.places = [...state.places, { id: uid(), name: name.trim(), aliases: [] }];
    }
    state.myRoutes = existing ? state.myRoutes.map(r => (r.id === existing.id ? draft : r)) : [...state.myRoutes, draft];
    if (draft.preferred) for (const r of state.myRoutes) if (r !== draft && norm(r.from) === norm(draft.from) && norm(r.to) === norm(draft.to)) r.preferred = false;
    close();
    persist('myRoutes', 'places');
    toast(existing ? 'Saved the route' : 'Added the route');
  };
  draw();
  const { close } = dialog(h('form', { class: 'review route-editor', onsubmit: submit, novalidate: true },
    h('header', { class: 'row between' }, h('h2', null, existing ? 'Edit route' : 'New route'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(), html: icon('x') })),
    h('datalist', { id: listId }, placeNames().map(n => h('option', { value: n }))),
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'From'), h('input', { list: listId, dir: 'auto', value: draft.from, autocomplete: 'off', oninput: e => { draft.from = e.target.value; } })),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'To'), h('input', { list: listId, dir: 'auto', value: draft.to, autocomplete: 'off', oninput: e => { draft.to = e.target.value; } }))),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name, to tell routes apart'), h('input', { dir: 'auto', value: draft.name, placeholder: 'Direct bus', oninput: e => { draft.name = e.target.value; } })),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Steps, in order'), h('p', { class: 'hint' }, 'A rough number of minutes is fine. Timed trips replace it with your average.'), legsRoot,
      h('button', { type: 'button', class: 'btn ghost add-leg', onclick: () => { draft.legs.push({ id: uid(), kind: 'walk', label: '', minutes: 5, times: '', optional: false }); draw(); } }, 'Add step')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!draft.preferred, onchange: e => { draft.preferred = e.target.checked; } }), 'This is my usual route between these places'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Only for events starting before (optional)'),
      h('input', { type: 'time', class: 'arrive-before', value: draft.arriveBefore || '', onchange: e => { draft.arriveBefore = e.target.value || null; } }),
      h('span', { class: 'field-hint' }, 'For example, a lift that only works for early practice. When it fits, it is used ahead of your usual route.')),
    err,
    h('div', { class: 'row end' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary' }, existing ? 'Save route' : 'Add route'))), { className: 'wide-dialog' });
}

/* ---------- Route list ---------- */
const clockSum = (route, stats) => route.legs.filter(l => !l.optional).reduce((s, l) => s + legMinutes(l, stats), 0);

function legHistory(route, stats) {
  const logged = route.legs.filter(l => stats.has(l.id));
  if (!logged.length) return null;
  return h('details', { class: 'j-details' }, h('summary', null, 'Timed history'),
    h('ul', { class: 'walk-history' }, logged.flatMap(l => state.legSamples.filter(s => s.legId === l.id).sort((a, b) => (a.date < b.date ? 1 : -1)).map(s => h('li', null,
      h('span', { dir: 'auto' }, `${legLabel(l)}, ${fmt(parseYmd(s.date), { day: 'numeric', month: 'short' })}`),
      h('span', { class: 'mono' }, `${s.minutes} min`),
      h('button', { class: 'icon-btn', 'aria-label': `Remove ${s.minutes} minute time for ${legLabel(l)}`, onclick: () => {
        state.legSamples = state.legSamples.filter(x => x !== s);
        persist('legSamples');
        toast('Removed that time', { action: 'Undo', onAction: () => { state.legSamples = [...state.legSamples, s]; persist('legSamples'); } });
      }, html: icon('x') }))))));
}

// A full day's departures are too long to list on a route, so this counts them per weekday.
function scheduleText(leg) {
  if (!leg.times?.trim()) return '';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const counts = names.map((_, day) => { try { return parseDepartures(leg.times, day).length; } catch { return 0; } });
  const groups = [];
  counts.forEach((n, day) => {
    const last = groups[groups.length - 1];
    if (last && last.n === n) last.to = day; else groups.push({ n, from: day, to: day });
  });
  return `, ${groups.map(g => `${names[g.from]}${g.to > g.from ? `–${names[g.to]}` : ''}: ${g.n ? `${g.n} departures` : 'no service'}`).join(', ')}`;
}

function routeRow(route, stats) {
  const preview = travelFrom({ ...route, legs: route.legs.map(l => ({ ...l, times: '' })) }, 0, stats) ;
  return h('li', { class: 'route-row' },
    h('div', { class: 'route-row-head' },
      h('div', { class: 'route-row-title' },
        h('b', { dir: 'auto' }, route.name || 'Route'),
        route.preferred ? h('span', { class: 'tag' }, 'usual') : null,
        route.arriveBefore ? h('span', { class: 'tag' }, `before ${route.arriveBefore}`) : null),
      h('span', { class: 'route-total' }, `${clockSum(route, stats)} min`)),
    preview ? h('div', { class: 'ribbon', 'aria-hidden': 'true' }, preview.legs.map(l => h('i', { class: l.type === 'walk' ? 'walk' : l.type === 'stop' ? 'stop' : l.mode, style: { flex: Math.max(l.min, 1) } }))) : null,
    h('ol', { class: 'route-steps' }, route.legs.map(l => {
      const s = stats.get(l.id);
      return h('li', { class: l.optional ? 'hint' : '' }, h('bdi', null, legLabel(l)), `, ${legMinutes(l, stats)} min`, s ? ` (average of ${s.count})` : '', l.optional ? ', only sometimes' : '', isTransit(l) ? scheduleText(l) : '');
    })),
    legHistory(route, stats),
    h('div', { class: 'row gap wrap route-actions' },
      h('button', { class: 'btn primary', onclick: () => startTrip(route) }, 'Start timer'),
      h('button', { class: 'btn ghost', onclick: () => openRouteEditor(route) }, 'Edit'),
      h('button', { class: 'btn ghost', onclick: () => {
        state.myRoutes = [...state.myRoutes, reversedRoute(route, uid)];
        persist('myRoutes');
        toast(`Added the way back: ${route.to} to ${route.from}`);
      } }, 'Add way back'),
      h('button', { class: 'btn danger-ghost', onclick: async () => {
        if (await confirmDialog({ title: `Remove "${route.name}"?`, body: `${route.from} to ${route.to}. Its timed history is removed too.`, action: 'Remove route', danger: true })) {
          const ids = new Set(route.legs.map(l => l.id));
          state.myRoutes = state.myRoutes.filter(r => r !== route);
          state.legSamples = state.legSamples.filter(s => !ids.has(s.legId));
          persist('myRoutes', 'legSamples');
        }
      } }, 'Remove')));
}

// Routes prepared for you in data/my-routes.json, offered once each. Removing one later
// does not bring it back.
export async function loadPreparedRoutes() {
  try {
    const list = await (await fetch('data/my-routes.json', { cache: 'no-store' })).json();
    state.view.prepared = list.filter(r => importedVersion(r.id) < (r.version || 1));
    if (state.view.prepared.length) emit();
  } catch { /* no prepared routes, or running from a saved copy */ }
}

const importedVersion = id => state.settings.routeVersions?.[id] ?? ((state.settings.importedRoutes || []).includes(id) ? 1 : 0);

// Step ids stay the same across versions, so an update keeps your timed history.
function addPrepared() {
  const list = state.view.prepared || [];
  const ids = new Set(list.map(r => r.id));
  state.myRoutes = [...state.myRoutes.filter(r => !ids.has(r.id)), ...list];
  for (const r of list) for (const name of [r.from, r.to]) {
    if (!state.places.some(p => norm(p.name) === norm(name))) state.places = [...state.places, { id: uid(), name, aliases: [] }];
  }
  state.settings.routeVersions = { ...state.settings.routeVersions, ...Object.fromEntries(list.map(r => [r.id, r.version || 1])) };
  state.view.prepared = [];
  save('settings');
  persist('myRoutes', 'places');
  toast(`Updated your routes: ${list.length} ready`);
}

function preparedCard() {
  const list = state.view.prepared || [];
  if (!list.length) return null;
  const isUpdate = r => state.myRoutes.some(x => x.id === r.id);
  return h('section', { class: 'card prepared' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, `${list.length} route${list.length === 1 ? '' : 's'} ready`),
        h('ul', { class: 'prepared-list' }, list.map(r => h('li', { dir: 'auto' }, isUpdate(r) ? 'Update: ' : 'New: ', h('bdi', null, r.from), ' → ', h('bdi', null, r.to), ', ', h('bdi', null, r.name))))),
      h('button', { class: 'btn primary', onclick: addPrepared }, 'Add to my routes')));
}

export function myRoutesSection() {
  const stats = legStats(state.legSamples);
  const groups = new Map();
  for (const r of state.myRoutes) {
    const k = `${r.from} → ${r.to}`;
    if (!groups.has(k)) groups.set(k, { from: r.from, to: r.to, routes: [] });
    groups.get(k).routes.push(r);
  }
  return [
    preparedCard(),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', null, 'Your routes'), h('p', { class: 'hint' }, 'The trips you really take. Day plan uses them for every journey in your day.')),
        h('button', { class: 'btn primary', onclick: () => openRouteEditor() }, 'New route')),
      groups.size ? [...groups.values()].map(g => h('div', { class: 'route-group' },
        h('div', { class: 'route-group-head' }, h('h3', { dir: 'auto' }, h('bdi', null, g.from), ' → ', h('bdi', null, g.to)),
          h('button', { class: 'link', onclick: () => openRouteEditor(null, { from: g.from, to: g.to }) }, 'Another route')),
        h('ul', { class: 'route-list' }, g.routes.map(r => routeRow(r, stats)))))
        : h('div', { class: 'route-empty' }, h('p', null, 'Add your first route, such as MyTone to WIS: walk, train, walk. Rough minutes are fine.'))),
    placesCard(),
  ];
}

/* ---------- Stopwatch ---------- */
export function startTrip(route) {
  if (state.trip) { toast('A trip is already being timed. Finish or cancel it first.', { error: true }); return; }
  const now = Date.now();
  state.trip = { routeId: route.id, index: 0, stepStart: now, boarded: false, laps: [], day: sampleDay() };
  persist('trip');
}

const tripRoute = () => state.myRoutes.find(r => r.id === state.trip?.routeId);
const clock = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};

function nextStep(skip = false) {
  const trip = state.trip, route = tripRoute();
  const leg = route.legs[trip.index];
  const now = Date.now();
  if (!skip) trip.laps.push({ legId: leg.id, minutes: Math.max(1, Math.round((now - trip.stepStart) / 60000)) });
  trip.index++;
  trip.stepStart = now;
  trip.boarded = false;
  if (trip.index >= route.legs.length) { openTripReview(); return; }
  persist('trip');
}

function openTripReview() {
  const trip = state.trip, route = tripRoute();
  const rows = trip.laps.map(lap => ({ ...lap, leg: route.legs.find(l => l.id === lap.legId), keep: true }));
  const end = () => { state.trip = null; };
  const { close } = dialog(h('form', { class: 'review', onsubmit: e => {
    e.preventDefault();
    const kept = rows.filter(r => r.keep && r.minutes >= 1);
    state.legSamples = [...state.legSamples, ...kept.map(r => ({ id: uid(), legId: r.legId, minutes: r.minutes, date: trip.day }))];
    end();
    close();
    persist('legSamples', 'trip');
    toast(`Saved ${kept.length} time${kept.length === 1 ? '' : 's'}. Your estimates are updated.`);
  } },
    h('h2', null, 'Save these times?'),
    h('p', { class: 'hint' }, 'Correct anything that was off, and untick a time if the day was unusual, like a late train.'),
    h('ul', { class: 'lap-list' }, rows.map(r => h('li', null,
      h('label', { class: 'check grow' }, h('input', { type: 'checkbox', checked: true, onchange: e => { r.keep = e.target.checked; } }), h('bdi', null, legLabel(r.leg))),
      h('label', { class: 'leg-min' }, h('input', { type: 'number', min: 1, max: 600, value: r.minutes, 'aria-label': `Minutes for ${legLabel(r.leg)}`, oninput: e => { r.minutes = Math.round(+e.target.value) || 0; } }), h('span', { class: 'hint' }, 'min'))))),
    h('div', { class: 'row end' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { end(); close(); persist('trip'); toast('Discarded the trip'); } }, 'Discard'),
      h('button', { class: 'btn primary' }, 'Save times'))));
}

// Stays on screen on every page, and survives a reload, since it runs from saved timestamps.
export function tripBar() {
  const trip = state.trip, route = tripRoute();
  if (!trip || !route) return null;
  if (trip.index >= route.legs.length) return null;
  const leg = route.legs[trip.index];
  const waiting = isTransit(leg) && !trip.boarded;
  const total = route.legs.length;
  return h('section', { class: 'trip-bar', 'aria-label': 'Trip timer' },
    h('div', { class: 'trip-info' },
      h('span', { class: 'eyebrow' }, `Step ${trip.index + 1} of ${total}: `, h('bdi', null, route.name)),
      h('b', { dir: 'auto' }, waiting ? `Waiting for: ${legLabel(leg)}` : legLabel(leg))),
    h('span', { class: 'trip-clock', 'data-since': trip.stepStart, role: 'timer' }, clock(Date.now() - trip.stepStart)),
    h('div', { class: 'trip-actions' },
      waiting
        ? h('button', { class: 'btn primary', onclick: () => { trip.boarded = true; trip.stepStart = Date.now(); persist('trip'); } }, 'I boarded')
        : h('button', { class: 'btn primary', onclick: () => nextStep() }, trip.index + 1 === total ? 'Finish' : 'Next step'),
      leg.optional || waiting ? h('button', { class: 'btn ghost', onclick: () => nextStep(true) }, 'Skip') : null,
      h('button', { class: 'btn ghost', onclick: async () => {
        if (await confirmDialog({ title: 'Cancel this trip?', body: 'Times from this trip are not saved.', action: 'Cancel trip', danger: true })) { state.trip = null; persist('trip'); }
      } }, 'Cancel')));
}

setInterval(() => {
  for (const el of document.querySelectorAll('.trip-clock')) el.textContent = clock(Date.now() - +el.dataset.since);
}, 1000);

/* ---------- Logging one step by hand ---------- */
export function openLegLog(legId, label, dateMs = Date.now()) {
  const today = ymd(Date.now());
  const minutes = h('input', { type: 'number', min: 1, max: 600, required: true, autofocus: true });
  const date = h('input', { type: 'date', max: today, value: ymd(dateMs) > today ? today : ymd(dateMs), required: true });
  const { close } = dialog(h('form', { class: 'confirm', onsubmit: e => {
    e.preventDefault();
    state.legSamples = [...state.legSamples, { id: uid(), legId, minutes: Math.round(+minutes.value), date: date.value }];
    close();
    persist('legSamples');
    toast(`Logged ${Math.round(+minutes.value)} min for ${label}`);
  } },
    h('h2', { dir: 'auto' }, `Log: ${label}`),
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Minutes it took'), minutes),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Day'), date)),
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary' }, 'Log time'))));
}
