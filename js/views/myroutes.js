// Your places, your routes, and the stopwatch that keeps their times honest.
import { state, save, emit } from '../store.js';
import { h, uid, norm, ymd, parseYmd, fmt, pad } from '../util.js';
import { placeNames } from '../core.js';
import { LEG_KINDS, isTransit, waitId, hasAlts, legOptions, legStats, legMinutes, legLabel, parseDepartures, reversedRoute, travelFrom, lineRides, plannedRide, withLines } from '../myroutes.js';
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

/* ---------- Lines ---------- */
const newService = (name, minutes) => ({ id: uid(), name, minutes, there: '', back: '' });
const stopsOf = (line, s) => line.stations.filter((_, i) => s.minutes[i] != null);

function linesCard() {
  const usedBy = line => state.myRoutes.filter(r => r.legs.some(l => l.lineId === line.id)).length;
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, 'Lines'),
        h('p', { class: 'hint' }, 'A train or bus you take often, entered once. Steps in your routes can then just say where you get on and off.')),
      h('button', { class: 'btn ghost', onclick: () => openLineEditor() }, 'New line')),
    state.lines.length ? h('ul', { class: 'line-list' }, state.lines.map(line => h('li', { class: 'route-row' },
      h('div', { class: 'route-row-head' },
        h('div', { class: 'route-row-title' }, h('b', { dir: 'auto' }, line.name), h('span', { class: 'tag' }, LEG_KINDS[line.mode])),
        h('button', { class: 'btn ghost', onclick: () => openLineEditor(line) }, 'Edit')),
      h('p', { class: 'hint', dir: 'auto' }, line.stations.join(' · ')),
      h('p', { class: 'hint' }, line.services.map(s => `${s.name}: ${stopsOf(line, s).length} stops`).join(', '),
        usedBy(line) ? `. Used in ${usedBy(line)} route${usedBy(line) === 1 ? '' : 's'}.` : '. No route uses it yet.'))))
      : null);
}

