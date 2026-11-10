// Your places, your routes, and the stopwatch that keeps their times honest.
import { state, save, emit } from '../store.js';
import { h, uid, norm, ymd, parseYmd, fmt, fmtTime, fmtClock, pad } from '../util.js';
import { placeNames } from '../core.js';
import { LEG_KINDS, isTransit, waitId, hasAlts, legOptions, legStats, legMinutes, legLabel, parseDepartures, reversedRoute, travelFrom, lineRides, timetabledRide, withLines, missingTimes } from '../myroutes.js';
import { dialog, toast, icon, confirmDialog } from '../ui.js';
import { tripPlannerCard } from './tripplanner.js';
import { feedStatus, searchStops, findLines, feedResults, watchPairs, applyResults, fillOption, lineLabel, lineSummary, pairKey, fedOptions, changeText } from '../feed.js';

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

/* ---------- Official timetable ---------- */
const feedSummary = trips => lineSummary({ trips });
const stopName = s => s.en || s.name;

// Where a line with stops of its own lets you off, since it differs from the step.
const offAt = (o, l) => (o.feed && l.feed && o.feed.to.key !== l.feed.to.key ? [', off at ', h('bdi', null, o.feed.to.name)] : null);

// Back to times written by hand, keeping each line and its rough minutes.
function unlinkFeed(l) {
  for (const o of [l, ...(l.alts || [])]) { delete o.feedLine; delete o.trips; delete o.feedDate; delete o.feed; }
}

// Rereads the timetable on the computer: tells the helper which stops your steps use, and
// fills in what it has. The phone has no helper and keeps what Drive brings.
export async function syncTimetable() {
  const s = await feedStatus();
  if (JSON.stringify(s) !== JSON.stringify(state.view.feed ?? null)) { state.view.feed = s; emit(); }
  if (!s) return;
  try {
    await watchPairs(state.myRoutes);
    const results = await feedResults();
    const notes = [];
    const changed = applyResults(state.myRoutes, results, notes);
    if (changed) {
      state.myRoutes = [...state.myRoutes];
      if (notes.length) state.feedChanges = [...groupChanges(notes), ...(state.feedChanges || [])].slice(0, 40);
      persist('myRoutes', 'feedChanges');
    }
    // Stops new to the helper are read in the background, so look again shortly.
    const waiting = state.myRoutes.some(r => r.legs.some(l => fedOptions(l).some(({ feed }) => !results.pairs?.[pairKey(feed)])));
    if (waiting && !syncTimetable.soon) syncTimetable.soon = setTimeout(() => { syncTimetable.soon = null; syncTimetable(); }, 30000);
  } catch { /* the helper is busy or stopped; the next check tries again */ }
}

// The same change on several days, like a new timetable from Sunday to Thursday, is one note.
export function groupChanges(notes) {
  const out = new Map();
  for (const n of notes) {
    const text = changeText(n), key = `${n.routeId}|${n.line}|${n.from}|${text}`;
    if (!out.has(key)) out.set(key, { id: uid(), at: new Date().toISOString(), route: n.route, line: n.line, from: n.from, to: n.to, text, dates: [] });
    if (n.date) out.get(key).dates.push(n.date);
  }
  return [...out.values()].map(c => ({ ...c, dates: c.dates.sort() }));
}

// What changed in the official timetable on your routes, until you dismiss it.
export function changesCard() {
  const list = state.feedChanges || [];
  if (!list.length) return null;
  const dismiss = ids => { state.feedChanges = state.feedChanges.filter(c => !ids.includes(c.id)); persist('feedChanges'); };
  const days = c => c.dates.map(d => fmt(parseYmd(d), { weekday: 'short', day: 'numeric', month: 'short' })).join(', ');
  return h('section', { class: 'card feed-changes' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, 'Timetable changes'), h('p', { class: 'hint' }, 'The official timetable changed on your routes. Your plans already use the new times.')),
      h('button', { class: 'btn ghost', onclick: () => dismiss(list.map(c => c.id)) }, 'Dismiss all')),
    h('ul', { class: 'change-list' }, list.map(c => h('li', null,
      h('div', null,
        h('b', { dir: 'auto' }, h('bdi', null, c.line), ', ', h('bdi', null, c.from), ' to ', h('bdi', null, c.to)),
        h('p', { class: 'hint' }, h('bdi', null, c.route), c.dates.length ? `, ${days(c)}` : ''),
        h('p', null, c.text)),
      h('button', { class: 'icon-btn', 'aria-label': `Dismiss the change to ${c.line}`, onclick: () => dismiss([c.id]), html: icon('x') })))));
}

// What to do about steps whose times have not arrived, which depends on where you are.
export function missingTimesHelp() {
  if (state.view.feed) return 'Count-in is reading them now, which takes up to a minute.';
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return 'The Count-in window on this computer is an older version without the timetable. Close it and double-click start.bat to start it again.';
  return 'They come from Count-in on your computer, so start it there with start.bat, and Drive brings them here.';
}

function feedStatusText() {
  const missing = missingTimes(state.myRoutes);
  if (missing) return `${missing === 1 ? 'One bus or train has' : `${missing} buses and trains have`} no departure times yet, so their times are guesses. ${missingTimesHelp()}`;
  const s = state.view.feed;
  if (!s) return null;
  if (s.message) return s.message;
  return s.updated ? `Official timetable from ${fmt(new Date(s.updated), { day: 'numeric', month: 'short' })}, refreshed daily while Count-in runs here.` : null;
}

// One stop, found by name or by the code on its sign.
export function stopPicker(label, chosen, onPick) {
  const results = h('ul', { class: 'stop-results' });
  const input = h('input', { type: 'search', dir: 'auto', class: 'stop-search', placeholder: 'Name or code on the sign', value: chosen ? stopName(chosen) : '', 'aria-label': label });
  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    onPick(null);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.replaceChildren(); return; }
      let found = [];
      try { found = await searchStops(q); } catch (x) { results.replaceChildren(h('li', { class: 'hint' }, x.message)); return; }
      if (input.value.trim() !== q) return;
      results.replaceChildren(...(found.length ? found.map(s => h('li', null, h('button', { type: 'button', class: 'stop-hit', onclick: () => {
        input.value = stopName(s);
        results.replaceChildren();
        onPick(s);
      } }, h('bdi', null, stopName(s)), h('span', { class: 'hint' }, [s.en ? h('bdi', null, s.name) : null, s.station ? 'Train station' : s.cityEn || s.city ? h('bdi', null, s.cityEn || s.city) : null, s.codes.length ? s.codes.join(', ') : null].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x])))))) : [h('li', { class: 'hint' }, 'No stop by that name.')]));
    }, 250);
  });
  return h('div', { class: 'field grow stop-picker' }, h('span', { class: 'field-label' }, label), input, results);
}

