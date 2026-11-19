// HGW — application joueur et back-office (design system v2).
// Vanilla JS, aucune dépendance. Les vues sont routées par URL (history API) ;
// le serveur renvoie index.html pour toute route inconnue.

// ============================================================================
// ÉTAT
// ============================================================================
let appState = null;
let route = { view: 'today', pane: 'moderation' };
let selectedGameIds = new Set();
let gamesDirty = false;
let leaderboardFilter = 'all';
let leaderboardSearch = '';
let leaderboardExpanded = false;
const LB_LIMIT = 20;
let adminTourneyId = 'rl_rumble';
let settingsDirty = false;
let reviewIndex = 0;
const decidedProofs = new Set(); // preuves traitées localement (en attente d'envoi ou envoyées)
const pendingDecisions = new Map(); // id -> { timer, send }
let stageQueue = [];
let stageIndex = 0;
let tombolaSpinning = false;
let sseConnected = false;
let fetchTimer = null;
let adminCatalog = null; // { games, quests, pointsByDifficulty, logoSearchEnabled }
let catalogStale = true;
let catalogLoading = false;
let catGameId = null;
let catFilter = 'all';
let catSearch = '';
let gameEdit = null; // { id|null, logo_url }
let questEdit = null; // { id|null, difficulty, unlock_week }
let sgdbType = 'icons';
let sgdbGameId = null;
let sgdbTimer = null;

const REPLAYS_PATH = '%USERPROFILE%\\Documents\\TrackMania\\Tracks\\Replays\\Replays';
const REJECT_REASONS = [
  'La capture ne montre pas ton pseudo.',
  'Le résultat demandé n’est pas visible.',
  'Capture coupée ou illisible : renvoie l’écran de fin complet.',
  'Preuve d’une autre partie ou antérieure au défi.',
  'Lien inaccessible : vérifie qu’il est public.',
];
const MEDAL_LABEL = { author: 'Auteur', gold: 'Or', silver: 'Argent', bronze: 'Bronze', none: 'Aucune' };
const PLACEMENTS = [
  ['', '—'],
  ['1', '1er'],
  ['2', '2e'],
  ['3', '3e – 4e'],
  ['5', '5e – 8e'],
  ['9', 'Participation'],
];

// ============================================================================
// ICÔNES (au trait, 24 px, style Lucide — ISC)
// ============================================================================
const ICONS = {
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
};
function icon(name, cls = 'i') {
  const d = ICONS[name] || ICONS.info;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.outerHTML = icon(el.dataset.icon);
  });
}

// ============================================================================
// OUTILS
// ============================================================================
const $ = (id) => document.getElementById(id);

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Les emoji restent sur Discord : on les retire des textes venant du serveur.
function plain(str) {
  return String(str ?? '')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function tName(t) {
  return plain(t.name).replace(/^Tournoi\s*#?\d+\s*[—–-]\s*/i, '');
}

function trackName(m) {
  const n = plain(m.name).replace(m.code, '').trim();
  return n.replace(/^\((.*)\)$/, '$1') || m.code;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('fr-FR');
}

function signed(n) {
  return n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(Math.abs(n))}` : '0';
}

function initials(name) {
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

function avatar(user, size = '') {
  const src = user?.avatar && /^https?:\/\//.test(user.avatar) ? user.avatar : null;
  if (src) return `<img class="hgw-avatar ${size}" src="${esc(src)}" alt="" loading="lazy" />`;
  return `<span class="hgw-avatar ${size}" aria-hidden="true">${esc(initials(user?.display_name))}</span>`;
}

function monogram(game, small = false) {
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

function deltaSec(ms) {
  const s = (Math.abs(ms) / 1000).toFixed(3);
  return ms < 0 ? `−${s}` : `+${s}`;
}

function timeAgo(iso) {
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

function fmtDate(local) {
  if (!local) return '';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  return d.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function api(url, opts = {}) {
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

function copyText(text, label) {
  navigator.clipboard?.writeText(text);
  toast({ title: label || 'Copié', text, type: 'success' });
}

// ============================================================================
// TOASTS
// ============================================================================
function toast({ title, text = '', type = 'info', action = null, duration }) {
  const box = $('toasts');
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

function toastError(data, fallback = 'Une erreur est survenue.') {
  toast({ title: plain(data?.error) || fallback, type: 'danger' });
}

// ============================================================================
// ROUTAGE
// ============================================================================
const ROUTES = {
  '/': { view: 'today' },
  '/classement': { view: 'classement' },
  '/trackmania': { view: 'trackmania' },
  '/tournois': { view: 'tournois' },
  '/aide': { view: 'aide' },
  '/admin': { view: 'admin', pane: 'moderation' },
  '/admin/evenement': { view: 'admin', pane: 'evenement' },
  '/admin/tournois': { view: 'admin', pane: 'tournois' },
  '/admin/points': { view: 'admin', pane: 'points' },
  '/admin/catalogue': { view: 'admin', pane: 'catalogue' },
  '/admin/maintenance': { view: 'admin', pane: 'maintenance' },
};
const LEGACY_HASH = { '#classement': '/classement', '#defis': '/', '#trackmania': '/trackmania', '#tournois': '/tournois', '#guide': '/aide', '#admin': '/admin' };

function resolveRoute(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return ROUTES[clean] ? { path: clean, ...ROUTES[clean] } : { path: '/', ...ROUTES['/'] };
}

function navigate(path, { replace = false } = {}) {
  const r = resolveRoute(path);
  if (replace) history.replaceState({}, '', r.path);
  else if (location.pathname !== r.path) history.pushState({}, '', r.path);
  applyRoute(r);
  window.scrollTo({ top: 0 });
}

function applyRoute(r) {
  if (r.view === 'admin' && appState && appState.user?.is_admin !== 1) {
    history.replaceState({}, '', '/');
    r = { path: '/', ...ROUTES['/'] };
  }
  route = { view: r.view, pane: r.pane || 'moderation' };
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('is-active', s.id === `view-${route.view}`));
  document.querySelectorAll('.admin-pane').forEach((p) => p.classList.toggle('is-active', p.id === `pane-${route.pane}`));
  const titles = { today: 'Aujourd’hui', classement: 'Classement', trackmania: 'Trackmania', tournois: 'Tournois', aide: 'Aide', admin: 'Organisation' };
  document.title = `${titles[route.view] || 'Accueil'} · Hextaz Games Week`;
  if (appState) {
    renderNav();
    if (route.view === 'admin') renderAdmin();
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  e.preventDefault();
  navigate(new URL(a.href).pathname);
});
window.addEventListener('popstate', () => applyRoute(resolveRoute(location.pathname)));

// ============================================================================
// PHASES & TEMPS
// ============================================================================
function parisNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
}

function resetCountdown() {
  const now = parisNow();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);
  const sec = Math.max(0, Math.floor((next - now) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

function phaseInfo() {
  const s = appState?.eventSettings || {};
  const startMs = Date.parse(s.start_at);
  const day = Number.isFinite(startMs) ? Math.floor((parisNow() - new Date(s.start_at)) / 86400000) + 1 : null;
  let key = 'act1';
  if (s.effective_phase === 'registration') key = 'registration';
  else if (s.effective_phase === 'closed') key = 'closed';
  else if (s.effective_phase === 'week2') key = day !== null && day >= 13 ? 'finale' : 'act2';
  const labels = { registration: 'Inscriptions', act1: 'Acte I', act2: 'Acte II', finale: 'Finale', closed: 'Terminé' };
  return { key, label: labels[key], day: day !== null ? Math.max(1, Math.min(14, day)) : null, manual: s.status_mode && s.status_mode !== 'auto' };
}

function renderPhaseChip() {
  const p = phaseInfo();
  const text = $('phase-chip-text');
  if (p.key === 'registration') text.innerHTML = `<b>Inscriptions</b> · début ${esc(fmtDate(appState.eventSettings.start_at))}`;
  else if (p.key === 'closed') text.innerHTML = `<b>Événement terminé</b>`;
  else text.innerHTML = `<b>${p.label}</b>${p.day ? ` · J${p.day}` : ''} · nouveaux défis dans ${resetCountdown()}`;
  $('live-dot').classList.toggle('off', !sseConnected);
  $('live-dot').title = sseConnected ? 'Mises à jour en direct' : 'Reconnexion…';
}

function phaseTimeline() {
  const p = phaseInfo();
  const s = appState.eventSettings || {};
  const seg = (key, k, t, d, dayFrom, dayTo) => {
    const order = ['registration', 'act1', 'act2', 'finale', 'closed'];
    const done = order.indexOf(p.key) > order.indexOf(key);
    const now = p.key === key;
    let bar = '';
    if (now && p.day) {
      const pct = Math.round(((p.day - dayFrom + 1) / (dayTo - dayFrom + 1)) * 100);
      bar = `<div class="hgw-phase__bar"><span style="width:${Math.min(100, pct)}%"></span></div>`;
    }
    return `<div class="hgw-phase ${done ? 'done' : ''} ${now ? 'now' : ''}">
      <div class="hgw-phase__k">${k}${now ? ' · en cours' : ''}</div>
      <div class="hgw-phase__t">${t}</div>
      <div class="hgw-phase__d">${now && p.day ? `Jour ${p.day} · nouveaux défis dans ${resetCountdown()}` : done ? 'Terminé' : d}</div>
      ${bar}
    </div>`;
  };
  return `<div class="hgw-phases" aria-label="Étapes de l'événement">
    ${seg('act1', 'Acte I · J1–J7', 'Défis + 8 pistes solo', `Dès le ${esc(fmtDate(s.start_at))}`, 1, 7)}
    ${seg('act2', 'Acte II · J8–J12', 'Map serveur ouverte', `Dès le ${esc(fmtDate(s.week2_start_at))}`, 8, 12)}
    ${seg('finale', 'Finale · J13–J14', '4 tournois live', 'Samedi et dimanche', 13, 14)}
  </div>`;
}

// ============================================================================
// DONNÉES
// ============================================================================
async function fetchState() {
  const { ok, data } = await api('/api/state');
  if (!ok) {
    toastError(data, 'Impossible de charger les données.');
    return;
  }
  appState = data;
  if (!gamesDirty) selectedGameIds = new Set(appState.mySelectedGames || []);
  renderAll();
}

function scheduleFetch() {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(fetchState, 250);
}

function me() {
  const lb = appState.leaderboard || [];
  return lb.find((u) => u.id === appState.user?.id) || null;
}

function renderAll() {
  if (!appState) return;
  applyRoute(resolveRoute(location.pathname));
  renderPhaseChip();
  renderUser();
  renderToday();
  renderLeaderboard();
  renderTrackmania();
  renderTournaments();
  if (appState.user?.is_admin === 1) renderAdmin();
}

// ============================================================================
// NAVIGATION & MENU UTILISATEUR
// ============================================================================
function renderNav() {
  const openQuests = (appState.myDailyQuests || []).filter((q) => q.status === 'open' || q.status === 'rejected').length;
  const items = [
    ['/', 'home', appState.user ? 'Aujourd’hui' : 'Accueil', 'today', appState.user ? openQuests : 0],
    ['/classement', 'trophy', 'Classement', 'classement', 0],
    ['/trackmania', 'flag', 'Trackmania', 'trackmania', 0],
    ['/tournois', 'swords', 'Tournois', 'tournois', 0],
  ];
  $('main-nav').innerHTML = items
    .map(
      ([href, ic, label, view, count]) => `
      <a class="hgw-tab" href="${href}" data-link ${route.view === view ? 'aria-current="page"' : ''}>
        ${icon(ic)}<span>${label}</span>${count ? `<span class="hgw-tab__count" aria-label="${count} à faire">${count}</span>` : ''}
      </a>`
    )
    .join('');
}

function openLogin() {
  if (appState?.oauthConfigured) {
    location.href = '/api/auth/discord';
  } else if (appState?.devMode) {
    $('dev-login-dialog').showModal();
  } else {
    toast({ title: 'Connexion indisponible', text: 'La connexion Discord n’est pas encore configurée.', type: 'danger' });
  }
}

function renderUser() {
  const slot = $('user-slot');
  if (!appState.user) {
    slot.innerHTML = `<button type="button" class="hgw-btn hgw-btn--primary hgw-btn--sm" id="topbar-login">Se connecter</button>`;
    $('topbar-login').addEventListener('click', openLogin);
    return;
  }
  const m = me();
  const pending = appState.admin ? visibleProofs().length : 0;
  const isAdmin = appState.user.is_admin === 1;
  slot.innerHTML = `
    <div class="usermenu">
      <button type="button" class="usermenu__btn" id="usermenu-btn" aria-haspopup="menu" aria-expanded="false">
        ${avatar(appState.user)}
        <span class="usermenu__name">${esc(appState.user.display_name)}</span>
        <span class="usermenu__pts">${fmt(m?.total_points)} pts</span>
        ${isAdmin && pending ? `<span class="hgw-tab__count" aria-label="${pending} preuves à vérifier">${pending}</span>` : ''}
      </button>
      <div class="usermenu__list" id="usermenu-list" role="menu" hidden>
        <button type="button" class="usermenu__item" role="menuitem" data-act="ledger">${icon('list')}Mon historique de points</button>
        ${isAdmin ? `<a class="usermenu__item" role="menuitem" href="/admin" data-link>${icon('shield')}Organisation${pending ? `<span class="hgw-tab__count">${pending}</span>` : ''}</a>` : ''}
        <a class="usermenu__item" role="menuitem" href="/aide" data-link>${icon('help')}Aide</a>
        <div class="usermenu__sep"></div>
        <button type="button" class="usermenu__item" role="menuitem" data-act="logout">${icon('logout')}Se déconnecter</button>
      </div>
    </div>`;
  const btn = $('usermenu-btn');
  const list = $('usermenu-list');
  const close = () => {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    list.hidden = !list.hidden;
    btn.setAttribute('aria-expanded', String(!list.hidden));
  });
  list.addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = e.target.closest('[data-act], a');
    close();
    if (!item) return;
    if (item.dataset.act === 'ledger') openLedger(appState.user.id);
    if (item.dataset.act === 'logout') {
      await api('/api/auth/logout', { method: 'POST' });
      navigate('/');
      await fetchState();
      toast({ title: 'Tu es déconnecté.', type: 'success' });
    }
  });
}

// ============================================================================
// AUJOURD'HUI
// ============================================================================
function renderToday() {
  const root = $('view-today');
  if (!appState.user) {
    root.innerHTML = renderVisitorHome();
    root.querySelector('#hero-login')?.addEventListener('click', openLogin);
    root.querySelector('#hero-dev')?.addEventListener('click', () => $('dev-login-dialog').showModal());
    return;
  }

  const quests = appState.myDailyQuests || [];
  const hasGames = (appState.mySelectedGames || []).length >= 4;

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title" id="today-title">Salut ${esc(appState.user.display_name)}</h1>
        <p class="view-desc">${hasGames ? 'Voici ce qui t’attend aujourd’hui.' : 'Coche tes jeux pour recevoir tes premiers défis.'}</p>
      </div>
    </div>
    ${phaseTimeline()}
    ${appState.eventSettings?.effective_phase === 'closed' ? `<div class="banner banner--gold section">${icon('trophy')}<span>L’événement est terminé : les points sont gelés. Merci d’avoir joué !</span></div>` : ''}
    ${hasGames ? `<div class="hgw-card section">${renderTonight()}</div>` : ''}
    <div class="section">
      <div class="section-head">
        <h2 class="section-title">Tes défis du jour</h2>
        ${hasGames ? `<span class="small muted">${appState.canRerollToday ? '1 relance disponible aujourd’hui' : 'Relance utilisée · prochaine demain à 3 h'}</span>` : ''}
      </div>
      ${hasGames ? (quests.length ? `<div class="grid-3">${quests.map(questCard).join('')}</div>` : emptyCard('Pas de défi pour l’instant', 'Les défis sont tirés chaque nuit à 3 h.')) : `<div class="banner banner--gold">${icon('target')}<span>Coche au moins <b>4 jeux</b> ci-dessous puis enregistre : tes 3 défis arrivent tout de suite.</span></div>`}
    </div>
    ${hasGames ? `<div class="section"><h2 class="section-title">Ta progression</h2>${renderMyStats()}</div>` : ''}
    <div class="section" id="my-games">${renderGames()}</div>
  `;

  root.querySelectorAll('[data-proof]').forEach((b) => b.addEventListener('click', () => openProof(Number(b.dataset.proof))));
  root.querySelectorAll('[data-reroll]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      const { ok, data } = await api(`/api/quests/${b.dataset.reroll}/reroll`, { method: 'POST' });
      if (!ok) {
        b.disabled = false;
        return toastError(data);
      }
      toast({ title: 'Défi relancé', text: 'Même difficulté, nouveau défi.', type: 'success' });
      fetchState();
    })
  );
  root.querySelectorAll('[data-open-ledger]').forEach((b) => b.addEventListener('click', () => openLedger(appState.user.id)));
  bindGames(root);
}

