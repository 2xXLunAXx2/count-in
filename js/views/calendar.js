import { state, emit } from '../store.js';
import { h, DAY, MIN, addDays, startOfDay, startOfWeek, sameDay, fmt, fmtTime, fmtBefore, minutesOfDay, inkOn, ymd } from '../util.js';
import { ctx, calById, colorOf, visibleEvents, patchEvent, catOf } from '../core.js';
import { currentMinutes, pingsPerDay, writable } from '../rules.js';
import { openEditor, openNewEvent } from './editor.js';
import { planFor, openPlan } from './plan.js';
import { toast, icon } from '../ui.js';

const PX = 0.9; // pixels per minute
const SNAP = 15;

const isNarrow = () => window.innerWidth < 760;

function visibleDays() {
  const { cal, anchor } = state.view;
  if (cal === 'day') return [startOfDay(anchor)];
  if (isNarrow()) return [0, 1, 2].map(i => addDays(startOfDay(anchor), i));
  const w = startOfWeek(anchor, state.settings.weekStart);
  return [...Array(7).keys()].map(i => addDays(w, i));
}

export function step(dir) {
  const { cal, anchor } = state.view;
  if (cal === 'month') { const d = new Date(anchor); d.setDate(1); d.setMonth(d.getMonth() + dir); state.view.anchor = d.getTime(); }
  else state.view.anchor = addDays(anchor, dir * (cal === 'day' ? 1 : isNarrow() ? 3 : 7));
  emit();
}

function rangeTitle() {
  const { cal, anchor } = state.view;
  if (cal === 'month') return fmt(anchor, { month: 'long', year: 'numeric' });
  const days = visibleDays();
  if (days.length === 1) return fmt(days[0], { weekday: 'long', day: 'numeric', month: 'long' });
  const a = days[0], b = days[days.length - 1];
  return new Date(a).getMonth() === new Date(b).getMonth()
    ? `${new Date(a).getDate()}–${fmt(b, { day: 'numeric', month: 'long' })}`
    : `${fmt(a, { day: 'numeric', month: 'short' })} – ${fmt(b, { day: 'numeric', month: 'short' })}`;
}

function toolbar() {
  const seg = (id, label) => h('button', { class: 'seg-btn', 'aria-pressed': String(state.view.cal === id), onclick: () => { state.view.cal = id; emit(); } }, label);
  return h('header', { class: 'cal-bar' },
    h('h1', { class: 'cal-title' }, rangeTitle()),
    h('div', { class: 'cal-actions' },
      h('button', { class: 'btn ghost', onclick: () => { state.view.anchor = Date.now(); emit(); } }, 'Today'),
      h('div', { class: 'pager' },
        h('button', { class: 'icon-btn', 'aria-label': 'Previous', onclick: () => step(-1), html: icon('left') }),
        h('button', { class: 'icon-btn', 'aria-label': 'Next', onclick: () => step(1), html: icon('right') })),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Calendar view' }, seg('day', 'Day'), seg('week', isNarrow() ? '3 days' : 'Week'), seg('month', 'Month')),
      h('button', { class: 'btn primary new-event', onclick: () => openNewEvent(Date.now() + 3600000) }, h('span', { html: icon('plus') }), 'New event')));
}

function layoutDay(events) {
  const sorted = [...events].sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const cols = [];
    for (const ev of cluster) {
      let c = cols.findIndex(end => end <= ev.startMs);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = Math.max(ev.endMs, ev.startMs + 20 * MIN);
      out.push({ ev, col: c, ref: cols });
    }
    cluster = [];
  };
  for (const ev of sorted) {
    if (cluster.length && ev.startMs >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.endMs);
  }
  flush();
  return out.map(({ ev, col, ref }) => ({ ev, col, cols: ref.length }));
}

const canMove = ev => writable(calById(ev.calId)) && ev.organizerSelf !== false;