// Links a bus or train step to the official timetable: where you get on and off, and which
// lines you take there. A line already on the step keeps its timed history.
export function openFeedPicker(step, onDone) {
  let from = step.feed?.from || null, to = step.feed?.to || null, found = null, updated = null;
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const linesRoot = h('div', { class: 'feed-found' });
  const findBtn = h('button', { type: 'button', class: 'btn ghost find-lines' }, 'Find lines');
  // Ticked at first: the lines on the step already, by link or by name, like a Bus 69 you typed.
  const ticked = new Set([step.feedLine, ...(step.alts || []).map(a => a.feedLine)].filter(Boolean));
  const names = new Set(legOptions(step).map(legLabel));
  const fail = msg => { err.textContent = msg; err.hidden = false; };
  const drawLines = () => {
    if (!found) { linesRoot.replaceChildren(); return; }
    if (!found.length) { linesRoot.replaceChildren(h('p', { class: 'hint' }, 'No bus or train goes from the first stop to the second this week. Check the direction, or try the stop across the road.')); return; }
    for (const l of found) if (names.has(lineLabel(l))) ticked.add(l.id);
    names.clear();
    if (!found.some(l => ticked.has(l.id))) ticked.add(found[0].id);
    linesRoot.replaceChildren(h('span', { class: 'field-label' }, 'Lines you take here'),
      ...found.map(l => h('label', { class: 'check' }, h('input', { type: 'checkbox', class: 'feed-line', value: l.id, checked: ticked.has(l.id), onchange: e => { (e.target.checked ? ticked.add(l.id) : ticked.delete(l.id)); } }),
        h('bdi', null, lineLabel(l)), h('span', { class: 'hint' }, lineSummary(l)))));
  };
  findBtn.onclick = async () => {
    err.hidden = true;
    if (!from || !to) return fail('Choose both stops from the lists.');
    findBtn.disabled = true;
    linesRoot.replaceChildren(h('p', { class: 'hint' }, 'Reading the timetable. The first time for these stops takes up to half a minute.'));
    try { const res = await findLines(from, to); found = res.lines; updated = res.updated; } catch (x) { found = null; linesRoot.replaceChildren(); fail(x.message); }
    findBtn.disabled = false;
    drawLines();
  };
  const pick = side => s => { if (side === 'from') from = s; else to = s; found = null; drawLines(); };
  const use = () => {
    const chosen = (found || []).filter(l => ticked.has(l.id));
    if (!chosen.length) return fail('Find the lines, then tick the ones you take.');
    // The line the step already is stays the step, so its history stays with it.
    const current = step.feedLine || null;
    chosen.sort((a, b) => (b.id === current || lineLabel(b) === step.label) - (a.id === current || lineLabel(a) === step.label));
    const [main, ...others] = chosen;
    const oldAlts = step.alts || [];
    delete step.lineId; delete step.board; delete step.alight;
    Object.assign(step, { kind: main.mode, label: lineLabel(main), feedLine: main.id, feed: { from: { key: from.key, name: stopName(from) }, to: { key: to.key, name: stopName(to) } } });
    fillOption(step, main, updated);
    // Lines with stops of their own were not among these, and other ways like a lift are not on
    // the timetable at all, so they stay as they are.
    const otherWay = a => !a.feedLine && (a.kind === 'car' || a.optional);
    const ownStops = oldAlts.filter(a => otherWay(a) || (a.feed && a.feedLine && !others.some(l => l.id === a.feedLine)));
    step.alts = [...others.map(l => {
      const old = oldAlts.find(a => !otherWay(a) && !a.feed && (a.feedLine === l.id || a.name === lineLabel(l)));
      const alt = { id: old?.id || uid(), name: lineLabel(l), feedLine: l.id, minutes: old?.minutes ?? step.minutes, times: '' };
      fillOption(alt, l, updated);
      return alt;
    }), ...ownStops];
    if (!step.alts.length) delete step.alts;
    close();
    onDone();
  };
  const { close } = dialog(h('form', { class: 'review feed-picker', onsubmit: e => { e.preventDefault(); use(); }, novalidate: true },
    h('header', { class: 'row between' }, h('h2', null, 'Official timetable'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(), html: icon('x') })),
    h('p', { class: 'hint' }, 'Where you get on and off. Every bus and train between them is listed, and their times stay current each day.'),
    stopPicker('Get on at', from, pick('from')),
    stopPicker('Get off at', to, pick('to')),
    findBtn, linesRoot, err,
    h('div', { class: 'row end' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary' }, 'Use these lines'))), { className: 'wide-dialog' });
  if (from && to) findBtn.click();
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
  // On a step from the official timetable its lines are listed above, so only other ways show.
  const WAY_KINDS = { bus: 'Bus', train: 'Train', car: 'Lift' };
  const altsEditor = (l, ownOnly = false) => h('div', { class: 'leg-alts' },
    (l.alts || []).map((a, i) => (ownOnly && a.feedLine ? null : h('div', { class: 'leg-alt' },
      h('div', { class: 'leg-alt-top' },
        h('span', { class: 'hint' }, 'or'),
        h('input', { dir: 'auto', class: 'alt-name', value: a.name, placeholder: a.kind === 'car' ? 'Lift from Dad' : l.kind === 'bus' ? 'Bus 69' : 'Train', 'aria-label': 'Which way', oninput: e => { a.name = e.target.value; } }),
        h('label', { class: 'leg-min' }, h('input', { type: 'number', min: 0, max: 600, value: a.minutes, 'aria-label': 'Minutes', oninput: e => { a.minutes = Math.max(0, +e.target.value || 0); } }), h('span', { class: 'hint' }, 'min')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${a.name || 'this way'}`, onclick: () => { l.alts.splice(i, 1); if (!l.alts.length) delete l.alts; draw(); }, html: icon('x') })),
      h('div', { class: 'row gap wrap alt-when' },
        h('select', { class: 'alt-kind', 'aria-label': 'Kind', onchange: e => { if (e.target.value === l.kind) delete a.kind; else a.kind = e.target.value; draw(); } },
          Object.entries(WAY_KINDS).map(([k, name]) => h('option', { value: k, selected: (a.kind || l.kind) === k }, name))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', class: 'alt-optional', checked: !!a.optional, onchange: e => { if (e.target.checked) a.optional = true; else delete a.optional; } }), 'Only sometimes, ticked in Day plan'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', class: 'alt-all-the-way', checked: !!a.allTheWay, onchange: e => { if (e.target.checked) a.allTheWay = true; else delete a.allTheWay; } }), 'Takes me all the way'),
        h('label', { class: 'check' }, 'until', h('input', { type: 'time', class: 'alt-until', value: a.until || '', 'aria-label': 'Only until', onchange: e => { if (e.target.value) a.until = e.target.value; else delete a.until; } }))),
      (a.kind || l.kind) === 'car' ? null : h('textarea', { dir: 'ltr', rows: 2, class: 'alt-times', value: a.times || '', placeholder: TIMES_HINT, 'aria-label': `Departure times for ${a.name || 'this line'}`, oninput: e => { a.times = e.target.value; } })))),
    h('button', { type: 'button', class: 'link add-alt', onclick: () => {
      l.alts = [...(l.alts || []), ownOnly ? { id: uid(), name: '', kind: 'car', minutes: 10, times: '', optional: true }
        : { id: uid(), name: '', minutes: lineOf(l) ? legMinutes({ ...l, line: lineOf(l) }, new Map()) : l.minutes, times: '' }];
      draw();
    } }, ownOnly ? 'Add another way, like a lift' : 'Add another way for this step'),
    l.alts?.length ? h('p', { class: 'hint' }, 'The one that gets there first is planned, counting one you have only sometimes when it is ticked for that trip. Timing a ride asks which one you took, and each keeps its own average.') : null);
  // A step on the official timetable lists its lines; the timetable sets their times.
  const feedBlock = l => h('div', { class: 'leg-feed' },
    h('p', { class: 'hint' }, 'From ', h('bdi', null, l.feed.from.name), ' to ', h('bdi', null, l.feed.to.name), ', on the official timetable:'),
    h('ul', { class: 'feed-lines' }, legOptions(l).filter(o => o.feedLine).map(o => h('li', null, h('bdi', null, legLabel(o)), offAt(o, l),
      o.trips ? `, ${feedSummary(o.trips)}` : ', its times arrive with the next refresh'))),
    h('div', { class: 'row gap wrap' },
      state.view.feed ? h('button', { type: 'button', class: 'link fill-feed', onclick: () => openFeedPicker(l, draw) }, 'Change stops or lines') : null,
      h('button', { type: 'button', class: 'link unlink-feed', onclick: () => { unlinkFeed(l); draw(); } }, 'Write the times myself instead')));
  const draw = () => {
    legsRoot.replaceChildren(...draft.legs.map((l, i) => {
      const line = isTransit(l) ? lineOf(l) : null;
      const fed = !!l.feed && (l.kind === 'bus' || l.kind === 'train');
      return h('li', { class: 'leg-edit' },
        h('div', { class: 'leg-edit-top' },
          h('select', { 'aria-label': 'Kind of step', onchange: e => {
            l.kind = e.target.value;
            if (lineOf(l)?.mode !== l.kind) { delete l.lineId; delete l.board; delete l.alight; }
            if (l.feed && l.kind !== 'bus' && l.kind !== 'train') unlinkFeed(l);
            draw();
          } },
            Object.entries(LEG_KINDS).map(([k, name]) => h('option', { value: k, selected: l.kind === k }, name))),
          h('input', { dir: 'auto', value: l.label, placeholder: l.kind === 'stop' ? 'Store' : LEG_KINDS[l.kind], 'aria-label': 'What this step is', oninput: e => { l.label = e.target.value; } }),
          line || fed ? h('span', { class: 'leg-min' }) : h('label', { class: 'leg-min' }, h('input', { type: 'number', min: 0, max: 600, value: l.minutes, 'aria-label': 'Minutes', oninput: e => { l.minutes = Math.max(0, +e.target.value || 0); } }), h('span', { class: 'hint' }, 'min')),
          h('button', { type: 'button', class: 'icon-btn', disabled: i === 0, 'aria-label': 'Move up', onclick: () => move(i, -1), html: '↑' }),
          h('button', { type: 'button', class: 'icon-btn', disabled: i === draft.legs.length - 1, 'aria-label': 'Move down', onclick: () => move(i, 1), html: '↓' }),
          h('button', { type: 'button', class: 'icon-btn', disabled: draft.legs.length === 1, 'aria-label': 'Remove step', onclick: () => { draft.legs.splice(i, 1); draw(); }, html: icon('x') })),
        fed ? [feedBlock(l), altsEditor(l, true)] : [
          isTransit(l) && linesFor(l).length ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Line'),
            h('select', { class: 'leg-line', onchange: e => setLine(l, e.target.value) },
              h('option', { value: '' }, 'None, I will write the times here'),
              linesFor(l).map(x => h('option', { value: x.id, selected: x.id === l.lineId }, x.name)))) : null,
          line ? [h('div', { class: 'row gap wrap' }, stationPicker(l, 'board', 'Get on at'), stationPicker(l, 'alight', 'Get off at')),
            h('p', { class: 'hint leg-line-ride' }, lineRideText(l), '. Times come from the line.')]
            : isTransit(l) ? h('textarea', { dir: 'ltr', rows: 2, class: 'leg-times', value: l.times || '', placeholder: TIMES_HINT, 'aria-label': 'Departure times', oninput: e => { l.times = e.target.value; } }) : null,
          l.kind === 'bus' || l.kind === 'train' ? altsEditor(l) : null,
          (l.kind === 'bus' || l.kind === 'train') && state.view.feed ? h('button', { type: 'button', class: 'link fill-feed', onclick: () => openFeedPicker(l, draw) }, 'Fill from the official timetable') : null],
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
    h('label', { class: 'check' }, h('input', { type: 'checkbox', class: 'fallback', checked: !!draft.fallback, onchange: e => { if (e.target.checked) draft.fallback = true; else delete draft.fallback; } }),
      'Only when no other route works, like a taxi after the last bus'),
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

// A route you timed on a day: when you left and arrived, where the times say so.
export function timedOn(route, dayKey) {
  const ids = new Set(route.legs.flatMap(sampleIds));
  const list = state.legSamples.filter(s => s.date === dayKey && (s.routeId ? s.routeId === route.id : ids.has(s.legId)));
  if (!list.length) return null;
  const at = list.filter(s => s.at);
  return { count: list.length, ...(at.length ? { left: Math.min(...at.map(s => s.at)), arrived: Math.max(...at.map(s => s.at + s.minutes * 60000)) } : {}), note: list.find(s => s.note)?.note || '' };
}

// Changes one saved time, or every time of the trip it was timed on, since a note like heavy
// bags is about the whole trip.
function updateSamples(s, patch) {
  const same = x => x === s || (s.trip && x.trip === s.trip);
  state.legSamples = state.legSamples.map(x => (same(x) ? Object.fromEntries(Object.entries({ ...x, ...patch }).filter(([, v]) => v !== undefined && v !== '' && v !== false)) : x));
  persist('legSamples');
}

// Corrects a saved time in place, so the history never gets a second copy of it.
function editSample(s, name) {
  const minutes = h('input', { type: 'number', min: 0, max: 600, required: true, class: 'edit-minutes', value: s.minutes });
  const date = h('input', { type: 'date', required: true, class: 'edit-date', value: s.date });
  const { close } = dialog(h('form', { class: 'confirm', onsubmit: e => {
    e.preventDefault();
    const fixed = { ...s, minutes: Math.round(+minutes.value), date: date.value };
    if (s.timed == null && fixed.minutes !== s.minutes && s.at) fixed.timed = s.minutes;
    state.legSamples = state.legSamples.map(x => (x === s ? fixed : x));
    close();
    persist('legSamples');
    toast(`Changed to ${fixed.minutes} min`, { action: 'Undo', onAction: () => { state.legSamples = state.legSamples.map(x => (x === fixed ? s : x)); persist('legSamples'); } });
  } },
    h('h2', { dir: 'auto' }, `Edit: ${name}`),
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Minutes'), minutes),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Day'), date)),
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary' }, 'Save'))));
}

function noteDialog(s) {
  let text = s.note || '';
  const { close } = dialog(h('form', { class: 'confirm', onsubmit: e => { e.preventDefault(); updateSamples(s, { note: text.trim() || undefined }); close(); } },
    h('h2', null, 'Note'),
    h('p', { class: 'hint' }, s.trip ? 'For every time on this trip.' : 'For this time.'),
    h('textarea', { rows: 3, dir: 'auto', class: 'sample-note', value: text, placeholder: 'Like: lots of bags, walked slower', oninput: e => { text = e.target.value; } }),
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary' }, 'Save note'))));
}

function legHistory(route) {
  const samplesOf = l => state.legSamples.filter(s => sampleIds(l).includes(s.legId)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.at || 0) - (a.at || 0)));
  const logged = route.legs.filter(l => samplesOf(l).length);
  if (!logged.length) return null;
  const nameOf = (l, s) => (s.legId === waitId(l.id) ? `Waiting for ${waitName(l)}` : legLabel(legOptions(l).find(o => o.id === s.legId)));
  return h('details', { class: 'j-details' }, h('summary', null, 'Timed history'),
    h('ul', { class: 'walk-history' }, logged.flatMap(l => samplesOf(l).map(s => h('li', { class: s.unusual ? 'unusual' : '' },
      h('div', { class: 'sample-what' },
        h('span', { dir: 'auto' }, `${nameOf(l, s)}, ${fmt(parseYmd(s.date), { day: 'numeric', month: 'short' })}`, s.at ? `, ${fmtTime(s.at)}` : ''),
        // For a wait: when the bus or train came, against the timetable.
        s.at && s.legId === waitId(l.id) ? h('span', { class: 'hint sample-came' }, `It came at ${fmtTime(s.at + s.minutes * 60000)}`,
          s.due != null ? `; the next one in the timetable after you got there was ${fmtClock(s.due)}` : '') : null,
        s.note ? h('span', { class: 'hint sample-note-text', dir: 'auto' }, s.note) : null,
        s.unusual ? h('span', { class: 'hint' }, 'Left out of your averages') : null,
        s.timed != null && s.timed !== s.minutes ? h('span', { class: 'hint sample-timed' }, `You changed it; the timer said ${s.timed} min. `,
          h('button', { class: 'link use-timed', onclick: () => {
            state.legSamples = state.legSamples.map(x => (x === s ? { ...x, minutes: s.timed } : x));
            persist('legSamples');
            toast(`Back to the timer's ${s.timed} min`);
          } }, 'Use that')) : null),
      h('span', { class: 'mono' }, `${s.minutes} min`),
      h('div', { class: 'sample-actions' },
        h('button', { class: 'link edit-sample', onclick: () => editSample(s, nameOf(l, s)) }, 'Edit'),
        h('button', { class: 'link add-note', onclick: () => noteDialog(s) }, s.note ? 'Edit note' : 'Note'),
        h('button', { class: 'link toggle-unusual', onclick: () => {
          updateSamples(s, { unusual: !s.unusual });
          toast(s.unusual ? 'Counted in your averages again' : `Left out of your averages${s.trip ? ', with the rest of that trip' : ''}`);
        } }, s.unusual ? 'Count it' : 'Leave out'),
        h('button', { class: 'icon-btn', 'aria-label': `Remove ${s.minutes} minute time for ${legLabel(l)}`, onclick: () => {
          state.legSamples = state.legSamples.filter(x => x !== s);
          persist('legSamples');
          toast('Removed that time', { action: 'Undo', onAction: () => { state.legSamples = [...state.legSamples, s]; persist('legSamples'); } });
        }, html: icon('x') })))))));
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
    return h('div', { class: 'hint' }, 'or ', h('bdi', null, legLabel(o)), offAt(o, l), `, ${legMinutes(o, stats)} min`, s ? ` (average of ${s.count})` : '', scheduleText(o),
      o.allTheWay ? ', all the way' : '', o.optional ? ', only sometimes' : '', o.until ? `, until ${o.until}` : '');
  }) : null);
  return h('li', { class: 'route-row' },
    h('div', { class: 'route-row-head' },
      h('div', { class: 'route-row-title' },
        h('b', { dir: 'auto' }, route.name || 'Route'),
        route.preferred ? h('span', { class: 'tag' }, 'usual') : null,
        route.arriveBefore ? h('span', { class: 'tag' }, `before ${route.arriveBefore}`) : null,
        route.fallback ? h('span', { class: 'tag' }, 'when nothing else works') : null),
      h('span', { class: 'route-total' }, `${clockSum(route, stats)} min`)),
    preview ? h('div', { class: 'ribbon', 'aria-hidden': 'true' }, preview.legs.map(l => h('i', { class: l.type === 'walk' ? 'walk' : l.type === 'stop' ? 'stop' : l.mode, style: { flex: Math.max(l.min, 1) } }))) : null,
    h('ol', { class: 'route-steps' }, route.legs.map(l => {
      const s = stats.get(l.id), w = stats.get(waitId(l.id));
      const tail = [w ? `, after waiting ${w.avg} min on average` : '', l.optional ? ', only sometimes' : ''];
      if (l.line && l.board && l.alight) return h('li', { class: l.optional ? 'hint' : '' }, h('bdi', null, legLabel(l)), h('bdi', null, lineStepText(l, stats)), ...tail, altsText(l));
      return h('li', { class: l.optional ? 'hint' : '' }, h('bdi', null, legLabel(l)), `, ${legMinutes(l, stats)} min`, s ? ` (average of ${s.count})` : '',
        l.feed ? [', from ', h('bdi', null, l.feed.from.name), ' to ', h('bdi', null, l.feed.to.name), ' on the official timetable'] : null,
        ...tail, isTransit(l) ? scheduleText(l) : '', l.lineId && !l.line ? ', its line was removed' : '', altsText(l));
    })),
    legHistory(route),
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
    // A retired route was merged into another, so it is only offered for removal where you have it.
    state.view.prepared = list.filter(r => importedVersion(r.id) < (r.version || 1) && (!r.retired || state.myRoutes.some(x => x.id === r.id)));
    if (state.view.prepared.length) emit();
  } catch { /* no prepared routes, or running from a saved copy */ }
  try {
    const fixes = await (await fetch('data/fixes.json', { cache: 'no-store' })).json();
    state.view.fixes = fixes.filter(f => !(state.settings.appliedFixes || []).includes(f.id));
    if (state.view.fixes.length) emit();
  } catch { /* no fixes prepared */ }
}

