// Pure logic: which category an event is in, which notifications it should have,
// and the list of Google changes needed to get there. No DOM, no network.
import { parseClock, uid, minutesOfDay, startOfDay, addDays, norm, MIN } from './util.js';

export const GOOGLE_COLORS = {
  1: ['Lavender', '#7986cb'], 2: ['Sage', '#33b679'], 3: ['Grape', '#8e24aa'], 4: ['Flamingo', '#e67c73'],
  5: ['Banana', '#f6bf26'], 6: ['Tangerine', '#f4511e'], 7: ['Peacock', '#039be5'], 8: ['Graphite', '#616161'],
  9: ['Blueberry', '#3f51b5'], 10: ['Basil', '#0b8043'], 11: ['Tomato', '#d50000'],
};
const MAX_BEFORE = 40320; // Google's limit: 4 weeks
const MAX_REMINDERS = 5;  // Google's limit per event

export const writable = cal => !!cal && (cal.accessRole === 'owner' || cal.accessRole === 'writer');

const HEBREW = /[֐-׿]/;
const NO_COLOR_NAME = 'No color';

// Latin words match whole, so "WIS" skips "Wisdom" and "doctor" skips "Doctoral". Hebrew
// matches anywhere in the title, since prefixes join the word: "לרופא" contains "רופא".
export function titleMatches(title, word) {
  const t = title.toLowerCase(), w = word.trim().toLowerCase();
  if (!w) return false;
  if (HEBREW.test(w)) return t.includes(w);
  let i = t.indexOf(w);
  const isWordChar = ch => !!ch && /[\p{L}\p{N}]/u.test(ch);
  while (i >= 0) {
    if (!isWordChar(t[i - 1]) && !isWordChar(t[i + w.length])) return true;
    i = t.indexOf(w, i + 1);
  }
  return false;
}

// Every calendar + color pair that belongs to a category. A title-only category has none.
export const colorPairs = c => [...(c.calId ? [{ calId: c.calId, colorId: c.colorId || null }] : []), ...(c.also || [])];

// Order of precedence: a choice made on the event, then title words, then color.
export function categoryFor(ev, cats) {
  if (ev.ext?.cat) { const picked = cats.find(c => c.id === ev.ext.cat); if (picked) return picked; }
  const title = ev.summary || '';
  // A sub-category collects events by whole title, wherever they are: "MyTone" under Work
  // takes every MyTone event, and "הרכב" is not "הרכב תופים" or "מרתון הרכבים". When a title
  // is in two, the one limited to a color takes the events of that color.
  const byTitle = cats.filter(c => c.parentId && meetsColor(c, ev) && c.keywords?.some(w => norm(w) === norm(title)));
  if (byTitle.length) return byTitle.find(c => colorCondition(c)) || byTitle[0];
  const top = topCategoryFor(ev, cats.filter(c => !c.parentId), title);
  if (!top) return null;
  // With no titles listed, a color alone sorts the events already in the parent.
  return cats.find(c => c.parentId === top.id && colorCondition(c) && !c.keywords?.length && meetsColor(c, ev)) || top;
}

// A sub-category can be limited to one Google color, or to 'none' for uncolored events.
export const colorCondition = c => c.whenColor ?? (c.whenNoColor ? 'none' : null);
function meetsColor(c, ev) {
  const want = colorCondition(c);
  if (!want) return true;
  return want === 'none' ? !ev.colorId : ev.colorId === want;
}

function topCategoryFor(ev, cats, title) {
  for (const c of cats) if (c.keywords?.some(w => titleMatches(title, w))) return c;
  const color = ev.colorId || null;
  for (const c of cats) {
    if (colorPairs(c).some(p => p.calId === ev.calId && p.colorId === color)) return c;
    if (color && c.pendingColorId === color && c.calId === ev.calId) return c;
  }
  return null;
}

// A sub-category follows its parent for anything it does not set itself.
export function effectiveCategory(cat, cats) {
  if (!cat?.parentId) return cat;
  const parent = cats.find(c => c.id === cat.parentId);
  if (!parent) return cat;
  return { ...cat, minutes: cat.minutes ?? parent.minutes ?? null, color: cat.color || parent.color, place: cat.place || parent.place || null,
    // Its color is what puts an event here, so a recolor of the parent must skip it.
    pendingColorId: colorCondition(cat) ? null : parent.pendingColorId || null };
}

// Drops colors from calendars that no longer exist, such as the sample calendar's. A
// category left with neither colors nor title words is removed.
export function pruneCategories(cats, calendars) {
  const ids = new Set(calendars.map(c => c.id));
  const out = [];
  for (const c of cats) {
    const also = (c.also || []).filter(p => ids.has(p.calId));
    if (c.calId && !ids.has(c.calId)) {
      if (!also.length && !c.keywords?.length) continue;
      const [first, ...rest] = also;
      out.push(first ? { ...c, calId: first.calId, colorId: first.colorId, also: rest } : { ...c, calId: null, colorId: null, also: [] });
    } else out.push({ ...c, also });
  }
  const kept = new Set(out.map(c => c.id));
  return out.filter(c => !c.parentId || kept.has(c.parentId));
}

