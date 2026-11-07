// Alerts & colors: the rules page. Nothing is written to Google until "Review" is confirmed.
import { state, save, emit } from '../store.js';
import { h, addDays, startOfDay, fmt, fmtBefore, fmtTime, uid, norm } from '../util.js';
import { ctx, catOf, pendingOps, applyOps, undoLastApply, setCalendarDefaults, sync, skipOp, clearSkipped, skippedCount } from '../core.js';
import { pingsPerDay, GOOGLE_COLORS, writable, colorPairs, mergeCategories, effectiveCategory, hoursToMark, markColors, markOp, colorCondition } from '../rules.js';
import { dialog, minuteChips, toast, confirmDialog, icon } from '../ui.js';

const persist = () => { save('categories', 'settings'); emit(); };

function hero(events) {
  const from = startOfDay(Date.now());
  const c = ctx();
  const now = pingsPerDay(events, c, from, 7, false), next = pingsPerDay(events, c, from, 7, true);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const a = sum(now), b = sum(next);
  const peak = Math.max(1, ...now, ...next);
  const strip = (vals, cls) => vals.map((v, i) => h('div', { class: 'strip-day' },
    h('div', { class: `strip-bars ${cls}` }, Array.from({ length: v }, () => h('i', { style: { height: `${100 / peak}%` } }))),
  ));
  const same = a === b;
  return h('section', { class: 'hero' },
    h('div', { class: 'hero-num' },
      h('p', { class: 'eyebrow' }, 'Notifications in the next 7 days'),
      h('p', { class: 'big' }, h('span', { class: same ? '' : 'was' }, a), same ? null : h('span', { class: 'arrow' }, '→'), same ? null : h('span', null, b)),
      h('p', { class: 'hint' }, same ? 'Set a rule below and see the difference here.' : 'What you get now, and what you would get with these rules.')),
    h('div', { class: 'hero-strips' }, [...Array(7).keys()].map(i => h('div', { class: 'strip-col' },
      h('div', { class: 'strip-pair' }, strip([now[i]], 'cur'), same ? null : strip([next[i]], 'next')),
      h('span', { class: 'strip-label' }, fmt(addDays(from, i), { weekday: 'short' })),
      h('span', { class: 'strip-count' }, same || now[i] === next[i] ? now[i] : `${now[i]}→${next[i]}`)))));
}

const calName = id => state.calendars.find(c => c.id === id)?.summary || 'Unknown calendar';
const pairName = p => (p.colorId ? `${GOOGLE_COLORS[p.colorId]?.[0]} in ${calName(p.calId)}` : `${calName(p.calId)}, no color`);

// Every real title in a group, each assigned to a sub-category with one choice.
function titlePicker(cat) {
  const kids = state.categories.filter(c => c.parentId === cat.id);
  if (!kids.length) return null;
  const titles = new Map();
  for (const e of state.events) {
    const c = catOf(e);
    if (c?.id !== cat.id && c?.parentId !== cat.id) continue;
    const t = (e.summary || '').trim();
    if (!t) continue;
    const row = titles.get(norm(t)) || { title: t, count: 0 };
    row.count++;
    titles.set(norm(t), row);
  }
  if (!titles.size) return null;
  const assign = (title, kidId) => {
    for (const k of kids) k.keywords = (k.keywords || []).filter(w => norm(w) !== norm(title));
    const kid = kids.find(k => k.id === kidId);
    if (kid) kid.keywords = [...kid.keywords, title];
    persist();
  };
  const rows = [...titles.values()].sort((a, b) => b.count - a.count);
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, `Titles in "${cat.name}"`),
    h('ul', { class: 'title-list' }, rows.map(r => {
      const current = kids.find(k => k.keywords?.some(w => norm(w) === norm(r.title)));
      return h('li', { class: 'title-row' },
        h('span', { class: 'title-name', dir: 'auto' }, r.title),
        h('span', { class: 'hint' }, r.count === 1 ? 'once' : `${r.count} times`),
        h('select', { 'aria-label': `Sub-category for ${r.title}`, onchange: e => assign(r.title, e.target.value) },
          h('option', { value: '', selected: !current }, `Just ${cat.name}`),
          kids.map(k => h('option', { value: k.id, selected: current === k }, k.name))));
    })));
}

