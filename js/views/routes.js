// Routes: pick a place and a deadline, get the latest you can leave.
import { state, save, emit } from '../store.js';
import { h, ymd, fmtClock, fmtTime, parseClock, parseYmd, norm, fmt } from '../util.js';
import { planArrival, parseTimetable, parseGtfs, matchPlace as findPlace, SAMPLE_TIMETABLE } from '../transit.js';
import { calById, network, addTravelEvent, lineName, placeNames, routerFor } from '../core.js';
import { placeFromText } from '../myroutes.js';
import { toast, confirmDialog, icon, dialog } from '../ui.js';
import { openWalkLog, walksCard } from './walks.js';
import { myRoutesSection, openLegLog, openRouteEditor, startTrip } from './myroutes.js';

const lastResult = { journeys: null, query: null, error: '' };

const matchPlace = text => placeFromText(state.places, text) || findPlace(network(), text);

function placeInput(id, label, value, onChange) {
  const listId = `places-${id}`;
  return h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, label),
    h('input', { list: listId, value, dir: 'auto', autocomplete: 'off', placeholder: 'Stop or place', onchange: e => onChange(e.target.value) }),
    h('datalist', { id: listId }, placeNames().map(n => h('option', { value: n }))));
}

function search() {
  const r = state.route;
  lastResult.error = '';
  lastResult.journeys = null;
  const arrive = parseClock(r.time);
  if (!r.from || !r.to) { lastResult.error = 'Choose where you start and where you are going.'; return; }
  if (!r.date || arrive == null) { lastResult.error = 'Choose the date and time you need to be there.'; return; }
  const dateMs = parseYmd(r.date);
  const deadline = arrive - (+r.early || 0);
  try {
    const mine = routerFor(dateMs).arriveOptions(r.from, r.to, deadline).sort((a, b) => b.depart - a.depart);
    const hasRoutes = state.myRoutes.some(x => norm(x.from) === norm(r.from) && norm(x.to) === norm(r.to));
    lastResult.journeys = hasRoutes ? mine : planArrival(network(), { from: r.from, to: r.to, dateMs, arriveBy: deadline, transfer: +state.settings.transfer || 4 });
    lastResult.query = { ...r, dateMs, deadline, arrive };
  } catch (e) {
    lastResult.error = /is not in your timetables/.test(e.message) ? `You have no route from ${r.from} to ${r.to} yet. Add one under Your routes.` : e.message;
  }
}

export function ribbon(j) {
  const total = Math.max(1, j.arrive - j.depart);
  const segs = [];
  let t = j.depart;
  for (const l of j.legs) {
    if (l.dep > t) segs.push(h('i', { class: 'wait', style: { flex: l.dep - t }, title: `Wait ${l.dep - t} min` }));
    segs.push(h('i', { class: l.type === 'walk' ? 'walk' : l.type === 'stop' ? 'stop' : l.mode, style: { flex: l.arr - l.dep }, title: l.text || (l.type === 'walk' ? `Walk ${l.min} min` : `${l.line}, ${l.arr - l.dep} min`) }));
    t = l.arr;
  }
  return h('div', { class: 'ribbon', 'aria-hidden': 'true', style: { '--total': total } }, segs);
}