function renderVisitorHome() {
  const lb = (appState.leaderboard || []).slice(0, 5);
  const canLogin = appState.oauthConfigured || appState.devMode;
  return `
    <div class="hgw-card hero">
      <div>
        <p class="hgw-stat__label t-gold">Hextaz Games Week</p>
        <h1 class="hero__title" id="today-title" style="margin-top: var(--space-2)">Deux semaines de défis, de chronos et de tournois.</h1>
        <p class="hero__lead">Joue à ton rythme, 15 minutes par soir suffisent. Trois défis par jour sur tes jeux, la chasse aux médailles Trackmania, puis quatre tournois live pour finir.</p>
        <div class="row" style="margin-top: var(--space-6)">
          ${appState.oauthConfigured ? `<button type="button" class="hgw-btn hgw-btn--primary hgw-btn--lg" id="hero-login">Se connecter avec Discord</button>` : ''}
          ${appState.devMode ? `<button type="button" class="hgw-btn hgw-btn--${appState.oauthConfigured ? 'ghost' : 'primary hgw-btn--lg'}" id="hero-dev">Connexion de test</button>` : ''}
          ${!canLogin ? `<span class="small muted">La connexion ouvrira bientôt.</span>` : ''}
          <a class="hgw-btn hgw-btn--ghost" href="/aide" data-link>Comment ça marche</a>
        </div>
      </div>
      <ol class="hero__steps">
        <li><span><b>Coche tes jeux</b><span class="muted small">Au moins 4, les jeux web gratuits sont inclus.</span></span></li>
        <li><span><b>Relève tes 3 défis du jour</b><span class="muted small">Envoie une capture, un orga valide, les points tombent.</span></span></li>
        <li><span><b>Grimpe au classement</b><span class="muted small">300 points = un ticket pour la tombola du dimanche.</span></span></li>
      </ol>
    </div>
    <div class="section">${phaseTimeline()}</div>
    <div class="hgw-card section">
      <div class="hgw-card__head">
        <div><h2 class="hgw-card__title">En tête du classement</h2></div>
        <a href="/classement" data-link class="hgw-btn hgw-btn--ghost hgw-btn--sm">Tout le classement</a>
      </div>
      ${lb.length ? `<div class="table-wrap"><table class="hgw-table"><tbody>${withTieRanks(lb, 'total_points').map(({ row, rank }) => lbRow(row, rank, false)).join('')}</tbody></table></div>` : `<div class="hgw-empty"><strong>Personne pour l’instant</strong>Sois le premier à marquer des points.</div>`}
    </div>`;
}

function renderTonight() {
  const items = [];
  const quests = appState.myDailyQuests || [];
  const rejected = quests.filter((q) => q.status === 'rejected');
  const open = quests.filter((q) => q.status === 'open');
  const m = me();
  const reg = appState.myRegularity || { activeDaysCount: 0, tiers: [] };

  if (rejected.length) items.push(['alert', `<b>${rejected.length} preuve${rejected.length > 1 ? 's' : ''} refusée${rejected.length > 1 ? 's' : ''}</b> à renvoyer`, '']);
  if (open.length) {
    const pts = open.reduce((s, q) => s + (q.points || 0), 0);
    items.push(['target', `<b>${open.length} défi${open.length > 1 ? 's' : ''}</b> à faire`, `+${pts}`]);
  }
  const nextTier = (reg.tiers || []).find((t) => !t.unlocked);
  const activeToday = quests.some((q) => q.status === 'validated');
  if (nextTier && items.length < 3) {
    items.push([
      'flame',
      activeToday
        ? `Journée validée · <b>${reg.activeDaysCount}/${nextTier.days} jours</b> pour le palier`
        : `Valide un défi aujourd’hui pour le palier <b>${nextTier.days} jours</b> (${reg.activeDaysCount}/${nextTier.days})`,
      `+${nextTier.points}`,
    ]);
  }
  const nextMedal = closestMedal();
  if (nextMedal && items.length < 3) items.push(['flag', `${nextMedal.label} sur <b>${esc(nextMedal.code)}</b> à ${nextMedal.gap} s`, `+${nextMedal.gain}`]);
  if (m && !m.tombola_eligible && items.length < 3) items.push(['ticket', `Encore <b>${fmt(appState.tombolaThreshold - m.total_points)} pts</b> pour la tombola`, '']);
  if (!items.length) items.push(['check', '<b>Tout est fait pour aujourd’hui.</b> Reviens après 3 h pour de nouveaux défis.', '']);

  return `<div class="hgw-card__head" style="margin-bottom: var(--space-3)"><h2 class="hgw-card__title">Ce soir</h2></div>
    <div class="tonight">${items
      .slice(0, 3)
      .map(([ic, txt, gain]) => `<div class="tonight__item">${icon(ic)}<span>${txt}</span>${gain ? `<span class="hgw-badge hgw-badge--points tonight__gain">${gain}</span>` : ''}</div>`)
      .join('')}</div>`;
}

function medalSteps(m) {
  return [
    { key: 'bronze', ms: m.bronze_ms, pts: 5 },
    { key: 'silver', ms: m.silver_ms, pts: 10 },
    { key: 'gold', ms: m.gold_ms, pts: 20 },
    { key: 'author', ms: m.author_ms, pts: 30 },
  ];
}

function closestMedal() {
  const subs = new Map((appState.myTmnfSubmissions || []).map((s) => [s.map_id, s]));
  let best = null;
  for (const m of (appState.tmnfMaps || []).filter((x) => !x.is_weekly)) {
    const sub = subs.get(m.id);
    if (!sub) continue;
    const next = medalSteps(m).find((s) => sub.best_time_ms > s.ms);
    if (!next) continue;
    const gapMs = sub.best_time_ms - next.ms;
    if (!best || gapMs < best.gapMs) {
      best = { code: m.code, label: MEDAL_LABEL[next.key], gapMs, gap: (gapMs / 1000).toFixed(3).replace('.', ','), gain: next.pts - (sub.best_points || 0) };
    }
  }
  return best && best.gain > 0 ? best : null;
}

function diffPips(d) {
  const n = { easy: 1, medium: 2, hard: 3 }[d] || 1;
  const label = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile' }[d] || d;
  return `<span class="hgw-diff"><span class="hgw-diff__pips" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>${label}</span>`;
}

function questCard(q) {
  const cap = appState.maxWeeklyQuestsPerGame || 4;
  const used = appState.myWeeklyGameCounts?.[q.game_id] || 0;
  const game = (appState.games || []).find((g) => g.id === q.game_id) || { short_name: q.game_name };
  const states = {
    open: { cls: '', badge: `<span class="hgw-badge hgw-badge--points">+${q.points}</span>` },
    submitted: { cls: 'hgw-quest--pending', badge: `<span class="hgw-badge hgw-badge--info"><span class="hgw-badge__dot"></span>En vérification</span>` },
    validated: { cls: 'hgw-quest--done', badge: `<span class="hgw-badge hgw-badge--success">${icon('check')}Validé +${q.points}</span>` },
    rejected: { cls: 'hgw-quest--rejected', badge: `<span class="hgw-badge hgw-badge--danger">Refusée</span>` },
  };
  const st = states[q.status] || { cls: '', badge: `<span class="hgw-badge">Expiré</span>` };

  let actions = '';
  if (q.status === 'open') {
    actions = `<button type="button" class="hgw-btn hgw-btn--primary" data-proof="${q.id}">Envoyer ma preuve</button>
      <button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--icon" data-reroll="${q.id}" ${appState.canRerollToday ? '' : 'disabled'}
        aria-label="${appState.canRerollToday ? 'Relancer ce défi (1 relance aujourd’hui)' : 'Relance déjà utilisée aujourd’hui'}"
        title="${appState.canRerollToday ? 'Relancer ce défi' : 'Prochaine relance demain à 3 h'}">${icon('dice')}</button>`;
  } else if (q.status === 'rejected') {
    actions = `<button type="button" class="hgw-btn hgw-btn--primary" data-proof="${q.id}">Renvoyer une preuve</button>`;
  }

  return `<article class="hgw-quest ${st.cls}">
    <div class="hgw-quest__top">
      <span class="hgw-quest__game">${monogram(game, true)}${esc(q.game_name)} <span class="quota ${used >= cap ? 'is-full' : ''}" title="Défis de ce jeu cette semaine">${used}/${cap}</span></span>
      ${st.badge}
    </div>
    <div>
      ${diffPips(q.difficulty)}
      <h3 class="hgw-quest__title" style="margin-top: var(--space-2)">${esc(plain(q.title))}</h3>
      <p class="hgw-quest__desc">${esc(plain(q.description))}</p>
      ${q.status === 'submitted' ? `<p class="small faint" style="margin-top: var(--space-2)">Envoyée ${esc(timeAgo(q.submitted_at))}. Un orga valide en général dans la soirée.</p>` : ''}
      ${q.status === 'open' && q.proof_hint ? `<p class="small faint" style="margin-top: var(--space-2)">Preuve attendue : ${esc(plain(q.proof_hint))}</p>` : ''}
    </div>
    ${q.status === 'rejected' ? `<div class="hgw-quest__note"><b>Motif :</b> ${esc(plain(q.reject_reason) || 'preuve incomplète.')}</div>` : ''}
    ${actions ? `<div class="hgw-quest__actions">${actions}</div>` : ''}
  </article>`;
}

function renderMyStats() {
  const m = me() || { rank: '—', total_points: 0, async_points: 0, live_points: 0, tombola_eligible: false, tombola_progress_pct: 0 };
  const total = (appState.leaderboard || []).length;
  const reg = appState.myRegularity || { activeDaysCount: 0, totalBonusPoints: 0, tiers: [] };
  const nextTier = (reg.tiers || []).find((t) => !t.unlocked);
  const left = Math.max(0, appState.tombolaThreshold - m.total_points);
  return `<div class="grid-4">
    <button type="button" class="hgw-stat" data-open-ledger style="border:0;text-align:left;color:inherit;font:inherit;cursor:pointer">
      <div class="hgw-stat__label">Rang</div>
      <div class="hgw-stat__value">#${m.rank}<small>/ ${total}</small></div>
      <div class="hgw-stat__meta">Voir mon historique</div>
    </button>
    <div class="hgw-stat">
      <div class="hgw-stat__label">Points</div>
      <div class="hgw-stat__value hgw-stat__value--gold">${fmt(m.total_points)}</div>
      <div class="hgw-split" style="margin-top: var(--space-2)" title="Quinzaine ${m.async_points} · week-end ${m.live_points}"><span class="a" style="flex:${m.async_points || 0}"></span><span class="l" style="flex:${m.live_points || 0}"></span></div>
      <div class="hgw-stat__meta">Quinzaine ${fmt(m.async_points)} · week-end ${fmt(m.live_points)}</div>
    </div>
    <div class="hgw-stat">
      <div class="hgw-stat__label">Tombola</div>
      ${m.tombola_eligible ? `<div class="hgw-stat__value t-success">Qualifié</div><div class="hgw-stat__meta">Ton ticket est dans l’urne.</div>` : `<div class="hgw-stat__value">${fmt(left)}<small>pts restants</small></div><div class="hgw-progress"><span style="width:${m.tombola_progress_pct}%"></span></div>`}
    </div>
    <div class="hgw-stat">
      <div class="hgw-stat__label">Régularité</div>
      <div class="hgw-stat__value">${reg.activeDaysCount}<small>/ 12 j</small></div>
      <div class="tiers">${(reg.tiers || []).map((t) => `<span class="tier ${t.unlocked ? 'is-on' : ''}" title="${t.days} jours actifs : +${t.points} pts"><b>+${t.points}</b><span>${t.days} j</span></span>`).join('')}</div>
      ${nextTier ? '' : `<div class="hgw-stat__meta">Tous les paliers débloqués (+${reg.totalBonusPoints}).</div>`}
    </div>
  </div>`;
}