// Which colors and title words make an event belong to this category.
function membership(cat) {
  const parent = cat.parentId ? state.categories.find(c => c.id === cat.parentId) : null;
  const words = h('input', {
    dir: 'auto', value: (cat.keywords || []).join(', '), placeholder: parent ? 'הרכב תופים, Bass lesson' : 'WIS, office, meeting',
    'aria-label': `Title words for ${cat.name}`,
    onchange: e => { cat.keywords = [...new Set(e.target.value.split(/[,،]/).map(w => w.trim()).filter(Boolean))]; persist(); },
  });
  const others = state.categories.filter(c => c !== cat && !c.parentId);
  const subName = h('input', { dir: 'auto', placeholder: 'Name, for example "Bass"', 'aria-label': `New sub-category inside ${cat.name}` });
  const addSub = e => {
    e.preventDefault();
    const name = subName.value.trim();
    if (!name) return;
    state.categories = [...state.categories, { id: uid(), name, parentId: cat.id, calId: null, colorId: null, also: [], keywords: [name], minutes: null, pendingColorId: null, color: null }];
    persist();
  };
  const allTitles = parent ? (() => {
    const seen = new Map();
    for (const e of state.events) {
      const t = (e.summary || '').trim();
      if (!t || (cat.keywords || []).some(w => norm(w) === norm(t))) continue;
      const row = seen.get(norm(t)) || { title: t, count: 0 };
      row.count++;
      seen.set(norm(t), row);
    }
    return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 200);
  })() : [];
  return h('details', { class: 'cat-more' },
    h('summary', { 'aria-label': `What belongs in ${cat.name}` }, 'What belongs here'),
    h('div', { class: 'cat-more-body' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, parent ? 'Events with exactly these titles' : 'Any event with these words in its title'), words,
        h('span', { class: 'field-hint' }, parent ? `Separate titles with commas. These events join "${parent.name}", whatever their color.` : 'Separate words with commas. Title words win over colors, from any calendar.')),
      parent && allTitles.length ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Add a title from your calendar'),
        h('select', { onchange: e => { if (!e.target.value) return; cat.keywords = [...(cat.keywords || []), e.target.value]; persist(); } },
          h('option', { value: '' }, 'Choose a title'),
          allTitles.map(t => h('option', { value: t.title }, `${t.title} (${t.count})`)))) : null,
      parent ? null : titlePicker(cat),
      parent ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Only events with this color in Google Calendar'),
        h('select', { onchange: e => { cat.whenColor = e.target.value || null; cat.whenNoColor = false; persist(); } },
          h('option', { value: '', selected: !colorCondition(cat) }, 'Any color'),
          h('option', { value: 'none', selected: colorCondition(cat) === 'none' }, 'No color'),
          Object.entries(GOOGLE_COLORS).map(([id, [name]]) => h('option', { value: id, selected: colorCondition(cat) === id }, name)))) : null,
      parent && colorCondition(cat) ? h('span', { class: 'field-hint' }, 'When an event changes color in Google Calendar, it moves to the parent. Color changes to the parent skip these events.') : null,
      parent ? null : h('form', { class: 'field', onsubmit: addSub }, h('span', { class: 'field-label' }, `Add a sub-category inside "${cat.name}"`),
        h('div', { class: 'row gap' }, subName, h('button', { class: 'btn ghost' }, 'Add'))),
      (cat.also || []).length ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Also includes'),
        h('div', { class: 'chips' }, cat.also.map(p => h('span', { class: 'chip' }, pairName(p),
          h('button', { class: 'chip-x', 'aria-label': `Take ${pairName(p)} back out of ${cat.name}`, onclick: () => { cat.also = cat.also.filter(x => x !== p); persist(); sync(); }, html: icon('x') }))))) : null,
      !parent && others.length ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, `Combine "${cat.name}" into another category`),
        h('select', { onchange: e => {
          const target = state.categories.find(c => c.id === e.target.value);
          if (!target) return;
          state.categories = mergeCategories(state.categories, cat, target);
          persist();
          toast(`Combined "${cat.name}" into "${target.name}"`);
        } }, h('option', { value: '' }, 'Choose a category'), others.map(c => h('option', { value: c.id }, c.name)))) : null));
}