/* Fixes prepared for your saved times, like replacing times entered by mistake. Each is
   offered once, applied only when you press Apply, and can be undone right after. */
export function applyFix(fix) {
  const was = state.legSamples;
  const remove = new Set(fix.remove || []);
  const added = (fix.add || []).map(a => {
    const at = a.at ? new Date(a.at).getTime() : null;
    const step = state.myRoutes.flatMap(r => r.legs).find(l => legOptions(l).some(o => o.id === a.legId));
    const planned = at && step ? plannedOf(step, a.legId, at) : null;
    return { id: uid(), legId: a.legId, minutes: a.minutes, date: a.date, ...(at ? { at } : {}), ...(planned != null ? { planned } : {}), ...(a.note ? { note: a.note } : {}) };
  });
  state.legSamples = [...state.legSamples.filter(s => !remove.has(s.legId)), ...added];
  state.settings.appliedFixes = [...(state.settings.appliedFixes || []), fix.id];
  state.view.fixes = (state.view.fixes || []).filter(f => f.id !== fix.id);
  save('settings');
  persist('legSamples');
  return () => {
    state.legSamples = was;
    state.settings.appliedFixes = state.settings.appliedFixes.filter(id => id !== fix.id);
    state.view.fixes = [...(state.view.fixes || []), fix];
    save('settings');
    persist('legSamples');
  };
}