function eventBlock(ev, day, slot) {
  const color = colorOf(ev), ink = inkOn(color);
  const start = Math.max(ev.startMs, day), end = Math.min(ev.endMs, addDays(day, 1));
  const top = (start - day) / MIN * PX, height = Math.max((end - start) / MIN * PX - 2, 16);
  const width = 100 / slot.cols;
  const el = h('button', {
    class: `ev ${ev.endMs < Date.now() ? 'past' : ''} ${height < 34 ? 'tight' : ''}`,
    'data-ev': ev.id,
    style: { top: `${top}px`, height: `${height}px`, left: `${slot.col * width}%`, width: `calc(${width}% - 2px)`, '--c': color, '--ink': ink },
    onclick: e => { if (!el.dataset.dragged) openEditor(ev); delete el.dataset.dragged; e.stopPropagation(); },
  },
    h('span', { class: 'ev-title', dir: 'auto' }, ev.summary || 'Untitled'),
    h('span', { class: 'ev-meta' }, `${fmtTime(ev.startMs)}–${fmtTime(ev.endMs)}`),
    ev.location && height > 62 ? h('span', { class: 'ev-meta ev-loc', dir: 'auto' }, ev.location) : null,
    canMove(ev) ? h('span', { class: 'ev-resize', 'data-resize': '1' }) : null);
  if (canMove(ev)) el.addEventListener('pointerdown', e => startDrag(e, el, ev, day));
  el.addEventListener('pointerenter', () => document.querySelectorAll(`.tick[data-for="${CSS.escape(ev.id)}"]`).forEach(t => t.classList.add('hot')));
  el.addEventListener('pointerleave', () => document.querySelectorAll('.tick.hot').forEach(t => t.classList.remove('hot')));
  return el;
}

