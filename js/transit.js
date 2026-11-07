// Timetable import (plain text and GTFS) and the arrive-by journey planner.
import { uid, norm, parseClock, addDays, parseYmd, ymd } from './util.js';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ALL_DAYS = 0b1111111;

function parseDays(text) {
  const s = norm(text);
  if (!s || s === 'daily' || s === 'all') return ALL_DAYS;
  let mask = 0;
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const [a, b] = part.split('-').map(x => DAY_NAMES.indexOf(x.slice(0, 3)));
    if (a < 0 || (b !== undefined && b < 0)) throw new Error(`"${part}" is not a day. Use sun, mon, tue, wed, thu, fri or sat.`);
    if (b === undefined) mask |= 1 << a;
    else for (let d = a; ; d = (d + 1) % 7) { mask |= 1 << d; if (d === b) break; }
  }
  return mask;
}

// Text format: a block per line and direction, one row per stop, one column per trip.
//   line: Coastal train
//   mode: train
//   days: sun-thu
//   Home Station, 07:02, 07:32
//   Central, 07:20, 07:50
//   walk: Home -> Home Station: 12
export function parseTimetable(text, name = 'Pasted timetable') {
  const feed = { id: uid(), name, kind: 'text', nodes: [], trips: [], walks: [] };
  const nodeIds = new Map();
  const node = n => {
    const k = norm(n);
    if (!nodeIds.has(k)) { nodeIds.set(k, feed.nodes.length); feed.nodes.push(n.trim()); }
    return nodeIds.get(k);
  };
  let block = null;
  const flush = () => {
    if (!block || !block.rows.length) { block = null; return; }
    const cols = Math.max(...block.rows.map(r => r.times.length));
    for (let c = 0; c < cols; c++) {
      const stops = [];
      for (const r of block.rows) {
        const t = r.times[c];
        if (t == null) continue;
        const prev = stops.length ? stops[stops.length - 1][2] : null;
        // A time earlier than the previous stop means the trip ran past midnight.
        const at = prev != null && t < prev % 1440 && prev % 1440 > 720 && t < 720 ? t + Math.floor(prev / 1440 + 1) * 1440 : t + (prev != null ? Math.floor(prev / 1440) * 1440 : 0);
        stops.push([r.node, at, at]);
      }
      if (stops.length > 1) feed.trips.push({ line: block.line, mode: block.mode, days: block.days, stops });
    }
    block = null;
  };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const meta = /^(line|mode|days|walk)\s*:\s*(.*)$/i.exec(line);
    if (meta) {
      const k = meta[1].toLowerCase(), v = meta[2].trim();
      if (k === 'walk') {
        const w = /^(.+?)\s*(?:->|→|<->)\s*(.+?)\s*:\s*(\d+)/.exec(v);
        if (!w) throw new Error(`Line ${i + 1}: write walks as "walk: Home -> Station: 12".`);
        feed.walks.push([node(w[1]), node(w[2]), +w[3]]);
      } else if (k === 'line') {
        flush();
        block = { line: v || 'Line', mode: 'bus', days: ALL_DAYS, rows: [] };
      } else {
        if (!block) block = { line: 'Line', mode: 'bus', days: ALL_DAYS, rows: [] };
        try {
          if (k === 'mode') block.mode = /train|rail/i.test(v) ? 'train' : 'bus';
          else block.days = parseDays(v);
        } catch (e) { throw new Error(`Line ${i + 1}: ${e.message}`); }
      }
      return;
    }
    const cells = line.split(/[,\t;|]/).map(c => c.trim());
    if (cells.length < 2) throw new Error(`Line ${i + 1}: expected a stop name followed by times, such as "Central, 07:20, 07:50".`);
    if (!block) block = { line: 'Line', mode: 'bus', days: ALL_DAYS, rows: [] };
    const times = cells.slice(1).map(c => {
      if (!c || c === '-' || c === '–') return null;
      const t = parseClock(c);
      if (t == null) throw new Error(`Line ${i + 1}: "${c}" is not a time. Use HH:MM, or - when the trip skips this stop.`);
      return t;
    });
    block.rows.push({ node: node(cells[0]), times });
  });
  flush();
  if (!feed.trips.length && !feed.walks.length) throw new Error('No trips found. Each line needs at least two stops with times.');
  return feed;
}

/* ---------- GTFS zip reader (streams, so big files do not need to fit in memory at once) ---------- */
const MAX_STOP_TIMES = 2500000;