function fixesCard() {
  const list = state.view.fixes || [];
  if (!list.length) return null;
  return list.map(f => {
    const now = state.legSamples.filter(s => (f.remove || []).includes(s.legId)).length;
    return h('section', { class: 'card prepared fix' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', null, 'Fix ready: ', h('bdi', null, f.title)), h('p', { class: 'hint' }, f.text, ` You have ${now} time${now === 1 ? '' : 's'} there now.`)),
        h('button', { class: 'btn primary apply-fix', onclick: () => {
          const undo = applyFix(f);
          toast('Fixed your times', { action: 'Undo', onAction: undo });
        } }, 'Apply')));
  });
}

const importedVersion = id => state.settings.routeVersions?.[id] ?? ((state.settings.importedRoutes || []).includes(id) ? 1 : 0);

// Step ids stay the same across versions, so an update keeps your timed history.
function addPrepared() {
  const list = state.view.prepared || [];
  const ids = new Set(list.map(r => r.id));
  const gone = new Set(state.myRoutes.filter(r => list.some(x => x.retired && x.id === r.id)).flatMap(r => r.legs.flatMap(sampleIds)));
  state.legSamples = state.legSamples.filter(s => !gone.has(s.legId));
  const added = list.filter(r => !r.retired);
  state.myRoutes = [...state.myRoutes.filter(r => !ids.has(r.id)), ...added];
  for (const r of added) for (const name of [r.from, r.to]) {
    if (!state.places.some(p => norm(p.name) === norm(name))) state.places = [...state.places, { id: uid(), name, aliases: [] }];
  }
  state.settings.routeVersions = { ...state.settings.routeVersions, ...Object.fromEntries(list.map(r => [r.id, r.version || 1])) };
  state.view.prepared = [];
  save('settings');
  persist('myRoutes', 'places', 'legSamples');
  if (state.view.feed) syncTimetable();
  toast(`Updated your routes: ${list.length} ready`);
}