// Un jeu désactivé ou sans défi actif n'est pas proposé : il ferait perdre un emplacement au joueur.
function selectableGames() {
  return (appState.games || []).filter((g) => g.is_universal || (g.active !== 0 && g.active_quest_count > 0));
}

function renderGames() {
  const games = selectableGames();
  const cap = appState.maxWeeklyQuestsPerGame || 4;
  const counts = appState.myWeeklyGameCounts || {};
  const act1 = phaseInfo().key === 'act1';
  const selectedCount = games.filter((g) => !g.is_universal && selectedGameIds.has(g.id)).length;
  const capped = games.filter((g) => selectedGameIds.has(g.id) && !g.is_universal && (counts[g.id] || 0) >= cap);
  const openSelected = selectedCount - capped.length;

  return `<div class="section-head">
      <div>
        <h2 class="section-title">Mes jeux</h2>
        <p class="small muted" style="margin-top: var(--space-1)">${selectedCount} coché${selectedCount > 1 ? 's' : ''} · minimum 4 · ${cap} défis max par jeu et par semaine</p>
      </div>
      <button type="button" class="hgw-btn hgw-btn--${gamesDirty || (appState.mySelectedGames || []).length < 4 ? 'primary' : 'secondary'} hgw-btn--sm" id="save-games" ${gamesDirty ? '' : 'disabled'}>Enregistrer mes jeux</button>
    </div>
    ${capped.length && openSelected < 4 ? `<div class="banner banner--info" style="margin-bottom: var(--space-4)">${icon('info')}<span><b>${capped.map((g) => esc(g.short_name)).join(', ')}</b> ${capped.length > 1 ? 'sont complets' : 'est complet'} cette semaine. Coche d’autres jeux pour garder de la variété dans tes défis.</span></div>` : ''}
    <div class="games-grid">${games
      .map((g) => {
        const used = counts[g.id] || 0;
        const full = !g.is_universal && used >= cap;
        if (g.is_universal) {
          return `<div class="game-tile is-universal">${monogram(g)}<span><span class="game-tile__name">${esc(g.short_name)}</span><span class="game-tile__meta">Inclus d’office · ${esc(plain(g.platforms))}</span></span><span class="quota">${used}/${cap}</span></div>`;
        }
        const on = selectedGameIds.has(g.id);
        return `<button type="button" class="game-tile ${full ? 'is-capped' : ''}" data-game="${esc(g.id)}" aria-pressed="${on}">
          ${monogram(g)}
          <span><span class="game-tile__name">${esc(g.name)}</span><span class="game-tile__meta">${full ? (act1 ? 'Complet jusqu’à lundi' : 'Complet cette semaine') : on ? `${used}/${cap} cette semaine` : esc(plain(g.platforms))}</span></span>
          <span class="game-tile__check" aria-hidden="true">${on ? icon('check') : ''}</span>
        </button>`;
      })
      .join('')}</div>`;
}

function bindGames(root) {
  root.querySelectorAll('[data-game]').forEach((tile) =>
    tile.addEventListener('click', () => {
      const id = tile.dataset.game;
      if (selectedGameIds.has(id)) selectedGameIds.delete(id);
      else selectedGameIds.add(id);
      gamesDirty = true;
      $('my-games').innerHTML = renderGames();
      bindGames($('my-games'));
      $('my-games').querySelector(`[data-game="${CSS.escape(id)}"]`)?.focus();
    })
  );
  root.querySelector('#save-games')?.addEventListener('click', async (e) => {
    const n = selectableGames().filter((g) => !g.is_universal && selectedGameIds.has(g.id)).length;
    if (n < 4) return toast({ title: `Coche encore ${4 - n} jeu${4 - n > 1 ? 'x' : ''}`, text: 'Il en faut au moins 4.', type: 'danger' });
    e.currentTarget.disabled = true;
    const { ok, data } = await api('/api/profile/games', { json: { gameIds: Array.from(selectedGameIds) } });
    if (!ok) {
      e.currentTarget.disabled = false;
      return toastError(data);
    }
    gamesDirty = false;
    toast({ title: 'Jeux enregistrés', text: 'Tes défis du jour sont prêts.', type: 'success' });
    fetchState();
  });
}

function emptyCard(title, text) {
  return `<div class="hgw-card hgw-card--flat"><div class="hgw-empty"><strong>${esc(title)}</strong>${esc(text)}</div></div>`;
}

// ============================================================================
// CLASSEMENT
// ============================================================================
function lbRow(p, rank, withSplit = true, extra = '') {
  const isMe = p.id === appState.user?.id;
  const sub = `${p.quests_validated || 0} défis · ${p.tmnf_medals_count || 0} médaille${(p.tmnf_medals_count || 0) > 1 ? 's' : ''}`;
  const left = appState.tombolaThreshold - p.total_points;
  return `<tr class="${isMe ? 'is-me' : ''} ${extra}" data-player="${esc(p.id)}">
    <td class="hgw-rank ${rank === 1 ? 'hgw-rank--1' : ''}">${rank}</td>
    <td><button type="button" class="linklike hgw-player" data-player-btn="${esc(p.id)}" aria-label="Voir l’historique de ${esc(p.display_name)}">
      ${avatar(p)}
      <span style="min-width:0"><span class="hgw-player__name">${esc(p.display_name)}${isMe ? ' <span class="hgw-badge" style="height:18px">toi</span>' : ''}</span><span class="hgw-player__sub" style="display:block">${sub}</span></span>
    </button></td>
    ${withSplit ? `<td class="split-cell"><div class="hgw-split" title="Quinzaine ${p.async_points} · week-end ${p.live_points}"><span class="a" style="flex:${p.async_points}"></span><span class="l" style="flex:${p.live_points}"></span></div></td>` : ''}
    <td class="r"><div class="hgw-pts">${fmt(p.total_points)}</div>${p.tombola_eligible ? `<div class="hgw-ticket">Tombola ✓</div>` : isMe ? `<div class="hgw-player__sub">${fmt(left)} pts avant tombola</div>` : ''}</td>
  </tr>`;
}

function withTieRanks(rows, key) {
  let prev = null;
  let rank = 0;
  return rows.map((r, i) => {
    if (prev === null || r[key] !== prev) rank = i + 1;
    prev = r[key];
    return { row: r, rank };
  });
}

function renderLeaderboard() {
  const all = appState.leaderboard || [];
  $('lb-n-all').textContent = all.length;
  $('lb-n-tombola').textContent = all.filter((p) => p.tombola_eligible).length;

  // Podium
  const prizes = ['Carte cadeau 10 €', 'Discord Nitro', 'Abonnement Twitch'];
  const card = (p, place) => {
    if (!p) return `<div class="podium__card is-empty is-${place}"><span class="podium__place">${place}${place === 1 ? 're' : 'e'} place</span><span class="muted">Place libre</span><span class="podium__prize">${prizes[place - 1]}</span></div>`;
    return `<button type="button" class="podium__card is-${place}" data-player-btn="${esc(p.id)}">
      <span class="podium__place">${place}${place === 1 ? 're' : 'e'} place</span>
      <span class="row" style="gap: var(--space-3)">${avatar(p, 'hgw-avatar--lg')}<span><span class="hgw-player__name" style="font-size:16px;display:block">${esc(p.display_name)}</span><span class="hgw-player__sub">${place > 1 && all[0] ? `${fmt(all[0].total_points - p.total_points)} pts derrière` : 'En tête'}</span></span></span>
      <span class="podium__pts">${fmt(p.total_points)} <small class="muted" style="font-size:14px">pts</small></span>
      <span class="podium__prize">${icon('gift')} ${prizes[place - 1]}</span>
    </button>`;
  };
  $('podium').innerHTML = card(all[1], 2) + card(all[0], 1) + card(all[2], 3);

  // Tableau
  let rows = [...all];
  const q = leaderboardSearch.trim().toLowerCase();
  if (q) rows = rows.filter((p) => [p.display_name, p.username, p.tmnf_login].some((v) => String(v || '').toLowerCase().includes(q)));
  let key = 'total_points';
  if (leaderboardFilter === 'tombola') rows = rows.filter((p) => p.tombola_eligible);
  if (leaderboardFilter === 'async') key = 'async_points';
  if (leaderboardFilter === 'live') key = 'live_points';
  rows.sort((a, b) => b[key] - a[key] || b.total_points - a.total_points);
  const ranked = withTieRanks(rows, key);

  const tbody = $('lb-tbody');
  if (!ranked.length) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="hgw-empty"><strong>Aucun joueur trouvé</strong>Essaie un autre nom ou un autre filtre.</div></td></tr>`;
  } else {
    const truncated = !leaderboardExpanded && ranked.length > LB_LIMIT;
    const shown = truncated ? ranked.slice(0, LB_LIMIT) : ranked;
    let html = shown.map(({ row, rank }) => lbRow(row, rank)).join('');
    const myIdx = ranked.findIndex((r) => r.row.id === appState.user?.id);
    if (truncated && myIdx >= LB_LIMIT) html += lbRow(ranked[myIdx].row, ranked[myIdx].rank, true, 'is-pinned');
    if (truncated) html += `<tr><td colspan="4" style="text-align:center"><button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--sm" id="lb-more">Afficher les ${ranked.length - LB_LIMIT} autres joueurs</button></td></tr>`;
    tbody.innerHTML = html;
    $('lb-more')?.addEventListener('click', () => {
      leaderboardExpanded = true;
      renderLeaderboard();
    });
  }

  // Activité
  const feed = appState.recentFeed || [];
  $('feed').innerHTML = feed.length
    ? feed
        .map(
          (it) => `<div class="feed__item"><div><div class="feed__who">${esc(it.display_name)}</div><div class="feed__what">${esc(plain(it.label))} · ${esc(timeAgo(it.updated_at))}</div></div><span class="hgw-badge hgw-badge--points">${signed(it.points)}</span></div>`
        )
        .join('')
    : `<div class="hgw-empty"><strong>Rien pour l’instant</strong>Les premiers points apparaîtront ici en direct.</div>`;
}

// ============================================================================
// TRACKMANIA
// ============================================================================
function renderTrackmania() {
  const s = appState.eventSettings || {};
  const unlocked = Boolean(s.tmnf_weekly_unlocked);
  const locked = Boolean(s.tmnf_weekly_locked);
  const server = appState.tmnfServer || {};
  const weekly = appState.weeklyTmnfLeaderboard || [];

  let state;
  if (unlocked) state = `<span class="hgw-badge hgw-badge--success"><span class="hgw-badge__dot"></span>Ouvert</span>`;
  else if (locked) state = `<span class="hgw-badge">Terminé</span>`;
  else state = `<span class="hgw-badge">${icon('lock')}Acte II</span>`;

  $('tm-server-card').innerHTML = `
    <div class="hgw-card__head">
      <div>
        <h2 class="hgw-card__title">Map du serveur</h2>
        <p class="hgw-card__desc">Top 10 : 150 · 110 · 80 · 50 · 30 pts${s.tmnf_cutoff_at ? ` · jusqu’au ${esc(fmtDate(s.tmnf_cutoff_at))}` : ''}</p>
      </div>
      ${state}
    </div>
    ${
      unlocked
        ? `<div class="addr"><div><div class="hgw-stat__label">Adresse</div><div class="addr__v" id="tm-addr">${esc(server.playitAddress || '')}</div></div>
            <div class="row"><button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--sm" id="copy-addr">${icon('copy')}Copier</button>
            <a class="hgw-btn hgw-btn--primary hgw-btn--sm" href="${esc(server.joinUrl || '#')}">${icon('play')}Rejoindre</a></div></div>`
        : locked
        ? `<div class="banner">${icon('flag')}<span>Le chrono serveur est terminé : le top 10 est figé.</span></div>`
        : `<div class="banner">${icon('lock')}<span>Ouvre au début de l’acte II, le ${esc(fmtDate(s.week2_start_at))}. D’ici là, chasse les médailles sur les 8 pistes solo.</span></div>`
    }
    <div class="table-wrap" style="margin-top: var(--space-4)">
      <table class="hgw-table">
        <thead><tr><th>#</th><th>Pilote</th><th class="r">Chrono</th><th class="r">Points</th></tr></thead>
        <tbody>${
          weekly.length
            ? weekly
                .slice(0, 10)
                .map(
                  (r) => `<tr class="${r.user_id === appState.user?.id ? 'is-me' : ''}"><td class="hgw-rank ${r.rank === 1 ? 'hgw-rank--1' : ''}">${r.rank}</td><td class="hgw-player__name">${esc(r.display_name)}</td><td class="r hgw-num">${esc(r.formatted_time)}</td><td class="r"><span class="hgw-badge hgw-badge--points">+${r.projected_points}</span></td></tr>`
                )
                .join('')
            : `<tr><td colspan="4"><div class="hgw-empty" style="padding: var(--space-5)">${unlocked ? '<strong>Aucun chrono</strong>Pose le premier temps.' : '<strong>Pas encore de classement</strong>Il démarre à l’ouverture du serveur.'}</div></td></tr>`
        }</tbody>
      </table>
    </div>`;
  $('copy-addr')?.addEventListener('click', () => copyText(server.playitAddress, 'Adresse copiée'));

  const loginInput = $('tmnf-login-input');
  if (appState.user?.tmnf_login && document.activeElement !== loginInput) loginInput.value = appState.user.tmnf_login;

  // Pistes
  const subs = new Map((appState.myTmnfSubmissions || []).map((x) => [x.map_id, x]));
  const maps = (appState.tmnfMaps || []).filter((m) => !m.is_weekly);
  const total = maps.reduce((acc, m) => acc + (subs.get(m.id)?.best_points || 0), 0);
  $('tm-total-badge').textContent = `${total} / ${maps.length * 30} pts`;

  $('track-grid').innerHTML = maps
    .map((m) => {
      const sub = subs.get(m.id);
      const my = sub ? sub.best_time_ms : null;
      const steps = [
        { key: 'author', cls: 'm-author', ms: m.author_ms, t: m.author_formatted },
        { key: 'gold', cls: 'm-gold', ms: m.gold_ms, t: m.gold_formatted },
        { key: 'silver', cls: 'm-silver', ms: m.silver_ms, t: m.silver_formatted },
        { key: 'bronze', cls: 'm-bronze', ms: m.bronze_ms, t: m.bronze_formatted },
      ];
      const nextKey = (my === null ? steps[3] : [...steps].reverse().find((s) => my > s.ms))?.key;
      const pts = sub?.best_points || 0;
      let pb = `<span>Pas encore de replay</span>`;
      let delta = m.wr_formatted ? `<span class="small muted">Record ${esc(m.wr_holder)} <b class="hgw-num" style="color:var(--ink-1)">${esc(m.wr_formatted)}</b></span>` : '';
      if (my !== null) {
        pb = `<span>Ton record <b class="hgw-num" style="color:var(--ink-1)">${esc(sub.best_time_formatted)}</b></span>`;
        const next = steps.find((s) => s.key === nextKey);
        delta = next ? `<span class="hgw-delta">${MEDAL_LABEL[next.key]} à ${deltaSec(next.ms - my)}</span>` : `<span class="hgw-delta t-success">Auteur obtenue</span>`;
      }
      return `<article class="hgw-track">
        <div class="hgw-track__head"><div><span class="hgw-track__code">${esc(m.code)}</span><h3 class="hgw-track__name">${esc(trackName(m))}</h3></div>
          <span class="hgw-badge ${pts ? 'hgw-badge--points' : ''}">${pts} / 30</span></div>
        <div class="hgw-medals">${steps
          .map((s) => `<div class="hgw-medal ${my !== null && my <= s.ms ? 'got' : ''} ${s.key === nextKey ? 'next' : ''}"><div class="hgw-medal__k"><i class="${s.cls}"></i>${MEDAL_LABEL[s.key]}</div><div class="hgw-medal__t">${esc(s.t)}</div></div>`)
          .join('')}</div>
        <div class="hgw-track__pb">${pb}${delta}</div>
        <div class="row">
          <button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--sm" data-track="${esc(m.id)}">Classement de la piste</button>
          ${appState.devMode && appState.user ? `<a class="hgw-btn hgw-btn--ghost hgw-btn--sm" href="/api/tmnf/sample-replay/${encodeURIComponent(m.id)}">Replay de test</a>` : ''}
        </div>
      </article>`;
    })
    .join('');
  $('track-grid').querySelectorAll('[data-track]').forEach((b) => b.addEventListener('click', () => openTrack(b.dataset.track)));
}

