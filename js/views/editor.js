// The event panel: viewing and editing are the same screen.
import { state, emit } from '../store.js';
import { h, ymd, fmtTime, parseYmd, parseClock, MIN, addDays, fmt, fmtBefore, startOfDay } from '../util.js';
import { calById, catOf, colorOf, patchEvent, createEvent, deleteEvent, timeBody } from '../core.js';
import { currentMinutes, writable, colorCondition, privateChanges, GOOGLE_COLORS } from '../rules.js';
import { dialog, minuteChips, toast, confirmDialog, icon } from '../ui.js';

const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);

const SWATCHES = ['#4a33e8', '#0f8b8d', '#1f9d55', '#e0a100', '#f2622e', '#e5397a', '#8b2fc9', '#3d4a5c'];

export function openNewEvent(startMs, endMs, summary = '') {
  const snapped = Math.round(startMs / (15 * MIN)) * (15 * MIN);
  const cal = state.calendars.find(c => c.primary && writable(c)) || state.calendars.find(writable);
  if (!cal) { toast('None of your calendars can be edited.', { error: true }); return; }
  openPanel({ isNew: true, id: null, calId: cal.id, summary, location: '', description: '', colorId: null, allDay: false, startMs: snapped, endMs: endMs || snapped + 60 * MIN, useDefault: true, overrides: [], ext: {} });
}

export const openEditor = ev => openPanel(ev);