function preparedCard() {
  const list = state.view.prepared || [];
  if (!list.length) return null;
  const isUpdate = r => state.myRoutes.some(x => x.id === r.id);
  return h('section', { class: 'card prepared' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, `${list.length} route${list.length === 1 ? '' : 's'} ready`),
        h('ul', { class: 'prepared-list' }, list.map(r => h('li', { dir: 'auto' }, r.retired ? 'Removed, now part of another: ' : isUpdate(r) ? 'Update: ' : 'New: ', h('bdi', null, r.from), ' → ', h('bdi', null, r.to), ', ', h('bdi', null, r.name))))),
      h('button', { class: 'btn primary', onclick: addPrepared }, 'Add to my routes')));
}

// Routes between the same two places, both ways, with home first in its pairs and the pairs
// with home first in the list. Within a direction: your usual route, then others, fallbacks last.
export function routeGroups(routes, home = '') {
  const isHome = n => !!home && norm(n) === norm(home);
  const pairs = new Map();
  for (const r of routes) {
    const [a, b] = [r.from, r.to].sort((x, y) => (isHome(y) - isHome(x)) || x.localeCompare(y));
    const key = `${norm(a)}|${norm(b)}`;
    if (!pairs.has(key)) pairs.set(key, { a, b, ways: new Map() });
    const ways = pairs.get(key).ways, way = `${norm(r.from)}>${norm(r.to)}`;
    if (!ways.has(way)) ways.set(way, { from: r.from, to: r.to, routes: [] });
    ways.get(way).routes.push(r);
  }
  const rank = r => (r.preferred ? 0 : r.fallback ? 2 : 1);
  return [...pairs.values()]
    .sort((x, y) => (isHome(y.a) - isHome(x.a)) || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
    .map(p => ({ a: p.a, b: p.b, ways: [...p.ways.values()]
      .sort((x, y) => (norm(y.from) === norm(p.a)) - (norm(x.from) === norm(p.a)))
      .map(w => ({ ...w, routes: [...w.routes].sort((x, y) => rank(x) - rank(y)) })) }));
}

// Routes with a bus or train whose times were typed by hand, from before the official timetable.
export const handTyped = routes => routes.filter(r => r.legs.some(l => (l.kind === 'bus' || l.kind === 'train') && !l.feed));

function handTypedCard() {
  const list = handTyped(state.myRoutes);
  // Routes ready to add replace some of these, so they come first.
  if (!list.length || state.view.prepared?.length) return null;
  const keep = state.myRoutes.filter(r => !list.includes(r));
  const lines = state.lines.filter(x => !keep.some(r => r.legs.some(l => l.lineId === x.id)));
  const remove = async () => {
    const what = `${list.length} route${list.length === 1 ? '' : 's'}${lines.length ? ` and ${lines.length} line${lines.length === 1 ? '' : 's'}` : ''}`;
    if (!await confirmDialog({ title: `Remove ${what}?`, body: 'Their timed history goes too. You can undo this right after.', action: `Remove ${what}`, danger: true })) return;
    const was = { myRoutes: state.myRoutes, legSamples: state.legSamples, lines: state.lines };
    const ids = new Set(list.flatMap(r => r.legs.flatMap(sampleIds)));
    state.myRoutes = keep;
    state.legSamples = state.legSamples.filter(s => !ids.has(s.legId));
    state.lines = state.lines.filter(x => !lines.includes(x));
    persist('myRoutes', 'legSamples', 'lines');
    toast(`Removed ${what}`, { action: 'Undo', onAction: () => { Object.assign(state, was); persist('myRoutes', 'legSamples', 'lines'); } });
  };
  return h('section', { class: 'card hand-typed' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, 'Routes with times you typed'),
        h('p', { class: 'hint' }, 'These are from before the official timetable, so their bus and train times do not stay current.')),
      h('button', { class: 'btn danger-ghost', onclick: remove }, `Remove ${list.length === 1 ? 'it' : `these ${list.length}`}`)),
    h('ul', { class: 'prepared-list' },
      list.map(r => h('li', { dir: 'auto' }, h('bdi', null, r.from), ' → ', h('bdi', null, r.to), ', ', h('bdi', null, r.name), r.day ? `, only on ${fmt(parseYmd(r.day), { day: 'numeric', month: 'short' })}` : '')),
      lines.map(x => h('li', { dir: 'auto' }, 'Line: ', h('bdi', null, x.name)))));
}

