// The walk log: how long each walk really took. Averages feed the route planner.
import { state, save, emit } from '../store.js';
import { h, ymd, parseYmd, fmt, uid, norm } from '../util.js';
import { network } from '../core.js';
import { walkStats } from '../transit.js';
import { dialog, toast, icon } from '../ui.js';

const persist = () => { save('walkLog'); emit(); };

export function openWalkLog({ from = '', to = '', dateMs = Date.now(), minutes = '' } = {}) {
  const today = ymd(Date.now());
  const day = ymd(dateMs) > today ? today : ymd(dateMs);
  const listId = 'walk-places';
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const fail = msg => { err.textContent = msg; err.hidden = false; };
  const fromI = h('input', { list: listId, dir: 'auto', value: from, autocomplete: 'off', required: true });
  const toI = h('input', { list: listId, dir: 'auto', value: to, autocomplete: 'off', required: true });
  const minI = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: 300, step: 1, value: minutes, required: true, autofocus: !!(from && to) });
  const dateI = h('input', { type: 'date', max: today, value: day, required: true });
  const submit = e => {
    e.preventDefault();
    const a = fromI.value.trim(), b = toI.value.trim(), m = Number(minI.value);
    if (norm(a) === norm(b)) return fail('Start and end have to be different places.');
    if (!Number.isInteger(m) || m < 1 || m > 300) return fail('Enter the minutes as a whole number from 1 to 300.');
    if (!dateI.value || dateI.value > today) return fail('Choose today or an earlier day.');
    state.walkLog = [...state.walkLog, { id: uid(), from: a, to: b, minutes: m, date: dateI.value }];
    close();
    persist();
    const s = walkStats(state.walkLog).get(`${norm(a)}>${norm(b)}`);
    toast(`Logged ${m} min. Your average for this walk is now ${s.avg} min.`);
  };
  const { close } = dialog(h('form', { class: 'review', onsubmit: submit },
    h('header', { class: 'row between' }, h('h2', null, 'Log a walk'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(), html: icon('x') })),
    h('datalist', { id: listId }, network().names.map(n => h('option', { value: n }))),
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'From'), fromI),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'To'), toI)),
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Minutes it took'), minI),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Day'), dateI)),
    err,
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary' }, 'Log walk'))));
}

function removeEntry(entry) {
  state.walkLog = state.walkLog.filter(w => w !== entry);
  persist();
  toast(`Removed the ${entry.minutes} min walk`, { action: 'Undo', onAction: () => { state.walkLog = [...state.walkLog, entry]; persist(); } });
}

// Walks written in your timetables plus any direction you have logged. Big GTFS
// transfer lists are left out, since they are not walks anyone chose to track.
function walkRows() {
  const rows = new Map();
  const add = (from, to, listed) => {
    const k = `${norm(from)}>${norm(to)}`;
    if (!rows.has(k)) rows.set(k, { from, to, listed: null, entries: [] });
    if (listed != null) rows.get(k).listed = listed;
    return rows.get(k);
  };
  for (const f of state.feeds) if (f.kind !== 'gtfs') for (const [a, b, min] of f.walks) add(f.nodes[a], f.nodes[b], min);
  for (const w of state.walkLog) add(w.from, w.to).entries.push(w);
  return [...rows.values()];
}

export function walksCard() {
  const stats = walkStats(state.walkLog);
  const rows = walkRows();
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, 'Walking times'),
        h('p', { class: 'hint' }, 'Log how long your walks take. Estimates use your average, rounded up, for that direction.')),
      h('button', { class: 'btn ghost', onclick: () => openWalkLog() }, 'Log a walk')),
    rows.length ? h('ul', { class: 'walk-list' }, rows.map(r => {
      const s = stats.get(`${norm(r.from)}>${norm(r.to)}`);
      return h('li', { class: 'walk-row' },
        h('div', { class: 'walk-main' },
          h('span', { class: 'walk-route' }, h('bdi', null, r.from), ' → ', h('bdi', null, r.to)),
          h('span', { class: 'walk-value' }, s ? `${s.avg} min` : r.listed != null ? `${r.listed} min` : ''),
          h('span', { class: 'hint walk-source' }, s ? `Average of ${s.count} walk${s.count === 1 ? '' : 's'}` : 'Timetable estimate'),
          h('button', { class: 'btn ghost walk-log', 'aria-label': `Log a walk from ${r.from} to ${r.to}`, onclick: () => openWalkLog({ from: r.from, to: r.to }) }, 'Log')),
        r.entries.length ? h('details', { class: 'j-details' },
          h('summary', null, 'History'),
          h('ul', { class: 'walk-history' }, [...r.entries].sort((a, b) => (a.date < b.date ? 1 : -1)).map(e => h('li', null,
            h('span', null, fmt(parseYmd(e.date), { weekday: 'short', day: 'numeric', month: 'short' })),
            h('span', { class: 'mono' }, `${e.minutes} min`),
            h('button', { class: 'icon-btn', 'aria-label': `Remove ${e.minutes} minute walk on ${e.date}`, onclick: () => removeEntry(e), html: icon('x') }))))) : null);
    })) : h('p', { class: 'hint' }, 'Nothing logged yet.'));
}