// Pulls everything from `source` into `target`, so both become one category.
export function mergeCategories(cats, source, target) {
  const merged = {
    ...target,
    also: [...(target.also || []), ...colorPairs(source)],
    keywords: [...new Set([...(target.keywords || []), ...(source.keywords || [])])],
  };
  return cats.filter(c => c !== source).map(c => {
    if (c === target) return merged;
    return c.parentId === source.id ? { ...c, parentId: target.id } : c;
  });
}

// Updates categories saved before title words became a list.
const migrate = c => {
  if (c.keyword === undefined) return c;
  const { keyword, ...rest } = c;
  return keyword ? { ...rest, calId: null, colorId: null, keywords: [keyword] } : rest;
};

// Creates a category for every calendar + color pair not yet covered. New categories
// leave notifications alone (minutes: null) until the person sets a rule.
export function ensureCategories(events, calendars, cats) {
  const out = cats.map(migrate).map(c => {
    // Your main calendar is named after your email, which reads badly as a category.
    const cal = c.calId && !c.colorId ? calendars.find(x => x.id === c.calId) : null;
    return cal?.primary && c.name === cal.summary ? { ...c, name: NO_COLOR_NAME } : c;
  });
  const titlesFor = new Map();
  for (const ev of events) {
    if (categoryFor(ev, out)) continue;
    const key = `${ev.calId}|${ev.colorId || ''}`;
    if (!titlesFor.has(key)) titlesFor.set(key, { calId: ev.calId, colorId: ev.colorId || null, titles: new Map() });
    const t = titlesFor.get(key).titles;
    t.set(ev.summary || 'Untitled', (t.get(ev.summary || 'Untitled') || 0) + 1);
  }
  for (const { calId, colorId, titles } of titlesFor.values()) {
    const cal = calendars.find(c => c.id === calId);
    const top = [...titles.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.push({
      id: uid(), calId, colorId, keywords: [], also: [], minutes: null, pendingColorId: null,
      name: colorId ? top : cal?.primary ? NO_COLOR_NAME : (cal?.summary || top),
      color: colorId ? GOOGLE_COLORS[colorId]?.[1] || '#616161' : (cal?.color || '#616161'),
    });
  }
  return out;
}

export function currentMinutes(ev, cal) {
  const list = ev.useDefault ? (cal?.defaultReminders || []) : (ev.overrides || []);
  return [...new Set(list.map(r => r.minutes))].sort((a, b) => b - a);
}

function inQuiet(m, from, to) {
  return from <= to ? m >= from && m < to : m >= from || m < to;
}

// Moves or drops a reminder that would fire during quiet hours.
export function applyQuiet(startMs, minutes, quiet) {
  if (!quiet?.on) return minutes;
  const from = parseClock(quiet.from), to = parseClock(quiet.to);
  if (from == null || to == null || from === to) return minutes;
  const out = [];
  for (const m of minutes) {
    const at = startMs - m * MIN;
    const mod = minutesOfDay(at);
    if (!inQuiet(mod, from, to)) { out.push(m); continue; }
    if (quiet.mode === 'drop') continue;
    // Most recent moment quiet hours began, at or before the reminder.
    let day = startOfDay(at);
    let qStart = day + from * MIN;
    if (qStart > at) { day = addDays(day, -1); qStart = day + from * MIN; }
    const moved = Math.round((startMs - qStart) / MIN);
    if (moved <= MAX_BEFORE) out.push(moved);
  }
  return out;
}

// The minutes an event should have, or null when rules do not touch it.
export function desiredMinutes(ev, cat, quiet) {
  if (ev.ext?.manual || !cat || cat.minutes == null) return null;
  const list = cat.quietExempt ? cat.minutes : applyQuiet(ev.startMs, cat.minutes, quiet);
  return [...new Set(list)].filter(m => m >= 0 && m <= MAX_BEFORE).sort((a, b) => b - a).slice(0, MAX_REMINDERS);
}

const key = list => (list || []).join(',');

// Notifications an event will fire after pending rules are applied.
export function plannedMinutes(ev, ctx) {
  const cal = ctx.calById.get(ev.calId);
  const now = currentMinutes(ev, cal);
  if (!writable(cal)) return now;
  const want = desiredMinutes(ev, effectiveCategory(categoryFor(ev, ctx.categories), ctx.categories), ctx.quiet);
  if (want == null) return now;
  const skip = ctx.skipped?.[ev.id] ?? ctx.skipped?.[ev.recurringEventId];
  return skip?.startsWith(`${key(want)}|`) ? now : want;
}

export function makeCtx({ categories, calendars, quiet, skipped }) {
  return { categories, quiet, skipped, calById: new Map(calendars.map(c => [c.id, c])) };
}

// Identifies what a change would do. A skipped change stays skipped until the rule asks for something else.
export const opKey = op => `${op.after ? key(op.after) : '-'}|${op.color || ''}`;
export const withoutSkipped = (ops, skipped = {}) => ops.filter(op => skipped[op.targetId] !== opKey(op));

function undoFor(ev) {
  return { reminders: { useDefault: !!ev.useDefault, overrides: ev.useDefault ? [] : (ev.overrides || []) }, colorId: ev.colorId || null };
}

function toPatch(minutes, colorId) {
  const patch = {};
  if (minutes) patch.reminders = { useDefault: false, overrides: minutes.map(m => ({ method: 'popup', minutes: m })) };
  if (colorId) patch.colorId = colorId;
  return patch;
}

// Turns the rules into the fewest Google writes. A series whose instances all want the
// same thing gets one write to the series; `instanceOnly` is the follow-up pass that
// catches individually edited instances a series write does not reach.
export function computeOps(events, ctx, nowMs, { instanceOnly = false } = {}) {
  const groups = new Map();
  for (const ev of events) {
    if (ev.endMs <= nowMs || !writable(ctx.calById.get(ev.calId))) continue;
    const id = (!instanceOnly && ev.recurringEventId) || ev.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(ev);
  }
  const ops = [];
  for (const [targetId, list] of groups) {
    const rows = list.map(ev => {
      const cat = effectiveCategory(categoryFor(ev, ctx.categories), ctx.categories);
      const want = desiredMinutes(ev, cat, ctx.quiet);
      const have = currentMinutes(ev, ctx.calById.get(ev.calId));
      const color = cat?.pendingColorId && ev.colorId !== cat.pendingColorId ? cat.pendingColorId : null;
      const remindersChange = want != null && (ev.useDefault || key(want) !== key(have));
      return { ev, cat, want, have, color, remindersChange };
    });
    const touching = rows.filter(r => r.remindersChange || r.color);
    if (!touching.length) continue;
    const managed = rows.filter(r => r.want != null);
    const sameWant = new Set(managed.map(r => key(r.want))).size <= 1;
    const sameColor = new Set(rows.map(r => r.color || '')).size <= 1;
    const series = rows.length > 0 && !!list[0].recurringEventId && !instanceOnly && sameWant && sameColor;
    if (series) {
      const r = touching[0];
      ops.push(makeOp(r, targetId, true, list.length, r.remindersChange ? r.want : null, r.color));
    } else {
      for (const r of touching) ops.push(makeOp(r, r.ev.id, false, 1, r.remindersChange ? r.want : null, r.color));
    }
  }
  return ops.sort((a, b) => a.when - b.when);
}

function makeOp(r, targetId, isSeries, count, minutes, color) {
  return {
    calId: r.ev.calId, targetId, isSeries, count, seriesId: r.ev.recurringEventId || null, eventId: r.ev.id, title: r.ev.summary || 'Untitled', when: r.ev.startMs,
    catName: r.cat?.name, before: r.have, after: minutes, color,
    patch: toPatch(minutes, color), undo: undoFor(r.ev),
  };
}

// Events of a color-limited sub-category that have already ended, newest first, ready to be marked.
export function hoursToMark(events, cat, ctx, nowMs) {
  return events
    .filter(e => e.endMs <= nowMs && writable(ctx.calById.get(e.calId)) && categoryFor(e, ctx.categories)?.id === cat.id)
    .sort((a, b) => b.startMs - a.startMs);
}

// The colors an event can take and stay in the parent, other than the one it is leaving.
export const markColors = (parent, cat) => [...new Set(colorPairs(parent).map(p => p.colorId).filter(Boolean))].filter(id => id !== colorCondition(cat));

// Colors one occurrence only, never its whole series.
export const markOp = (ev, colorId) => ({
  calId: ev.calId, targetId: ev.id, isSeries: false, count: 1, seriesId: null, eventId: ev.id, title: ev.summary || 'Untitled', when: ev.startMs,
  before: [], after: null, color: colorId, patch: { colorId }, undo: { reminders: { useDefault: !!ev.useDefault, overrides: ev.overrides || [] }, colorId: ev.colorId || null },
});

// The app's private fields on an event, limited to what changed. Google rejects empty values
// for fields an event does not have, so clearing is only sent for ones that exist.
export function privateChanges(ev, want) {
  const have = { countinColor: ev.ext?.color || null, countinManual: ev.ext?.manual ? '1' : null, countinCat: ev.ext?.cat || null };
  const out = {};
  for (const [k, v] of Object.entries(want)) if ((v || null) !== have[k]) out[k] = v || null;
  return Object.keys(out).length ? { extendedProperties: { private: out } } : {};
}

// Notification counts per day for [from, from + days), under current or planned state.
export function pingsPerDay(events, ctx, from, days, planned) {
  const out = Array.from({ length: days }, () => 0);
  const end = addDays(from, days);
  for (const ev of events) {
    const cal = ctx.calById.get(ev.calId);
    if (cal?.on === false) continue;
    const mins = planned ? plannedMinutes(ev, ctx) : currentMinutes(ev, cal);
    for (const m of mins) {
      const at = ev.startMs - m * MIN;
      if (at < from || at >= end) continue;
      const i = Math.round((startOfDay(at) - from) / 86400000);
      if (i >= 0 && i < days) out[i]++;
    }
  }
  return out;
}