export function openLineEditor(existing) {
  const draft = existing ? JSON.parse(JSON.stringify(existing))
    : { id: uid(), name: '', mode: 'train', stations: ['', ''], services: [newService('All stops', [0, null])] };
  const used = existing && state.myRoutes.some(r => r.legs.some(l => l.lineId === existing.id));
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const grid = h('div', { class: 'line-grid' });
  const times = h('div', { class: 'line-times' });
  const swap = (arr, i, j) => { [arr[i], arr[j]] = [arr[j], arr[i]]; };
  const moveStation = (i, d) => { swap(draft.stations, i, i + d); for (const s of draft.services) swap(s.minutes, i, i + d); draw(); };
  const removeStation = i => { draft.stations.splice(i, 1); for (const s of draft.services) s.minutes.splice(i, 1); draw(); };
  const draw = () => {
    const cols = draft.services.length;
    grid.style.setProperty('--cols', cols);
    grid.replaceChildren(
      h('span', { class: 'field-label' }, 'Station'),
      ...draft.services.map(s => h('input', { class: 'service-name', value: s.name, 'aria-label': 'Service name', placeholder: 'Fast', oninput: e => { s.name = e.target.value; }, onchange: draw })),
      h('span'),
      ...draft.stations.flatMap((st, i) => [
        h('input', { dir: 'auto', value: st, placeholder: i ? 'Tel Aviv HaShalom' : 'Netanya', 'aria-label': `Station ${i + 1}`, oninput: e => { draft.stations[i] = e.target.value; }, onchange: draw }),
        ...draft.services.map(s => h('input', { type: 'number', min: 0, max: 600, class: 'line-min', value: s.minutes[i] ?? '', placeholder: 'skips', 'aria-label': `${s.name || 'Service'}: minutes to ${st || `station ${i + 1}`}`,
          oninput: e => { s.minutes[i] = e.target.value === '' ? null : Math.max(0, Math.round(+e.target.value)); } })),
        h('span', { class: 'row' },
          h('button', { type: 'button', class: 'icon-btn', disabled: i === 0, 'aria-label': 'Move up', onclick: () => moveStation(i, -1), html: '↑' }),
          h('button', { type: 'button', class: 'icon-btn', disabled: i === draft.stations.length - 1, 'aria-label': 'Move down', onclick: () => moveStation(i, 1), html: '↓' }),
          h('button', { type: 'button', class: 'icon-btn', disabled: draft.stations.length <= 2, 'aria-label': 'Remove station', onclick: () => removeStation(i), html: icon('x') })),
      ]));
    times.replaceChildren(...draft.services.map(s => {
      const stops = stopsOf(draft, s);
      const first = stops[0] || 'the first stop', last = stops[stops.length - 1] || 'the last stop';
      return h('fieldset', { class: 'service-times' },
        h('legend', null, h('bdi', null, s.name || 'Service'), ' departures'),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'From ', h('bdi', null, first), ' toward ', h('bdi', null, last)),
          h('textarea', { dir: 'ltr', rows: 2, class: 'leg-times there', value: s.there, placeholder: 'sun-thu: 06:10, 06:40\nfri: every 30 from 07:00 to 14:00', oninput: e => { s.there = e.target.value; } })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'From ', h('bdi', null, last), ' back toward ', h('bdi', null, first)),
          h('textarea', { dir: 'ltr', rows: 2, class: 'leg-times back', value: s.back, placeholder: 'sun-thu: 07:05, 07:35', oninput: e => { s.back = e.target.value; } })),
        cols > 1 ? h('button', { type: 'button', class: 'btn danger-ghost', onclick: () => { draft.services = draft.services.filter(x => x !== s); draw(); } }, 'Remove this service') : null);
    }));
  };
  const submit = e => {
    e.preventDefault();
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    draft.name = draft.name.trim();
    draft.stations = draft.stations.map(s => s.trim());
    if (!draft.name) return fail('Give the line a name, like Coastal train.');
    if (draft.stations.some(s => !s)) return fail('Every station needs a name. Remove the ones you do not need.');
    if (new Set(draft.stations.map(norm)).size < draft.stations.length) return fail('Two stations have the same name.');
    for (const s of draft.services) {
      s.name = s.name.trim() || 'All stops';
      const mins = s.minutes.filter(m => m != null);
      if (mins.length < 2) return fail(`${s.name}: give minutes for at least two stations.`);
      if (mins.some((m, i) => i && m < mins[i - 1])) return fail(`${s.name}: minutes have to grow from one station to the next.`);
      for (const [k, way] of [['there', 'going'], ['back', 'coming back']]) {
        try { parseDepartures(s[k]); } catch (x) { return fail(`${s.name}, ${way}: ${x.message}`); }
      }
    }
    if (new Set(draft.services.map(s => norm(s.name))).size < draft.services.length) return fail('Two services have the same name.');
    state.lines = existing ? state.lines.map(l => (l.id === existing.id ? draft : l)) : [...state.lines, draft];
    close();
    persist('lines');
    toast(existing ? 'Saved the line' : 'Added the line');
  };
  draw();
  const { close } = dialog(h('form', { class: 'review route-editor line-editor', onsubmit: submit, novalidate: true },
    h('header', { class: 'row between' }, h('h2', null, existing ? 'Edit line' : 'New line'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(), html: icon('x') })),
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Name'), h('input', { dir: 'auto', value: draft.name, placeholder: 'Coastal train', oninput: e => { draft.name = e.target.value; } })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Kind'),
        h('select', { onchange: e => { draft.mode = e.target.value; } }, ['train', 'bus'].map(k => h('option', { value: k, selected: draft.mode === k }, LEG_KINDS[k]))))),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Stations, in order, with minutes from the first'),
      h('p', { class: 'hint' }, 'The same minutes count both ways. Leave a box empty where a service does not stop, like a fast evening train.'),
      grid,
      h('div', { class: 'row gap wrap' },
        h('button', { type: 'button', class: 'btn ghost add-station', onclick: () => { draft.stations.push(''); for (const s of draft.services) s.minutes.push(null); draw(); } }, 'Add station'),
        h('button', { type: 'button', class: 'btn ghost add-service', onclick: () => { draft.services.push(newService(draft.services.length === 1 ? 'Fast' : '', [...draft.services[0].minutes])); draw(); } }, 'Add a service, like fast'))),
    times,
    err,
    h('div', { class: 'row end' },
      existing ? h('button', { type: 'button', class: 'btn danger-ghost', disabled: used, title: used ? 'Routes still use this line' : null, onclick: () => { state.lines = state.lines.filter(l => l.id !== existing.id); close(); persist('lines'); } }, 'Remove') : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary' }, existing ? 'Save line' : 'Add line'))), { className: 'wide-dialog' });
}

