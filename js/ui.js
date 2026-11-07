// Shared bits of interface: toasts, dialogs, icons, the notification time picker.
import { h, fmtBefore } from './util.js';

const ICONS = {
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3v4M15.5 3v4"/>',
  plan: '<circle cx="6" cy="5.5" r="1.8"/><circle cx="6" cy="18.5" r="1.8"/><path d="M6 7.5v9M11 5.5h9M11 12h9M11 18.5h9"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5zM10 21h4"/>',
  route: '<circle cx="6" cy="18.5" r="2.2"/><circle cx="18" cy="5.5" r="2.2"/><path d="M8.2 18.5H15a3.3 3.3 0 0 0 0-6.5H9a3.3 3.3 0 0 1 0-6.5h6.8"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 3.5v4h-4"/>',
};
export const icon = name => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

export function toast(message, { error = false, action, onAction } = {}) {
  const root = document.getElementById('toasts');
  const el = h('div', { class: `toast ${error ? 'error' : ''}`, role: error ? 'alert' : 'status' },
    h('span', null, message),
    action ? h('button', { class: 'toast-action', onclick: () => { el.remove(); onAction(); } }, action) : null);
  root.append(el);
  setTimeout(() => el.remove(), error ? 9000 : 6000);
}

export function dialog(content, { className = '', onClose } = {}) {
  const dlg = h('dialog', { class: `dlg ${className}` }, content);
  document.body.append(dlg);
  const close = () => dlg.close();
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  dlg.showModal();
  return { dlg, close };
}

export function confirmDialog({ title, body, action, danger, extra }) {
  return new Promise(res => {
    let result = false;
    const { close } = dialog(h('div', { class: 'confirm' },
      h('h2', null, title),
      body ? h('p', null, body) : null,
      extra,
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { result = true; close(); } }, action))),
    { onClose: () => res(result) });
  });
}

const PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880];

// Editable set of "minutes before" values shown as removable chips.
export function minuteChips(minutes, onChange) {
  const sorted = [...minutes].sort((a, b) => a - b);
  const add = h('select', {
    class: 'chip-add', 'aria-label': 'Add a notification time',
    onchange: e => {
      const v = e.target.value;
      if (v === 'custom') {
        const n = Number(prompt('Minutes before the event (0 to 40320):', '45'));
        if (Number.isInteger(n) && n >= 0 && n <= 40320 && !minutes.includes(n)) onChange([...minutes, n]);
      } else if (v !== '') onChange([...minutes, +v]);
      e.target.value = '';
    },
  },
    h('option', { value: '' }, minutes.length ? '+ Add' : '+ Add time'),
    PRESETS.filter(m => !minutes.includes(m)).map(m => h('option', { value: m }, m === 0 ? 'At start' : `${fmtBefore(m)} before`)),
    h('option', { value: 'custom' }, 'Custom…'));
  return h('div', { class: 'chips' },
    sorted.map(m => h('span', { class: 'chip' }, m === 0 ? 'At start' : `${fmtBefore(m)} before`,
      h('button', { class: 'chip-x', 'aria-label': `Remove ${fmtBefore(m)}`, onclick: () => onChange(minutes.filter(x => x !== m)), html: icon('x') }))),
    minutes.length < 5 ? add : null);
}