// Which place pairs are open, for this visit only.
const openPairs = new Set();

export function myRoutesSection() {
  const stats = legStats(state.legSamples);
  const groups = routeGroups(state.myRoutes.filter(x => !x.day), state.settings.home);
  const oneTime = state.myRoutes.filter(r => r.day).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return [
    preparedCard(),
    fixesCard(),
    handTypedCard(),
    changesCard(),
    tripPlannerCard(),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', null, 'Your routes'), h('p', { class: 'hint' }, 'The trips you really take. Day plan uses them for every journey in your day.'),
          feedStatusText() ? h('p', { class: `${missingTimes(state.myRoutes) ? 'tl-warn' : 'hint'} feed-status` }, feedStatusText()) : null),
        h('button', { class: 'btn primary', onclick: () => openRouteEditor() }, 'New route')),
      groups.length ? groups.map(g => {
        const key = `${norm(g.a)}|${norm(g.b)}`, count = g.ways.reduce((n, w) => n + w.routes.length, 0);
        const ways = g.ways.map(w => `${w.from} → ${w.to}`);
        return h('details', { class: 'route-pair', open: openPairs.has(key), ontoggle: e => { if (e.target.open) openPairs.add(key); else openPairs.delete(key); } },
          h('summary', null, h('span', { class: 'route-pair-name', dir: 'auto' }, h('bdi', null, g.a), ' ↔ ', h('bdi', null, g.b)),
            h('span', { class: 'hint' }, `${count} route${count === 1 ? '' : 's'}${ways.length === 1 ? `, ${ways[0]} only` : ''}`)),
          g.ways.map(w => h('div', { class: 'route-group' },
            h('div', { class: 'route-group-head' }, h('h3', { dir: 'auto' }, h('bdi', null, w.from), ' → ', h('bdi', null, w.to)),
              h('button', { class: 'link', onclick: () => openRouteEditor(null, { from: w.from, to: w.to }) }, 'Another route')),
            h('ul', { class: 'route-list' }, w.routes.map(r => routeRow(r, stats))))));
      })
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
  if (!trip.boarded) return {};
  const planned = plannedOf(leg, trip.ride || leg.id, trip.stepStart);
  return { at: trip.stepStart, ...(planned == null ? {} : { planned }) };
}

