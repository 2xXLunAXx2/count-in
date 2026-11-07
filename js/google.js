// Google Calendar backend. Runs entirely in the browser: the access token stays in
// this browser's storage and calls go straight to Google.
import { state } from './store.js';
import { sleep, parseYmd } from './util.js';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
// Only a hidden folder that Count-in itself creates, not the rest of your Drive.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SCOPE = `${CALENDAR_SCOPE} ${DRIVE_SCOPE}`;
const API = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3', DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_KEY = 'count-in-token';

export class NeedsSignIn extends Error {}
export class Conflict extends Error {}
export class NeedsScope extends Error {}

export function normalizeEvent(raw, calId) {
  const allDay = !raw.start?.dateTime;
  const startMs = allDay ? parseYmd(raw.start.date) : Date.parse(raw.start.dateTime);
  const endMs = allDay ? parseYmd(raw.end.date) : Date.parse(raw.end.dateTime);
  const priv = raw.extendedProperties?.private || {};
  return {
    id: raw.id, calId, etag: raw.etag, summary: raw.summary || '', description: raw.description || '', location: raw.location || '',
    colorId: raw.colorId || null, allDay, startMs, endMs, recurringEventId: raw.recurringEventId || null,
    useDefault: raw.reminders ? !!raw.reminders.useDefault : true, overrides: raw.reminders?.overrides || [],
    ext: { color: priv.countinColor || null, manual: priv.countinManual === '1', ...(priv.countinTravelTo ? { travelTo: priv.countinTravelTo } : {}), ...(priv.countinCat ? { cat: priv.countinCat } : {}) },
    free: raw.transparency === 'transparent',
    // An invitation you have not said yes to. "Maybe" still counts as going.
    notAccepted: ['needsAction', 'declined'].includes((raw.attendees || []).find(a => a.self)?.responseStatus),
    organizerSelf: raw.organizer ? !!raw.organizer.self : true, attendees: (raw.attendees || []).length, link: raw.htmlLink || '',
  };
}

// Kept in local storage so new tabs and reloads stay signed in. Google's token only
// lasts about an hour, and only this computer's browser can read it.
const session = {
  read() { try { return JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch { return null; } },
  get() { const t = this.read(); return t && t.exp > Date.now() + 30000 ? t.token : null; },
  set(token, seconds) { try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: Date.now() + seconds * 1000 })); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

// True when the token is gone or within five minutes of expiring.
export const sessionEndingSoon = () => { const t = session.read(); return !t || t.exp < Date.now() + 5 * 60000; };

export function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res;
    s.onerror = () => rej(new Error('Google sign-in did not load. Check your internet connection.'));
    document.head.append(s);
  });
}

// Must run from a click, or the browser blocks Google's sign-in popup.
export async function signIn(clientId, account) {
  await loadGis();
  return new Promise((res, rej) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      ...(account ? { login_hint: account } : {}),
      callback: r => {
        if (r.error) return rej(new Error(`Google sign-in failed: ${r.error_description || r.error}`));
        // Drive is optional: without it, routes simply stay on this device.
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(r, CALENDAR_SCOPE)) return rej(new Error('Calendar access was not granted, so Count-in cannot read or change your calendar.'));
        session.set(r.access_token, +r.expires_in || 3500);
        res();
      },
      error_callback: e => rej(new Error(e.type === 'popup_closed' ? 'The Google sign-in window was closed before finishing.' : `Google sign-in failed: ${e.message || e.type}`)),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function signOut() {
  const token = session.get();
  session.clear();
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token);
}