/* ---------- Route editor ---------- */
const TIMES_HINT = 'Departures (optional)\nsun-thu: 07:12, 07:42\nfri: every 30 from 08:00 to 14:00';
const STARTER_LEGS = () => [
  { id: uid(), kind: 'walk', label: 'Walk to the station', minutes: 10, times: '', optional: false },
  { id: uid(), kind: 'train', label: 'Train', minutes: 20, times: '', optional: false },
  { id: uid(), kind: 'walk', label: 'Walk there', minutes: 10, times: '', optional: false },
];

// `preset.day` offers the route for that day only, ticked when `preset.oneTime`.
export function openRouteEditor(existing, preset = {}) {
  const draft = existing ? JSON.parse(JSON.stringify(existing)) : { id: uid(), from: preset.from || '', to: preset.to || '', name: '', preferred: false, legs: STARTER_LEGS() };
  const offerDay = draft.day || preset.day || null, forEvent = draft.forEvent || preset.forEvent || null;
  const setOneTime = on => {
    if (on) Object.assign(draft, { day: offerDay, ...(forEvent ? { forEvent } : {}) });
    else { delete draft.day; delete draft.forEvent; }
  };
  if (!existing) setOneTime(!!preset.oneTime);
  const listId = 'route-places';
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const legsRoot = h('ol', { class: 'leg-editor' });
  const move = (i, d) => { const [l] = draft.legs.splice(i, 1); draft.legs.splice(i + d, 0, l); draw(); };
  const lineOf = l => state.lines.find(x => x.id === l.lineId) || null;
  const linesFor = l => state.lines.filter(x => x.mode === l.kind);
  const setLine = (l, id) => {
    const line = state.lines.find(x => x.id === id);
    if (!line) { delete l.lineId; delete l.board; delete l.alight; draw(); return; }
    const was = lineOf(l);
    if (!l.label || l.label === was?.name || l.label === LEG_KINDS[l.kind]) l.label = line.name;
    Object.assign(l, { lineId: line.id, board: line.stations[0], alight: line.stations[line.stations.length - 1], times: '' });
    draw();
  };
  const stationPicker = (l, key, label) => h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, label),
    h('select', { class: `line-${key}`, onchange: e => { l[key] = e.target.value; draw(); } }, lineOf(l).stations.map(s => h('option', { value: s, selected: norm(s) === norm(l[key]) }, s))));
  const lineRideText = l => {
    const rides = lineRides(lineOf(l), l.board, l.alight);
    if (!rides.length) return 'No service stops at both of these.';
    return rides.length === 1 ? `${rides[0].ride} min ride` : rides.map(r => `${r.service}: ${r.ride} min`).join(', ');
  };
  // Other lines on the same step, each with its own minutes and departures.
  const altsEditor = l => h('div', { class: 'leg-alts' },
    (l.alts || []).map((a, i) => h('div', { class: 'leg-alt' },
      h('div', { class: 'leg-alt-top' },
        h('span', { class: 'hint' }, 'or'),
        h('input', { dir: 'auto', class: 'alt-name', value: a.name, placeholder: l.kind === 'bus' ? 'Bus 69' : 'Train', 'aria-label': 'Which line', oninput: e => { a.name = e.target.value; } }),
        h('label', { class: 'leg-min' }, h('input', { type: 'number', min: 0, max: 600, value: a.minutes, 'aria-label': 'Minutes', oninput: e => { a.minutes = Math.max(0, +e.target.value || 0); } }), h('span', { class: 'hint' }, 'min')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${a.name || 'this line'}`, onclick: () => { l.alts.splice(i, 1); if (!l.alts.length) delete l.alts; draw(); }, html: icon('x') })),
      h('textarea', { dir: 'ltr', rows: 2, class: 'alt-times', value: a.times || '', placeholder: TIMES_HINT, 'aria-label': `Departure times for ${a.name || 'this line'}`, oninput: e => { a.times = e.target.value; } }))),
    h('button', { type: 'button', class: 'link add-alt', onclick: () => {
      l.alts = [...(l.alts || []), { id: uid(), name: '', minutes: lineOf(l) ? legMinutes({ ...l, line: lineOf(l) }, new Map()) : l.minutes, times: '' }];
      draw();
    } }, 'Add another line for this step'),
    l.alts?.length ? h('p', { class: 'hint' }, 'The one that gets there first is planned. Timing a ride asks which one you took, and each keeps its own average.') : null);
  const draw = () => {
    legsRoot.replaceChildren(...draft.legs.map((l, i) => {
      const line = isTransit(l) ? lineOf(l) : null;
      return h('li', { class: 'leg-edit' },
        h('div', { class: 'leg-edit-top' },
          h('select', { 'aria-label': 'Kind of step', onchange: e => { l.kind = e.target.value; if (lineOf(l)?.mode !== l.kind) { delete l.lineId; delete l.board; delete l.alight; } draw(); } },
            Object.entries(LEG_KINDS).map(([k, name]) => h('option', { value: k, selected: l.kind === k }, name))),
          h('input', { dir: 'auto', value: l.label, placeholder: l.kind === 'stop' ? 'Store' : LEG_KINDS[l.kind], 'aria-label': 'What this step is', oninput: e => { l.label = e.target.value; } }),
          line ? h('span', { class: 'leg-min' }) : h('label', { class: 'leg-min' }, h('input', { type: 'number', min: 0, max: 600, value: l.minutes, 'aria-label': 'Minutes', oninput: e => { l.minutes = Math.max(0, +e.target.value || 0); } }), h('span', { class: 'hint' }, 'min')),
          h('button', { type: 'button', class: 'icon-btn', disabled: i === 0, 'aria-label': 'Move up', onclick: () => move(i, -1), html: '↑' }),
          h('button', { type: 'button', class: 'icon-btn', disabled: i === draft.legs.length - 1, 'aria-label': 'Move down', onclick: () => move(i, 1), html: '↓' }),
          h('button', { type: 'button', class: 'icon-btn', disabled: draft.legs.length === 1, 'aria-label': 'Remove step', onclick: () => { draft.legs.splice(i, 1); draw(); }, html: icon('x') })),
        isTransit(l) && linesFor(l).length ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Line'),
          h('select', { class: 'leg-line', onchange: e => setLine(l, e.target.value) },
            h('option', { value: '' }, 'None, I will write the times here'),
            linesFor(l).map(x => h('option', { value: x.id, selected: x.id === l.lineId }, x.name)))) : null,
        line ? [h('div', { class: 'row gap wrap' }, stationPicker(l, 'board', 'Get on at'), stationPicker(l, 'alight', 'Get off at')),
          h('p', { class: 'hint leg-line-ride' }, lineRideText(l), '. Times come from the line.')]
          : isTransit(l) ? h('textarea', { dir: 'ltr', rows: 2, class: 'leg-times', value: l.times || '', placeholder: TIMES_HINT, 'aria-label': 'Departure times', oninput: e => { l.times = e.target.value; } }) : null,
        l.kind === 'bus' || l.kind === 'train' ? altsEditor(l) : null,
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!l.optional, onchange: e => { l.optional = e.target.checked; } }), 'Only sometimes, like going through the store'));
    }));
  };
  const submit = e => {
    e.preventDefault();
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    if (!draft.from.trim() || !draft.to.trim()) return fail('Choose where the route starts and ends.');
    if (norm(draft.from) === norm(draft.to)) return fail('Start and end have to be different places.');
    for (const l of draft.legs) {
      if (l.alts && !hasAlts(l)) delete l.alts;
      if (hasAlts(l)) {
        const names = [legLabel(l), ...l.alts.map(a => a.name.trim())];
        if (names.some(n => !n)) return fail(`${legLabel(l)}: name each line, like Bus 69.`);
        if (new Set(names.map(norm)).size < names.length) return fail(`${legLabel(l)}: give each line on this step its own name, the step included.`);
        for (const a of l.alts) {
          a.name = a.name.trim();
          try { parseDepartures(a.times); } catch (x) { return fail(`${a.name}: ${x.message}`); }
        }
      }
      if (l.lineId && isTransit(l)) {
        const line = lineOf(l);
        if (!line) return fail(`${legLabel(l)}: its line was removed. Choose another.`);
        if (norm(l.board) === norm(l.alight)) return fail(`${legLabel(l)}: get on and off at different stations.`);
        if (!lineRides(line, l.board, l.alight).length) return fail(`${legLabel(l)}: no service on ${line.name} stops at both ${l.board} and ${l.alight}.`);
        continue;
      }
      try { if (isTransit(l)) parseDepartures(l.times); } catch (x) { return fail(`${legLabel(l)}: ${x.message}`); }
    }
    if (!draft.name.trim()) draft.name = draft.legs.filter(isTransit).map(legLabel).join(' + ') || 'Walk';
    // A one-time trip's ends stay out of your places, which are for where you go regularly.
    if (!draft.day) for (const name of [draft.from, draft.to]) {
      if (!state.places.some(p => norm(p.name) === norm(name))) state.places = [...state.places, { id: uid(), name: name.trim(), aliases: [] }];
    }
    state.myRoutes = existing ? state.myRoutes.map(r => (r.id === existing.id ? draft : r)) : [...state.myRoutes, draft];
    if (draft.preferred && !draft.day) for (const r of state.myRoutes) if (r !== draft && norm(r.from) === norm(draft.from) && norm(r.to) === norm(draft.to)) r.preferred = false;
    close();
    persist('myRoutes', 'places');
    toast(existing ? 'Saved the route' : 'Added the route');
  };
  draw();
  const { close } = dialog(h('form', { class: 'review route-editor', onsubmit: submit, novalidate: true },
    h('header', { class: 'row between' }, h('h2', null, existing ? 'Edit route' : 'New route'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(), html: icon('x') })),
    offerDay ? h('label', { class: 'check' }, h('input', { type: 'checkbox', class: 'one-time', checked: !!draft.day, onchange: e => setOneTime(e.target.checked) }),
      `Only on ${fmt(parseYmd(offerDay), { weekday: 'long', day: 'numeric', month: 'long' })}`) : null,
    h('datalist', { id: listId }, placeNames().map(n => h('option', { value: n }))),
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'From'), h('input', { list: listId, dir: 'auto', value: draft.from, autocomplete: 'off', oninput: e => { draft.from = e.target.value; } })),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'To'), h('input', { list: listId, dir: 'auto', value: draft.to, autocomplete: 'off', placeholder: forEvent ? 'Where it is, like White' : null, autofocus: !!forEvent && !draft.to, oninput: e => { draft.to = e.target.value; } }))),
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

// Every id a step's times are saved under: each way to ride it, and the wait.
const sampleIds = l => [...legOptions(l).map(o => o.id), waitId(l.id)];
// What you wait for on a step, which on one with several lines is any of them.
const waitName = l => legOptions(l).map(legLabel).join(' or ');

function legHistory(route, stats) {
  const logged = route.legs.filter(l => sampleIds(l).some(id => stats.has(id)));
  if (!logged.length) return null;
  const samplesOf = l => state.legSamples.filter(s => sampleIds(l).includes(s.legId)).sort((a, b) => (a.date < b.date ? 1 : -1));
  const nameOf = (l, s) => (s.legId === waitId(l.id) ? `Waiting for ${waitName(l)}` : legLabel(legOptions(l).find(o => o.id === s.legId)));
  return h('details', { class: 'j-details' }, h('summary', null, 'Timed history'),
    h('ul', { class: 'walk-history' }, logged.flatMap(l => samplesOf(l).map(s => h('li', null,
      h('span', { dir: 'auto' }, `${nameOf(l, s)}, ${fmt(parseYmd(s.date), { day: 'numeric', month: 'short' })}`),
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

// How a step on a line compares with its timetable, from your timed rides.
function lineStepText(l, stats) {
  const s = stats.get(l.id);
  const rides = lineRides(l.line, l.board, l.alight);
  const where = `, from ${l.board} to ${l.alight}`;
  const late = s?.late ?? 0;
  const services = rides.length > 1 ? ` (${rides.map(r => `${r.service} ${Math.max(1, r.ride + late)}`).join(', ')} min)` : '';
  const timed = s?.timed ? `, ${late > 0 ? `${late} min slower than` : late < 0 ? `${-late} min faster than` : 'on time with'} the timetable over ${s.timed} ride${s.timed === 1 ? '' : 's'}` : '';
  return `${where}, ${legMinutes(l, stats)} min${services}${timed}, times from ${l.line.name}`;
}

function routeRow(stored, stats) {
  // Shown with its lines; edits and removal work on the route as stored.
  const route = withLines([stored], state.lines)[0];
  const preview = travelFrom({ ...route, legs: route.legs.map(l => ({ ...l, times: '', line: null, alts: [] })) }, 0, new Map(route.legs.map(l => [l.id, { avg: legMinutes(l, stats), count: 0 }])));
  // Other lines on a step, each with its own average and departures.
  const altsText = l => (hasAlts(l) ? legOptions(l).slice(1).map(o => {
    const s = stats.get(o.id);
    return h('div', { class: 'hint' }, 'or ', h('bdi', null, legLabel(o)), `, ${legMinutes(o, stats)} min`, s ? ` (average of ${s.count})` : '', scheduleText(o));
  }) : null);
  return h('li', { class: 'route-row' },
    h('div', { class: 'route-row-head' },
      h('div', { class: 'route-row-title' },
        h('b', { dir: 'auto' }, route.name || 'Route'),
        route.preferred ? h('span', { class: 'tag' }, 'usual') : null,
        route.arriveBefore ? h('span', { class: 'tag' }, `before ${route.arriveBefore}`) : null),
      h('span', { class: 'route-total' }, `${clockSum(route, stats)} min`)),
    preview ? h('div', { class: 'ribbon', 'aria-hidden': 'true' }, preview.legs.map(l => h('i', { class: l.type === 'walk' ? 'walk' : l.type === 'stop' ? 'stop' : l.mode, style: { flex: Math.max(l.min, 1) } }))) : null,
    h('ol', { class: 'route-steps' }, route.legs.map(l => {
      const s = stats.get(l.id), w = stats.get(waitId(l.id));
      const tail = [w ? `, after waiting ${w.avg} min on average` : '', l.optional ? ', only sometimes' : ''];
      if (l.line && l.board && l.alight) return h('li', { class: l.optional ? 'hint' : '' }, h('bdi', null, legLabel(l)), h('bdi', null, lineStepText(l, stats)), ...tail, altsText(l));
      return h('li', { class: l.optional ? 'hint' : '' }, h('bdi', null, legLabel(l)), `, ${legMinutes(l, stats)} min`, s ? ` (average of ${s.count})` : '',
        ...tail, isTransit(l) ? scheduleText(l) : '', l.lineId && !l.line ? ', its line was removed' : '', altsText(l));
    })),
    legHistory(route, stats),
    h('div', { class: 'row gap wrap route-actions' },
      h('button', { class: 'btn primary', onclick: () => startTrip(stored) }, 'Start timer'),
      h('button', { class: 'btn ghost', onclick: () => openRouteEditor(stored) }, 'Edit'),
      h('button', { class: 'btn ghost', onclick: () => {
        state.myRoutes = [...state.myRoutes, reversedRoute(stored, uid)];
        persist('myRoutes');
        toast(`Added the way back: ${route.to} to ${route.from}`);
      } }, 'Add way back'),
      h('button', { class: 'btn danger-ghost', onclick: async () => {
        if (await confirmDialog({ title: `Remove "${route.name}"?`, body: `${route.from} to ${route.to}. Its timed history is removed too.`, action: 'Remove route', danger: true })) {
          const ids = new Set(route.legs.flatMap(sampleIds));
          state.myRoutes = state.myRoutes.filter(r => r !== stored);
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
  const oneTime = state.myRoutes.filter(r => r.day).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const r of state.myRoutes.filter(x => !x.day)) {
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
    oneTime.length ? h('section', { class: 'card' },
      h('h2', null, 'One-time routes'),
      h('p', { class: 'hint' }, 'Each is used on its day only. Add them from Day plan, next to an event with no place.'),
      [...new Set(oneTime.map(r => r.day))].map(day => h('div', { class: 'route-group' },
        h('div', { class: 'route-group-head' }, h('h3', null, fmt(parseYmd(day), { weekday: 'long', day: 'numeric', month: 'long' })), day < ymd(Date.now()) ? h('span', { class: 'tag' }, 'past') : null),
        h('ul', { class: 'route-list' }, oneTime.filter(r => r.day === day).map(r => routeRow(r, stats)))))) : null,
    linesCard(),
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

// For a ride on a line, what the train you boarded was timetabled to take, so the
// timed ride teaches how late it runs.
function plannedFor(leg, trip) {
  const line = leg.lineId && trip.boarded && (trip.ride || leg.id) === leg.id && state.lines.find(x => x.id === leg.lineId);
  if (!line) return {};
  const at = new Date(trip.stepStart);
  const planned = plannedRide(line, leg.board, leg.alight, at.getDay(), at.getHours() * 60 + at.getMinutes());
  return planned == null ? {} : { planned };
}

function nextStep(skip = false) {
  const trip = state.trip, route = tripRoute();
  const leg = route.legs[trip.index];
  const now = Date.now();
  if (!skip) trip.laps.push({ legId: trip.ride || leg.id, of: leg.id, minutes: Math.max(1, Math.round((now - trip.stepStart) / 60000)), ...plannedFor(leg, trip) });
  trip.index++;
  trip.stepStart = now;
  trip.boarded = false;
  delete trip.ride;
  if (trip.index >= route.legs.length) { openTripReview(); return; }
  persist('trip');
}

// Waiting from reaching the stop to boarding. Zero is a real answer: the bus was there.
// `ride` is which line was boarded, on a step that more than one serves.
function boarded(ride = null) {
  const trip = state.trip, leg = tripRoute().legs[trip.index], now = Date.now();
  trip.laps.push({ legId: waitId(leg.id), of: leg.id, wait: true, minutes: Math.max(0, Math.round((now - trip.stepStart) / 60000)) });
  trip.boarded = true;
  if (ride) trip.ride = ride;
  trip.stepStart = now;
  persist('trip');
}

function openTripReview() {
  const trip = state.trip, route = tripRoute();
  const rows = trip.laps.map(lap => ({ ...lap, leg: route.legs.find(l => l.id === (lap.of || lap.legId)), keep: true }));
  const label = r => (r.wait ? `Waiting for ${waitName(r.leg)}` : legLabel(legOptions(r.leg).find(o => o.id === r.legId) || r.leg));
  // A ride on a step with several lines can be moved to the line really taken. Only the
  // step's own line has a timetable to compare with.
  const ridePicker = r => h('select', { class: 'ride-pick', 'aria-label': `Which line for ${legLabel(r.leg)}`, onchange: e => {
    if (r.legId === r.leg.id) r.mainPlanned = r.planned;
    r.legId = e.target.value;
    r.planned = r.legId === r.leg.id ? r.mainPlanned : null;
  } }, legOptions(r.leg).map(o => h('option', { value: o.id, selected: o.id === r.legId }, legLabel(o))));
  const end = () => { state.trip = null; };
  const { close } = dialog(h('form', { class: 'review', onsubmit: e => {
    e.preventDefault();
    const kept = rows.filter(r => r.keep && r.minutes >= (r.wait ? 0 : 1));
    state.legSamples = [...state.legSamples, ...kept.map(r => ({ id: uid(), legId: r.legId, minutes: r.minutes, date: trip.day, ...(r.planned != null ? { planned: r.planned } : {}) }))];
    end();
    close();
    persist('legSamples', 'trip');
    toast(`Saved ${kept.length} time${kept.length === 1 ? '' : 's'}. Your estimates are updated.`);
  } },
    h('h2', null, 'Save these times?'),
    h('p', { class: 'hint' }, 'Correct anything that was off, and untick a time if the day was unusual, like a late train.'),
    h('ul', { class: 'lap-list' }, rows.map(r => h('li', null,
      !r.wait && hasAlts(r.leg)
        ? h('div', { class: 'check grow' }, h('input', { type: 'checkbox', checked: true, 'aria-label': `Keep the time for ${legLabel(r.leg)}`, onchange: e => { r.keep = e.target.checked; } }), ridePicker(r))
        : h('label', { class: 'check grow' }, h('input', { type: 'checkbox', checked: true, onchange: e => { r.keep = e.target.checked; } }), h('bdi', null, label(r))),
      h('label', { class: 'leg-min' }, h('input', { type: 'number', min: r.wait ? 0 : 1, max: 600, value: r.minutes, 'aria-label': `Minutes for ${label(r)}`, oninput: e => { r.minutes = Math.round(+e.target.value) || 0; } }), h('span', { class: 'hint' }, 'min'))))),
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
  // Tapped on reaching the stop, so the walk ends there and the wait starts.
  const next = route.legs[trip.index + 1];
  const doneLabel = trip.index + 1 === total ? 'Finish' : next.kind === 'bus' ? 'At the stop' : next.kind === 'train' ? 'At the station' : 'Next step';
  return h('section', { class: 'trip-bar', 'aria-label': 'Trip timer' },
    h('div', { class: 'trip-info' },
      h('span', { class: 'eyebrow' }, `Step ${trip.index + 1} of ${total}: `, h('bdi', null, route.name)),
      h('b', { dir: 'auto' }, waiting ? `Waiting for: ${waitName(leg)}`
        : legLabel(legOptions(leg).find(o => o.id === trip.ride) || leg))),
    h('span', { class: 'trip-clock', 'data-since': trip.stepStart, role: 'timer' }, clock(Date.now() - trip.stepStart)),
    h('div', { class: 'trip-actions' },
      // With several lines on the step, boarding says which one, so the ride counts for it.
      waiting && hasAlts(leg)
        ? legOptions(leg).map(o => h('button', { class: 'btn primary board-on', onclick: () => boarded(o.id) }, h('bdi', null, `On ${legLabel(o)}`)))
        : waiting ? h('button', { class: 'btn primary', onclick: () => boarded() }, 'I boarded')
        : h('button', { class: 'btn primary', onclick: () => nextStep() }, doneLabel),
      leg.optional || waiting ? h('button', { class: 'btn ghost', onclick: () => nextStep(true) }, 'Skip') : null,
      h('button', { class: 'btn ghost', onclick: async () => {
        if (await confirmDialog({ title: 'Cancel this trip?', body: 'Times from this trip are not saved.', action: 'Cancel trip', danger: true })) { state.trip = null; persist('trip'); }
      } }, 'Cancel')));
}

setInterval(() => {
  for (const el of document.querySelectorAll('.trip-clock')) el.textContent = clock(Date.now() - +el.dataset.since);
}, 1000);

/* ---------- Logging one step by hand ---------- */
// `planned` is the timetabled ride for a step on a line, so the logged time is compared with it.
// `choices` are the lines on a step that several serve, [{ id, name }], to say which was taken.
export function openLegLog(legId, label, dateMs = Date.now(), planned = null, choices = null) {
  const today = ymd(Date.now());
  const minutes = h('input', { type: 'number', min: 1, max: 600, required: true, autofocus: true });
  const date = h('input', { type: 'date', max: today, value: ymd(dateMs) > today ? today : ymd(dateMs), required: true });
  const which = choices?.length > 1 ? h('select', { class: 'log-line' }, choices.map(c => h('option', { value: c.id, selected: c.id === legId }, c.name))) : null;
  const { close } = dialog(h('form', { class: 'confirm', onsubmit: e => {
    e.preventDefault();
    const id = which ? which.value : legId;
    const name = choices?.find(c => c.id === id)?.name || label;
    state.legSamples = [...state.legSamples, { id: uid(), legId: id, minutes: Math.round(+minutes.value), date: date.value, ...(planned != null && id === legId ? { planned } : {}) }];
    close();
    persist('legSamples');
    toast(`Logged ${Math.round(+minutes.value)} min for ${name}`);
  } },
    h('h2', { dir: 'auto' }, `Log: ${which ? choices.map(c => c.name).join(' or ') : label}`),
    which ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Which line you took'), which) : null,
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Minutes it took'), minutes),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Day'), date)),
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary' }, 'Log time'))));
}