export function legRow(l, next, transfer, dateMs) {
  const gap = next ? next.dep - l.arr : null;
  if (l.legId) {
    return [
      h('li', { class: `leg ${l.type === 'ride' ? l.mode : l.type}` },
        h('span', { class: 'leg-time' }, fmtClock(l.dep)),
        h('div', { class: 'leg-body' },
          h('p', null, h('bdi', null, l.label), ` · ${l.min} min`),
          h('p', { class: 'hint' }, l.logged ? `Your average of ${l.logged} · ` : 'Your estimate · ',
            h('button', { type: 'button', class: 'link', onclick: () => openLegLog(l.legId, l.label, dateMs) }, 'Log a time')))),
      gap > 0 ? h('li', { class: 'leg-gap' }, `${gap} min wait`) : null,
    ];
  }
  return [
    h('li', { class: `leg ${l.type === 'walk' ? 'walk' : l.mode}` },
      h('span', { class: 'leg-time' }, fmtClock(l.dep)),
      h('div', { class: 'leg-body' },
        l.type === 'walk'
          ? [h('p', null, `Walk ${l.min} min to `, h('bdi', null, l.to)),
            h('p', { class: 'hint' }, l.logged ? `Your average of ${l.logged} walk${l.logged === 1 ? '' : 's'} · ` : 'Timetable estimate · ',
              h('button', { type: 'button', class: 'link', onclick: () => openWalkLog({ from: l.from, to: l.to, dateMs }) }, 'Log this walk'))]
          : [h('p', null, h('span', { class: 'line-tag' }, h('bdi', null, lineName(l))), ' from ', h('bdi', null, l.from)),
            h('p', { class: 'hint' }, `Get off at `, h('bdi', null, l.to), ` at ${fmtClock(l.arr)} · ${l.arr - l.dep} min · ${l.stops.length - 1} stop${l.stops.length > 2 ? 's' : ''}`)])),
    gap > 0 ? h('li', { class: `leg-gap ${l.type !== 'walk' && next.type !== 'walk' && gap <= transfer + 2 ? 'tight' : ''}` },
      gap <= transfer + 2 && l.type !== 'walk' ? `Only ${gap} min to change` : `${gap} min wait`) : null,
  ];
}

export async function addToCalendar(j, q) {
  try {
    await addTravelEvent(j, q);
    toast('Added travel to your calendar, with a notification 10 min before you leave');
  } catch (e) { toast(e.message, { error: true }); }
}

function results() {
  if (lastResult.error) return h('p', { class: 'form-error' }, lastResult.error);
  const js = lastResult.journeys, q = lastResult.query;
  if (!js) return h('div', { class: 'route-empty' }, h('p', null, 'Tell it where you need to be and when. You get the last moment you can leave.'));
  if (!js.length) return h('div', { class: 'route-empty' },
    h('p', { class: 'strong' }, `Nothing gets you there by ${fmtClock(q.deadline)}.`),
    h('p', { class: 'hint' }, 'Try a later time or another day, or check that your timetables cover this trip and this day of the week.'));
  const fewest = Math.min(...js.map(j => j.rides));
  return h('ol', { class: 'journeys' }, js.map((j, i) => {
    const label = j.name ? (i === 0 ? `Latest you can leave: ${j.name}` : j.name) : i === 0 ? 'Latest you can leave' : j.rides === fewest && js[0].rides !== fewest ? 'Fewest changes' : 'Earlier option';
    const spare = q.deadline - j.arrive;
    return h('li', { class: `journey ${i === 0 ? 'first' : ''}` },
      h('div', { class: 'j-head' },
        h('div', null, h('p', { class: 'eyebrow' }, label), h('p', { class: 'j-depart' }, fmtClock(j.depart))),
        h('div', { class: 'j-side' },
          h('p', null, `Arrive ${fmtClock(j.arrive)}`),
          h('p', { class: 'hint' }, `${j.arrive - j.depart} min · ${j.rides <= 1 ? 'no changes' : `${j.rides - 1} change${j.rides > 2 ? 's' : ''}`}${spare > 0 ? ` · ${spare} min spare` : ''}`))),
      ribbon(j),
      h('details', { class: 'j-details', open: i === 0 },
        h('summary', null, 'Step by step'),
        h('ol', { class: 'legs' }, j.legs.map((l, k) => legRow(l, j.legs[k + 1], +state.settings.transfer || 4, q.dateMs)),
          h('li', { class: 'leg end' }, h('span', { class: 'leg-time' }, fmtClock(j.arrive)), h('div', { class: 'leg-body' }, h('p', null, h('bdi', null, q.to)))))),
      h('button', { class: `btn ${i === 0 ? 'primary' : 'ghost'} j-add`, onclick: () => addToCalendar(j, q) }, 'Add travel to calendar'));
  }));
}