function colorPopover(cat) {
  const taken = new Set(state.categories.filter(c => c !== cat).flatMap(colorPairs).filter(p => p.calId === cat.calId).map(p => p.colorId));
  const palette = ['#4a33e8', '#2563eb', '#0ea5c4', '#0f8b8d', '#1f9d55', '#7cb518', '#e0a100', '#f2622e', '#e23d3d', '#e5397a', '#8b2fc9', '#3d4a5c'];
  const googleNow = cat.pendingColorId || cat.colorId;
  const shown = effectiveCategory(cat, state.categories).color;
  return h('details', { class: 'color-pop' },
    h('summary', { class: 'cat-swatch', style: { '--c': shown }, 'aria-label': `Change color of ${cat.name}` }),
    h('div', { class: 'pop' },
      h('p', { class: 'pop-title' }, 'Color in Count-in'),
      h('div', { class: 'swatches' },
        palette.map(c => h('button', { class: 'swatch', style: { '--c': c }, 'aria-label': c, 'aria-pressed': String(cat.color === c), onclick: () => { cat.color = c; persist(); } })),
        h('input', { type: 'color', class: 'swatch-input', 'aria-label': 'Pick any color', value: shown, onchange: e => { cat.color = e.target.value; persist(); } })),
      cat.parentId && cat.color ? h('button', { class: 'link', onclick: () => { cat.color = null; persist(); } }, 'Use the parent\'s color') : null,
      cat.colorId && writable(state.calendars.find(c => c.id === cat.calId)) ? [
        h('p', { class: 'pop-title' }, 'Color in Google Calendar'),
        h('div', { class: 'swatches' }, Object.entries(GOOGLE_COLORS).map(([id, [name, hex]]) => h('button', {
          class: 'swatch', style: { '--c': hex }, 'aria-label': name, title: taken.has(id) ? `${name} is used by another category` : name, disabled: taken.has(id), 'aria-pressed': String(googleNow === id),
          onclick: () => { cat.pendingColorId = id === cat.colorId ? null : id; persist(); },
        }))),
        h('p', { class: 'hint' }, 'Google only offers these 11 colors.'),
      ] : null));
}

// Total time of this month's events so far, for categories that track work still to do.
function hoursSoFar(cat) {
  const now = Date.now();
  const first = new Date(now); first.setDate(1); first.setHours(0, 0, 0, 0);
  const list = state.events.filter(e => !e.allDay && e.startMs >= first.getTime() && e.startMs < now && catOf(e)?.id === cat.id);
  const mins = list.reduce((sum, e) => sum + (Math.min(e.endMs, now) - e.startMs) / 60000, 0);
  const hrs = Math.round(mins / 6) / 10;
  return `${hrs} hr so far this month, ${list.length} event${list.length === 1 ? '' : 's'}`;
}