async function uploadReplays(files) {
  if (!appState?.user) return openLogin();
  const list = Array.from(files || []).filter((f) => /\.gbx$/i.test(f.name));
  if (!list.length) return toast({ title: 'Aucun fichier .Replay.gbx', text: 'Glisse des fichiers qui finissent par .Replay.gbx.', type: 'danger' });
  const box = $('gbx-results');
  box.innerHTML = list
    .map((f) => `<div class="hgw-file"><span class="hgw-file__name">${esc(f.name)}</span><span class="hgw-badge hgw-badge--info"><span class="hgw-spinner" style="width:10px;height:10px"></span>Analyse</span></div>`)
    .join('');
  const fd = new FormData();
  list.forEach((f) => fd.append('replays', f));
  const { ok, data } = await api('/api/tmnf/submit-replays-batch', { method: 'POST', body: fd });
  if (!ok) {
    box.innerHTML = `<div class="banner banner--danger">${icon('alert')}<span>${esc(plain(data.error) || 'Envoi impossible.')}</span></div>`;
    return;
  }
  box.innerHTML = (data.results || [])
    .map((r) =>
      r.ok
        ? `<div class="hgw-file"><span class="hgw-file__name">${esc(r.mapCode)} · ${esc(r.formattedTime)}</span><span class="hgw-badge ${r.deltaPoints > 0 ? 'hgw-badge--success' : ''}">${MEDAL_LABEL[r.medal] || esc(r.medal)}${r.deltaPoints > 0 ? ` · +${r.deltaPoints}` : ' · pas mieux'}</span></div>`
        : `<div class="hgw-file"><span class="hgw-file__name">${esc(r.fileName)}</span><span class="hgw-badge hgw-badge--danger" title="${esc(plain(r.error))}">${esc(plain(r.error)).slice(0, 48)}</span></div>`
    )
    .join('');
  const refused = (data.results || []).filter((r) => !r.ok).length;
  toast({
    title: data.totalDeltaPoints > 0 ? `+${data.totalDeltaPoints} pts · ${data.validCount} replay${data.validCount > 1 ? 's' : ''} validé${data.validCount > 1 ? 's' : ''}` : `${data.validCount} replay${data.validCount > 1 ? 's' : ''} analysé${data.validCount > 1 ? 's' : ''}`,
    text: refused ? `${refused} refusé${refused > 1 ? 's' : ''} : voir le détail sous la zone de dépôt.` : '',
    type: refused ? 'danger' : data.totalDeltaPoints > 0 ? 'points' : 'success',
  });
  $('gbx-input').value = '';
  fetchState();
}

async function openTrack(mapId) {
  const { ok, data } = await api(`/api/tmnf/map/${encodeURIComponent(mapId)}/leaderboard`);
  if (!ok) return toastError(data);
  const m = data.map;
  const entries = data.entries || [];
  $('track-title').textContent = `${m.code} · ${trackName(m)}`;
  $('track-sub').textContent = `Auteur ${m.author_formatted} · Or ${m.gold_formatted} · Argent ${m.silver_formatted} · Bronze ${m.bronze_formatted}`;
  $('track-wr').innerHTML = entries.length
    ? `<div class="banner banner--gold">${icon('trophy')}<span style="flex:1">Record : <b>${esc(entries[0].display_name)}</b> en <b class="hgw-num">${esc(entries[0].formatted_time)}</b></span>
        <a class="hgw-btn hgw-btn--secondary hgw-btn--sm" href="/api/tmnf/map/${encodeURIComponent(m.id)}/ghost/${encodeURIComponent(entries[0].user_id)}">${icon('download')}Ghost du record</a></div>`
    : '';
  $('track-tbody').innerHTML = entries.length
    ? entries
        .map(
          (e) => `<tr class="${e.user_id === appState.user?.id ? 'is-me' : ''}"><td class="hgw-rank ${e.rank === 1 ? 'hgw-rank--1' : ''}">${e.rank}</td><td class="hgw-player__name">${esc(e.display_name)}</td>
          <td class="r hgw-num">${esc(e.formatted_time)}</td><td class="r hgw-delta">${e.delta_wr_ms === 0 ? 'record' : deltaSec(e.delta_wr_ms)}</td>
          <td><span class="hgw-badge">${MEDAL_LABEL[e.medal] || esc(e.medal)}</span></td>
          <td class="r"><a class="hgw-btn hgw-btn--ghost hgw-btn--sm" href="/api/tmnf/map/${encodeURIComponent(m.id)}/ghost/${encodeURIComponent(e.user_id)}" aria-label="Télécharger le ghost de ${esc(e.display_name)}">${icon('download')}Ghost</a></td></tr>`
        )
        .join('')
    : `<tr><td colspan="6"><div class="hgw-empty"><strong>Aucun chrono</strong>Sois le premier à poser un temps sur cette piste.</div></td></tr>`;
  $('track-dialog').showModal();
}

// ============================================================================
// TOURNOIS
// ============================================================================
function teamsOf(t) {
  const map = new Map();
  for (const r of t.registrations) {
    if (!r.team_number) continue;
    if (!map.has(r.team_number)) map.set(r.team_number, { num: r.team_number, name: plain(r.team_name) || `Équipe ${r.team_number}`, members: [] });
    map.get(r.team_number).members.push(r);
  }
  return [...map.values()];
}

function renderTournaments() {
  const myId = appState.user?.id;
  $('tournaments-grid').innerHTML = (appState.tournaments || [])
    .map((t) => {
      const mine = t.registrations.some((r) => r.user_id === myId);
      const teams = teamsOf(t);
      return `<article class="hgw-card">
        <div class="hgw-card__head">
          <div class="row" style="gap: var(--space-3); flex-wrap: nowrap">${monogram({ name: tName(t) })}
            <div><h2 class="hgw-card__title">${esc(tName(t))}</h2><p class="hgw-card__desc">${esc(plain(t.scheduled_label))}</p></div></div>
          <span class="hgw-badge hgw-badge--points">1er · ${t.points_scale['1']}</span>
        </div>
        <p class="muted">${esc(plain(t.mode_label))}</p>
        <div class="row-between" style="margin-top: var(--space-4)">
          <span class="small muted">${t.registrations.length} inscrit${t.registrations.length > 1 ? 's' : ''}</span>
          <button type="button" class="hgw-btn ${mine ? 'hgw-btn--secondary' : 'hgw-btn--primary'} hgw-btn--sm" data-toggle-t="${esc(t.id)}">${mine ? `${icon('check')}Inscrit · se désinscrire` : 'M’inscrire'}</button>
        </div>
        ${t.registrations.length ? `<div class="row" style="margin-top: var(--space-3)">${t.registrations.map((r) => `<span class="hgw-badge" title="Chapeau ${r.pool}">${esc(r.display_name)}${t.id === 'rl_rumble' ? ` · C${r.pool}` : ''}</span>`).join('')}</div>` : ''}
        ${
          teams.length
            ? `<div style="margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--line-subtle)">
                <div class="hgw-stat__label" style="margin-bottom: var(--space-2)">Équipes</div>
                <div class="grid-auto" style="grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: var(--space-2)">${teams
                  .map((tm) => `<div class="hgw-stat"><div class="body-strong" style="font-weight:600">${esc(tm.name)}</div>${tm.members.map((mm) => `<div class="row-between small"><span>${esc(mm.display_name)}</span><span class="faint hgw-num">C${mm.pool}</span></div>`).join('')}</div>`)
                  .join('')}</div></div>`
            : ''
        }
      </article>`;
    })
    .join('');
  $('tournaments-grid').querySelectorAll('[data-toggle-t]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!appState.user) return openLogin();
      b.disabled = true;
      const { ok, data } = await api(`/api/tournaments/${b.dataset.toggleT}/toggle`, { method: 'POST' });
      if (!ok) {
        b.disabled = false;
        return toastError(data);
      }
      toast({ title: data.registered ? 'Inscription confirmée' : 'Inscription retirée', type: 'success' });
      fetchState();
    })
  );
}

// ============================================================================
// DIALOGUES JOUEUR
// ============================================================================
let pastedProofFile = null;

function openProof(id) {
  const q = (appState.myDailyQuests || []).find((x) => x.id === id);
  if (!q) return;
  pastedProofFile = null;
  $('proof-form').reset();
  $('proof-assignment-id').value = id;
  $('proof-title').textContent = q.status === 'rejected' ? 'Renvoyer une preuve' : 'Envoyer ma preuve';
  $('proof-context').textContent = `${plain(q.title)} · ${q.game_name} · +${q.points} pts`;
  $('proof-hint').innerHTML = `${icon('info')}<span>${esc(plain(q.proof_hint) || 'Capture de l’écran de fin de partie ou clip court.')}</span>`;
  $('proof-preview').hidden = true;
  $('proof-drop-title').textContent = 'Colle une capture (Ctrl+V) ou glisse un fichier';
  $('proof-drop').classList.remove('is-over');
  $('proof-error').textContent = '';
  $('proof-dialog').showModal();
}

function setProofFile(file) {
  pastedProofFile = file;
  $('proof-drop-title').textContent = `${file.name} · ${Math.round(file.size / 1024)} Ko`;
  $('proof-drop').classList.add('is-over');
  $('proof-error').textContent = '';
  if (file.type.startsWith('image/')) {
    const r = new FileReader();
    r.onload = (ev) => {
      $('proof-preview').src = ev.target.result;
      $('proof-preview').hidden = false;
    };
    r.readAsDataURL(file);
  } else {
    $('proof-preview').hidden = true;
  }
}

async function openLedger(userId) {
  const { ok, data } = await api(`/api/player/${encodeURIComponent(userId)}/ledger`);
  if (!ok) return toastError(data);
  const isMe = userId === appState.user?.id;
  const total = (data.entries || []).reduce((s, e) => s + e.points, 0);
  $('ledger-title').textContent = isMe ? 'Mon historique de points' : data.player.display_name;
  $('ledger-sub').textContent = `${fmt(total)} pts au total`;
  $('ledger-games').innerHTML = (data.selectedGames || []).map((g) => `<span class="hgw-badge">${esc(g.short_name)}</span>`).join('');
  $('ledger-entries').innerHTML = (data.entries || []).length
    ? data.entries
        .map(
          (e) => `<div class="feed__item"><div><div class="feed__who" style="font-weight:500">${esc(plain(e.label))}</div><div class="feed__what">${e.category === 'live' ? 'Week-end live' : 'Quinzaine'} · ${esc(timeAgo(e.updated_at))}</div></div><span class="hgw-badge hgw-badge--points">${signed(e.points)}</span></div>`
        )
        .join('')
    : `<div class="hgw-empty"><strong>Aucun point pour l’instant</strong>${isMe ? 'Relève un défi pour marquer tes premiers points.' : ''}</div>`;
  $('ledger-dialog').showModal();
}

// ============================================================================
// ADMIN
// ============================================================================
function renderAdmin() {
  if (appState.user?.is_admin !== 1) return;
  const pending = visibleProofs().length;
  const panes = [
    ['/admin', 'moderation', 'shield', 'Modération', pending],
    ['/admin/evenement', 'evenement', 'calendar', 'Événement', 0],
    ['/admin/catalogue', 'catalogue', 'list', 'Jeux et défis', 0],
    ['/admin/tournois', 'tournois', 'swords', 'Tournois', 0],
    ['/admin/points', 'points', 'gift', 'Points et tombola', 0],
  ];
  $('admin-nav').innerHTML =
    panes.map(([href, id, ic, label, n]) => `<a href="${href}" data-link ${route.pane === id ? 'aria-current="page"' : ''}>${icon(ic)}${label}${n ? `<span class="hgw-tab__count">${n}</span>` : ''}</a>`).join('') +
    `<div class="admin-nav__sep"></div><a href="/admin/maintenance" data-link ${route.pane === 'maintenance' ? 'aria-current="page"' : ''}>${icon('wrench')}Maintenance</a>`;
  const p = phaseInfo();
  $('admin-desc').textContent = `${p.label}${p.day ? ` · jour ${p.day}` : ''}${p.manual ? ' · phase forcée manuellement' : ''}`;

  renderKpis();
  renderReview();
  renderSettings();
  renderAdminTournaments();
  renderManualPoints();
  $('tombola-desc').textContent = `${(appState.leaderboard || []).filter((x) => x.tombola_eligible).length} joueurs qualifiés (300 pts et plus).`;
  $('dev-tools').hidden = !appState.devMode;
  if (route.pane === 'catalogue') renderCatalog();
}