// The departure the timetable had next after you reached the stop at `at`, from any line on
// the step, in minutes of the day. Saved with a wait, so you can see later how the bus kept to it.
function dueAfter(leg, at) {
  const d = new Date(at), wd = d.getDay(), t = d.getHours() * 60 + d.getMinutes();
  const deps = legOptions(leg).flatMap(o => {
    if (o.trips) return (o.trips[wd] || []).map(x => x[0]);
    try { return o.times ? parseDepartures(o.times, wd) : []; } catch { return []; }
  });
  return deps.filter(x => x >= t).sort((a, b) => a - b)[0] ?? null;
}

// The ride the timetable expected for one way of riding a step, boarded at `at`.
function plannedOf(leg, rideId, at) {
  const step = leg.lineId ? { ...leg, line: state.lines.find(x => x.id === leg.lineId) || null } : leg;
  const opt = legOptions(step).find(o => o.id === rideId);
  const d = new Date(at);
  return opt ? timetabledRide(opt, d.getDay(), d.getHours() * 60 + d.getMinutes()) : null;
}

function nextStep(skip = false) {
  const trip = state.trip, route = tripRoute();
  const leg = route.legs[trip.index];
  const now = Date.now();
  if (!skip) trip.laps.push({ legId: trip.ride || leg.id, of: leg.id, start: trip.stepStart, minutes: Math.max(1, Math.round((now - trip.stepStart) / 60000)), ...plannedFor(leg, trip) });
  // A way that takes you all the way, like a lift home, ends the trip.
  const took = legOptions(leg).find(o => o.id === trip.ride);
  trip.index = !skip && took?.allTheWay ? route.legs.length : trip.index + 1;
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
  const due = dueAfter(leg, trip.stepStart);
  trip.laps.push({ legId: waitId(leg.id), of: leg.id, wait: true, start: trip.stepStart, minutes: Math.max(0, Math.round((now - trip.stepStart) / 60000)), ...(due != null ? { due } : {}) });
  trip.boarded = true;
  if (ride) trip.ride = ride;
  trip.stepStart = now;
  persist('trip');
}

function openTripReview() {
  const trip = state.trip, route = tripRoute();
  // `timed` is what the stopwatch said, kept when you correct it, so it can be brought back.
  const rows = trip.laps.map(lap => ({ ...lap, timed: lap.minutes, leg: route.legs.find(l => l.id === (lap.of || lap.legId)), keep: true }));
  const label = r => (r.wait ? `Waiting for ${waitName(r.leg)}` : legLabel(legOptions(r.leg).find(o => o.id === r.legId) || r.leg));
  // A ride on a step with several lines can be moved to the line really taken, and is then
  // compared with that line's timetable.
  const ridePicker = r => h('select', { class: 'ride-pick', 'aria-label': `Which line for ${legLabel(r.leg)}`, onchange: e => {
    r.legId = e.target.value;
    r.planned = r.at ? plannedOf(r.leg, r.legId, r.at) : null;
  } }, legOptions(r.leg).map(o => h('option', { value: o.id, selected: o.id === r.legId }, legLabel(o))));
  const end = () => { state.trip = null; };
  // A note says what was different, and an unusual trip is kept out of your averages but stays
  // in your history, where it can be counted again.
  const extra = { note: '', unusual: false };
  const { close } = dialog(h('form', { class: 'review', onsubmit: e => {
    e.preventDefault();
    const kept = rows.filter(r => r.keep && r.minutes >= (r.wait ? 0 : 1));
    const tripId = uid(), note = extra.note.trim();
    state.legSamples = [...state.legSamples, ...kept.map(r => ({ id: uid(), legId: r.legId, minutes: r.minutes, date: trip.day, trip: tripId, routeId: route.id,
      ...(r.start ? { at: r.start } : {}), ...(r.planned != null ? { planned: r.planned } : {}), ...(r.minutes !== r.timed ? { timed: r.timed } : {}), ...(r.due != null ? { due: r.due } : {}), ...(note ? { note } : {}), ...(extra.unusual ? { unusual: true } : {}) }))];
    end();
    close();
    persist('legSamples', 'trip');
    toast(extra.unusual ? `Saved ${kept.length} time${kept.length === 1 ? '' : 's'} in your history, left out of your averages.` : `Saved ${kept.length} time${kept.length === 1 ? '' : 's'}. Your estimates are updated.`);
  } },
    h('h2', null, 'Save these times?'),
    h('p', { class: 'hint' }, 'Correct anything that was off, and untick a time you do not want saved.'),
    h('ul', { class: 'lap-list' }, rows.map(r => h('li', null,
      !r.wait && hasAlts(r.leg)
        ? h('div', { class: 'check grow' }, h('input', { type: 'checkbox', checked: true, 'aria-label': `Keep the time for ${legLabel(r.leg)}`, onchange: e => { r.keep = e.target.checked; } }), ridePicker(r))
        : h('label', { class: 'check grow' }, h('input', { type: 'checkbox', checked: true, onchange: e => { r.keep = e.target.checked; } }), h('bdi', null, label(r))),
      h('label', { class: 'leg-min' }, h('input', { type: 'number', min: r.wait ? 0 : 1, max: 600, value: r.minutes, 'aria-label': `Minutes for ${label(r)}`, oninput: e => { r.minutes = Math.round(+e.target.value) || 0; } }), h('span', { class: 'hint' }, 'min'))))),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Note (optional)'),
      h('textarea', { rows: 2, dir: 'auto', class: 'trip-note', placeholder: 'Like: lots of bags, walked slower', oninput: e => { extra.note = e.target.value; } })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', class: 'trip-unusual', onchange: e => { extra.unusual = e.target.checked; } }),
      'An unusual trip: keep it in my history, but out of my averages'),
    h('div', { class: 'row end' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { end(); close(); persist('trip'); toast('Discarded the trip'); } }, 'Discard'),
      h('button', { class: 'btn primary' }, 'Save times'))));
}

