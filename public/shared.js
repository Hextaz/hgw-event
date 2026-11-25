// HGW — utilitaires front-end partagés (ES Module, sans dépendance).

export const ICONS = {
  home: '<path d="M3 11 12 3l9 8"/><path d="M5 9.5V21h14V9.5"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  swords: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="M13 19l6-6M16 16l4 4M19 21l2-2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/><circle cx="8.5" cy="15.5" r="1"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>',
  tv: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M8 21h8"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flame: '<path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8 0 4 3 7 7 7Z"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4V8Z"/><path d="M13 6v12"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v9H5v-9M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L2 10l8-8 2.3 2.3a4 4 0 0 0 2.4 2Z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  play: '<path d="M6 4l14 8-14 8V4Z"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  medal: '<circle cx="12" cy="15" r="6"/><path d="M8.5 10.5 6 3h4l2 5 2-5h4l-2.5 7.5"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
};

export const $ = (id) => document.getElementById(id);

export function icon(name, cls = 'i') {
  const d = ICONS[name] || ICONS.info;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.outerHTML = icon(el.dataset.icon);
  });
}

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function plain(str) {
  return String(str ?? '')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function tName(t) {
  return plain(t.name).replace(/^Tournoi\s*#?\d+\s*[—–-]\s*/i, '');
}

export function trackName(m) {
  const n = plain(m.name).replace(m.code, '').trim();
  return n.replace(/^\((.*)\)$/, '$1') || m.code;
}

export function fmt(n) {
  return Number(n || 0).toLocaleString('fr-FR');
}

export function signed(n) {
  return n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(Math.abs(n))}` : '0';
}

export function formatTmTime(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '—';
  const totalMs = Math.round(Number(ms));
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const r = totalMs % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

export function formatMetric(value, metricType, unit = '') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  if (metricType === 'time_asc') return formatTmTime(Number(value));
  if (metricType === 'binary') return Number(value) > 0 ? 'Validé' : '—';
  const s = Math.round(Number(value)).toLocaleString('fr-FR');
  return unit ? `${s} ${unit}` : s;
}

/**
 * Parse un temps saisi ("0:42.500", "42.500", "42500") en ms, ou un nombre brut pour un score.
 */
export function parseMetricInput(raw, metricType) {
  const s = String(raw || '').trim().replace(',', '.');
  if (!s) return NaN;
  if (metricType === 'time_asc') {
    const mmss = s.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
    if (mmss) {
      const mins = Number(mmss[1]);
      const secs = Number(mmss[2]);
      const ms = Number((mmss[3] || '0').padEnd(3, '0'));
      return mins * 60000 + secs * 1000 + ms;
    }
    if (s.includes('.')) {
      const secs = Number(s);
      return Number.isFinite(secs) ? Math.round(secs * 1000) : NaN;
    }
    const n = Number(s);
    return Number.isFinite(n) ? (n < 600 ? Math.round(n * 1000) : Math.round(n)) : NaN;
  }
  const n = Number(s.replace(/\s+/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

export function deltaSec(ms) {
  const s = (Math.abs(ms) / 1000).toFixed(3);
  return ms < 0 ? `−${s}` : `+${s}`;
}

export function initials(name) {
  return (
    String(name || '?')
      .replace(/[^\p{L}\p{N} ]/gu, '')
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}

export function avatar(user, size = '') {
  const src = user?.avatar && /^https?:\/\//.test(user.avatar) ? user.avatar : null;
  if (src) return `<img class="hgw-avatar ${size}" src="${esc(src)}" alt="" loading="lazy" />`;
  return `<span class="hgw-avatar ${size}" aria-hidden="true">${esc(initials(user?.display_name))}</span>`;
}

export function monogram(game, small = false) {
  const label = game?.short_name || game?.name || game?.game_name || '?';
  const letters = label
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const logo = game?.logo_url && /^(https:\/\/|\/uploads\/logos\/)/.test(game.logo_url) ? game.logo_url : null;
  if (logo) {
    return `<span class="monogram has-logo ${small ? 'monogram--sm' : ''}" aria-hidden="true"><img src="${esc(logo)}" alt="" loading="lazy" data-fallback="${esc(letters || '?')}" /></span>`;
  }
  return `<span class="monogram ${small ? 'monogram--sm' : ''}" aria-hidden="true">${esc(letters || '?')}</span>`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const t = Date.parse(String(iso).includes('T') || String(iso).endsWith('Z') ? iso : `${String(iso).replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

export function fmtDate(local) {
  if (!local) return '';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  return d.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function toLocalInput(v) {
  return v ? String(v).slice(0, 16) : '';
}

export function diffPips(d) {
  const n = { easy: 1, medium: 2, hard: 3 }[d] || 1;
  const label = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile' }[d] || d;
  return `<span class="hgw-diff"><span class="hgw-diff__pips" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>${label}</span>`;
}

export function emptyCard(title, text) {
  return `<div class="hgw-card hgw-card--flat"><div class="hgw-empty"><strong>${esc(title)}</strong>${esc(text)}</div></div>`;
}

export function withTieRanks(rows, key) {
  let prev = null;
  let rank = 0;
  return rows.map((r, i) => {
    if (prev === null || r[key] !== prev) rank = i + 1;
    prev = r[key];
    return { row: r, rank };
  });
}

export function teamsOf(t) {
  const map = new Map();
  for (const r of t.registrations || []) {
    if (!r.team_number) continue;
    if (!map.has(r.team_number)) {
      map.set(r.team_number, { num: r.team_number, name: plain(r.team_name) || `Équipe ${r.team_number}`, members: [] });
    }
    map.get(r.team_number).members.push(r);
  }
  return [...map.values()].sort((a, b) => a.num - b.num);
}

export async function api(url, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || 'POST';
    init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    init.body = JSON.stringify(opts.json);
    delete init.json;
  }
  try {
    const res = await fetch(url, init);
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'Connexion au serveur impossible. Réessaie dans un instant.' } };
  }
}

export function toast({ title, text = '', type = 'info', action = null, duration }) {
  const box = $('toasts');
  if (!box) return;
  while (box.children.length >= 3) box.firstElementChild.remove();
  const el = document.createElement('div');
  const glyph = { success: '✓', danger: '!', points: '+', info: 'i' }[type] || 'i';
  el.className = `hgw-toast hgw-toast--${type}`;
  el.setAttribute('role', type === 'danger' ? 'alert' : 'status');
  el.innerHTML = `
    <span class="hgw-toast__icon" aria-hidden="true">${glyph}</span>
    <div class="hgw-toast__body">
      <div class="hgw-toast__title">${esc(title)}</div>
      ${text ? `<div class="hgw-toast__text">${esc(text)}</div>` : ''}
      ${action ? `<button type="button" class="hgw-toast__action">${esc(action.label)}</button>` : ''}
    </div>
    <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--icon hgw-btn--sm" aria-label="Fermer la notification">${icon('x')}</button>`;
  const remove = () => el.remove();
  el.querySelector('[aria-label="Fermer la notification"]').addEventListener('click', remove);
  if (action) {
    el.querySelector('.hgw-toast__action').addEventListener('click', () => {
      action.fn();
      remove();
    });
  }
  box.appendChild(el);
  const ms = duration ?? (type === 'danger' ? 9000 : 5000);
  if (ms > 0) setTimeout(remove, ms);
}

export function toastError(data, fallback = 'Une erreur est survenue.') {
  toast({ title: plain(data?.error) || fallback, type: 'danger' });
}

export function copyText(text, label) {
  navigator.clipboard?.writeText(text);
  toast({ title: label || 'Copié', text, type: 'success' });
}

/**
 * Valide une URL avant insertion dans href/src (bloque javascript:, data:, etc.).
 */
export function safeUrl(raw, allowedProtocols = ['https:', 'http:']) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return allowedProtocols.includes(u.protocol) ? s : null;
  } catch {
    return null;
  }
}

