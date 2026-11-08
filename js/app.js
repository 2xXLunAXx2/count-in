import { state, loadState, save, subscribe, emit } from './store.js';
import { h, addDays, startOfDay, startOfWeek, sameDay, fmt, fmtTime, uid } from './util.js';
import { sync, catOf, ctx, pendingOps, dropSampleData } from './core.js';
import { icon } from './ui.js';
import { renderCalendar } from './views/calendar.js';
import { renderAlerts } from './views/alerts.js';
import { renderRoutes, ensureSampleFeed } from './views/routes.js';
import { renderPlan } from './views/plan.js';
import { tripBar, ensureStarterPlaces, loadPreparedRoutes, syncTimetable } from './views/myroutes.js';
import { renderSettings, renewSession } from './views/settings.js';
import { loadGis, sessionEndingSoon } from './google.js';
import { cloudSync } from './cloud.js';
import { effectiveCategory } from './rules.js';

const PAGES = [
  ['calendar', 'Calendar', 'calendar', renderCalendar],
  ['plan', 'Day plan', 'plan', renderPlan],
  ['alerts', 'Alerts & colors', 'bell', renderAlerts],
  ['routes', 'Routes', 'route', renderRoutes],
  ['settings', 'Settings', 'settings', renderSettings],
];

function go(page) { state.view.page = page; state.view.scrollTop = null; history.replaceState(null, '', `#${page}`); emit(); }

function wordmark() {
  return h('div', { class: 'wordmark', 'aria-label': 'Count-in' },
    h('span', { class: 'mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')), h('span', null, 'Count-in'));
}

function nav(cls) {
  const pending = pendingOps().length;
  return h('nav', { class: cls, 'aria-label': 'Main' }, PAGES.map(([id, label, ic]) =>
    h('button', { class: 'nav-btn', 'aria-current': state.view.page === id ? 'page' : null, onclick: () => go(id) },
      h('span', { class: 'nav-icon', html: icon(ic) }),
      h('span', { class: 'nav-label' }, cls === 'bottom-nav' ? { alerts: 'Alerts', plan: 'Plan' }[id] || label : label),
      id === 'alerts' && pending ? h('span', { class: 'badge', 'aria-label': `${pending} changes ready` }, pending) : null)));
}

function miniMonth() {
  const a = new Date(state.view.anchor);
  const first = new Date(a.getFullYear(), a.getMonth(), 1).getTime();
  const start = startOfWeek(first, state.settings.weekStart);
  const cells = [...Array(42).keys()].map(i => addDays(start, i));
  const weekStart = startOfWeek(state.view.anchor, state.settings.weekStart);
  const inRange = d => state.view.cal === 'day' ? sameDay(d, state.view.anchor) : (d >= weekStart && d < addDays(weekStart, 7));
  return h('div', { class: 'mini' },
    h('p', { class: 'mini-title' }, fmt(first, { month: 'long', year: 'numeric' })),
    h('div', { class: 'mini-grid' },
      cells.slice(0, 7).map(d => h('span', { class: 'mini-dow' }, fmt(d, { weekday: 'narrow' }))),
      cells.map(d => h('button', {
        class: `mini-day ${new Date(d).getMonth() !== a.getMonth() ? 'other' : ''} ${sameDay(d, Date.now()) ? 'today' : ''} ${inRange(d) ? 'range' : ''}`,
        'aria-label': fmt(d, { day: 'numeric', month: 'long' }),
        onclick: () => { state.view.anchor = d; if (state.view.page !== 'calendar') state.view.page = 'calendar'; if (state.view.cal === 'month') state.view.cal = 'week'; emit(); },
      }, new Date(d).getDate()))));
}

function categoryFilters() {
  const now = Date.now();
  const hidden = new Set(state.settings.hiddenCats);
  const used = new Set(state.events.filter(e => e.endMs > now - 7 * 864e5).map(e => catOf(e)?.id));
  const usedParents = new Set(state.categories.filter(c => c.parentId && used.has(c.id)).map(c => c.parentId));
  const cats = state.categories.filter(c => !c.parentId && (used.has(c.id) || usedParents.has(c.id)))
    .flatMap(c => [c, ...state.categories.filter(k => k.parentId === c.id && used.has(k.id))]);
  if (!cats.length) return null;
  return h('div', { class: 'filters' },
    h('p', { class: 'mini-title' }, 'Categories'),
    cats.map(c => h('button', {
      class: `filter ${c.parentId ? 'child' : ''}`, 'aria-pressed': String(!hidden.has(c.id)), style: { '--c': effectiveCategory(c, state.categories).color },
      onclick: () => {
        state.settings.hiddenCats = hidden.has(c.id) ? state.settings.hiddenCats.filter(x => x !== c.id) : [...state.settings.hiddenCats, c.id];
        save('settings'); emit();
      },
    }, h('span', { class: 'filter-dot' }), h('span', { class: 'filter-name', dir: 'auto' }, c.name))));
}