async function zipEntries(file) {
  const tailSize = Math.min(file.size, 66000);
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This file is not a readable zip. GTFS schedules come as a .zip.');
  const count = tail.getUint16(eocd + 10, true), size = tail.getUint32(eocd + 12, true), offset = tail.getUint32(eocd + 16, true);
  const dir = new DataView(await file.slice(offset, offset + size).arrayBuffer());
  const out = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    const method = dir.getUint16(p + 10, true), compSize = dir.getUint32(p + 20, true);
    const nameLen = dir.getUint16(p + 28, true), extraLen = dir.getUint16(p + 30, true), commentLen = dir.getUint16(p + 32, true);
    const localOffset = dir.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(dir.buffer, p + 46, nameLen));
    out.set(name.split('/').pop(), { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readCsv(file, entry, onRow) {
  const head = new DataView(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  const start = entry.localOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  let stream = file.slice(start, start + entry.compSize).stream();
  if (entry.method === 8) stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '', cols = null;
  const handle = line => {
    if (!line) return;
    const cells = line.includes('"') ? splitQuoted(line) : line.split(',');
    if (!cols) { cols = new Map(cells.map((c, i) => [c.replace(/^﻿/, '').trim(), i])); return; }
    onRow(name => { const i = cols.get(name); return i === undefined ? '' : (cells[i] || '').trim(); });
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    let from = 0;
    while ((nl = buf.indexOf('\n', from)) >= 0) { handle(buf.slice(from, nl).replace(/\r$/, '')); from = nl + 1; }
    buf = buf.slice(from);
  }
  handle(buf.replace(/\r$/, ''));
}

function splitQuoted(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const gtfsClock = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const gtfsDate = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

export async function parseGtfs(file, onProgress = () => {}) {
  const entries = await zipEntries(file);
  for (const need of ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']) {
    if (!entries.has(need)) throw new Error(`This zip has no ${need}, so it is not a GTFS schedule.`);
  }
  const feed = { id: uid(), name: file.name.replace(/\.zip$/i, ''), kind: 'gtfs', nodes: [], trips: [], walks: [] };
  onProgress('Reading stops');
  const stopNode = new Map(), nodeByKey = new Map(), nameCount = new Map(), stopRows = [];
  await readCsv(file, entries.get('stops.txt'), get => {
    if (get('location_type') && get('location_type') !== '0') return;
    const name = get('stop_name');
    const key = `${norm(name)}|${Math.round(+get('stop_lat') * 200)}|${Math.round(+get('stop_lon') * 200)}`;
    stopRows.push({ id: get('stop_id'), name, key, code: get('stop_code') });
  });
  for (const s of stopRows) if (!nodeByKey.has(s.key)) { nodeByKey.set(s.key, s); nameCount.set(norm(s.name), (nameCount.get(norm(s.name)) || 0) + 1); }
  const nodeId = new Map();
  for (const s of stopRows) {
    if (!nodeId.has(s.key)) {
      nodeId.set(s.key, feed.nodes.length);
      feed.nodes.push(nameCount.get(norm(s.name)) > 1 && s.code ? `${s.name} · ${s.code}` : s.name);
    }
    stopNode.set(s.id, nodeId.get(s.key));
  }
  onProgress('Reading lines');
  const routes = new Map();
  await readCsv(file, entries.get('routes.txt'), get => {
    const type = +get('route_type');
    routes.set(get('route_id'), { line: get('route_short_name') || get('route_long_name') || 'Line', mode: type === 2 || (type >= 100 && type < 200) ? 'train' : 'bus' });
  });
  const services = new Map();
  const service = id => { if (!services.has(id)) services.set(id, { days: 0, from: null, to: null, add: [], rem: [] }); return services.get(id); };
  if (entries.has('calendar.txt')) await readCsv(file, entries.get('calendar.txt'), get => {
    const s = service(get('service_id'));
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].forEach((d, i) => { if (get(d) === '1') s.days |= 1 << i; });
    s.from = gtfsDate(get('start_date')); s.to = gtfsDate(get('end_date'));
  });
  if (entries.has('calendar_dates.txt')) await readCsv(file, entries.get('calendar_dates.txt'), get => {
    (get('exception_type') === '1' ? service(get('service_id')).add : service(get('service_id')).rem).push(gtfsDate(get('date')));
  });
  onProgress('Reading trips');
  const trips = new Map();
  await readCsv(file, entries.get('trips.txt'), get => {
    const r = routes.get(get('route_id')) || { line: 'Line', mode: 'bus' };
    const s = service(get('service_id'));
    trips.set(get('trip_id'), { line: r.line, mode: r.mode, headsign: get('trip_headsign'), days: s.days, from: s.from, to: s.to, add: s.add, rem: s.rem, raw: [] });
  });
  onProgress('Reading departure times');
  let rows = 0, tooBig = false;
  await readCsv(file, entries.get('stop_times.txt'), get => {
    if (tooBig) return;
    if (++rows > MAX_STOP_TIMES) { tooBig = true; return; }
    const trip = trips.get(get('trip_id')), node = stopNode.get(get('stop_id'));
    const arr = get('arrival_time'), dep = get('departure_time');
    if (!trip || node === undefined || !arr || !dep) return;
    trip.raw.push([+get('stop_sequence'), node, gtfsClock(arr), gtfsClock(dep)]);
    if (rows % 200000 === 0) onProgress(`Reading departure times: ${rows.toLocaleString('en')}`);
  });
  if (tooBig) throw new Error(`This schedule has more than ${MAX_STOP_TIMES.toLocaleString('en')} stop times, too many to plan with inside a browser. Use a regional schedule, or paste just the lines you ride.`);
  for (const t of trips.values()) {
    const stops = t.raw.sort((a, b) => a[0] - b[0]).map(r => [r[1], r[2], r[3]]);
    delete t.raw;
    if (stops.length > 1) feed.trips.push({ ...t, stops });
  }
  if (entries.has('transfers.txt')) await readCsv(file, entries.get('transfers.txt'), get => {
    const a = stopNode.get(get('from_stop_id')), b = stopNode.get(get('to_stop_id'));
    if (a !== undefined && b !== undefined && a !== b) feed.walks.push([a, b, Math.ceil((+get('min_transfer_time') || 120) / 60)]);
  });
  onProgress('Done');
  return feed;
}

/* ---------- Planner ---------- */
const walkKey = (from, to) => `${norm(from)}>${norm(to)}`;

// Average logged minutes per direction, rounded up so estimates lean toward being on time.
export function walkStats(log = []) {
  const totals = new Map();
  for (const { from, to, minutes } of log) {
    const k = walkKey(from, to);
    const t = totals.get(k) || { sum: 0, count: 0 };
    t.sum += minutes; t.count++;
    totals.set(k, t);
  }
  return new Map([...totals].map(([k, t]) => [k, { avg: Math.ceil(t.sum / t.count), count: t.count }]));
}

// A logged average beats the timetable's figure. A direction with no logs of its own
// borrows the opposite direction's average, until it has some.
export function buildNetwork(feeds, walkLog = []) {
  const names = [], ids = new Map(), trips = [], walksTo = new Map(), walksFrom = new Map();
  const nodeOf = name => {
    const k = norm(name);
    if (!ids.has(k)) { ids.set(k, names.length); names.push(name); }
    return ids.get(k);
  };
  const base = new Map();
  for (const feed of feeds) {
    const map = feed.nodes.map(nodeOf);
    for (const t of feed.trips) trips.push({ ...t, stops: t.stops.map(([n, a, d]) => [map[n], a, d]) });
    for (const [a, b, min] of feed.walks) { base.set(`${map[a]}>${map[b]}`, min); base.set(`${map[b]}>${map[a]}`, min); }
  }
  for (const w of walkLog) {
    const a = nodeOf(w.from), b = nodeOf(w.to);
    if (!base.has(`${a}>${b}`)) base.set(`${a}>${b}`, null);
    if (!base.has(`${b}>${a}`)) base.set(`${b}>${a}`, null);
  }
  const stats = walkStats(walkLog);
  for (const [key, listed] of base) {
    const [a, b] = key.split('>').map(Number);
    const s = stats.get(walkKey(names[a], names[b])) || stats.get(walkKey(names[b], names[a]));
    const min = s ? s.avg : listed;
    const logged = s ? s.count : 0;
    if (!walksTo.has(b)) walksTo.set(b, []);
    walksTo.get(b).push({ from: a, min, logged });
    if (!walksFrom.has(a)) walksFrom.set(a, []);
    walksFrom.get(a).push({ to: b, min });
  }
  return { names, ids, trips, walksTo, walksFrom, cache: new Map() };
}

function runsOn(trip, dateMs) {
  const date = ymd(dateMs);
  if (trip.rem?.includes(date)) return false;
  if (trip.add?.includes(date)) return true;
  if (trip.from && date < trip.from) return false;
  if (trip.to && date > trip.to) return false;
  return !!(trip.days & (1 << new Date(dateMs).getDay()));
}

// Rides that could matter for arriving on `dateMs`: that date, plus trips from the
// day before that run past midnight. Times are minutes from `dateMs` midnight.
function connectionsFor(net, dateMs) {
  const k = ymd(dateMs);
  if (net.cache.has(k)) return net.cache.get(k);
  const list = [];
  const prev = addDays(dateMs, -1);
  net.trips.forEach((trip, tripIdx) => {
    for (const [day, shift] of [[dateMs, 0], [prev, -1440]]) {
      if (!runsOn(trip, day)) continue;
      const s = trip.stops;
      if (shift && s[s.length - 1][1] + shift < 0) continue;
      for (let i = 0; i + 1 < s.length; i++) {
        const dep = s[i][2] + shift, arr = s[i + 1][1] + shift;
        if (arr < 0) continue;
        list.push({ trip: `${tripIdx}:${shift}`, tripIdx, shift, i, from: s[i][0], to: s[i + 1][0], dep, arr });
      }
    }
  });
  list.sort((a, b) => b.arr - a.arr || b.dep - a.dep);
  net.cache.set(k, list);
  return list;
}

// One backward sweep per allowed number of rides. Layer k holds the latest moment you
// can be at each stop and still arrive in time, using at most k rides.
function latestDepartures(net, conns, to, limit, transfer, maxRides) {
  const n = net.names.length;
  const S = [new Float64Array(n).fill(-Infinity)];
  const J = [new Map()];
  S[0][to] = limit;
  for (const w of net.walksTo.get(to) || []) {
    const t = limit - w.min;
    if (t > S[0][w.from]) { S[0][w.from] = t; J[0].set(w.from, { walkTo: to, min: w.min, logged: w.logged }); }
  }
  for (let k = 1; k <= maxRides; k++) {
    const cur = S[k - 1].slice(), prev = S[k - 1], jm = new Map(), exits = new Map();
    for (const c of conns) {
      if (c.arr > limit) continue;
      let exit = exits.get(c.trip);
      if (!exit) {
        const need = k === 1 ? 0 : transfer;
        const finalLeg = c.to === to || J[0].has(c.to);
        if (c.arr + (finalLeg ? 0 : need) <= prev[c.to]) { exit = c; exits.set(c.trip, c); }
      }
      if (!exit) continue;
      if (c.dep > cur[c.from]) {
        cur[c.from] = c.dep;
        jm.set(c.from, { board: c, exit });
        for (const w of net.walksTo.get(c.from) || []) {
          const t = c.dep - w.min;
          if (t > cur[w.from]) { cur[w.from] = t; jm.set(w.from, { walkTo: c.from, min: w.min, logged: w.logged }); }
        }
      }
    }
    S.push(cur); J.push(jm);
  }
  return { S, J };
}

function rebuild(net, { S, J }, from, to, k, limit) {
  const legs = [];
  let node = from, guard = 0;
  while (node !== to && guard++ < 24) {
    let layer = k;
    const target = S[k][node];
    while (layer >= 0 && !(J[layer].has(node) && S[layer][node] === target)) layer--;
    if (layer < 0) return null;
    const step = J[layer].get(node);
    if (step.walkTo !== undefined) {
      legs.push({ type: 'walk', from: net.names[node], to: net.names[step.walkTo], dep: target, arr: target + step.min, min: step.min, logged: step.logged || 0 });
      node = step.walkTo;
      k = layer;
    } else {
      const { board, exit } = step, trip = net.trips[board.tripIdx];
      const stops = trip.stops.slice(board.i, exit.i + 2).map(([n, a, d]) => ({ name: net.names[n], time: a + board.shift, dep: d + board.shift }));
      legs.push({ type: 'ride', line: trip.line, mode: trip.mode, headsign: trip.headsign, from: net.names[board.from], to: net.names[exit.to], dep: board.dep, arr: exit.arr, stops });
      node = exit.to;
      k = layer - 1;
    }
    if (k < 0) k = 0;
  }
  if (node !== to) return null;
  // The sweep times walks backward from the deadline. Once you are off a ride you walk straight away.
  for (let i = 1; i < legs.length; i++) {
    if (legs[i].type !== 'walk') continue;
    legs[i].dep = legs[i - 1].arr;
    legs[i].arr = legs[i].dep + legs[i].min;
  }
  return legs;
}

export function planArrival(net, { from, to, dateMs, arriveBy, transfer = 4, maxRides = 4, options = 4 }) {
  const a = net.ids.get(norm(from)), b = net.ids.get(norm(to));
  if (a === undefined) throw new Error(`"${from}" is not in your timetables.`);
  if (b === undefined) throw new Error(`"${to}" is not in your timetables.`);
  if (a === b) throw new Error('Start and destination are the same place.');
  const conns = connectionsFor(net, dateMs);
  const out = [], seen = new Set();
  let limit = arriveBy;
  for (let round = 0; round < options && out.length < options; round++) {
    const res = latestDepartures(net, conns, b, limit, transfer, maxRides);
    let best = -Infinity, latestArrival = -Infinity;
    for (let k = 0; k <= maxRides; k++) {
      const dep = res.S[k][a];
      if (dep <= best) continue;
      best = dep;
      const legs = rebuild(net, res, a, b, k, limit);
      if (!legs) continue;
      const arr = legs[legs.length - 1].arr;
      latestArrival = Math.max(latestArrival, arr);
      const sig = legs.map(l => `${l.line || 'w'}@${l.dep}`).join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ depart: legs[0].dep, arrive: arr, legs, rides: legs.filter(l => l.type === 'ride').length });
    }
    if (latestArrival === -Infinity) break;
    limit = latestArrival - 1;
  }
  return out.sort((x, y) => y.depart - x.depart || x.rides - y.rides);
}

// Earliest arrival when you cannot leave before `departAfter`. A forward sweep finds that
// arrival time, then the arrive-by search picks the simplest journey reaching it.
export function planDeparture(net, { from, to, dateMs, departAfter, transfer = 4, maxRides = 4 }) {
  const a = net.ids.get(norm(from)), b = net.ids.get(norm(to));
  if (a === undefined || b === undefined || a === b) return null;
  const ready = new Float64Array(net.names.length).fill(Infinity);
  const walkOut = (node, t) => {
    for (const w of net.walksFrom.get(node) || []) if (t + w.min < ready[w.to]) ready[w.to] = t + w.min;
  };
  ready[a] = departAfter;
  walkOut(a, departAfter);
  let best = ready[b];
  const conns = [...connectionsFor(net, dateMs)].sort((x, y) => x.dep - y.dep || x.arr - y.arr);
  const onboard = new Set();
  for (const c of conns) {
    if (c.dep < departAfter || c.dep >= best) continue;
    if (!onboard.has(c.trip) && c.dep < ready[c.from]) continue;
    onboard.add(c.trip);
    if (c.to === b) { if (c.arr < best) best = c.arr; continue; }
    const t = c.arr + transfer;
    if (t < ready[c.to]) ready[c.to] = t;
    walkOut(c.to, c.arr);
    const viaWalk = (net.walksFrom.get(c.to) || []).find(w => w.to === b);
    if (viaWalk && c.arr + viaWalk.min < best) best = c.arr + viaWalk.min;
  }
  if (best === Infinity) return null;
  const options = planArrival(net, { from, to, dateMs, arriveBy: best, transfer, maxRides, options: 3 });
  return options.filter(j => j.depart >= departAfter).sort((x, y) => x.arrive - y.arrive || x.rides - y.rides || y.depart - x.depart)[0] || null;
}

// Finds the stop a free-text location refers to, such as "Institute Gate, room 4".
export function matchPlace(net, text) {
  const t = norm(text);
  if (!t) return '';
  const { names } = net;
  return names.find(n => norm(n) === t) || names.find(n => t.includes(norm(n))) || names.find(n => norm(n).includes(t)) || '';
}

export const SAMPLE_TIMETABLE = `# Sample timetable with made-up places. Replace it with your real schedules.
walk: Home -> Oak Street: 6
walk: Home -> Northgate Station: 14
walk: Harbour Station -> Institute Gate: 9

line: Train R1
mode: train
days: sun-thu
Northgate Station, 06:42, 07:12, 07:42, 08:12, 08:42, 09:12
Mill Junction,     06:55, 07:25, 07:55, 08:25, 08:55, 09:25
Harbour Station,   07:14, 07:44, 08:14, 08:44, 09:14, 09:44

line: Train R1 back
mode: train
days: sun-thu
Harbour Station,   16:20, 17:20, 18:20, 19:20, 20:20
Mill Junction,     16:39, 17:39, 18:39, 19:39, 20:39
Northgate Station, 16:52, 17:52, 18:52, 19:52, 20:52

line: Bus 22
mode: bus
days: sun-thu
Oak Street,      07:05, 07:35, 08:05, 08:35
Mill Junction,   07:21, 07:51, 08:21, 08:51
Institute Gate,  07:48, 08:18, 08:48, 09:18

line: Bus 22 back
mode: bus
days: sun-thu
Institute Gate,  17:05, 18:05, 19:05
Mill Junction,   17:32, 18:32, 19:32
Oak Street,      17:48, 18:48, 19:48

line: Bus 7
mode: bus
days: sun-sat
Oak Street,  17:10, 18:10, 19:10
Music Hall,  17:34, 18:34, 19:34

line: Bus 7 back
mode: bus
days: sun-sat
Music Hall,  20:10, 21:15, 22:15
Oak Street,  20:34, 21:39, 22:39
`;