export function confirmDialog({ title = 'Confirmation', message = '', confirmLabel = 'Confirmer', danger = true }) {
  return new Promise((resolve) => {
    const dlg = $('action-dialog');
    if (!dlg) return resolve(false);
    const form = $('action-dialog-form');
    const okBtn = $('action-dialog-ok');
    const cancelBtn = $('action-dialog-cancel');
    $('action-dialog-title').textContent = title;
    $('action-dialog-msg').textContent = message;
    $('action-dialog-input-wrap').hidden = true;
    okBtn.textContent = confirmLabel;
    okBtn.className = `hgw-btn ${danger ? 'hgw-btn--danger' : 'hgw-btn--primary'}`;

    const cleanup = (val) => {
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      resolve(val);
    };
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      cleanup(val);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      finish(true);
    };
    const onCancel = () => finish(false);
    const onClose = () => finish(false);

    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    okBtn.focus();
  });
}

export function promptDialog({
  title = 'Saisie',
  message = '',
  label = 'Nom',
  defaultValue = '',
  placeholder = '',
  confirmLabel = 'Valider',
}) {
  return new Promise((resolve) => {
    const dlg = $('action-dialog');
    if (!dlg) return resolve(null);
    const form = $('action-dialog-form');
    const okBtn = $('action-dialog-ok');
    const cancelBtn = $('action-dialog-cancel');
    const input = $('action-dialog-input');
    $('action-dialog-title').textContent = title;
    $('action-dialog-msg').textContent = message;
    $('action-dialog-label').textContent = label;
    $('action-dialog-input-wrap').hidden = false;
    input.value = defaultValue;
    input.placeholder = placeholder;
    okBtn.textContent = confirmLabel;
    okBtn.className = 'hgw-btn hgw-btn--primary';

    const cleanup = (val) => {
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      resolve(val);
    };
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      cleanup(val);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return input.focus();
      finish(val);
    };
    const onCancel = () => finish(null);
    const onClose = () => finish(null);

    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.focus();
    input.select();
  });
}