async function api(path, { method = 'GET', body, etag, params, base = API, service = 'Google Calendar' } = {}) {
  const token = session.get();
  if (!token) throw new NeedsSignIn('Your Google session ended.');
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(etag ? { 'If-Match': etag } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    if (r.ok) return r.json();
    if (r.status === 401) { session.clear(); throw new NeedsSignIn('Your Google session ended.'); }
    if (r.status === 412) throw new Conflict('This event changed in Google Calendar while you were editing.');
    const err = await r.json().catch(() => ({}));
    const reason = err.error?.errors?.[0]?.reason || '';
    const said = `${reason} ${err.error?.status || ''} ${err.error?.message || ''} ${JSON.stringify(err.error?.details || '')}`;
    if (r.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(said)) throw new Error(`${service} is not turned on in your Count-in project in Google Cloud yet.`);
    if (r.status === 403 && /insufficient/i.test(said)) throw new NeedsScope(`Google has not allowed Count-in to use ${service} yet. Reconnect, and tick the box for it.`);
    if ((r.status === 429 || r.status === 403 && /rateLimit/i.test(reason) || r.status >= 500) && attempt < 4) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const where = err.error?.errors?.[0]?.location;
    throw new Error(`${service} said: ${err.error?.message || `error ${r.status}`}${where ? ` (${where})` : ''}`);
  }
}

const enc = encodeURIComponent;

export const google = {
  hasSession: () => !!session.get(),
  async listCalendars() {
    const out = [];
    let pageToken;
    do {
      const r = await api('/users/me/calendarList', { params: { maxResults: 250, ...(pageToken ? { pageToken } : {}) } });
      out.push(...r.items);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out.map(c => ({
      id: c.id, summary: c.summaryOverride || c.summary, color: c.backgroundColor || '#616161', accessRole: c.accessRole,
      primary: !!c.primary, defaultReminders: c.defaultReminders || [], timeZone: c.timeZone, on: c.selected !== false,
    }));
  },
  async listEvents(calId, fromMs, toMs) {
    const out = [];
    let pageToken;
    do {
      const r = await api(`/calendars/${enc(calId)}/events`, {
        params: {
          singleEvents: 'true', orderBy: 'startTime', maxResults: 2500,
          timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(),
          ...(pageToken ? { pageToken } : {}),
        },
      });
      out.push(...r.items);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out.filter(e => e.status !== 'cancelled' && (e.eventType || 'default') !== 'workingLocation').map(e => normalizeEvent(e, calId));
  },
  async getEvent(calId, id) {
    return api(`/calendars/${enc(calId)}/events/${enc(id)}`);
  },
  async patchEvent(calId, id, patch, etag) {
    const raw = await api(`/calendars/${enc(calId)}/events/${enc(id)}`, { method: 'PATCH', body: patch, etag, params: { sendUpdates: 'none' } });
    return normalizeEvent(raw, calId);
  },
  async createEvent(calId, body) {
    const raw = await api(`/calendars/${enc(calId)}/events`, { method: 'POST', body, params: { sendUpdates: 'none' } });
    return normalizeEvent(raw, calId);
  },
  async deleteEvent(calId, id) {
    await api(`/calendars/${enc(calId)}/events/${enc(id)}`, { method: 'DELETE', params: { sendUpdates: 'none' } });
  },
  async setCalendarDefaults(calId, minutes) {
    await api(`/users/me/calendarList/${enc(calId)}`, { method: 'PATCH', body: { defaultReminders: minutes.map(m => ({ method: 'popup', minutes: m })) } });
  },
};

// Files in Count-in's hidden Drive folder. You cannot see them in Drive, and other apps cannot read them.
const inDrive = { base: DRIVE, service: 'Google Drive' };
export const drive = {
  async find(name) {
    const r = await api('/files', { ...inDrive, params: { spaces: 'appDataFolder', q: `name='${name}'`, fields: 'files(id)', orderBy: 'createdTime' } });
    return r.files[0]?.id || null;
  },
  read: id => api(`/files/${enc(id)}`, { ...inDrive, params: { alt: 'media' } }),
  async write(id, name, data) {
    const fileId = id || (await api('/files', { ...inDrive, method: 'POST', body: { name, parents: ['appDataFolder'], mimeType: 'application/json' }, params: { fields: 'id' } })).id;
    await api(`/files/${enc(fileId)}`, { ...inDrive, base: DRIVE_UPLOAD, method: 'PATCH', body: data, params: { uploadType: 'media', fields: 'id' } });
    return fileId;
  },
};
