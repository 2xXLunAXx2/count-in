// Small DOM and date helpers shared by every module.
export const MIN = 60000;
export const DAY = 86400000;

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const pad = n => String(n).padStart(2, '0');
export const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
export const startOfWeek = (t, ws = 0) => { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - ((d.getDay() - ws + 7) % 7)); return d.getTime(); };
export const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
export const fmtTime = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const minutesOfDay = t => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
export const fmtClock = m => { const x = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`; };
export const parseClock = s => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
export const fmt = (t, opts) => new Intl.DateTimeFormat('en-GB', opts).format(t);
export const sameDay = (a, b) => startOfDay(a) === startOfDay(b);

export function fmtBefore(m) {
  if (m === 0) return 'At start';
  if (m % 1440 === 0) return `${m / 1440} day${m > 1440 ? 's' : ''}`;
  if (m % 60 === 0) return `${m / 60} hr`;
  if (m > 60) return `${Math.floor(m / 60)} hr ${m % 60} min`;
  return `${m} min`;
}

export function inkOn(hex) {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.3 ? '#14142a' : '#ffffff';
}

export const uid = () => Math.random().toString(36).slice(2, 10);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