function openPanel(ev) {
  const cal = calById(ev.calId);
  const editable = writable(cal);
  const canEditDetails = editable && ev.organizerSelf !== false;
  const form = {
    summary: ev.summary, location: ev.location, description: ev.description, calId: ev.calId,
    allDay: ev.allDay, date: ymd(ev.startMs), start: fmtTime(ev.startMs), end: fmtTime(ev.endMs),
    endDate: ymd(ev.allDay ? ev.endMs - 86400000 : ev.endMs),
    colorId: ev.colorId, customColor: ev.ext?.color || null, catId: ev.ext?.cat || '',
    manual: !!ev.ext?.manual, minutes: currentMinutes(ev, cal), scope: 'one',
  };
  const cat = catOf(ev);
  let close;

  const read = () => {
    const startMs = form.allDay ? parseYmd(form.date) : parseYmd(form.date) + parseClock(form.start) * MIN;
    let endMs = form.allDay ? addDays(parseYmd(form.endDate), 1) : parseYmd(form.endDate) + parseClock(form.end) * MIN;
    return { startMs, endMs };
  };

  const notifBox = h('div');
  const drawNotif = () => {
    notifBox.replaceChildren(
      h('div', { class: 'seg wide', role: 'group', 'aria-label': 'Notification source' },
        h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(!form.manual), onclick: () => { form.manual = false; drawNotif(); } }, 'Follow category'),
        h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(form.manual), onclick: () => { form.manual = true; drawNotif(); } }, 'Just this event')),
      form.manual
        ? h('div', { class: 'stack-s' }, minuteChips(form.minutes, m => { form.minutes = m; drawNotif(); }), form.minutes.length ? null : h('p', { class: 'hint' }, 'No notifications for this event.'))
        : h('p', { class: 'hint' }, followText()));
  };
  const followText = () => {
    const c = cat;
    if (!c || c.minutes == null) return `Currently: ${listText(currentMinutes(ev, cal))}. Set a rule for ${c ? `"${c.name}"` : 'this category'} under Alerts & colors.`;
    return `"${c.name}" rule: ${listText(c.minutes)}.`;
  };
  const listText = list => list.length ? list.map(m => (m === 0 ? 'at start' : `${fmtBefore(m)} before`)).join(', ') : 'no notifications';

  const colorBox = h('div', { class: 'swatches' });
  const drawColor = () => {
    colorBox.replaceChildren(
      h('button', { type: 'button', class: 'swatch-text', 'aria-pressed': String(!form.customColor), onclick: () => { form.customColor = null; drawColor(); } }, 'Category color'),
      ...SWATCHES.map(c => h('button', { type: 'button', class: 'swatch', style: { '--c': c }, 'aria-label': `Color ${c}`, 'aria-pressed': String(form.customColor === c), onclick: () => { form.customColor = c; drawColor(); } })),
      h('input', { type: 'color', class: 'swatch-input', 'aria-label': 'Pick any color', value: form.customColor || colorOf(ev), oninput: e => { form.customColor = e.target.value; } }));
  };

  const dateRow = h('div');
  const drawDates = () => {
    const d = !canEditDetails;
    dateRow.replaceChildren(h('div', { class: 'date-grid' },
      field('Starts', h('input', { type: 'date', value: form.date, disabled: d, oninput: e => { form.date = e.target.value; form.endDate = e.target.value; drawDates(); } })),
      form.allDay ? field('Ends', h('input', { type: 'date', value: form.endDate, disabled: d, oninput: e => { form.endDate = e.target.value; } })) : field('From', h('input', { type: 'time', value: form.start, disabled: d, oninput: e => { form.start = e.target.value; } })),
      form.allDay ? null : field('To', h('input', { type: 'time', value: form.end, disabled: d, oninput: e => { form.end = e.target.value; } }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: form.allDay, disabled: d, onchange: e => { form.allDay = e.target.checked; drawDates(); } }), 'All day'));
  };

  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  // The panel can be longer than the screen, so the message goes where it cannot be missed.
  const showError = msg => { errorBox.textContent = msg; errorBox.hidden = false; toast(msg, { error: true }); };

  const save = async btn => {
    errorBox.hidden = true;
    const { startMs, endMs } = read();
    if (!form.allDay && parseClock(form.start) == null) return showError('Enter a start time.');
    if (!form.allDay && parseClock(form.end) == null) return showError('Enter an end time.');
    if (endMs <= startMs) return showError('The event has to end after it starts.');
    const ext = privateChanges(ev, { countinColor: form.customColor, countinManual: form.manual ? '1' : null, countinCat: form.catId });
    // Choosing a category with a Google color also shows that color in Google Calendar.
    const chosen = state.categories.find(c => c.id === form.catId);
    const owner = chosen?.parentId ? state.categories.find(c => c.id === chosen.parentId) : chosen;
    const limitedTo = chosen ? colorCondition(chosen) : null;
    if (limitedTo) form.colorId = limitedTo === 'none' ? null : limitedTo;
    else if (owner?.colorId && owner.calId === form.calId) form.colorId = owner.colorId;
    const reminders = form.manual ? { useDefault: false, overrides: form.minutes.map(m => ({ method: 'popup', minutes: m })) } : undefined;
    btn.disabled = true;
    try {
      if (ev.isNew) {
        await createEvent(form.calId, {
          summary: form.summary || 'Untitled', location: form.location, description: form.description,
          ...(form.colorId ? { colorId: form.colorId } : {}),
          ...timeBody(ev, startMs, endMs, form.allDay), ...(reminders ? { reminders } : {}), ...ext,
        });
        toast(`Added "${form.summary || 'Untitled'}"`);
      } else {
        const patch = { ...ext };
        if (canEditDetails) {
          for (const k of ['summary', 'location', 'description']) if (form[k] !== ev[k]) patch[k] = form[k];
          if (startMs !== ev.startMs || endMs !== ev.endMs || form.allDay !== ev.allDay) { patch._startMs = startMs; patch._endMs = endMs; patch._allDay = form.allDay; }
        }
        if (form.colorId !== ev.colorId) patch.colorId = form.colorId;
        if (reminders) patch.reminders = reminders;
        if (Object.keys(patch).length) await patchEvent(ev, patch, form.scope);
        toast(Object.keys(patch).length ? 'Saved changes' : 'Nothing to save');
      }
      close();
    } catch (e) {
      showError(e.message);
      btn.disabled = false;
    }
  };

  const remove = async () => {
    const isSeries = !!ev.recurringEventId;
    let scope = 'one';
    const extra = isSeries ? scopePicker('one', v => { scope = v; }) : null;
    const yes = await confirmDialog({
      title: `Delete "${ev.summary || 'Untitled'}"?`, action: 'Delete', danger: true, extra,
      body: state.mode === 'google' ? 'It also goes to the trash in Google Calendar, where you can restore it for 30 days.' : null,
    });
    if (!yes) return;
    try { await deleteEvent(ev, scope); toast('Deleted'); close(); } catch (e) { showError(e.message); }
  };

  const planRoute = () => {
    state.route = { ...state.route, to: ev.location || state.route.to, date: ymd(ev.startMs), time: fmtTime(ev.startMs), eventTitle: ev.summary };
    state.view.page = 'routes';
    close();
    emit();
  };

  const body = h('form', { class: 'panel', onsubmit: e => { e.preventDefault(); save(e.submitter || e.target.querySelector('[type=submit]')); } },
    h('header', { class: 'panel-head', style: { '--c': colorOf(ev) } },
      h('span', { class: 'panel-dot' }),
      h('span', { class: 'panel-cal' }, ev.isNew ? 'New event' : (cat?.name || cal?.summary)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(), html: icon('x') })),
    h('input', { class: 'panel-title', 'aria-label': 'Title', placeholder: 'Add a title', dir: 'auto', value: form.summary, readonly: !canEditDetails, oninput: e => { form.summary = e.target.value; }, autofocus: !!ev.isNew }),
    !editable ? h('p', { class: 'note' }, `"${cal?.summary}" is read-only, so this event can only be changed by its owner. To quiet it, change the calendar's default under Alerts & colors.`) : null,
    !canEditDetails && editable ? h('p', { class: 'note' }, 'Someone else organizes this event. You can still change its color and your notifications.') : null,
    dateRow,
    field('Where', h('input', { dir: 'auto', list: 'event-places', autocomplete: 'off', value: form.location, placeholder: 'Add a place', disabled: !canEditDetails, oninput: e => { form.location = e.target.value; } })),
    h('datalist', { id: 'event-places' }, state.places.map(p => h('option', { value: p.name }))),
    ev.isNew && state.calendars.filter(writable).length > 1 ? field('Calendar', h('select', { onchange: e => { form.calId = e.target.value; } }, state.calendars.filter(writable).map(c => h('option', { value: c.id, selected: c.id === form.calId }, c.summary)))) : null,
    editable && state.categories.length ? field('Category', h('select', { onchange: e => { form.catId = e.target.value; } },
      h('option', { value: '' }, ev.isNew || !cat ? 'Automatic' : `Automatic (${cat.name})`),
      state.categories.filter(c => !c.parentId).flatMap(p => [p, ...state.categories.filter(k => k.parentId === p.id)])
        .map(c => h('option', { value: c.id, selected: c.id === form.catId }, c.parentId ? `${state.categories.find(p => p.id === c.parentId)?.name} › ${c.name}` : c.name)))) : null,
    editable ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Notifications'), notifBox) : null,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Color in Count-in'), colorBox,
      h('span', { class: 'field-hint' }, form.colorId && GOOGLE_COLORS[form.colorId] ? `Google Calendar keeps showing ${GOOGLE_COLORS[form.colorId][0]}.` : '')),
    field('Notes', h('textarea', { rows: 3, dir: 'auto', value: form.description, disabled: !canEditDetails, oninput: e => { form.description = e.target.value; } })),
    ev.recurringEventId && editable ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Repeating event'), scopePicker('one', v => { form.scope = v; })) : null,
    h('footer', { class: 'panel-foot' },
      errorBox,
      !ev.isNew && canEditDetails ? h('button', { type: 'button', class: 'btn danger-ghost', onclick: remove }, 'Delete') : null,
      !ev.isNew ? h('button', { type: 'button', class: 'btn ghost', onclick: planRoute }, 'Plan route') : null,
      h('span', { class: 'spacer' }),
      editable ? h('button', { type: 'submit', class: 'btn primary' }, ev.isNew ? 'Add event' : 'Save changes') : null));

  drawDates(); drawNotif(); drawColor();
  ({ close } = dialog(body, { className: 'drawer' }));
}

function scopePicker(initial, onChange) {
  const name = `scope-${Math.random().toString(36).slice(2)}`;
  const opt = (v, label) => h('label', { class: 'check' }, h('input', { type: 'radio', name, value: v, checked: initial === v, onchange: () => onChange(v) }), label);
  return h('div', { class: 'row gap' }, opt('one', 'This event'), opt('series', 'All in the series'));
}
