import { state, save, emit } from '../store.js';
import { h, fmtTime } from '../util.js';
import { google, signIn, signOut } from '../google.js';
import { sync, switchBackend, setSessionRenewer } from '../core.js';
import { cloudSync } from '../cloud.js';
import { resetDemo } from '../demo.js';
import { parseTimetable, SAMPLE_TIMETABLE } from '../transit.js';
import { toast, confirmDialog } from '../ui.js';

let renewing = null, lastTry = 0;

// Signs back in with the saved client ID. Browsers only allow Google's window to open from
// a click, so this runs from one. `force` is an explicit Reconnect, which also reports errors.
export function renewSession({ force = false } = {}) {
  if (renewing) return renewing;
  if (!force && Date.now() - lastTry < 60000) return Promise.resolve();
  lastTry = Date.now();
  const account = state.calendars.find(c => c.primary)?.id;
  renewing = signIn(state.settings.clientId, account)
    .then(() => sync())
    .then(() => cloudSync())
    .catch(e => { if (force) toast(e.message, { error: true }); })
    .finally(() => { renewing = null; });
  return renewing;
}

setSessionRenewer(() => renewSession({ force: true }));

async function connect(clientId) {
  // Saved before signing in, so a failed attempt never means typing the ID again.
  state.settings.clientId = clientId;
  save('settings');
  try {
    await signIn(clientId);
    // Sample rules do not apply to a real calendar, so real data starts from a clean slate.
    if (state.mode !== 'google') {
      state.categories = state.categories.filter(c => !c.calId); state.history = []; state.appliedRules = null; state.calendars = []; state.events = [];
      state.settings.quiet = { ...state.settings.quiet, on: false };
    }
    switchBackend('google');
    save();
    await sync();
    await cloudSync();
    if (state.sync.status === 'ok') { toast('Connected to Google Calendar'); state.view.page = 'alerts'; }
    emit();
  } catch (e) { toast(e.message, { error: true }); }
}
export { connect };

function googleCard() {
  if (state.mode === 'google') {
    return h('section', { class: 'card' },
      h('h2', null, 'Google Calendar'),
      h('p', null, google.hasSession() ? 'Connected. Changes save straight to your calendar.' : 'Google sign-ins last about an hour. Reconnect to keep syncing. Your client ID is saved.'),
      state.sync.at ? h('p', { class: 'hint' }, `Last synced at ${fmtTime(state.sync.at)}.`) : null,
      h('div', { class: 'row gap wrap' },
        google.hasSession() ? null : h('button', { class: 'btn primary', onclick: () => renewSession({ force: true }) }, 'Reconnect'),
        h('button', { class: 'btn ghost', onclick: async () => {
          if (!await confirmDialog({ title: 'Disconnect Google Calendar?', body: 'Count-in forgets its copy of your calendar and goes back to the sample. Your Google Calendar stays exactly as it is, including notifications you already saved.', action: 'Disconnect' })) return;
          signOut();
          switchBackend('demo');
          Object.assign(state, { categories: state.categories.filter(c => !c.calId), calendars: [], events: [], history: [], appliedRules: null, cloudBase: null });
          save();
          await sync();
        } }, 'Disconnect')));
  }
  const input = h('input', { value: state.settings.clientId, placeholder: '1234567890-abc.apps.googleusercontent.com', 'aria-label': 'Google client ID', spellcheck: 'false' });
  const origin = location.origin;
  return h('section', { class: 'card' },
    h('h2', null, 'Connect Google Calendar'),
    h('p', { class: 'hint' }, 'You are looking at a sample calendar. Connecting takes about five minutes, once. Google requires each app to have its own ID, and this one will belong only to you.'),
    h('ol', { class: 'steps' },
      h('li', null, 'Open the ', h('a', { href: 'https://console.cloud.google.com/projectcreate', target: '_blank', rel: 'noopener' }, 'Google Cloud console'), ' and create a project named Count-in.'),
      h('li', null, h('a', { href: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', target: '_blank', rel: 'noopener' }, 'Enable the Google Calendar API'), ' for that project, and the ', h('a', { href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com', target: '_blank', rel: 'noopener' }, 'Google Drive API'), ' so your phone and computer share routes.'),
      h('li', null, 'Set up the ', h('a', { href: 'https://console.cloud.google.com/auth/overview', target: '_blank', rel: 'noopener' }, 'Google Auth Platform'), ': choose External, then under Audience add the Google account you will sign in with as a test user. Without this, Google answers "Error 403: access_denied".'),
      h('li', null, 'Under ', h('a', { href: 'https://console.cloud.google.com/auth/clients', target: '_blank', rel: 'noopener' }, 'Clients'), ', create a Web application client and add this as an authorized JavaScript origin: ', h('code', null, origin)),
      h('li', null, 'Paste the client ID here and connect. Google warns that the app is unverified, which is expected for an app you made yourself.')),
    h('div', { class: 'row gap' }, input, h('button', { class: 'btn primary', onclick: () => {
      // Phones sometimes turn a pasted ID into a link, adding http:// in front.
      const id = input.value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      if (!id.endsWith('.apps.googleusercontent.com')) { toast('That does not look like a client ID. It ends in .apps.googleusercontent.com.', { error: true }); return; }
      connect(id);
    } }, 'Connect')));
}

