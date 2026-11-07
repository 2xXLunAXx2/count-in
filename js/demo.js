// Sample calendar that behaves like the Google backend, so everything can be tried
// (and tested) without touching a real calendar.
import { state, save } from './store.js';
import { normalizeEvent, Conflict } from './google.js';
import { addDays, startOfDay, startOfWeek, ymd, uid, parseYmd, MIN } from './util.js';

const iso = t => new Date(t).toISOString();

export const SAMPLE_CALENDAR_IDS = ['me', 'talks', 'hol'];

function seed() {
  const week = startOfWeek(Date.now(), 0);
  const first = addDays(week, -21);
  const series = (id, calId, summary, colorId, days, hm, dur, extra = {}) => {
    const [hh, mm] = hm.split(':').map(Number);
    const firstDay = [...Array(7).keys()].map(i => addDays(first, i)).find(d => days.includes(new Date(d).getDay()));
    const start = firstDay + (hh * 60 + mm) * MIN;
    return { id, calId, days, base: { summary, colorId, start: { dateTime: iso(start) }, end: { dateTime: iso(start + dur * MIN) }, reminders: { useDefault: true }, ...extra }, exceptions: {} };
  };
  return {
    calendars: [
      { id: 'me', summary: 'My calendar', color: '#4a33e8', accessRole: 'owner', primary: true, defaultReminders: [{ method: 'popup', minutes: 30 }], on: true },
      { id: 'talks', summary: 'Institute seminars', color: '#0b8043', accessRole: 'reader', defaultReminders: [{ method: 'popup', minutes: 10 }], on: true },
      { id: 'hol', summary: 'Holidays', color: '#8e24aa', accessRole: 'reader', defaultReminders: [], on: true },
    ],
    series: [
      series('drums', 'me', 'Drum practice', '2', [0, 1, 2, 3, 4], '06:15', 150),
      series('work', 'me', 'Work', '3', [0, 1, 2, 3, 4], '10:15', 465, { location: 'Institute Gate' }),
      series('ensemble', 'me', 'הרכב תופים', '5', [2], '19:00', 120, { location: 'Music Hall' }),
      series('team', 'me', 'פגישת צוות', '7', [1], '20:00', 60),
      series('lesson', 'me', 'Drum lesson', '1', [3], '19:45', 60, { location: 'Music Hall' }),
      series('plants', 'me', 'Water the plants', '4', [0, 1, 2, 3, 4, 5, 6], '22:00', 15, { transparency: 'transparent', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] } }),
      series('seminar', 'talks', 'Machine learning seminar', null, [4], '11:00', 60, { location: 'Building 3, room 101' }),
    ],
    singles: [
      { id: 'dentist', calId: 'me', summary: 'Dentist', colorId: '6', location: 'Oak Street', start: { dateTime: iso(addDays(week, 5) + 9 * 60 * MIN) }, end: { dateTime: iso(addDays(week, 5) + 10 * 60 * MIN) }, reminders: { useDefault: true } },
      { id: 'jam', calId: 'me', summary: 'Jam with friends', colorId: '5', start: { dateTime: iso(addDays(week, 6) + 17 * 60 * MIN) }, end: { dateTime: iso(addDays(week, 6) + 20 * 60 * MIN) }, reminders: { useDefault: true } },
      { id: 'holiday', calId: 'hol', summary: 'Public holiday', start: { date: ymd(addDays(week, 12)) }, end: { date: ymd(addDays(week, 13)) } },
    ],
    etags: {},
  };
}

const db = () => {
  if (!state.demo) { state.demo = seed(); save('demo'); }
  return state.demo;
};
const commit = () => save('demo');
const etag = id => db().etags[id] || '1';
const bump = id => { db().etags[id] = String(+etag(id) + 1); };

function expand(s, fromMs, toMs) {
  const out = [];
  const firstStart = Date.parse(s.base.start.dateTime);
  const dur = Date.parse(s.base.end.dateTime) - firstStart;
  const tod = firstStart - startOfDay(firstStart);
  for (let d = startOfDay(Math.max(fromMs, firstStart)); d < toMs; d = addDays(d, 1)) {
    if (!s.days.includes(new Date(d).getDay())) continue;
    const id = `${s.id}_${ymd(d)}`;
    const ex = s.exceptions[id];
    if (ex === 'deleted') continue;
    const start = d + tod;
    out.push({ ...s.base, start: { dateTime: iso(start) }, end: { dateTime: iso(start + dur) }, ...ex, id, recurringEventId: s.id, etag: etag(id) });
  }
  return out;
}

function ensureSeries(id) {
  const m = /^(.+)_\d{4}-\d{2}-\d{2}$/.exec(id);
  return m ? db().series.find(s => s.id === m[1]) : null;
}

const mergeExt = (cur, patch) => {
  if (!patch.extendedProperties) return {};
  const priv = { ...cur.extendedProperties?.private, ...patch.extendedProperties.private };
  for (const k of Object.keys(priv)) if (priv[k] == null) delete priv[k];
  return { extendedProperties: { private: priv } };
};

export const demo = {
  hasSession: () => true,
  async listCalendars() { return db().calendars; },
  async listEvents(calId, fromMs, toMs) {
    const raws = [
      ...db().series.filter(s => s.calId === calId).flatMap(s => expand(s, fromMs, toMs)),
      ...db().singles.filter(e => e.calId === calId).map(e => ({ ...e, etag: etag(e.id) })),
    ];
    return raws.map(e => normalizeEvent(e, calId)).filter(e => e.endMs > fromMs && e.startMs < toMs);
  },
  async getEvent(calId, id) {
    const s = db().series.find(x => x.id === id);
    if (s) return s.base;
    return db().singles.find(x => x.id === id);
  },
  async patchEvent(calId, id, patch, tag) {
    if (tag && tag !== etag(id)) throw new Conflict('This event changed while you were editing.');
    const master = db().series.find(s => s.id === id);
    let raw;
    if (master) {
      master.base = { ...master.base, ...patch, ...mergeExt(master.base, patch) };
      raw = { ...master.base, id };
    } else {
      const s = ensureSeries(id);
      if (s) {
        const cur = s.exceptions[id] || {};
        s.exceptions[id] = { ...cur, ...patch, ...mergeExt(cur, patch) };
        const d = parseYmd(id.slice(-10));
        raw = expand(s, d, addDays(d, 1))[0];
      } else {
        const e = db().singles.find(x => x.id === id);
        Object.assign(e, patch, mergeExt(e, patch));
        raw = e;
      }
    }
    bump(id);
    commit();
    return normalizeEvent({ ...raw, etag: etag(id) }, calId);
  },
  async createEvent(calId, body) {
    const e = { reminders: { useDefault: true }, ...body, id: uid(), calId };
    db().singles.push(e);
    commit();
    return normalizeEvent({ ...e, etag: etag(e.id) }, calId);
  },
  async deleteEvent(calId, id) {
    const d = db();
    const si = d.series.findIndex(s => s.id === id);
    if (si >= 0) d.series.splice(si, 1);
    else {
      const s = ensureSeries(id);
      if (s) s.exceptions[id] = 'deleted';
      else d.singles = d.singles.filter(e => e.id !== id);
    }
    commit();
  },
  async setCalendarDefaults(calId, minutes) {
    db().calendars.find(c => c.id === calId).defaultReminders = minutes.map(m => ({ method: 'popup', minutes: m }));
    commit();
  },
};

export function resetDemo() { state.demo = seed(); save('demo'); }