function renderKpis() {
  const s = appState.admin?.stats;
  if (!s) return;
  const pending = visibleProofs().length;
  $('admin-kpis').innerHTML = `
    <button type="button" class="hgw-stat ${pending ? 'kpi--action' : ''}" id="kpi-pending" style="${pending ? '' : 'border:0;text-align:left;color:inherit;font:inherit'}">
      <div class="hgw-stat__label">Preuves à vérifier</div><div class="hgw-stat__value">${pending}</div><div class="hgw-stat__meta">${pending ? 'Commencer la modération' : 'Tout est à jour'}</div>
    </button>
    <div class="hgw-stat"><div class="hgw-stat__label">Joueurs</div><div class="hgw-stat__value">${fmt(s.totalUsers)}</div><div class="hgw-stat__meta">${fmt(s.tombolaQualifiedCount)} qualifiés tombola</div></div>
    <div class="hgw-stat"><div class="hgw-stat__label">Défis validés</div><div class="hgw-stat__value">${fmt(s.totalValidatedQuests)}</div></div>
    <div class="hgw-stat"><div class="hgw-stat__label">Points distribués</div><div class="hgw-stat__value">${fmt(s.totalPoints)}</div><div class="hgw-stat__meta">${fmt(s.totalReplays)} replays Trackmania</div></div>`;
  $('kpi-pending').addEventListener('click', () => $('review-zone').querySelector('[data-decide="approve"]')?.focus());
}

function visibleProofs() {
  return (appState.admin?.pendingProofs || []).filter((p) => !decidedProofs.has(p.id));
}

function renderReview() {
  const list = visibleProofs();
  const zone = $('review-zone');
  if (!list.length) {
    zone.innerHTML = emptyCard('Aucune preuve en attente', 'Tout est à jour. Les nouvelles preuves arrivent aussi dans #preuves sur Discord.');
    return;
  }
  if (reviewIndex >= list.length) reviewIndex = 0;
  const p = list[reviewIndex];
  const isImg = p.proof_file && /\.(png|jpe?g|webp|gif)$/i.test(p.proof_file);
  const fileUrl = p.proof_file ? `/uploads/proofs/${encodeURIComponent(p.proof_file)}` : '';
  const media = isImg
    ? `<button type="button" class="hgw-review__media review-media" id="review-zoom" aria-label="Agrandir la capture"><img src="${fileUrl}" alt="Preuve de ${esc(p.display_name)}" /></button>`
    : `<div class="hgw-review__media">${p.proof_file ? `<a href="${fileUrl}" target="_blank" rel="noopener">${icon('play')} Ouvrir le fichier</a>` : p.proof_url ? `<a href="${esc(p.proof_url)}" target="_blank" rel="noopener noreferrer">${icon('external')} Ouvrir le lien</a>` : 'Aucun fichier'}</div>`;
  zone.innerHTML = `
    <div class="hgw-review">
      ${media}
      <div>
        <div class="hgw-review__meta">${avatar(p)}<b style="color:var(--ink-1)">${esc(p.display_name)}</b><span>· ${esc(p.game_name)} · ${esc(timeAgo(p.submitted_at))}</span>
          <span class="hgw-badge hgw-badge--points">+${p.points}</span>${diffPips(p.difficulty)}
          <span class="hgw-review__queue" style="margin-left:auto">${reviewIndex + 1} / ${list.length}</span></div>
        <h3 class="hgw-review__title">${esc(plain(p.title))}</h3>
        <p class="muted"><b style="color:var(--ink-1)">Consigne :</b> ${esc(plain(p.description))}</p>
        ${p.proof_url && p.proof_file ? `<p class="small" style="margin-top: var(--space-2)"><a href="${esc(p.proof_url)}" target="_blank" rel="noopener noreferrer">Lien joint</a></p>` : ''}
        ${p.proof_note ? `<p class="small muted" style="margin-top: var(--space-2)">Note du joueur : « ${esc(p.proof_note)} »</p>` : ''}
        <div class="hgw-review__actions">
          <button type="button" class="hgw-btn hgw-btn--primary hgw-btn--sm" data-decide="approve">Valider <span class="hgw-btn__kbd">V</span></button>
          <button type="button" class="hgw-btn hgw-btn--danger hgw-btn--sm" data-decide="reject">Refuser… <span class="hgw-btn__kbd">R</span></button>
          <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--sm" data-decide="skip" ${list.length < 2 ? 'disabled' : ''}>Passer <span class="hgw-btn__kbd">→</span></button>
        </div>
        <p class="review-keys">Chaque décision peut être annulée pendant 5 secondes.</p>
      </div>
    </div>`;
  $('review-zoom')?.addEventListener('click', () => openLightbox(fileUrl, `${p.display_name} · ${plain(p.title)}`));
  zone.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.decide)));
}

function decide(kind) {
  const list = visibleProofs();
  const p = list[reviewIndex];
  if (!p) return;
  if (kind === 'skip') {
    reviewIndex = (reviewIndex + 1) % list.length;
    return renderReview();
  }
  if (kind === 'reject') return openReject(p);
  queueDecision(p, { action: 'approve' });
}

function queueDecision(p, body) {
  decidedProofs.add(p.id);
  const send = async () => {
    pendingDecisions.delete(p.id);
    const { ok, data } = await api(`/api/admin/proofs/${p.id}/review`, { json: body });
    if (!ok) {
      decidedProofs.delete(p.id);
      toastError(data, 'La décision n’a pas pu être enregistrée.');
    }
    scheduleFetch();
  };
  const timer = setTimeout(send, 5000);
  pendingDecisions.set(p.id, { timer, send, p, body });
  renderAdmin();
  renderUser();
  toast({
    title: body.action === 'approve' ? `Validé · +${p.points} pts pour ${p.display_name}` : `Refusé · ${p.display_name}`,
    type: body.action === 'approve' ? 'success' : 'info',
    duration: 5000,
    action: {
      label: 'Annuler',
      fn: () => {
        const pd = pendingDecisions.get(p.id);
        if (pd) clearTimeout(pd.timer);
        pendingDecisions.delete(p.id);
        decidedProofs.delete(p.id);
        renderAdmin();
        renderUser();
      },
    },
  });
}

function flushDecisions() {
  for (const [id, pd] of pendingDecisions) {
    clearTimeout(pd.timer);
    fetch(`/api/admin/proofs/${id}/review`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pd.body) });
  }
  pendingDecisions.clear();
}
window.addEventListener('pagehide', flushDecisions);