function syncLine() {
  const { status, at, error } = state.sync;
  if (status === 'signin') return h('button', { class: 'sync warn', onclick: () => renewSession({ force: true }) }, 'Reconnect to Google');
  if (status === 'error') return h('button', { class: 'sync warn', title: error, onclick: () => sync() }, 'Sync failed. Try again');
  return h('button', { class: 'sync', onclick: () => sync(), 'aria-label': 'Sync now' },
    h('span', { class: status === 'syncing' ? 'spin' : '', html: icon('refresh') }),
    status === 'syncing' ? 'Syncing' : state.mode === 'demo' ? 'Sample calendar' : at ? `Synced ${fmtTime(at)}` : 'Sync now');
}

const scrollKeep = new Map();

function render() {
  const root = document.getElementById('app');
  const page = PAGES.find(p => p[0] === state.view.page) || PAGES[0];
  const oldMain = root.querySelector('.main');
  if (oldMain) scrollKeep.set(oldMain.dataset.page, oldMain.scrollTop);
  const openPops = [...root.querySelectorAll('details[open]')].map(d => d.querySelector('summary')?.getAttribute('aria-label')).filter(Boolean);
  const main = h('main', { class: 'main', 'data-page': page[0] },
    tripBar(),
    state.mode === 'demo' && page[0] !== 'settings' ? h('p', { class: 'demo-banner' }, 'This is a sample calendar, so nothing here touches your real one. ', h('button', { class: 'link', onclick: () => go('settings') }, 'Connect Google Calendar')) : null,
    state.view.savedCopy ? h('p', { class: 'error-banner', role: 'alert' }, isLocal()
      ? 'Count-in\'s server is not running, so this is a saved copy and may be out of date. Double-click start.bat, then reload this page.'
      : 'You are offline, so this is a saved copy. Trip timers still run, and your times are shared once you are back online.') : null,
    state.sync.status === 'error' && state.sync.error ? h('p', { class: 'error-banner', role: 'alert' }, state.sync.error) : null,
    state.sync.status === 'signin' ? h('p', { class: 'demo-banner', role: 'alert' }, 'Google sign-ins last about an hour, so this may be out of date. Your client ID is saved. ', h('button', { class: 'link', onclick: () => renewSession({ force: true }) }, 'Reconnect')) : null,
    page[3]());
  root.replaceChildren(
    h('aside', { class: 'side' }, wordmark(), nav('side-nav'), page[0] === 'calendar' ? [miniMonth(), categoryFilters()] : null, h('div', { class: 'spacer' }), syncLine()),
    main,
    nav('bottom-nav'));
  main.scrollTop = scrollKeep.get(page[0]) || 0;
  for (const label of openPops) root.querySelector(`details > summary[aria-label="${CSS.escape(label)}"]`)?.parentElement.setAttribute('open', '');
  const theme = state.settings.theme;
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

const DOCTOR_WORDS = ['doctor', 'dr', 'dentist', 'clinic', 'physio', 'רופא', 'שיניים', 'מרפאה', 'קופת חולים'];

function ensureDoctorsCategory() {
  if (state.settings.doctorsAdded) return;
  state.settings.doctorsAdded = true;
  state.categories = [{ id: uid(), name: 'Doctors', calId: null, colorId: null, also: [], keywords: DOCTOR_WORDS, minutes: null, pendingColorId: null, color: '#e23d3d' }, ...state.categories];
  save('settings', 'categories');
}

const isLocal = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

// The offline copy has never saved this one-off address, so it only loads from the real server.
async function checkServer() {
  let reachable = true;
  try { reachable = (await fetch(`manifest.webmanifest?check=${Date.now()}`, { cache: 'no-store' })).ok; } catch { reachable = false; }
  if (reachable !== !state.view.savedCopy) { state.view.savedCopy = !reachable; emit(); }
}

async function start() {
  await loadState();
  ensureSampleFeed();
  ensureDoctorsCategory();
  ensureStarterPlaces();
  dropSampleData();
  if (state.mode === 'google') {
    // Loaded ahead of time: a click only permits Google's window if it opens straight away.
    loadGis().catch(() => {});
    document.addEventListener('click', () => {
      if (state.mode === 'google' && state.settings.clientId && sessionEndingSoon()) renewSession();
    }, true);
  }
  const hash = location.hash.slice(1);
  if (PAGES.some(p => p[0] === hash)) state.view.page = hash;
  subscribe(render);
  render();
  loadPreparedRoutes();
  // On the computer, the helper's timetable keeps steps current; the phone has no helper.
  if (isLocal()) { syncTimetable(); setInterval(() => { if (!document.hidden) syncTimetable(); }, 10 * 60000); }
  checkServer();
  setInterval(checkServer, 60000);
  window.addEventListener('hashchange', () => { const p = location.hash.slice(1); if (PAGES.some(x => x[0] === p) && p !== state.view.page) go(p); });
  await sync();
  await cloudSync();
  setInterval(() => { if (!document.hidden) { sync(); cloudSync(); } }, 5 * 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Coming back to the app is when another device's trip or times matter.
    cloudSync();
    if (Date.now() - state.sync.at > 60000) sync();
  });
  let lastNarrow = window.innerWidth < 760;
  window.addEventListener('resize', () => { const n = window.innerWidth < 760; if (n !== lastNarrow) { lastNarrow = n; emit(); } });
  // Keep the "now" line and the past-event styling honest.
  setInterval(() => { if (!document.hidden && state.view.page === 'calendar' && !document.querySelector('dialog[open], .dragging')) emit(); }, 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();