// Where a ride starts and ends, when the official timetable says.
const stopFrom = l => l.feed?.from?.name || null, stopTo = l => l.feed?.to?.name || null;
const placeWord = l => (l.kind === 'bus' ? 'the stop' : l.kind === 'train' ? 'the station' : 'the pick-up');
const rideName = l => (legLabel(l) === 'Train' ? 'the train' : legLabel(l));

/* What the bar says at each moment, made for tapping in a hurry: what you are doing now, what
   the button confirms, and what comes after it. */
export function tripStatus(route, trip) {
  const leg = route.legs[trip.index], next = route.legs[trip.index + 1];
  const took = legOptions(leg).find(o => o.id === trip.ride) || leg;
  const last = !next || took.allTheWay;
  const ride = isTransit(leg);
  if (ride && !trip.boarded) {
    const at = stopFrom(leg);
    return { now: `Waiting for ${hasAlts(leg) ? waitName(leg) : rideName(leg)}${at ? ` at ${at}` : ''}`, then: `Ride${stopTo(leg) ? ` to ${stopTo(leg)}` : ''}`, button: `I'm on ${rideName(leg)}` };
  }
  if (ride) {
    const off = stopTo(took);
    return { now: `On ${rideName(took)}${off ? `, get off at ${off}` : ''}`, then: last ? 'You are there' : legLabel(next), button: last ? "I've arrived" : `I got off${off ? ` at ${off}` : ''}` };
  }
  if (last) return { now: legLabel(leg), then: 'You are there', button: "I've arrived" };
  if (isTransit(next)) {
    const at = stopFrom(next) || placeWord(next);
    return { now: legLabel(leg), then: `Wait for ${hasAlts(next) ? waitName(next) : rideName(next)}`, button: `I'm at ${at}` };
  }
  return { now: legLabel(leg), then: legLabel(next), button: `Done: ${legLabel(leg)}` };
}

// Stays on screen on every page, and survives a reload, since it runs from saved timestamps.
export function tripBar() {
  const trip = state.trip, route = tripRoute();
  if (!trip || !route) return null;
  if (trip.index >= route.legs.length) return null;
  const leg = route.legs[trip.index];
  const waiting = isTransit(leg) && !trip.boarded;
  const total = route.legs.length;
  const say = tripStatus(route, trip);
  return h('section', { class: 'trip-bar', 'aria-label': 'Trip timer' },
    h('div', { class: 'trip-info' },
      h('span', { class: 'eyebrow' }, h('bdi', null, route.name), ` · step ${trip.index + 1} of ${total}`),
      h('b', { class: 'trip-now', dir: 'auto' }, 'Now: ', h('bdi', null, say.now)),
      h('span', { class: 'trip-next', dir: 'auto' }, 'Next: ', h('bdi', null, say.then))),
    h('span', { class: 'trip-clock', 'data-since': trip.stepStart, role: 'timer' }, clock(Date.now() - trip.stepStart)),
    h('div', { class: 'trip-actions' },
      // With several lines on the step, boarding says which one, so the ride counts for it.
      waiting && hasAlts(leg)
        ? legOptions(leg).map(o => h('button', { class: 'btn primary board-on', onclick: () => boarded(o.id) }, h('bdi', null, o.alt && o.kind !== leg.kind ? `${legLabel(o)} instead` : `On ${legLabel(o)}`)))
        : waiting ? h('button', { class: 'btn primary', onclick: () => boarded() }, h('bdi', null, say.button))
        : h('button', { class: 'btn primary', onclick: () => nextStep() }, h('bdi', null, say.button)),
      leg.optional || waiting ? h('button', { class: 'btn ghost', onclick: () => nextStep(true) }, waiting ? 'Skip this ride' : 'Skip this stop') : null,
      h('button', { class: 'btn ghost', onclick: async () => {
        if (await confirmDialog({ title: 'Cancel this trip?', body: 'Times from this trip are not saved.', action: 'Cancel trip', danger: true })) { state.trip = null; persist('trip'); }
      } }, 'Cancel')),
    // The steps from here on, with the finished ones folded into one, so the current step is
    // always in view. A bus or train starts with its wait, shown as a step of its own.
    h('ol', { class: 'trip-steps', 'aria-label': 'Steps' },
      trip.index ? h('li', { class: 'done' }, `✓ ${trip.index} done`) : null,
      route.legs.slice(trip.index).flatMap((l, i) => {
        const here = i === 0, wait = isTransit(l);
        const chip = (text, now) => h('li', { class: now ? 'now' : here && wait && !now ? (trip.boarded ? 'done' : '') : '', 'aria-current': now ? 'step' : null }, h('bdi', null, text));
        return wait ? [chip(`Wait for ${rideName(l)}`, here && !trip.boarded), chip(legLabel(l), here && trip.boarded)] : [chip(legLabel(l), here)];
      })));
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
  const note = h('textarea', { rows: 2, dir: 'auto', class: 'log-note', placeholder: 'Note (optional), like: lots of bags' });
  const unusual = h('input', { type: 'checkbox', class: 'log-unusual' });
  const { close } = dialog(h('form', { class: 'confirm', onsubmit: e => {
    e.preventDefault();
    const id = which ? which.value : legId;
    const name = choices?.find(c => c.id === id)?.name || label;
    state.legSamples = [...state.legSamples, { id: uid(), legId: id, minutes: Math.round(+minutes.value), date: date.value, ...(planned != null && id === legId ? { planned } : {}),
      ...(note.value.trim() ? { note: note.value.trim() } : {}), ...(unusual.checked ? { unusual: true } : {}) }];
    close();
    persist('legSamples');
    toast(`Logged ${Math.round(+minutes.value)} min for ${name}`);
  } },
    h('h2', { dir: 'auto' }, `Log: ${which ? choices.map(c => c.name).join(' or ') : label}`),
    which ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Which line you took'), which) : null,
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Minutes it took'), minutes),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Day'), date)),
    note,
    h('label', { class: 'check' }, unusual, 'Unusual: keep it out of my averages'),
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary' }, 'Log time'))));
}