let rejectTarget = null;
function openReject(p) {
  rejectTarget = p;
  $('reject-form').reset();
  $('reject-title').textContent = `Refuser la preuve de ${p.display_name}`;
  $('reject-reasons').innerHTML = REJECT_REASONS.map((r, i) => `<button type="button" class="reason" data-reason="${i}" aria-pressed="false"><kbd>${i + 1}</kbd>${esc(r)}</button>`).join('');
  $('reject-reasons').querySelectorAll('[data-reason]').forEach((b) => b.addEventListener('click', () => pickReason(Number(b.dataset.reason))));
  $('reject-dialog').showModal();
  $('reject-reasons').querySelector('[data-reason]')?.focus();
}
function pickReason(i) {
  if (!REJECT_REASONS[i]) return;
  $('reject-text').value = REJECT_REASONS[i];
  $('reject-reasons').querySelectorAll('[data-reason]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.reason) === i)));
}

function openLightbox(src, caption) {
  $('lightbox-img').src = src;
  $('lightbox-img').alt = caption;
  $('lightbox-cap').textContent = caption;
  $('lightbox').showModal();
}

function toLocalInput(v) {
  return v ? String(v).slice(0, 16) : '';
}

function renderSettings() {
  const cfg = appState.eventSettings;
  if (!cfg) return;
  const p = phaseInfo();
  $('settings-phase').textContent = `${p.label}${p.manual ? ' · forcée' : ''}`;
  $('settings-phase').className = `hgw-badge ${p.manual ? 'hgw-badge--danger' : ''}`;
  if (settingsDirty) return;
  $('cfg-start-at').value = toLocalInput(cfg.start_at);
  $('cfg-week2-start-at').value = toLocalInput(cfg.week2_start_at);
  $('cfg-tmnf-cutoff-at').value = toLocalInput(cfg.tmnf_cutoff_at);
  $('cfg-end-at').value = toLocalInput(cfg.end_at);
  $('cfg-playit-addr').value = cfg.tmnf_playit_address || '';
  const weekly = (appState.tmnfMaps || []).find((m) => m.is_weekly);
  $('cfg-weekly-uid').value = weekly?.uid || '';
  const manual = cfg.status_mode && cfg.status_mode !== 'auto';
  $('cfg-manual').checked = manual;
  $('cfg-manual-field').hidden = !manual;
  $('cfg-status-mode').value = cfg.status_mode === 'live' ? 'week2' : manual ? cfg.status_mode : 'week1';
}

function validateSettings() {
  const v = (id) => Date.parse($(id).value);
  const [a, b, c, d] = ['cfg-start-at', 'cfg-week2-start-at', 'cfg-tmnf-cutoff-at', 'cfg-end-at'].map(v);
  document.querySelectorAll('#settings-form .hgw-field').forEach((f) => f.classList.remove('hgw-field--error'));
  const fail = (id, msg) => {
    $(id).closest('.hgw-field').classList.add('hgw-field--error');
    $('settings-error').textContent = msg;
    $(id).focus();
    return false;
  };
  if (![a, b, c, d].every(Number.isFinite)) return fail('cfg-start-at', 'Renseigne les quatre dates.');
  if (b <= a) return fail('cfg-week2-start-at', 'L’acte II doit commencer après l’acte I.');
  if (c <= b) return fail('cfg-tmnf-cutoff-at', 'La fin du chrono serveur doit être après le début de l’acte II.');
  if (d < c) return fail('cfg-end-at', 'La fin de l’événement doit être après la fin du chrono serveur.');
  $('settings-error').textContent = '';
  return true;
}

function renderAdminTournaments() {
  const ts = appState.tournaments || [];
  if (!ts.find((t) => t.id === adminTourneyId) && ts[0]) adminTourneyId = ts[0].id;
  $('admin-tourney-seg').innerHTML = ts.map((t) => `<button type="button" data-t="${esc(t.id)}" aria-pressed="${t.id === adminTourneyId}">${esc(tName(t))} <span class="hgw-seg__n">${t.registrations.length}</span></button>`).join('');
  $('admin-tourney-seg').querySelectorAll('[data-t]').forEach((b) =>
    b.addEventListener('click', () => {
      adminTourneyId = b.dataset.t;
      renderAdminTournaments();
    })
  );
  const t = ts.find((x) => x.id === adminTourneyId);
  const tbody = $('admin-pools-tbody');
  if (!t || !t.registrations.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="hgw-empty"><strong>Aucun inscrit</strong>Les joueurs s’inscrivent depuis l’onglet Tournois.</div></td></tr>`;
  } else {
    tbody.innerHTML = t.registrations
      .map(
        (r) => `<tr>
        <td class="hgw-player__name">${esc(r.display_name)}</td>
        <td><label class="hgw-sr" for="pool-${esc(r.user_id)}">Chapeau de ${esc(r.display_name)}</label>
          <select id="pool-${esc(r.user_id)}" class="hgw-input compact" data-pool="${esc(r.user_id)}">${[1, 2, 3].map((n) => `<option value="${n}" ${r.pool === n ? 'selected' : ''}>Chapeau ${n}</option>`).join('')}</select></td>
        <td><input type="checkbox" class="check" data-checkin="${esc(r.user_id)}" ${r.checked_in ? 'checked' : ''} aria-label="${esc(r.display_name)} présent" /></td>
        <td class="small">${r.team_name ? esc(plain(r.team_name)) : '<span class="faint">—</span>'}</td>
        <td><label class="hgw-sr" for="place-${esc(r.user_id)}">Place de ${esc(r.display_name)}</label>
          <select id="place-${esc(r.user_id)}" class="hgw-input compact" data-place="${esc(r.user_id)}">${PLACEMENTS.map(([v, l]) => `<option value="${v}" ${String(r.placement ?? '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      </tr>`
      )
      .join('');
    tbody.querySelectorAll('[data-pool]').forEach((s) =>
      s.addEventListener('change', async () => {
        const { ok, data } = await api(`/api/admin/tournaments/${adminTourneyId}/player`, { json: { userId: s.dataset.pool, pool: Number(s.value) } });
        if (!ok) toastError(data);
        scheduleFetch();
      })
    );
    tbody.querySelectorAll('[data-checkin]').forEach((c) =>
      c.addEventListener('change', async () => {
        const { ok, data } = await api(`/api/admin/tournaments/${adminTourneyId}/player`, { json: { userId: c.dataset.checkin, checkedIn: c.checked } });
        if (!ok) toastError(data);
        scheduleFetch();
      })
    );
  }

  const fg = ts.find((x) => x.id === 'fall_guys');
  const opts = [
    [0, '0'],
    [1, '1 · éliminé'],
    [3, '3 · qualifié'],
    [6, '6 · finale'],
    [10, '10 · couronne'],
  ];
  $('admin-fg-tbody').innerHTML =
    fg && fg.registrations.length
      ? fg.registrations
          .map((r) => {
            const shows = r.fg_shows || [0, 0, 0, 0, 0];
            return `<tr data-fg="${esc(r.user_id)}"><td class="hgw-player__name">${esc(r.display_name)}</td>${[0, 1, 2, 3, 4]
              .map((i) => `<td><select class="hgw-input compact" data-show="${i}" aria-label="Partie ${i + 1} de ${esc(r.display_name)}">${opts.map(([v, l]) => `<option value="${v}" ${shows[i] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>`)
              .join('')}<td class="r hgw-num">${r.fg_total_score || 0}</td><td class="r"><span class="hgw-badge hgw-badge--points">+${r.points_awarded || 0}</span></td></tr>`;
          })
          .join('')
      : `<tr><td colspan="8"><div class="hgw-empty"><strong>Aucun inscrit à Fall Guys</strong></div></td></tr>`;
}

// ============================================================================
// ADMIN : CATALOGUE JEUX & DÉFIS
// ============================================================================
const DIFF_LABEL = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile' };
const DIFFS = ['easy', 'medium', 'hard'];

async function loadCatalog() {
  if (catalogLoading) return;
  catalogLoading = true;
  const { ok, data } = await api('/api/admin/catalog');
  catalogLoading = false;
  if (!ok) return toastError(data, 'Impossible de charger le catalogue.');
  adminCatalog = data;
  catalogStale = false;
  if (!adminCatalog.games.find((g) => g.id === catGameId)) catGameId = adminCatalog.games[0]?.id || null;
  if (route.pane === 'catalogue') renderCatalog();
}

function catGame(id = catGameId) {
  return adminCatalog?.games.find((g) => g.id === id) || null;
}

function catQuests(gameId = catGameId) {
  return (adminCatalog?.quests || []).filter((q) => q.game_id === gameId);
}

// Nombre de défis actifs tirables par difficulté, en acte I puis en acte II (cumulé).
function coverage(gameId) {
  const qs = catQuests(gameId).filter((q) => q.active);
  const count = (week, d) => qs.filter((q) => q.difficulty === d && q.unlock_week <= week).length;
  return { 1: DIFFS.map((d) => count(1, d)), 2: DIFFS.map((d) => count(2, d)) };
}

function hasCoverageHole(g) {
  if (!g.active) return false;
  return coverage(g.id)[1].some((n) => n === 0);
}

function renderCatalog() {
  if (catalogStale) loadCatalog();
  if (!adminCatalog) {
    $('cat-games').innerHTML = `<p class="small muted" style="padding: var(--space-2)">Chargement…</p>`;
    $('cat-detail').innerHTML = '';
    return;
  }
  const games = adminCatalog.games;
  const activeCount = games.filter((g) => g.active).length;
  $('cat-games-desc').textContent = `${activeCount} actif${activeCount > 1 ? 's' : ''} · ${adminCatalog.quests.filter((q) => q.active).length} défis tirables`;
  $('cat-games').innerHTML = games
    .map(
      (g) => `<button type="button" role="option" class="cat-game ${g.active ? '' : 'is-off'}" data-cat-game="${esc(g.id)}" aria-selected="${g.id === catGameId}">
        ${monogram(g)}
        <span style="min-width: 0">
          <span class="cat-game__name">${esc(g.short_name)}</span>
          <span class="cat-game__meta">${g.active_quest_count} défi${g.active_quest_count > 1 ? 's' : ''} · ${g.is_universal ? 'tous' : `${g.player_count} joueur${g.player_count > 1 ? 's' : ''}`}${g.active ? '' : ' · inactif'}</span>
        </span>
        ${hasCoverageHole(g) ? `<span class="cat-game__warn" title="Il manque une difficulté en acte I">${icon('alert')}</span>` : ''}
      </button>`
    )
    .join('');
  $('cat-games').querySelectorAll('[data-cat-game]').forEach((b) =>
    b.addEventListener('click', () => {
      catGameId = b.dataset.catGame;
      catSearch = '';
      renderCatalog();
    })
  );
  renderCatalogDetail();
}

function renderCatalogDetail() {
  const g = catGame();
  const box = $('cat-detail');
  if (!g) {
    box.innerHTML = emptyCard('Aucun jeu', 'Ajoute un premier jeu pour lui créer des défis.');
    return;
  }
  const cov = coverage(g.id);
  const pts = adminCatalog.pointsByDifficulty;
  const all = catQuests(g.id);
  const n = {
    all: all.length,
    w1: all.filter((q) => q.unlock_week === 1 && q.active).length,
    w2: all.filter((q) => q.unlock_week === 2 && q.active).length,
    off: all.filter((q) => !q.active).length,
  };
  const covRow = (week, label) =>
    `<span class="coverage__h">${label}</span>${cov[week].map((c) => `<span class="coverage__n ${c === 0 ? 'is-empty' : ''}">${c}</span>`).join('')}`;

  box.innerHTML = `
    <div class="hgw-card__head">
      <div class="cat-head">
        ${monogram(g)}
        <div>
          <h2 class="hgw-card__title">${esc(g.name)} ${g.active ? '' : '<span class="hgw-badge hgw-badge--danger">Inactif</span>'} ${g.is_universal ? '<span class="hgw-badge hgw-badge--info">Inclus d’office</span>' : ''}</h2>
          <p class="hgw-card__desc">${esc(plain(g.platforms) || 'Plateformes non renseignées')}</p>
        </div>
      </div>
      <div class="row">
        <button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--sm" id="cat-edit-game">${icon('edit')}Modifier le jeu</button>
        <button type="button" class="hgw-btn hgw-btn--primary hgw-btn--sm" id="cat-add-quest">${icon('plus')}Nouveau défi</button>
      </div>
    </div>
    <div class="coverage" title="Défis actifs pouvant être tirés, par difficulté">
      <span></span>${DIFFS.map((d) => `<span class="coverage__h">${DIFF_LABEL[d]} · ${pts[d]} pts</span>`).join('')}
      ${covRow(1, 'Acte I')}
      ${covRow(2, 'Acte II')}
    </div>
    ${g.active && cov[1].some((c) => c === 0) ? `<div class="banner banner--info" style="margin-bottom: var(--space-4)">${icon('alert')}<span>Sans défi dans chaque difficulté, le tirage pioche dans un autre jeu du joueur : prévois au moins un défi facile, moyen et difficile.</span></div>` : ''}
    <div class="row" style="justify-content: space-between; margin-bottom: var(--space-3)">
      <div class="hgw-seg" role="group" aria-label="Filtrer les défis" id="cat-filter">
        ${[
          ['all', 'Tous', n.all],
          ['w1', 'Acte I', n.w1],
          ['w2', 'Acte II', n.w2],
          ['off', 'Archivés', n.off],
        ]
          .map(([k, l, c]) => `<button type="button" data-f="${k}" aria-pressed="${catFilter === k}">${l} <span class="hgw-seg__n">${c}</span></button>`)
          .join('')}
      </div>
      <div class="hgw-search" style="max-width: 260px; flex: 1">
        ${icon('search')}
        <label class="hgw-sr" for="cat-search">Rechercher un défi</label>
        <input id="cat-search" class="hgw-input" placeholder="Rechercher" value="${esc(catSearch)}" autocomplete="off" />
      </div>
    </div>
    <div class="table-wrap">
      <table class="hgw-table">
        <thead><tr><th>Difficulté</th><th>Défi</th><th>Acte</th><th class="r" title="Tirés / validés">Tirés</th><th class="r">Actions</th></tr></thead>
        <tbody id="cat-quests"></tbody>
      </table>
    </div>`;

  box.querySelector('#cat-edit-game').addEventListener('click', () => openGameDialog(g.id));
  box.querySelector('#cat-add-quest').addEventListener('click', () => openQuestDialog(null));
  box.querySelectorAll('#cat-filter [data-f]').forEach((b) =>
    b.addEventListener('click', () => {
      catFilter = b.dataset.f;
      renderCatalogDetail();
    })
  );
  box.querySelector('#cat-search').addEventListener('input', (e) => {
    catSearch = e.target.value;
    renderCatalogRows();
  });
  renderCatalogRows();
}

function renderCatalogRows() {
  const tbody = $('cat-quests');
  if (!tbody) return;
  const term = catSearch.trim().toLowerCase();
  const rows = catQuests().filter((q) => {
    if (catFilter === 'w1' && (q.unlock_week !== 1 || !q.active)) return false;
    if (catFilter === 'w2' && (q.unlock_week !== 2 || !q.active)) return false;
    if (catFilter === 'off' && q.active) return false;
    if (term && !`${q.title} ${q.description}`.toLowerCase().includes(term)) return false;
    return true;
  });
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="hgw-empty" style="padding: var(--space-6)"><strong>Aucun défi</strong>${term ? 'Rien ne correspond à ta recherche.' : 'Crée le premier avec « Nouveau défi ».'}</div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (q) => `<tr data-quest="${esc(q.id)}" class="${q.active ? '' : 'is-archived'}">
        <td>${diffPips(q.difficulty)}</td>
        <td><div class="cat-quest-title">${esc(plain(q.title))}</div><div class="cat-quest-desc">${esc(plain(q.description))}</div></td>
        <td>${q.unlock_week === 2 ? 'II' : 'I'}</td>
        <td class="r mono" style="white-space: nowrap" title="${q.usage_count} tirages, ${q.validated_count} validés, ${q.rerolled_count} relancés">${q.usage_count}<span class="faint"> / ${q.validated_count}</span></td>
        <td class="r" style="white-space: nowrap">
          <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--icon hgw-btn--sm" data-q-toggle="${esc(q.id)}" aria-label="${q.active ? 'Archiver' : 'Réactiver'}" title="${q.active ? 'Archiver (ne sera plus tiré)' : 'Réactiver'}">${icon(q.active ? 'archive' : 'restore')}</button>
          ${q.usage_count === 0 ? `<button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--icon hgw-btn--sm" data-q-delete="${esc(q.id)}" aria-label="Supprimer" title="Supprimer définitivement">${icon('trash')}</button>` : ''}
        </td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('tr[data-quest]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openQuestDialog(tr.dataset.quest);
    })
  );
  tbody.querySelectorAll('[data-q-toggle]').forEach((b) => b.addEventListener('click', () => toggleQuest(b.dataset.qToggle)));
  tbody.querySelectorAll('[data-q-delete]').forEach((b) => b.addEventListener('click', () => removeQuest(b.dataset.qDelete)));
}

async function toggleQuest(id, silent = false) {
  const q = adminCatalog.quests.find((x) => x.id === id);
  if (!q) return;
  const { ok, data } = await api(`/api/admin/quests/${encodeURIComponent(id)}`, { method: 'PUT', json: { active: !q.active } });
  if (!ok) return toastError(data);
  await loadCatalog();
  if (!silent) {
    toast({
      title: q.active ? 'Défi archivé' : 'Défi réactivé',
      text: q.active ? `« ${plain(q.title)} » ne sera plus tiré. Les points déjà gagnés sont conservés.` : `« ${plain(q.title)} » peut de nouveau être tiré.`,
      type: 'success',
      action: { label: 'Annuler', fn: () => toggleQuest(id, true) },
    });
  }
}

async function removeQuest(id) {
  const q = adminCatalog.quests.find((x) => x.id === id);
  if (!q || !confirm(`Supprimer définitivement « ${plain(q.title)} » ?`)) return false;
  const { ok, data } = await api(`/api/admin/quests/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!ok) {
    toastError(data);
    return false;
  }
  toast({ title: 'Défi supprimé', type: 'success' });
  await loadCatalog();
  return true;
}

// ---------------------------------------------------------------------------
// Dialogue « Jeu »
// ---------------------------------------------------------------------------
function updateLogoPreview() {
  const url = $('gf-logo-url').value.trim();
  $('gf-logo-preview').innerHTML = monogram({ short_name: $('gf-short').value || $('gf-name').value || '?', logo_url: url });
}

function openGameDialog(id) {
  const g = id ? catGame(id) : null;
  gameEdit = { id: g?.id || null, pendingFile: null, pendingImport: null };
  $('game-dialog-title').textContent = g ? `Modifier ${g.short_name}` : 'Nouveau jeu';
  $('game-dialog-sub').textContent = g
    ? `${g.active_quest_count} défis actifs · ${g.player_count} joueurs l’ont coché`
    : 'Il sera proposé aux joueurs dès qu’il aura au moins un défi actif.';
  $('gf-name').value = g?.name || '';
  $('gf-short').value = g?.short_name || '';
  $('gf-platforms').value = g?.platforms || '';
  $('gf-logo-url').value = g?.logo_url || '';
  $('gf-active').checked = g ? Boolean(g.active) : true;
  $('gf-active').disabled = Boolean(g?.is_universal);
  $('gf-error').textContent = '';
  const used = g && (g.usage_count > 0 || g.player_count > 0);
  $('gf-delete').hidden = !g || Boolean(g.is_universal);
  $('gf-delete').disabled = Boolean(used);
  $('gf-delete').title = used ? 'Ce jeu a déjà servi : décoche « Actif » pour le retirer sans perdre l’historique.' : '';
  // SteamGridDB
  $('gf-sgdb').hidden = false;
  $('gf-sgdb-results').innerHTML = adminCatalog.logoSearchEnabled
    ? ''
    : `<p class="small faint">Recherche de logos désactivée. Ajoute une clé gratuite <span class="mono">STEAMGRIDDB_API_KEY</span> dans <span class="mono">.env</span> pour chercher un logo par nom.</p>`;
  $('gf-sgdb-bar').hidden = !adminCatalog.logoSearchEnabled;
  $('gf-sgdb-q').value = adminCatalog.logoSearchEnabled ? g?.short_name || '' : '';
  $('gf-sgdb-images').innerHTML = '';
  sgdbGameId = null;
  updateLogoPreview();
  $('game-dialog').showModal();
  if (adminCatalog.logoSearchEnabled && $('gf-sgdb-q').value) searchLogos();
  $('gf-name').focus();
}

async function searchLogos() {
  const q = $('gf-sgdb-q').value.trim();
  if (q.length < 2) {
    $('gf-sgdb-results').innerHTML = '';
    return;
  }
  const { ok, data } = await api(`/api/admin/logo-search?q=${encodeURIComponent(q)}`);
  if (!ok) {
    $('gf-sgdb-results').innerHTML = `<p class="small t-danger">${esc(plain(data.error))}</p>`;
    return;
  }
  if (!data.results.length) {
    $('gf-sgdb-results').innerHTML = `<p class="small faint">Aucun jeu trouvé.</p>`;
    return;
  }
  $('gf-sgdb-results').innerHTML = data.results
    .map((r) => `<button type="button" class="reason" data-sgdb="${r.id}" aria-pressed="${r.id === sgdbGameId}">${esc(r.name)}${r.year ? ` <span class="faint">${r.year}</span>` : ''}</button>`)
    .join('');
  $('gf-sgdb-results').querySelectorAll('[data-sgdb]').forEach((b) =>
    b.addEventListener('click', () => {
      sgdbGameId = Number(b.dataset.sgdb);
      $('gf-sgdb-results').querySelectorAll('[data-sgdb]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      loadLogoImages();
    })
  );
  if (!sgdbGameId) $('gf-sgdb-results').querySelector('[data-sgdb]').click();
}

async function loadLogoImages() {
  if (!sgdbGameId) return;
  $('gf-sgdb-images').innerHTML = `<p class="small faint">Chargement…</p>`;
  const { ok, data } = await api(`/api/admin/logo-search/${sgdbGameId}/images?type=${sgdbType}`);
  if (!ok) {
    $('gf-sgdb-images').innerHTML = `<p class="small t-danger">${esc(plain(data.error))}</p>`;
    return;
  }
  if (!data.images.length) {
    $('gf-sgdb-images').innerHTML = `<p class="small faint">Aucune image de ce type. Essaie l’autre onglet.</p>`;
    return;
  }
  $('gf-sgdb-images').innerHTML = data.images
    .map((i) => `<button type="button" data-img="${esc(i.url)}" title="${i.width} × ${i.height}"><img src="${esc(i.thumb)}" alt="" loading="lazy" /></button>`)
    .join('');
  $('gf-sgdb-images').querySelectorAll('[data-img]').forEach((b) => b.addEventListener('click', () => pickLogo(b.dataset.img)));
}

async function pickLogo(url) {
  if (!gameEdit.id) {
    // Jeu pas encore créé : l'import se fera à l'enregistrement
    gameEdit.pendingImport = url;
    gameEdit.pendingFile = null;
    $('gf-logo-url').value = url;
    updateLogoPreview();
    return;
  }
  const { ok, data } = await api(`/api/admin/games/${encodeURIComponent(gameEdit.id)}/logo-import`, { json: { url } });
  if (!ok) return toastError(data);
  $('gf-logo-url').value = data.game.logo_url;
  updateLogoPreview();
  toast({ title: 'Logo importé', text: 'Hébergé sur le serveur HGW.', type: 'success' });
  loadCatalog();
}

async function uploadLogo(gameId, file) {
  const fd = new FormData();
  fd.append('logo', file);
  const { ok, data } = await api(`/api/admin/games/${encodeURIComponent(gameId)}/logo`, { method: 'POST', body: fd });
  if (!ok) {
    toastError(data);
    return null;
  }
  return data.game;
}

async function submitGame(e) {
  e.preventDefault();
  $('gf-error').textContent = '';
  const logo = $('gf-logo-url').value.trim();
  const pendingLocal = gameEdit.pendingFile || gameEdit.pendingImport;
  const payload = {
    name: $('gf-name').value,
    short_name: $('gf-short').value || $('gf-name').value,
    platforms: $('gf-platforms').value,
    active: $('gf-active').checked,
  };
  // Une image en attente (nouveau jeu) est envoyée après création ; sinon l'URL saisie fait foi.
  if (!pendingLocal) payload.logo_url = logo || null;
  const isNew = !gameEdit.id;
  const { ok, data } = await api(isNew ? '/api/admin/games' : `/api/admin/games/${encodeURIComponent(gameEdit.id)}`, {
    method: isNew ? 'POST' : 'PUT',
    json: payload,
  });
  if (!ok) {
    $('gf-error').textContent = plain(data.error) || 'Enregistrement impossible.';
    return;
  }
  const id = data.game.id;
  if (gameEdit.pendingFile) await uploadLogo(id, gameEdit.pendingFile);
  else if (gameEdit.pendingImport) {
    const r = await api(`/api/admin/games/${encodeURIComponent(id)}/logo-import`, { json: { url: gameEdit.pendingImport } });
    if (!r.ok) toastError(r.data);
  }
  $('game-dialog').close();
  toast({ title: isNew ? 'Jeu ajouté' : 'Jeu enregistré', text: isNew ? 'Ajoute-lui maintenant des défis.' : '', type: 'success' });
  catGameId = id;
  await loadCatalog();
  fetchState();
}

// ---------------------------------------------------------------------------
// Dialogue « Défi »
// ---------------------------------------------------------------------------
function renderQuestSegs() {
  const pts = adminCatalog.pointsByDifficulty;
  $('qf-diff').innerHTML = DIFFS.map(
    (d) => `<button type="button" data-d="${d}" aria-pressed="${questEdit.difficulty === d}">${DIFF_LABEL[d]} <span class="hgw-seg__n">${pts[d]} pts</span></button>`
  ).join('');
  $('qf-diff').querySelectorAll('[data-d]').forEach((b) =>
    b.addEventListener('click', () => {
      questEdit.difficulty = b.dataset.d;
      renderQuestSegs();
    })
  );
  $('qf-week').querySelectorAll('[data-week]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.week) === questEdit.unlock_week)));
}

function openQuestDialog(id) {
  const q = id ? adminCatalog.quests.find((x) => x.id === id) : null;
  questEdit = { id: q?.id || null, difficulty: q?.difficulty || 'easy', unlock_week: q?.unlock_week || 1 };
  $('quest-dialog-title').textContent = q ? 'Modifier le défi' : 'Nouveau défi';
  $('quest-dialog-sub').textContent = q
    ? `Tiré ${q.usage_count} fois · validé ${q.validated_count} fois · relancé ${q.rerolled_count} fois`
    : 'Un objectif clair et vérifiable sur une capture d’écran.';
  $('qf-game').innerHTML = adminCatalog.games
    .map((g) => `<option value="${esc(g.id)}">${esc(g.short_name)}${g.active ? '' : ' (inactif)'}</option>`)
    .join('');
  $('qf-game').value = q?.game_id || catGameId;
  $('qf-title').value = q?.title || '';
  $('qf-desc').value = q?.description || '';
  $('qf-proof').value = q?.proof_hint || '';
  $('qf-active').checked = q ? Boolean(q.active) : true;
  $('qf-error').textContent = '';
  // Le jeu et la difficulté sont figés une fois le défi validé ou en vérification (barème rétroactif).
  const locked = Boolean(q && q.validated_count > 0);
  $('qf-game').disabled = locked;
  $('qf-diff').classList.toggle('is-disabled', locked);
  $('qf-delete').hidden = !q;
  $('qf-delete').disabled = Boolean(q && q.usage_count > 0);
  $('qf-delete').title = q && q.usage_count > 0 ? 'Déjà tiré : archive-le plutôt (décoche « Actif »).' : '';
  renderQuestSegs();
  $('qf-diff').querySelectorAll('button').forEach((b) => (b.disabled = locked));
  $('quest-dialog').showModal();
  $('qf-title').focus();
}

async function submitQuest(e) {
  e.preventDefault();
  $('qf-error').textContent = '';
  const payload = {
    game_id: $('qf-game').value,
    title: $('qf-title').value,
    description: $('qf-desc').value,
    proof_hint: $('qf-proof').value || undefined,
    difficulty: questEdit.difficulty,
    unlock_week: questEdit.unlock_week,
    active: $('qf-active').checked,
  };
  const isNew = !questEdit.id;
  const { ok, data } = await api(isNew ? '/api/admin/quests' : `/api/admin/quests/${encodeURIComponent(questEdit.id)}`, {
    method: isNew ? 'POST' : 'PUT',
    json: payload,
  });
  if (!ok) {
    $('qf-error').textContent = plain(data.error) || 'Enregistrement impossible.';
    return;
  }
  $('quest-dialog').close();
  toast({ title: isNew ? 'Défi créé' : 'Défi enregistré', type: 'success' });
  catGameId = data.quest.game_id;
  if (isNew && catFilter === 'off') catFilter = 'all';
  await loadCatalog();
}

function bindCatalog() {
  $('cat-add-game').addEventListener('click', () => openGameDialog(null));
  $('game-form').addEventListener('submit', submitGame);
  $('quest-form').addEventListener('submit', submitQuest);
  ['gf-logo-url', 'gf-name', 'gf-short'].forEach((id) =>
    $(id).addEventListener('input', () => {
      if (id === 'gf-logo-url' && gameEdit) {
        gameEdit.pendingFile = null;
        gameEdit.pendingImport = null;
      }
      updateLogoPreview();
    })
  );
  $('gf-logo-clear').addEventListener('click', () => {
    gameEdit.pendingFile = null;
    gameEdit.pendingImport = null;
    $('gf-logo-url').value = '';
    updateLogoPreview();
  });
  $('gf-logo-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) return toast({ title: 'Image trop lourde', text: '1 Mo maximum.', type: 'danger' });
    if (!gameEdit.id) {
      gameEdit.pendingFile = file;
      gameEdit.pendingImport = null;
      $('gf-logo-url').value = '';
      $('gf-logo-preview').innerHTML = `<span class="monogram has-logo"><img src="${URL.createObjectURL(file)}" alt="" /></span>`;
      return;
    }
    const game = await uploadLogo(gameEdit.id, file);
    if (!game) return;
    $('gf-logo-url').value = game.logo_url;
    updateLogoPreview();
    toast({ title: 'Logo téléversé', type: 'success' });
    loadCatalog();
  });
  $('gf-delete').addEventListener('click', async () => {
    const g = catGame(gameEdit?.id);
    if (!g || !confirm(`Supprimer définitivement ${g.name} et ses ${g.quest_count} défis ?`)) return;
    const { ok, data } = await api(`/api/admin/games/${encodeURIComponent(g.id)}`, { method: 'DELETE' });
    if (!ok) {
      $('gf-error').textContent = plain(data.error);
      return;
    }
    $('game-dialog').close();
    toast({ title: 'Jeu supprimé', type: 'success' });
    catGameId = null;
    await loadCatalog();
    fetchState();
  });
  $('gf-sgdb-q').addEventListener('input', () => {
    clearTimeout(sgdbTimer);
    sgdbGameId = null;
    sgdbTimer = setTimeout(searchLogos, 350);
  });
  $('gf-sgdb-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(sgdbTimer);
      searchLogos();
    }
  });
  $('gf-sgdb-type').querySelectorAll('[data-type]').forEach((b) =>
    b.addEventListener('click', () => {
      sgdbType = b.dataset.type;
      $('gf-sgdb-type').querySelectorAll('[data-type]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      loadLogoImages();
    })
  );
  $('qf-week').querySelectorAll('[data-week]').forEach((b) =>
    b.addEventListener('click', () => {
      questEdit.unlock_week = Number(b.dataset.week);
      renderQuestSegs();
    })
  );
  $('qf-delete').addEventListener('click', async () => {
    if (questEdit?.id && (await removeQuest(questEdit.id))) $('quest-dialog').close();
  });
}

function renderManualPoints() {
  const sel = $('mp-user');
  const users = appState.admin?.allUsers || [];
  const current = sel.value;
  sel.innerHTML = users.map((u) => `<option value="${esc(u.id)}">${esc(u.display_name)} (@${esc(u.username)})</option>`).join('');
  if (current) sel.value = current;
  updateManualPreview();
}

function updateManualPreview() {
  const uid = $('mp-user').value;
  const amount = Math.round(Number($('mp-amount').value));
  const lb = appState?.leaderboard || [];
  const player = lb.find((p) => p.id === uid);
  const user = (appState?.admin?.allUsers || []).find((u) => u.id === uid);
  if (!user || !Number.isFinite(amount) || amount === 0) {
    $('mp-preview').innerHTML = `<span class="faint">Choisis un joueur et un montant non nul.</span>`;
    return;
  }
  const before = player?.total_points || 0;
  const after = before + amount;
  const newRank = lb.filter((p) => p.id !== uid && p.total_points > after).length + 1;
  $('mp-preview').innerHTML = `<b>${esc(user.display_name)}</b> : <span class="hgw-num">${fmt(before)} → ${fmt(after)}</span> pts · ${player ? `rang ${player.rank} → ${newRank}` : `entre au rang ${newRank}`}`;
}

// ============================================================================
// SCÈNES STREAM
// ============================================================================
function openTeamsStage() {
  const rl = (appState?.tournaments || []).find((t) => t.id === 'rl_rumble');
  if (!rl) return;
  const pools = [1, 2, 3].map((n) => rl.registrations.filter((r) => r.pool === n));
  $('stage-pools').innerHTML = pools
    .map((list, i) => `<div class="hgw-card hgw-card--flat"><div class="hgw-stat__label" style="margin-bottom: var(--space-2)">Chapeau ${i + 1}</div><div class="row">${list.map((p) => `<span class="hgw-badge">${esc(p.display_name)}</span>`).join('') || '<span class="faint small">Vide</span>'}</div></div>`)
    .join('');
  const teams = teamsOf(rl);
  stageQueue = [];
  stageIndex = 0;
  $('stage-teams').innerHTML = teams.length
    ? teams
        .map(
          (tm) => `<div class="hgw-card"><div class="hgw-card__head"><h3 class="hgw-card__title t-gold" style="font-size:20px">${esc(tm.name)}</h3></div>${[...tm.members]
            .sort((a, b) => b.pool - a.pool)
            .map((m, i) => {
              const id = `slot-${tm.num}-${i}`;
              stageQueue.push({ id, name: m.display_name, pool: m.pool });
              return `<div class="slot" id="${id}"><span>Chapeau ${m.pool} · à révéler</span><span class="hgw-num faint">C${m.pool}</span></div>`;
            })
            .join('')}</div>`
        )
        .join('')
    : `<div class="hgw-empty"><strong>Pas encore d’équipes</strong>Tire les équipes depuis l’admin, puis rouvre la scène.</div>`;
  stageQueue.sort((a, b) => b.pool - a.pool);
  $('teams-stage').classList.add('is-open');
  $('stage-next-btn').focus();
}

function revealNext() {
  const item = stageQueue[stageIndex];
  if (!item) return toast({ title: 'Toutes les équipes sont révélées', type: 'success' });
  stageIndex++;
  const el = $(item.id);
  if (!el) return;
  el.className = 'slot is-revealed';
  el.innerHTML = `<span>${esc(item.name)}</span><span class="hgw-badge">Chapeau ${item.pool}</span>`;
}

function openTombolaStage() {
  const qualified = (appState?.leaderboard || []).filter((p) => p.tombola_eligible);
  $('tombola-status').textContent = `${qualified.length} joueur${qualified.length > 1 ? 's' : ''} dans l’urne · 300 pts et plus`;
  $('tombola-wheel').className = 'wheel';
  $('tombola-wheel').textContent = qualified.length ? 'Prêt pour le tirage' : 'Personne n’a encore atteint 300 pts';
  $('tombola-spin-btn').disabled = !qualified.length;
  $('tombola-candidates').innerHTML = qualified.map((p) => `<span class="candidate" data-uid="${esc(p.id)}">${esc(p.display_name)} <span class="faint hgw-num">${p.total_points}</span></span>`).join('');
  $('tombola-stage').classList.add('is-open');
  $('tombola-spin-btn').focus();
}

async function spinTombola() {
  if (tombolaSpinning) return;
  tombolaSpinning = true;
  $('tombola-spin-btn').disabled = true;
  const { ok, data } = await api('/api/admin/tombola/draw', { method: 'POST' });
  if (!ok) {
    tombolaSpinning = false;
    $('tombola-spin-btn').disabled = false;
    return toastError(data);
  }
  const wheel = $('tombola-wheel');
  const chips = [...document.querySelectorAll('#tombola-candidates .candidate')];
  const cands = data.candidates || [];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('tombola-status').textContent = 'Tirage en cours…';
  if (!reduced && cands.length > 1) {
    const steps = 34;
    for (let i = 0; i < steps - 1; i++) {
      const pick = cands[Math.floor(Math.random() * cands.length)];
      chips.forEach((c) => c.classList.toggle('is-hot', c.dataset.uid === pick.id));
      wheel.textContent = pick.display_name;
      await new Promise((r) => setTimeout(r, Math.round(45 + Math.pow(i / steps, 2.3) * 290)));
    }
  }
  chips.forEach((c) => c.classList.toggle('is-hot', c.dataset.uid === data.winner.id));
  wheel.className = 'wheel is-winner';
  wheel.innerHTML = `<div><div class="hgw-stat__label" style="margin-bottom: var(--space-2)">Gagnant de la tombola</div>${esc(data.winner.display_name)}</div>`;
  $('tombola-status').textContent = `Tiré parmi ${data.eligibleCount} qualifié${data.eligibleCount > 1 ? 's' : ''}`;
  tombolaSpinning = false;
  $('tombola-spin-btn').disabled = false;
}

// ============================================================================
// TEMPS RÉEL
// ============================================================================
function connectSse() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    sseConnected = true;
    if (appState) renderPhaseChip();
  };
  es.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'connected') return;
      if (payload.type === 'catalog_updated') catalogStale = true;
      if (payload.message) toast({ title: plain(payload.message), type: payload.type === 'points_updated' ? 'points' : 'info' });
      scheduleFetch();
    } catch {
      /* battement de cœur */
    }
  };
  es.onerror = () => {
    sseConnected = false;
    if (appState) renderPhaseChip();
  };
}

// ============================================================================
// INITIALISATION
// ============================================================================
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function bindStatic() {
  hydrateIcons();

  // Délégations globales
  document.addEventListener('click', (e) => {
    const playerBtn = e.target.closest('[data-player-btn]');
    if (playerBtn) openLedger(playerBtn.dataset.playerBtn);
    const menu = $('usermenu-list');
    if (menu && !menu.hidden && !e.target.closest('.usermenu')) {
      menu.hidden = true;
      $('usermenu-btn')?.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    const menu = $('usermenu-list');
    if (e.key === 'Escape' && menu && !menu.hidden) {
      menu.hidden = true;
      $('usermenu-btn')?.focus();
    }
  });

  // Logo injoignable : retour au monogramme
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (img?.tagName === 'IMG' && img.dataset.fallback !== undefined) {
        const box = img.parentElement;
        box?.classList.remove('has-logo');
        img.replaceWith(document.createTextNode(img.dataset.fallback));
      }
    },
    true
  );

  bindCatalog();

  // Fermeture des dialogues
  document.querySelectorAll('dialog').forEach((d) => {
    d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
  });

  // Classement
  $('lb-filters').querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      leaderboardFilter = b.dataset.filter;
      $('lb-filters').querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderLeaderboard();
    })
  );
  $('lb-search').addEventListener('input', (e) => {
    leaderboardSearch = e.target.value || '';
    renderLeaderboard();
  });

  // Trackmania
  document.querySelectorAll('[data-copy-replays]').forEach((b) => b.addEventListener('click', () => copyText(REPLAYS_PATH, 'Chemin copié · colle-le dans la fenêtre d’ouverture')));
  const drop = $('gbx-drop');
  $('gbx-input').addEventListener('change', (e) => uploadReplays(e.target.files));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    uploadReplays(e.dataTransfer?.files);
  });
  $('tmnf-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!appState?.user) return openLogin();
    const tmnfLogin = $('tmnf-login-input').value.trim();
    if (!tmnfLogin) return $('tmnf-login-input').focus();
    const { ok, data } = await api('/api/profile/tmnf-login', { json: { tmnfLogin } });
    if (!ok) return toastError(data);
    toast({ title: 'Login Trackmania lié', text: `${tmnfLogin} : tes chronos du serveur remonteront tout seuls.`, type: 'success' });
    fetchState();
  });

  // Preuve
  const proofFile = $('proof-file');
  proofFile.addEventListener('change', () => proofFile.files?.[0] && setProofFile(proofFile.files[0]));
  const pd = $('proof-drop');
  pd.addEventListener('dragover', (e) => {
    e.preventDefault();
    pd.classList.add('is-over');
  });
  pd.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.[0]) setProofFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('paste', (e) => {
    if (!$('proof-dialog').open) return;
    for (const item of e.clipboardData?.items || []) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          setProofFile(new File([blob], `capture_${Date.now()}.png`, { type: blob.type }));
          e.preventDefault();
          break;
        }
      }
    }
  });
  $('proof-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('proof-url').value.trim();
    if (!pastedProofFile && !url) {
      $('proof-error').textContent = 'Ajoute une capture, un fichier ou un lien.';
      return;
    }
    const fd = new FormData();
    if (pastedProofFile) fd.append('proofFile', pastedProofFile);
    fd.append('proofUrl', url);
    fd.append('proofNote', $('proof-note').value.trim());
    const btn = $('proof-submit');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="hgw-spinner"></span>Envoi…';
    const { ok, data } = await api(`/api/quests/${$('proof-assignment-id').value}/submit`, { method: 'POST', body: fd });
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = 'Envoyer';
    if (!ok) {
      $('proof-error').textContent = plain(data.error) || 'Envoi impossible.';
      return;
    }
    $('proof-dialog').close();
    toast({ title: 'Preuve envoyée', text: 'Un orga va la vérifier. Tu seras notifié ici.', type: 'success' });
    fetchState();
  });

  // Connexion de test
  $('dev-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('dev-login-username').value.trim();
    if (!username) return;
    const { ok, data } = await api('/api/auth/dev-login', { json: { username, isAdmin: $('dev-login-admin').checked } });
    if (!ok) return toastError(data);
    $('dev-login-dialog').close();
    toast({ title: `Bienvenue ${username}`, type: 'success' });
    fetchState();
  });

  // Admin : refus
  $('reject-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const reason = $('reject-text').value.trim();
    if (!reason) {
      $('reject-text').closest('.hgw-field').classList.add('hgw-field--error');
      return $('reject-text').focus();
    }
    $('reject-text').closest('.hgw-field').classList.remove('hgw-field--error');
    $('reject-dialog').close();
    if (rejectTarget) queueDecision(rejectTarget, { action: 'reject', rejectReason: reason });
  });
  $('reject-dialog').addEventListener('keydown', (e) => {
    if (e.target === $('reject-text')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= REJECT_REASONS.length) {
      e.preventDefault();
      pickReason(n - 1);
    }
  });

  // Admin : réglages
  $('settings-form').addEventListener('input', () => (settingsDirty = true));
  $('cfg-manual').addEventListener('change', (e) => ($('cfg-manual-field').hidden = !e.target.checked));
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateSettings()) return;
    const payload = {
      status_mode: $('cfg-manual').checked ? $('cfg-status-mode').value : 'auto',
      start_at: $('cfg-start-at').value,
      week2_start_at: $('cfg-week2-start-at').value,
      tmnf_cutoff_at: $('cfg-tmnf-cutoff-at').value,
      end_at: $('cfg-end-at').value,
      tmnf_playit_address: $('cfg-playit-addr').value.trim(),
      weekly_map_uid: $('cfg-weekly-uid').value.trim(),
    };
    const { ok, data } = await api('/api/admin/settings', { json: payload });
    if (!ok) return toastError(data);
    settingsDirty = false;
    toast({ title: 'Réglages enregistrés', text: payload.status_mode === 'auto' ? 'Phases automatiques selon les dates.' : 'Phase forcée : pense à repasser en automatique.', type: payload.status_mode === 'auto' ? 'success' : 'danger' });
    fetchState();
  });

  // Admin : tournois
  const draw = async (announceDiscord) => {
    const { ok, data } = await api(`/api/admin/tournaments/${adminTourneyId}/draw-teams`, { json: { onlyCheckedIn: true, announceDiscord } });
    if (!ok) return toastError(data);
    toast({ title: `${data.teams.length} équipes tirées`, text: announceDiscord ? 'Annonce envoyée sur Discord.' : 'Ouvre la scène pour les révéler en stream.', type: 'success' });
    fetchState();
  };
  $('draw-teams-btn').addEventListener('click', () => draw(false));
  $('draw-discord-btn').addEventListener('click', () => draw(true));
  $('save-placements-btn').addEventListener('click', async () => {
    const placements = [...document.querySelectorAll('#admin-pools-tbody [data-place]')].filter((s) => s.value).map((s) => ({ userId: s.dataset.place, placement: Number(s.value) }));
    if (!placements.length) return toast({ title: 'Aucune place renseignée', text: 'Choisis au moins une place finale.', type: 'danger' });
    const { ok, data } = await api(`/api/admin/tournaments/${adminTourneyId}/placements`, { json: { placements } });
    if (!ok) return toastError(data);
    toast({ title: 'Résultats enregistrés', text: 'Les points live sont crédités.', type: 'success' });
    fetchState();
  });
  $('save-fg-btn').addEventListener('click', async () => {
    const scores = [...document.querySelectorAll('#admin-fg-tbody tr[data-fg]')].map((tr) => ({ userId: tr.dataset.fg, shows: [...tr.querySelectorAll('[data-show]')].map((s) => Number(s.value)) }));
    if (!scores.length) return;
    const { ok, data } = await api('/api/admin/fall-guys/scores', { json: { scores } });
    if (!ok) return toastError(data);
    toast({ title: 'Fall Guys calculé', text: 'Les points HGW sont attribués.', type: 'success' });
    fetchState();
  });

  // Admin : points
  ['mp-user', 'mp-amount'].forEach((id) => $(id).addEventListener('input', updateManualPreview));
  $('manual-points-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = $('mp-label').value.trim();
    const points = Math.round(Number($('mp-amount').value));
    const field = $('mp-label').closest('.hgw-field');
    field.classList.toggle('hgw-field--error', label.length < 3);
    if (!points) return $('mp-amount').focus();
    if (label.length < 3) return $('mp-label').focus();
    const { ok, data } = await api('/api/admin/manual-points', { json: { userId: $('mp-user').value, category: $('mp-cat').value, points, label } });
    if (!ok) return toastError(data);
    $('mp-label').value = '';
    toast({ title: `${signed(points)} pts appliqués`, text: label, type: 'success' });
    fetchState();
  });

  // Admin : maintenance
  $('cron-confirm').addEventListener('input', (e) => ($('cron-btn').disabled = e.target.value.trim().toUpperCase() !== 'RELANCER'));
  $('cron-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('cron-btn').disabled) return;
    const { ok, data } = await api('/api/admin/cron/trigger', { method: 'POST' });
    if (!ok) return toastError(data);
    $('cron-confirm').value = '';
    $('cron-btn').disabled = true;
    toast({ title: 'Tirage relancé', text: `${data.usersProcessed} joueurs traités.`, type: 'success' });
    fetchState();
  });
  $('seed-demo-btn').addEventListener('click', async () => {
    const { ok, data } = await api('/api/admin/seed-demo', { method: 'POST' });
    if (!ok) return toastError(data);
    toast({ title: plain(data.message) || 'Joueurs fictifs ajoutés', type: 'success' });
    fetchState();
  });
  $('sim-finish-btn').addEventListener('click', async () => {
    const weekly = (appState?.tmnfMaps || []).find((m) => m.is_weekly);
    if (!weekly) return;
    const best = appState?.weeklyTmnfLeaderboard?.[0]?.best_time_ms || 42500;
    const { ok, data } = await api('/api/tmnf/webhook', {
      json: { playerLogin: appState.user.tmnf_login || appState.user.username, playerNickname: appState.user.display_name, mapUid: weekly.uid, timeMs: Math.max(38500, best - Math.floor(Math.random() * 280) - 40) },
    });
    if (!ok) return toastError(data);
    toast({ title: `Chrono simulé : ${data.formattedTime}`, type: 'success' });
  });

  // Scènes
  $('open-stage-btn').addEventListener('click', openTeamsStage);
  $('stage-next-btn').addEventListener('click', revealNext);
  $('stage-all-btn').addEventListener('click', () => {
    while (stageIndex < stageQueue.length) revealNext();
  });
  $('stage-reset-btn').addEventListener('click', openTeamsStage);
  $('stage-close-btn').addEventListener('click', () => $('teams-stage').classList.remove('is-open'));
  $('open-tombola-btn').addEventListener('click', openTombolaStage);
  $('tombola-spin-btn').addEventListener('click', spinTombola);
  $('tombola-close-btn').addEventListener('click', () => $('tombola-stage').classList.remove('is-open'));

  // Clavier global
  window.addEventListener('keydown', (e) => {
    const teams = $('teams-stage').classList.contains('is-open');
    const tombola = $('tombola-stage').classList.contains('is-open');
    if (teams || tombola) {
      if (e.key === 'Escape') {
        $('teams-stage').classList.remove('is-open');
        $('tombola-stage').classList.remove('is-open');
      }
      if (e.code === 'Space' && !isTyping(e)) {
        e.preventDefault();
        teams ? revealNext() : spinTombola();
      }
      return;
    }
    if (document.querySelector('dialog[open]') || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (route.view === 'admin' && route.pane === 'moderation' && visibleProofs().length) {
      const k = e.key.toLowerCase();
      if (k === 'v') decide('approve');
      else if (k === 'r') {
        e.preventDefault();
        decide('reject');
      } else if (e.key === 'ArrowRight') decide('skip');
      else if (e.code === 'Space') {
        const zoom = $('review-zoom');
        if (zoom) {
          e.preventDefault();
          zoom.click();
        }
      }
    }
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  if (LEGACY_HASH[location.hash]) history.replaceState({}, '', LEGACY_HASH[location.hash]);
  bindStatic();
  applyRoute(resolveRoute(location.pathname));
  setInterval(() => appState && renderPhaseChip(), 30000);
  const params = new URLSearchParams(location.search);
  if (params.get('error')) toast({ title: 'La connexion Discord a échoué', text: 'Réessaie, ou préviens un orga si ça continue.', type: 'danger' });
  await fetchState();
  connectSse();
});