function upcomingChips() {
  const now = Date.now();
  const list = state.events.filter(e => !e.allDay && e.startMs > now && e.location && calById(e.calId)?.on !== false).slice(0, 40);
  const seen = new Set(), picks = [];
  for (const e of list) { if (seen.has(e.summary)) continue; seen.add(e.summary); picks.push(e); if (picks.length === 4) break; }
  if (!picks.length) return null;
  return h('div', { class: 'chip-row' },
    h('span', { class: 'field-label' }, 'From your calendar'),
    picks.map(e => h('button', {
      class: 'pick', dir: 'auto',
      onclick: () => {
        const place = matchPlace(e.location);
        state.route = { ...state.route, to: place || state.route.to, date: ymd(e.startMs), time: fmtTime(e.startMs) };
        save('route');
        if (state.route.from && place) search();
        emit();
        if (!place) toast(`"${e.location}" is not in your timetables, so choose the nearest stop.`);
      },
    }, h('b', null, e.summary), ` ${fmt(e.startMs, { weekday: 'short' })} ${fmtTime(e.startMs)}`)));
}

async function importFile(file, status) {
  try {
    let feed;
    if (/\.zip$/i.test(file.name)) feed = await parseGtfs(file, m => { status.textContent = m; });
    else feed = parseTimetable(await file.text(), file.name.replace(/\.\w+$/, ''));
    addFeed(feed);
  } catch (e) { toast(e.message, { error: true }); status.textContent = ''; }
}

function addFeed(feed) {
  state.feeds = [...state.feeds, feed];
  save('feeds');
  toast(`Added ${feed.name}: ${feed.trips.length.toLocaleString('en')} trips, ${feed.nodes.length.toLocaleString('en')} stops`);
  emit();
}

function openPaste() {
  const area = h('textarea', { rows: 14, class: 'mono', dir: 'auto', spellcheck: 'false', value: '', placeholder: 'line: Train R1\nmode: train\ndays: sun-thu\nHome Station, 07:02, 07:32\nCentral, 07:20, 07:50\n\nwalk: Home -> Home Station: 12' });
  const name = h('input', { placeholder: 'Name, for example "Commute"', 'aria-label': 'Timetable name' });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const { close } = dialog(h('div', { class: 'review' },
    h('header', { class: 'row between' }, h('h2', null, 'Paste a timetable'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(), html: icon('x') })),
    h('p', { class: 'hint' }, 'One row per stop and one column per trip. Add a new "line:" block for each direction. Use "-" when a trip skips a stop, and "walk:" for how long it takes on foot between places.'),
    name, area, err,
    h('div', { class: 'row end' },
      h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => {
        try { addFeed(parseTimetable(area.value, name.value.trim() || 'My timetable')); close(); }
        catch (e) { err.textContent = e.message; err.hidden = false; }
      } }, 'Add timetable'))));
}