function startDrag(e, el, ev, day) {
  if (e.pointerType === 'touch' || e.button !== 0) return;
  const resizing = !!e.target.dataset.resize;
  const x0 = e.clientX, y0 = e.clientY;
  const cols = [...document.querySelectorAll('.day-col')];
  const startTop = parseFloat(el.style.top), startH = parseFloat(el.style.height);
  let moved = false, dMin = 0, dDay = 0;
  const colIdx = cols.findIndex(c => +c.dataset.day === day);
  const onMove = m => {
    if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
    if (!moved) { moved = true; el.classList.add('dragging'); document.body.classList.add('is-dragging'); }
    dMin = Math.round((m.clientY - y0) / PX / SNAP) * SNAP;
    if (resizing) { el.style.height = `${Math.max(startH + dMin * PX, 14)}px`; return; }
    const over = cols.findIndex(c => { const r = c.getBoundingClientRect(); return m.clientX >= r.left && m.clientX < r.right; });
    dDay = over >= 0 ? over - colIdx : dDay;
    el.style.top = `${startTop + dMin * PX}px`;
    el.style.transform = `translateX(${dDay * cols[0].offsetWidth}px)`;
    const s = addDays(ev.startMs, dDay) + dMin * MIN;
    el.querySelector('.ev-meta').textContent = `${fmtTime(s)}–${fmtTime(s + ev.endMs - ev.startMs)}`;
  };
  const onUp = async () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.classList.remove('is-dragging');
    if (!moved) return;
    el.dataset.dragged = '1';
    if (!dMin && !dDay) { emit(); return; }
    const newStart = resizing ? ev.startMs : addDays(ev.startMs, dDay) + dMin * MIN;
    const newEnd = resizing ? Math.max(ev.endMs + dMin * MIN, ev.startMs + SNAP * MIN) : newStart + ev.endMs - ev.startMs;
    const before = { _startMs: ev.startMs, _endMs: ev.endMs };
    try {
      await patchEvent(ev, { _startMs: newStart, _endMs: newEnd });
      const fresh = state.events.find(x => x.id === ev.id && x.calId === ev.calId) || ev;
      toast(ev.recurringEventId ? `Moved this "${ev.summary}" only` : `Moved "${ev.summary}"`, {
        action: 'Undo', onAction: () => patchEvent(fresh, before).catch(err => toast(err.message, { error: true })),
      });
    } catch (err) { toast(err.message, { error: true }); emit(); }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function createDrag(e, col, day) {
  if (e.target !== col && !e.target.classList.contains('day-events')) return;
  if (e.button !== 0) return;
  const rect = col.getBoundingClientRect();
  const snap = y => Math.max(0, Math.round((y - rect.top) / PX / SNAP) * SNAP);
  const startMin = Math.floor((e.clientY - rect.top) / PX / SNAP) * SNAP;
  if (e.pointerType === 'touch') {
    // Taps open the editor from click, so a touch scroll is never mistaken for a new event.
    const y0 = e.clientY;
    col.addEventListener('pointerup', u => { if (Math.abs(u.clientY - y0) < 8) openNewEvent(day + startMin * MIN); }, { once: true });
    return;
  }
  const ghost = h('div', { class: 'draft', style: { top: `${startMin * PX}px`, height: `${60 * PX}px` } });
  col.querySelector('.day-events').append(ghost);
  let endMin = startMin + 60, moved = false;
  const onMove = m => {
    const cur = snap(m.clientY);
    if (cur > startMin + SNAP - 1) { moved = true; endMin = cur; ghost.style.height = `${(endMin - startMin) * PX}px`; }
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    openNewEvent(day + startMin * MIN, day + (moved ? endMin : startMin + 60) * MIN);
    ghost.remove();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function ticksFor(day, events) {
  const out = [];
  const c = ctx();
  const end = addDays(day, 1);
  for (const ev of events) {
    for (const m of currentMinutes(ev, c.calById.get(ev.calId))) {
      const at = ev.startMs - m * MIN;
      if (at < day || at >= end) continue;
      out.push(h('span', {
        class: 'tick', 'data-for': ev.id, style: { top: `${(at - day) / MIN * PX}px`, '--c': colorOf(ev) },
        title: `${fmtTime(at)}: notification for ${ev.summary || 'Untitled'} (${m === 0 ? 'at start' : `${fmtBefore(m)} before`})`,
      }));
    }
  }
  return out;
}

function travelBands(day) {
  return planFor(day).items.filter(i => i.kind === 'travel').map(i => {
    const minutes = Math.round((i.end - i.start) / MIN);
    const height = Math.max(minutes * PX - 2, 14);
    return h('button', {
      class: `travel-band ${i.late ? 'late' : ''}`, style: { top: `${(i.start - day) / MIN * PX}px`, height: `${height}px` },
      'aria-label': `${i.home ? 'Travel home' : `Travel to ${i.to}`}, ${fmtTime(i.start)} to ${fmtTime(i.end)}. Open day plan`,
      title: `${i.home ? 'Travel home' : `Travel to ${i.to}`}: ${fmtTime(i.start)}–${fmtTime(i.end)}`,
      onclick: e => { e.stopPropagation(); openPlan(day); },
    }, h('span', null, i.home ? 'Home' : 'Travel', height > 30 ? ` ${minutes} min` : null));
  });
}

function countTicks(n) {
  const shown = Math.min(n, 12);
  return h('span', { class: 'count-ticks', title: `${n} notification${n === 1 ? '' : 's'} this day`, 'aria-label': `${n} notifications` },
    Array.from({ length: shown }, () => h('i')), n > 12 ? h('b', null, `+${n - 12}`) : null);
}

function weekView() {
  const days = visibleDays();
  const events = visibleEvents();
  const pings = pingsPerDay(events, ctx(), days[0], days.length, false);
  const now = Date.now();
  const allDay = events.filter(e => e.allDay && e.endMs > days[0] && e.startMs < addDays(days[days.length - 1], 1));
  const cols = `--n:${days.length}`;
  const head = h('div', { class: 'week-head', style: cols },
    h('div', { class: 'gutter-cap' }),
    days.map((d, i) => h('button', { class: `day-head ${sameDay(d, now) ? 'today' : ''}`, 'aria-label': `Open ${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}`, onclick: () => { state.view.cal = 'day'; state.view.anchor = d; emit(); } },
      h('span', { class: 'dow' }, fmt(d, { weekday: 'short' })),
      h('span', { class: 'dnum' }, new Date(d).getDate()),
      countTicks(pings[i]))));
  const allRow = allDay.length ? h('div', { class: 'allday-row', style: cols },
    h('div', { class: 'gutter-cap small' }, 'all day'),
    days.map(d => h('div', { class: 'allday-cell' }, allDay.filter(e => e.endMs > d && e.startMs < addDays(d, 1)).map(ev =>
      h('button', { class: 'allday-ev', style: { '--c': colorOf(ev), '--ink': inkOn(colorOf(ev)) }, dir: 'auto', onclick: () => openEditor(ev) }, ev.summary))))) : null;
  const timed = events.filter(e => !e.allDay);
  const grid = h('div', { class: 'week-grid', style: `${cols};--px:${PX}` },
    h('div', { class: 'gutter' }, [...Array(24).keys()].map(hr => h('span', { class: 'hour', style: { top: `${hr * 60 * PX}px` } }, hr ? `${String(hr).padStart(2, '0')}:00` : ''))),
    days.map(d => {
      const list = timed.filter(e => e.endMs > d && e.startMs < addDays(d, 1));
      const col = h('div', { class: `day-col ${sameDay(d, now) ? 'today' : ''}`, 'data-day': d },
        h('div', { class: 'rail' }, ticksFor(d, timed)),
        h('div', { class: 'day-events' }, travelBands(d), layoutDay(list).map(s => eventBlock(s.ev, d, s))),
        sameDay(d, now) ? h('div', { class: 'now', style: { top: `${minutesOfDay(now) * PX}px` } }) : null);
      col.addEventListener('pointerdown', e => createDrag(e, col, d));
      return col;
    }));
  const scroller = h('div', { class: 'week-scroll' }, head, allRow, grid);
  queueMicrotask(() => {
    if (state.view.scrollTop != null) scroller.scrollTop = state.view.scrollTop;
    else scroller.scrollTop = 5.75 * 60 * PX;
  });
  scroller.addEventListener('scroll', () => { state.view.scrollTop = scroller.scrollTop; }, { passive: true });
  return scroller;
}

function monthView() {
  const { anchor } = state.view;
  const first = new Date(anchor); first.setDate(1); first.setHours(0, 0, 0, 0);
  const start = startOfWeek(first.getTime(), state.settings.weekStart);
  const cells = [...Array(42).keys()].map(i => addDays(start, i));
  const events = visibleEvents();
  const pings = pingsPerDay(events, ctx(), start, 42, false);
  const max = isNarrow() ? 2 : 4;
  return h('div', { class: 'month' },
    h('div', { class: 'month-dow' }, cells.slice(0, 7).map(d => h('span', null, fmt(d, { weekday: isNarrow() ? 'narrow' : 'short' })))),
    h('div', { class: 'month-grid' }, cells.map((d, i) => {
      const list = events.filter(e => e.endMs > d && e.startMs < addDays(d, 1));
      const other = new Date(d).getMonth() !== first.getMonth();
      return h('div', { class: `m-cell ${other ? 'other' : ''} ${sameDay(d, Date.now()) ? 'today' : ''}` },
        h('button', { class: 'm-day', 'aria-label': fmt(d, { weekday: 'long', day: 'numeric', month: 'long' }), onclick: () => { state.view.cal = 'day'; state.view.anchor = d; emit(); } },
          h('span', { class: 'm-num' }, new Date(d).getDate()), pings[i] ? countTicks(pings[i]) : null),
        list.slice(0, max).map(ev => h('button', { class: 'm-ev', style: { '--c': colorOf(ev), '--ink': inkOn(colorOf(ev)) }, onclick: () => openEditor(ev) },
          ev.allDay ? null : h('span', { class: 'm-time' }, fmtTime(ev.startMs)), h('span', { class: 'm-title', dir: 'auto' }, ev.summary || 'Untitled'))),
        list.length > max ? h('button', { class: 'm-more', onclick: () => { state.view.cal = 'day'; state.view.anchor = d; emit(); } }, `${list.length - max} more`) : null);
    })));
}

export function renderCalendar() {
  return h('section', { class: 'cal-page' }, toolbar(), state.view.cal === 'month' ? monthView() : weekView());
}
