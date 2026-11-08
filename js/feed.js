// The official timetable, which the helper on the computer running Count-in keeps (feed.py).
// On the phone there is no helper, so steps keep the trips the computer last filled in, and
// Drive brings them over.

const call = async (path, body) => {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) throw new Error(data?.error || 'The timetable helper did not answer. Start Count-in with start.bat.');
  return data;
};

// null when there is no helper, as on the phone.
export async function feedStatus() {
  try { return await call('/feed/status'); } catch { return null; }
}
export const searchStops = q => call(`/feed/stops?q=${encodeURIComponent(q)}`);
export const findLines = (from, to) => call('/feed/lines', { from: from.key, to: to.key });
export const feedResults = () => call('/feed/results');

export const pairKey = feed => `${feed.from.key}>${feed.to.key}`;
const isFed = leg => (leg.kind === 'bus' || leg.kind === 'train') && !!leg.feed;

// The step and each of its other lines, with the stops each uses: its own, or the step's.
export const fedOptions = leg => (isFed(leg) ? [leg, ...(leg.alts || [])].map(opt => ({ opt, feed: opt.feed || leg.feed })) : []);

// Every stop pair your routes use, so the helper rereads them each day.
export const watchPairs = routes => {
  const seen = new Map();
  for (const r of routes) for (const l of r.legs) for (const { feed } of fedOptions(l)) seen.set(pairKey(feed), { from: feed.from.key, to: feed.to.key });
  return call('/feed/watch', { pairs: [...seen.values()] });
};

export const MODE_NAMES = { bus: 'Bus', train: 'Train' };
export const lineLabel = line => (line.mode === 'train' ? 'Train' : `Bus ${line.name}`);
const typical = trips => {
  const rides = Object.values(trips).flat().map(t => t[1]).sort((a, b) => a - b);
  return rides.length ? rides[Math.floor(rides.length / 2)] : null;
};

// Gives a step or one of its other lines its trips from the timetable.
export function fillOption(opt, line, updated) {
  const trips = Object.fromEntries(Object.entries(line?.trips || {}).map(([wd, t]) => [wd, t.map(x => [x[0], x[1]])]));
  Object.assign(opt, { trips, feedDate: updated, times: '' });
  const ride = typical(trips);
  if (ride != null) opt.minutes = ride;
}

// Brings every step that uses the timetable up to date. Returns whether anything changed.
export function applyResults(routes, results) {
  let changed = false;
  for (const r of routes) for (const l of r.legs) {
    for (const { opt, feed } of fedOptions(l)) {
      const lines = results.pairs?.[pairKey(feed)];
      if (!lines || !opt.feedLine) continue;
      const before = JSON.stringify([opt.trips, opt.feedDate]);
      fillOption(opt, lines.find(x => x.id === opt.feedLine), results.updated);
      if (JSON.stringify([opt.trips, opt.feedDate]) !== before) changed = true;
    }
  }
  return changed;
}

// "61 a day, 38–47 min" for a line, from its busiest day.
export function lineSummary(line) {
  const days = Object.values(line.trips);
  const most = Math.max(0, ...days.map(d => d.length));
  if (!most) return 'no trips this week';
  const rides = days.flat().map(t => t[1]);
  const lo = Math.min(...rides), hi = Math.max(...rides);
  return `up to ${most} a day, ${lo === hi ? lo : `${lo}–${hi}`} min`;
}