function timetables() {
  const status = h('p', { class: 'hint', role: 'status' });
  const file = h('input', { type: 'file', accept: '.zip,.txt,.csv,.tsv', hidden: true, onchange: e => { if (e.target.files[0]) importFile(e.target.files[0], status); e.target.value = ''; } });
  return h('section', { class: 'card timetables' },
    h('h2', null, 'Your timetables'),
    state.feeds.length ? h('ul', { class: 'feed-list' }, state.feeds.map(f => h('li', null,
      h('div', null, h('b', { dir: 'auto' }, f.name), h('span', { class: 'hint' }, ` ${f.trips.length.toLocaleString('en')} trips · ${f.nodes.length.toLocaleString('en')} stops`)),
      h('button', { class: 'icon-btn', 'aria-label': `Remove ${f.name}`, onclick: async () => {
        if (await confirmDialog({ title: `Remove ${f.name}?`, action: 'Remove', danger: true })) { state.feeds = state.feeds.filter(x => x !== f); save('feeds'); lastResult.journeys = null; emit(); }
      }, html: icon('x') })))) : h('p', { class: 'hint' }, 'Add a timetable to start planning.'),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn ghost', onclick: openPaste }, 'Paste a timetable'),
      h('button', { class: 'btn ghost', onclick: () => file.click() }, 'Upload a file'), file),
    h('p', { class: 'hint' }, 'Upload the simple text format, or a GTFS .zip, the standard format transit agencies publish.'),
    status,
    h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, 'Minutes you need to change lines'),
      h('input', { type: 'number', min: 0, max: 30, value: state.settings.transfer, onchange: e => { state.settings.transfer = +e.target.value; save('settings'); search(); emit(); } })));
}

export function ensureSampleFeed() {
  if (state.mode === 'demo' && !state.feeds.length && !state.settings.sampleAdded) {
    state.feeds = [{ ...parseTimetable(SAMPLE_TIMETABLE, 'Sample timetable (made-up places)') }];
    state.settings.sampleAdded = true;
    if (!state.route.from) state.route.from = 'Home';
    save('feeds', 'settings', 'route');
  }
}

export function renderRoutes() {
  const r = state.route;
  const up = patch => { Object.assign(state.route, patch); save('route'); };
  if (r.to && !network().ids.has(norm(r.to))) { const m = matchPlace(r.to); if (m) r.to = m; }
  if (r.eventTitle && r.from && r.to && r.date && r.time) { search(); delete r.eventTitle; }
  if (lastResult.journeys) search(); // timed trips and edited routes change the estimates
  return h('section', { class: 'routes-page' },
    h('h1', { class: 'page-title' }, 'Routes'),
    h('div', { class: 'routes-main' }, myRoutesSection()),
    h('h2', { class: 'section-title' }, 'When should I leave?'),
    h('div', { class: 'routes-cols' },
      h('div', { class: 'routes-left' },
        h('form', { class: 'card route-form', onsubmit: e => { e.preventDefault(); search(); emit(); } },
          h('div', { class: 'row gap wrap' },
            placeInput('from', 'From', r.from, v => up({ from: v })),
            h('button', { type: 'button', class: 'icon-btn swap', 'aria-label': 'Swap start and destination', onclick: () => { up({ from: r.to, to: r.from }); emit(); }, html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v15M7 19l-3-3M7 19l3-3M17 20V5M17 5l-3 3M17 5l3 3"/></svg>' }),
            placeInput('to', 'To', r.to, v => up({ to: v }))),
          h('div', { class: 'row gap wrap' },
            h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Date'), h('input', { type: 'date', value: r.date || ymd(Date.now()), onchange: e => up({ date: e.target.value }) })),
            h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Be there by'), h('input', { type: 'time', value: r.time, onchange: e => up({ time: e.target.value }) })),
            h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Arrive early by'), h('select', { onchange: e => up({ early: +e.target.value }) }, [0, 5, 10, 15, 20, 30].map(m => h('option', { value: m, selected: +r.early === m }, m ? `${m} min` : 'No margin'))))),
          upcomingChips(),
          h('button', { class: 'btn primary wide' }, 'Find routes'))),
      h('div', { class: 'routes-right', 'aria-live': 'polite' }, results())),
    h('details', { class: 'advanced' },
      h('summary', { 'aria-label': 'Exact timetables' }, 'Exact timetables (optional)'),
      h('div', { class: 'advanced-body' },
        h('p', { class: 'hint' }, 'Only needed if you want exact schedules. Your routes above are used first, and timetables fill in for trips with no route of yours.'),
        timetables(),
        walksCard())));
}