// Colors a month's finished hours in one go, after showing exactly which ones.
function openMarkHours(cat) {
  const parent = state.categories.find(c => c.id === cat.parentId);
  const hours = hoursToMark(state.events, cat, ctx(), Date.now());
  if (!hours.length) { toast('No finished hours to mark right now.'); return; }
  const monthOf = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}`; };
  const months = [...new Map(hours.map(e => [monthOf(e.startMs), e.startMs])).entries()];
  const offered = markColors(parent, cat);
  const colors = offered.length ? offered : Object.keys(GOOGLE_COLORS).filter(id => id !== colorCondition(cat));
  const form = { month: months[0][0], colorId: parent.colorId && colors.includes(parent.colorId) ? parent.colorId : colors[0] };
  let selected = new Set();
  const listRoot = h('div', { class: 'review-list' });
  const summary = h('p', { class: 'strong', role: 'status' });
  const applyBtn = h('button', { class: 'btn primary' });
  const shown = () => hours.filter(e => monthOf(e.startMs) === form.month);
  const refresh = () => {
    const mins = [...selected].reduce((s, e) => s + (e.endMs - e.startMs) / 60000, 0);
    const n = selected.size;
    summary.textContent = `${n} event${n === 1 ? '' : 's'}, ${Math.round(mins / 6) / 10} hr`;
    applyBtn.textContent = n ? `Color ${n} event${n === 1 ? '' : 's'} ${GOOGLE_COLORS[form.colorId][0]}` : 'Select events to color';
    applyBtn.disabled = !n;
  };
  const draw = () => {
    selected = new Set(shown());
    listRoot.replaceChildren(h('ul', null, shown().map(e => h('li', { class: 'review-row' },
      h('label', { class: 'review-pick' },
        h('input', { type: 'checkbox', checked: true, onchange: x => { if (x.target.checked) selected.add(e); else selected.delete(e); refresh(); } }),
        h('span', { class: 'review-text' },
          h('span', { class: 'review-title', dir: 'auto' }, e.summary || 'Untitled'),
          h('span', { class: 'review-when' }, `${fmt(e.startMs, { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtTime(e.startMs)}–${fmtTime(e.endMs)}`)))))));
    refresh();
  };
  applyBtn.addEventListener('click', async () => {
    const ops = [...selected].map(e => markOp(e, form.colorId));
    applyBtn.disabled = true;
    const res = await applyOps(ops);
    close();
    if (res.failed) toast(`Colored ${res.done}, ${res.failed} failed. ${res.error}`, { error: true });
    else toast(`Marked ${res.done} event${res.done === 1 ? '' : 's'} as entered`, {
      action: 'Undo', onAction: async () => { const u = await undoLastApply(); toast(`Undid ${u.done} change${u.done === 1 ? '' : 's'}`); },
    });
  });
  const { close } = dialog(h('div', { class: 'review' },
    h('header', { class: 'row between' }, h('h2', null, 'Mark hours as entered'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(), html: icon('x') })),
    h('p', { class: 'hint' }, 'Each ticked event gets this color in Google Calendar, one occurrence at a time, and moves back to the parent category. Only events that have ended are listed.'),
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Month'),
        h('select', { onchange: e => { form.month = e.target.value; draw(); } }, months.map(([k, t]) => h('option', { value: k }, fmt(t, { month: 'long', year: 'numeric' }))))),
      h('label', { class: 'field grow' }, h('span', { class: 'field-label' }, 'Color'),
        h('select', { onchange: e => { form.colorId = e.target.value; refresh(); } }, colors.map(id => h('option', { value: id, selected: id === form.colorId }, GOOGLE_COLORS[id][0]))))),
    summary, listRoot,
    h('div', { class: 'row end' }, h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), applyBtn)));
  draw();
}

const removedToast = (cat, before, extra = '') => toast(`Removed "${cat.name}"${extra}`, { action: 'Undo', onAction: () => { state.categories = before; persist(); } });

// A top category with events would just come back at the next sync, so its events
// go somewhere first. Everything else can simply go.
function removeCategory(cat, hasEvents) {
  const before = state.categories;
  if (cat.parentId || !hasEvents.has(cat.id)) {
    state.categories = before.filter(c => c !== cat && c.parentId !== cat.id);
    persist();
    removedToast(cat, before);
    return;
  }
  const OTHER = '__other';
  const others = before.filter(c => c !== cat && !c.parentId);
  const existingOther = others.find(c => norm(c.name) === 'other');
  const pick = h('select', { 'aria-label': 'Where its events go' },
    existingOther ? null : h('option', { value: OTHER }, 'Other (a new category)'),
    others.map(c => h('option', { value: c.id, selected: c === existingOther }, c.name)));
  const { close } = dialog(h('form', {
    class: 'confirm',
    onsubmit: e => {
      e.preventDefault();
      let cats = before, target = before.find(c => c.id === pick.value);
      if (!target) {
        target = { id: uid(), name: 'Other', calId: null, colorId: null, also: [], keywords: [], minutes: null, pendingColorId: null, color: '#8a8da3' };
        cats = [...before, target];
      }
      state.categories = mergeCategories(cats, cat, target);
      close();
      persist();
      removedToast(cat, before, `. Its events are now in "${target.name}"`);
    },
  },
    h('h2', { dir: 'auto' }, `Remove "${cat.name}"?`),
    h('p', null, 'It still has events, so they need a category. Nothing changes in Google Calendar, but the events follow the new category\'s notification rule, so changes may appear in Review.'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Move its events to'), pick),
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn danger' }, 'Remove category'))));
}

function categoryRow(cat, counts, hasEvents, titlesBy) {
  const n = counts.get(cat.id) || 0;
  const cal = state.calendars.find(c => c.id === cat.calId);
  const ro = cat.calId && !writable(cal);
  const mode = cat.minutes == null ? 'keep' : cat.minutes.length ? 'custom' : 'off';
  const set = minutes => { cat.minutes = minutes; persist(); };
  const seg = (id, label, onclick) => h('button', { class: 'seg-btn', 'aria-pressed': String(mode === id), onclick }, label);
  const parent = cat.parentId ? state.categories.find(c => c.id === cat.parentId) : null;
  return h('li', { class: `cat-row ${parent ? 'child' : ''}` },
    colorPopover(cat),
    h('div', { class: 'cat-name' },
      h('input', { class: 'cat-input', dir: 'auto', value: cat.name, 'aria-label': 'Category name', onchange: e => { cat.name = e.target.value || cat.name; persist(); } }),
      h('span', { class: 'cat-sub', dir: 'auto' }, [
        cat.calId ? pairName({ calId: cat.calId, colorId: cat.pendingColorId || cat.colorId }) : null,
        cat.also?.length ? `+${cat.also.length} more` : null,
        cat.keywords?.length ? `${cat.keywords.length} title word${cat.keywords.length === 1 ? '' : 's'}` : null,
        colorCondition(cat) ? (colorCondition(cat) === 'none' ? 'no color only' : `${GOOGLE_COLORS[colorCondition(cat)][0]} only`) : null,
        colorCondition(cat) ? hoursSoFar(cat) : null,
        `${n} upcoming`,
      ].filter(Boolean).join(' · ')),
      parent && !hasEvents.has(cat.id) ? h('span', { class: 'cat-sub' }, colorCondition(cat) ? 'No events match this title and color right now.' : 'No event has exactly this title.') : null,
      titlesBy.get(cat.id)?.length ? h('span', { class: 'cat-sub cat-titles' }, 'Includes ', titlesBy.get(cat.id).map((t, i) => [i ? ', ' : '', h('bdi', null, t)])) : null,
      colorCondition(cat) ? h('button', { class: 'link mark-hours', onclick: () => openMarkHours(cat) }, 'Mark hours as entered') : null),
    ro
      ? h('p', { class: 'cat-ro' }, 'Read-only calendar. Use its default below.')
      : h('div', { class: 'cat-rule' },
        h('div', { class: 'seg', role: 'group', 'aria-label': `Notifications for ${cat.name}` },
          seg('keep', parent ? `Same as ${parent.name}` : 'Leave as is', () => set(null)),
          seg('off', 'Off', () => set([])),
          seg('custom', 'Choose', () => set(cat.minutes?.length ? cat.minutes : [15]))),
        mode === 'custom' ? minuteChips(cat.minutes, set) : null),
    h('button', { class: 'icon-btn', 'aria-label': `Remove category ${cat.name}`, title: 'Remove category', onclick: () => removeCategory(cat, hasEvents), html: icon('x') }),
    membership(cat));
}

function quietCard() {
  const q = state.settings.quiet;
  const up = patch => { Object.assign(q, patch); persist(); };
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, 'Quiet hours'), h('p', { class: 'hint' }, 'A notification that would fire in this window moves or disappears.')),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: q.on, 'aria-label': 'Quiet hours on', onchange: e => up({ on: e.target.checked }) }), h('span'))),
    q.on ? h('div', { class: 'row gap wrap' },
      h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, 'From'), h('input', { type: 'time', value: q.from, onchange: e => up({ from: e.target.value }) })),
      h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, 'To'), h('input', { type: 'time', value: q.to, onchange: e => up({ to: e.target.value }) })),
      h('label', { class: 'field inline grow' }, h('span', { class: 'field-label' }, 'When one falls inside'), h('select', { onchange: e => up({ mode: e.target.value }) },
        h('option', { value: 'earlier', selected: q.mode === 'earlier' }, 'Send it when quiet hours start'),
        h('option', { value: 'drop', selected: q.mode === 'drop' }, 'Skip it')))) : null);
}

function defaultsCard() {
  const row = cal => {
    const list = (cal.defaultReminders || []).map(r => r.minutes);
    return h('li', { class: 'def-row' },
      h('span', { class: 'def-dot', style: { '--c': cal.color } }),
      h('span', { class: 'def-name', dir: 'auto' }, cal.summary),
      minuteChips(list, async next => {
        try { await setCalendarDefaults(cal.id, next); toast(`Updated the default for ${cal.summary}`); }
        catch (e) { toast(e.message, { error: true }); }
      }));
  };
  return h('section', { class: 'card' },
    h('h2', null, 'Calendar defaults'),
    h('p', { class: 'hint' }, 'Used by new events you add in Google Calendar, and by read-only calendars. These changes save right away. With no default, a new event stays silent until your rules reach it.'),
    h('ul', { class: 'def-list' }, state.calendars.filter(c => c.on).map(row)));
}

function addCategoryForm() {
  const input = h('input', { dir: 'auto', placeholder: 'Name, for example "Friends"', 'aria-label': 'New category name' });
  const add = e => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    state.categories = [{ id: uid(), name, calId: null, colorId: null, also: [], keywords: [name], minutes: null, pendingColorId: null, color: '#3d4a5c' }, ...state.categories];
    persist();
  };
  return h('form', { class: 'add-rule', onsubmit: add },
    h('p', { class: 'hint' }, 'A new category starts by collecting events with its name in the title. Add more words under "What belongs here", or choose it on a single event.'),
    h('div', { class: 'row gap' }, input, h('button', { class: 'btn ghost' }, 'Add category')));
}

function openReview(startOps) {
  let ops = startOps;
  const selected = new Set(ops);
  const target = state.mode === 'google' ? 'Google Calendar' : 'the sample calendar';
  const status = h('p', { class: 'hint', role: 'status' });
  const applyBtn = h('button', { class: 'btn primary' });
  const toggleAll = h('button', { class: 'link', type: 'button' });
  const refresh = () => {
    const n = selected.size;
    applyBtn.textContent = n ? `Save ${n} change${n === 1 ? '' : 's'} to ${target}` : 'Select changes to save';
    applyBtn.disabled = !n;
    toggleAll.textContent = n === ops.length ? 'Select none' : 'Select all';
  };
  const listRoot = h('div', { class: 'review-list' });
  const drawList = () => {
    const groups = new Map();
    for (const op of ops) {
      const name = op.catName || 'No category';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(op);
    }
    listRoot.replaceChildren(...[...groups].map(([name, list]) => h('section', { class: 'review-group' },
      h('h3', { class: 'review-group-title', dir: 'auto' }, name),
      h('ul', null, list.map(op => h('li', { class: 'review-row' },
        h('label', { class: 'review-pick' },
          h('input', { type: 'checkbox', checked: selected.has(op), onchange: e => { if (e.target.checked) selected.add(op); else selected.delete(op); refresh(); } }),
          h('span', { class: 'review-text' },
            h('span', { class: 'review-title', dir: 'auto' }, op.title, op.isSeries ? h('span', { class: 'tag' }, `whole series, ${op.count} upcoming`) : null),
            h('span', { class: 'review-when' }, op.isSeries ? `next: ${fmt(op.when, { weekday: 'short', day: 'numeric', month: 'short' })}` : fmt(op.when, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
            h('span', { class: 'review-change' },
              op.after ? `${txt(op.before)} → ${txt(op.after)}` : null,
              op.color ? ` Color → ${GOOGLE_COLORS[op.color][0]}` : null))),
        h('button', {
          class: 'link review-skip', type: 'button', 'aria-label': `Skip this change for ${op.title}`,
          onclick: () => {
            skipOp(op);
            selected.delete(op);
            ops = ops.filter(o => o !== op);
            if (!ops.length) { close(); return; }
            drawList(); refresh();
          },
        }, 'Skip')))))));
  };
  toggleAll.addEventListener('click', () => {
    if (selected.size === ops.length) selected.clear(); else ops.forEach(o => selected.add(o));
    drawList(); refresh();
  });
  applyBtn.addEventListener('click', async () => {
    const chosen = ops.filter(o => selected.has(o));
    applyBtn.disabled = true;
    const res = await applyOps(chosen, n => { status.textContent = `Saving ${n} of ${chosen.length}`; });
    close();
    if (res.failed) toast(`Saved ${res.done}, ${res.failed} failed. ${res.error}`, { error: true });
    else toast(`Saved ${res.done} change${res.done === 1 ? '' : 's'} to your calendar`, {
      action: 'Undo', onAction: async () => { const u = await undoLastApply(); toast(`Undid ${u.done} change${u.done === 1 ? '' : 's'}`); },
    });
  });
  drawList(); refresh();
  const { close } = dialog(h('div', { class: 'review' },
    h('header', { class: 'row between' }, h('h2', null, 'Review changes'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(), html: icon('x') })),
    h('p', { class: 'hint' }, 'Only the ticked changes are saved. Unticked ones stay here for later, and Skip stops offering a change unless the rule changes. Guests are not notified, and you can undo a save.'),
    h('div', null, toggleAll),
    listRoot,
    status, h('div', { class: 'row end' }, h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), applyBtn)));
}
const txt = list => (list.length ? list.map(m => fmtBefore(m)).join(', ') : 'none');

export function renderAlerts() {
  const now = Date.now();
  const upcoming = state.events.filter(e => e.endMs > now && state.calendars.find(c => c.id === e.calId)?.on !== false);
  const counts = new Map();
  for (const e of upcoming) {
    const c = catOf(e);
    if (!c) continue;
    counts.set(c.id, (counts.get(c.id) || 0) + 1);
    if (c.parentId) counts.set(c.parentId, (counts.get(c.parentId) || 0) + 1); // a group counts its sub-categories
  }
  const ops = pendingOps();
  const hasColorPending = state.categories.some(c => c.pendingColorId);
  const hasEvents = new Set();
  const titleCounts = new Map();
  for (const e of state.events) {
    const c = catOf(e);
    if (!c) continue;
    hasEvents.add(c.id);
    if (c.parentId) hasEvents.add(c.parentId);
    if (!titleCounts.has(c.id)) titleCounts.set(c.id, new Map());
    const t = (e.summary || 'Untitled').trim();
    titleCounts.get(c.id).set(t, (titleCounts.get(c.id).get(t) || 0) + 1);
  }
  // The commonest titles, so a category can be recognized whatever it is called.
  const titlesBy = new Map([...titleCounts].map(([id, m]) => [id, [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0])]));
  const byCount = (a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0);
  const cats = state.categories.filter(c => !c.parentId).sort(byCount)
    .flatMap(c => [c, ...state.categories.filter(k => k.parentId === c.id).sort(byCount)]);
  return h('section', { class: 'alerts-page' },
    h('h1', { class: 'page-title' }, 'Alerts & colors'),
    hero(upcoming),
    h('section', { class: 'card' },
      h('h2', null, 'Categories'),
      h('p', { class: 'hint' }, 'Each of your calendar colors starts as a category. Rename, combine or extend them, and each one decides its own notifications and color.'),
      cats.length ? h('ul', { class: 'cat-list' }, cats.map(c => categoryRow(c, counts, hasEvents, titlesBy))) : h('p', { class: 'hint' }, 'Categories appear after your calendar loads.'),
      addCategoryForm()),
    quietCard(),
    defaultsCard(),
    state.history.length ? h('p', { class: 'undo-line' }, h('button', {
      class: 'link', onclick: async () => {
        const n = state.history[0].done.length;
        if (await confirmDialog({ title: 'Undo the last save?', body: `This puts ${n} change${n === 1 ? '' : 's'} back the way they were.`, action: 'Undo save' })) {
          const u = await undoLastApply();
          toast(`Undid ${u.done} change${u.done === 1 ? '' : 's'}${u.failed ? `, ${u.failed} failed` : ''}`, { error: !!u.failed });
        }
      },
    }, 'Undo the last save')) : null,
    skippedCount() ? h('p', { class: 'undo-line' }, `${skippedCount()} change${skippedCount() === 1 ? '' : 's'} skipped. `, h('button', { class: 'link', onclick: clearSkipped }, 'Offer them again')) : null,
    ops.length || hasColorPending ? h('div', { class: 'apply-bar' },
      h('span', null, h('b', null, ops.length), ` change${ops.length === 1 ? '' : 's'} ready for your calendar`),
      h('button', { class: 'btn primary', disabled: !ops.length, onclick: () => openReview(ops) }, 'Review')) : null);
}