function devicesCard() {
  if (state.mode !== 'google') return null;
  const { status, at, error } = state.cloud;
  const text = {
    syncing: 'Sharing now…',
    ok: `Shared${at ? ` at ${fmtTime(at)}` : ''}. Your routes, places, categories and timed trips match on every device signed in to this Google account.`,
    waiting: 'Nothing to share yet. Once a device with routes connects, they appear here too.',
    scope: 'Google has not allowed Count-in to keep its file in your Drive yet. Reconnect, and tick the box for Google Drive.',
    signin: 'Reconnect to Google to share your latest changes.',
    error,
  }[status] || 'Your routes, places, categories and timed trips are shared through a hidden file in your Google Drive, which only Count-in can open.';
  const notOn = status === 'error' && /not turned on/.test(error);
  return h('section', { class: 'card' },
    h('h2', null, 'Phone and computer'),
    h('p', { class: status === 'error' || status === 'scope' ? 'form-error' : null, role: status === 'error' ? 'alert' : null }, text),
    notOn ? h('p', { class: 'hint' }, h('a', { href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com', target: '_blank', rel: 'noopener' }, 'Turn on the Google Drive API'), ' for your Count-in project, wait a minute, then share again.') : null,
    h('div', { class: 'row gap wrap' },
      status === 'scope' || status === 'signin'
        ? h('button', { class: 'btn primary', onclick: () => renewSession({ force: true }) }, 'Reconnect')
        : h('button', { class: 'btn ghost', disabled: status === 'syncing', onclick: () => cloudSync() }, 'Share now')));
}

export function renderSettings() {
  const s = state.settings;
  const up = patch => { Object.assign(s, patch); save('settings'); emit(); };
  return h('section', { class: 'settings-page' },
    h('h1', { class: 'page-title' }, 'Settings'),
    googleCard(),
    devicesCard(),
    h('section', { class: 'card' },
      h('h2', null, 'Calendars to show'),
      h('ul', { class: 'def-list' }, state.calendars.map(c => h('li', { class: 'def-row' },
        h('label', { class: 'check grow' },
          h('input', { type: 'checkbox', checked: c.on, onchange: e => { c.on = e.target.checked; save('calendars'); sync(); } }),
          h('span', { class: 'def-dot', style: { '--c': c.color } }), h('span', { dir: 'auto' }, c.summary)))))),
    h('section', { class: 'card' },
      h('h2', null, 'Appearance'),
      h('div', { class: 'row gap wrap' },
        h('label', { class: 'field inline grow' }, h('span', { class: 'field-label' }, 'Theme'), h('select', { onchange: e => up({ theme: e.target.value }) },
          [['auto', 'Match my system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: s.theme === v }, l)))),
        h('label', { class: 'field inline grow' }, h('span', { class: 'field-label' }, 'Week starts on'), h('select', { onchange: e => up({ weekStart: +e.target.value }) },
          [[0, 'Sunday'], [1, 'Monday'], [6, 'Saturday']].map(([v, l]) => h('option', { value: v, selected: s.weekStart === v }, l)))))),
    state.mode === 'demo' ? h('section', { class: 'card' },
      h('h2', null, 'Sample calendar'),
      h('div', null, h('button', { class: 'btn ghost', onclick: async () => {
        resetDemo();
        state.feeds = [parseTimetable(SAMPLE_TIMETABLE, 'Sample timetable (made-up places)'), ...state.feeds.filter(f => !f.name.startsWith('Sample timetable'))];
        Object.assign(state, { categories: state.categories.filter(c => !c.calId), history: [], appliedRules: null, events: [] });
        state.settings.quiet = { ...state.settings.quiet, on: false };
        save();
        await sync();
        toast('Reset the sample calendar');
      } }, 'Reset the sample'))) : null);
}
