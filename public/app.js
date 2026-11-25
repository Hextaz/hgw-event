// HGW — application joueur modulaire (design system v2, ES Modules).
import {
  $,
  api,
  avatar,
  confirmDialog,
  copyText,
  deltaSec,
  diffPips,
  emptyCard,
  esc,
  fmt,
  fmtDate,
  formatMetric,
  hydrateIcons,
  icon,
  monogram,
  parseMetricInput,
  plain,
  safeUrl,
  signed,
  teamsOf,
  timeAgo,
  tName,
  toast,
  toastError,
  trackName,
  withTieRanks,
} from './shared.js';
import { decideProof, initAdmin, markCatalogStale, renderAdmin, visibleProofs } from './admin.js';

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
let hofSelectedId = null;

let stageQueue = [];
let stageIndex = 0;
let stageTourneyId = null;
let tombolaSpinning = false;
let sseConnected = false;
let fetchTimer = null;
let pastedProofFile = null;

const REPLAYS_PATH = '%USERPROFILE%\\Documents\\TrackMania\\Tracks\\Replays\\Replays';

// ============================================================================
// ROUTAGE
// ============================================================================
const ROUTES = {
  '/': { view: 'today' },
  '/classement': { view: 'classement' },
  '/vedette': { view: 'featured' },
  '/trackmania': { view: 'featured' }, // alias rétrocompatible
  '/tournois': { view: 'tournois' },
  '/hall-of-fame': { view: 'hof' },
  '/aide': { view: 'aide' },
  '/admin': { view: 'admin', pane: 'moderation' },
  '/admin/evenement': { view: 'admin', pane: 'evenement' },
  '/admin/vedette': { view: 'admin', pane: 'vedette' },
  '/admin/tournois': { view: 'admin', pane: 'tournois' },
  '/admin/points': { view: 'admin', pane: 'points' },
  '/admin/catalogue': { view: 'admin', pane: 'catalogue' },
  '/admin/maintenance': { view: 'admin', pane: 'maintenance' },
};
const LEGACY_HASH = {
  '#classement': '/classement',
  '#defis': '/',
  '#trackmania': '/vedette',
  '#tournois': '/tournois',
  '#guide': '/aide',
  '#admin': '/admin',
};

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
  if (isDraftLockedForViewer() && r.view !== 'today' && r.view !== 'hof') {
    history.replaceState({}, '', '/');
    r = { path: '/', ...ROUTES['/'] };
  }
  if (r.view === 'featured' && appState && !appState.eventSettings?.featured?.enabled) {
    history.replaceState({}, '', '/');
    r = { path: '/', ...ROUTES['/'] };
  }
  route = { view: r.view, pane: r.pane || 'moderation' };
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('is-active', s.id === `view-${route.view}`));
  document.querySelectorAll('.admin-pane').forEach((p) => p.classList.toggle('is-active', p.id === `pane-${route.pane}`));
  const brand = appState?.eventSettings?.event_name || 'Hextaz Games Week';
  const featTitle = appState?.eventSettings?.featured?.title || 'Jeu vedette';
  const titles = {
    today: 'Aujourd’hui',
    classement: 'Classement',
    featured: featTitle,
    tournois: 'Tournois',
    hof: 'Hall of Fame',
    aide: 'Aide',
    admin: 'Organisation',
  };
  document.title = `${titles[route.view] || 'Accueil'} · ${brand}`;
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
  const endMs = Date.parse(s.end_at);
  const totalDays = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(1, Math.round((endMs - startMs) / 86400000) + 1) : 14;
  const rawDay = Number.isFinite(startMs) ? Math.floor((parisNow() - new Date(s.start_at)) / 86400000) + 1 : null;
  const phase = s.effective_phase || 'act_1';
  let label = 'Acte I';
  if (phase === 'draft') label = 'Préparation';
  else if (phase === 'registration') label = 'Inscriptions';
  else if (phase === 'closed') label = 'Terminé';
  else {
    const act = (s.acts || []).find((a) => `act_${a.index}` === phase);
    label = act?.name || `Acte ${s.current_act || 1}`;
  }
  return {
    key: phase,
    label,
    day: rawDay !== null && rawDay >= 1 ? Math.min(totalDays, rawDay) : null,
    totalDays,
    manual: s.status_mode && s.status_mode !== 'auto',
  };
}

function renderPhaseChip() {
  const p = phaseInfo();
  const cfg = appState.eventSettings || {};
  const text = $('phase-chip-text');
  if (p.key === 'draft') text.innerHTML = `<b>Préparation</b>`;
  else if (p.key === 'registration') text.innerHTML = `<b>Inscriptions</b> · début ${esc(fmtDate(cfg.start_at))}`;
  else if (p.key === 'closed') text.innerHTML = `<b>Édition terminée</b>`;
  else text.innerHTML = `<b>${esc(p.label)}</b>${p.day ? ` · J${p.day}` : ''} · reset dans ${resetCountdown()}`;
  $('live-dot').classList.toggle('off', !sseConnected);
  $('live-dot').title = sseConnected ? 'Mises à jour en direct' : 'Reconnexion…';
}

function phaseTimeline() {
  const p = phaseInfo();
  const cfg = appState.eventSettings || {};
  const acts = cfg.acts || [];
  const feat = cfg.featured || {};
  const tCount = (appState.tournaments || []).length;

  const order = ['draft', 'registration', ...acts.map((a) => `act_${a.index}`), 'closed'];
  const currentIdx = order.indexOf(p.key);

  const actCards = acts.map((act) => {
    const key = `act_${act.index}`;
    const idx = order.indexOf(key);
    const done = currentIdx > idx;
    const now = p.key === key;
    let desc = `Défis quotidiens`;
    if (feat.enabled) {
      if (act.index === 1 && feat.stages_enabled) desc = `Défis + ${feat.stages_title}`;
      else if (feat.ladder_enabled && act.index === feat.ladder_unlock_act) desc = `Ouverture ${feat.ladder_title}`;
      else desc = `Nouveaux défis ${act.name}`;
    }
    return `<div class="hgw-phase ${done ? 'done' : ''} ${now ? 'now' : ''}">
      <div class="hgw-phase__k">${esc(act.name)}${now ? ' · en cours' : ''}</div>
      <div class="hgw-phase__t">${esc(desc)}</div>
      <div class="hgw-phase__d">${now ? `Nouveaux défis dans ${resetCountdown()}` : done ? 'Terminé' : `Dès le ${esc(fmtDate(act.start_at))}`}</div>
    </div>`;
  });

  const finaleCard =
    tCount > 0
      ? `<div class="hgw-phase ${p.key === 'closed' ? 'done' : ''}">
          <div class="hgw-phase__k">Finale live</div>
          <div class="hgw-phase__t">${tCount} tournoi${tCount > 1 ? 's' : ''} ensemble</div>
          <div class="hgw-phase__d">Clôture le ${esc(fmtDate(cfg.end_at))}</div>
        </div>`
      : '';

  return `<div class="hgw-phases" aria-label="Étapes de l'événement">${actCards.join('')}${finaleCard}</div>`;
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
  return (appState.leaderboard || []).find((u) => u.id === appState.user?.id) || null;
}

function isDraftLockedForViewer() {
  return appState?.eventSettings?.effective_phase === 'draft' && appState?.user?.is_admin !== 1;
}

function renderAll() {
  if (!appState) return;
  const brand = appState.eventSettings?.event_name || 'Hextaz Games Week';
  $('brand-name').textContent = brand;

  const draftSlot = $('draft-banner-slot');
  if (appState.eventSettings?.effective_phase === 'draft' && appState.user?.is_admin === 1) {
    draftSlot.innerHTML = `<div class="draft-banner">
      <span><b>Mode Préparation actif</b> · Les joueurs ne voient pas encore cette édition tant que tu ne passes pas en Inscriptions ou Auto.</span>
      <a href="/admin/evenement" data-link class="hgw-btn hgw-btn--primary hgw-btn--sm">Ouvrir la config</a>
    </div>`;
  } else {
    draftSlot.innerHTML = '';
  }

  applyRoute(resolveRoute(location.pathname));
  renderPhaseChip();
  renderUser();
  renderToday();
  renderLeaderboard();
  renderFeatured();
  renderTournaments();
  renderHof();
  renderHelp();
  if (appState.user?.is_admin === 1) renderAdmin();
}

// ============================================================================
// NAVIGATION & MENU UTILISATEUR
// ============================================================================
function renderNav() {
  const cfg = appState.eventSettings || {};
  const feat = cfg.featured || {};
  const openQuests = (appState.myDailyQuests || []).filter((q) => q.status === 'open' || q.status === 'rejected').length;
  const hasArchives = (appState.archivedEditions || []).length > 0;

  const items = [['/', 'home', appState.user ? 'Aujourd’hui' : 'Accueil', 'today', appState.user ? openQuests : 0]];
  if (!isDraftLockedForViewer()) {
    items.push(['/classement', 'trophy', 'Classement', 'classement', 0]);
    if (feat.enabled) {
      items.push(['/vedette', feat.connector === 'tmnf_gbx' ? 'flag' : 'star', feat.title || 'Jeu vedette', 'featured', 0]);
    }
    if ((appState.tournaments || []).length > 0) {
      items.push(['/tournois', 'swords', 'Tournois', 'tournois', 0]);
    }
  }
  if (hasArchives) {
    items.push(['/hall-of-fame', 'medal', 'Hall of Fame', 'hof', 0]);
  }

  $('main-nav').innerHTML = items
    .map(
      ([href, ic, label, view, count]) => `
      <a class="hgw-tab" href="${href}" data-link ${route.view === view ? 'aria-current="page"' : ''}>
        ${icon(ic)}<span>${esc(label)}</span>${count ? `<span class="hgw-tab__count" aria-label="${count} à faire">${count}</span>` : ''}
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
  const pending = appState.admin ? visibleProofs(appState).length : 0;
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
// AUJOURD'HUI / ACCUEIL / BROUILLON
// ============================================================================
function renderToday() {
  const root = $('view-today');
  const cfg = appState.eventSettings || {};

  if (isDraftLockedForViewer()) {
    const hasArchives = (appState.archivedEditions || []).length > 0;
    root.innerHTML = `
      <div class="hgw-card hero">
        <div>
          <p class="hgw-stat__label t-gold">Prochaine édition en préparation</p>
          <h1 class="hero__title" id="today-title" style="margin-top: var(--space-2)">${esc(cfg.event_name || 'Hextaz Games Week')} arrive bientôt.</h1>
          <p class="hero__lead">Les organisateurs préparent le programme, les défis et les tournois de cette nouvelle édition. Reviens très vite pour l’ouverture des inscriptions !</p>
          <div class="row" style="margin-top: var(--space-6)">
            ${hasArchives ? `<a class="hgw-btn hgw-btn--primary" href="/hall-of-fame" data-link>${icon('medal')}Voir le Hall of Fame</a>` : ''}
            ${!appState.user && (appState.oauthConfigured || appState.devMode) ? `<button type="button" class="hgw-btn hgw-btn--secondary" id="draft-login">Connexion organisateur</button>` : ''}
          </div>
        </div>
      </div>`;
    root.querySelector('#draft-login')?.addEventListener('click', openLogin);
    return;
  }

  if (!appState.user) {
    root.innerHTML = renderVisitorHome();
    root.querySelector('#hero-login')?.addEventListener('click', openLogin);
    root.querySelector('#hero-dev')?.addEventListener('click', () => $('dev-login-dialog').showModal());
    return;
  }

  const quests = appState.myDailyQuests || [];
  const minGames = cfg.min_selected_games || 4;
  const hasGames = (appState.mySelectedGames || []).length >= minGames;

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title" id="today-title">Salut ${esc(appState.user.display_name)}</h1>
        <p class="view-desc">${hasGames ? 'Voici ce qui t’attend aujourd’hui.' : `Coche au moins ${minGames} jeux pour recevoir tes premiers défis.`}</p>
      </div>
    </div>
    ${phaseTimeline()}
    ${cfg.effective_phase === 'closed' ? `<div class="banner banner--gold section">${icon('trophy')}<span>L’édition est terminée : les points sont gelés. Merci d’avoir joué !</span></div>` : ''}
    ${hasGames ? `<div class="hgw-card section">${renderTonight()}</div>` : ''}
    <div class="section">
      <div class="section-head">
        <h2 class="section-title">Tes défis du jour</h2>
        ${
          hasGames && cfg.daily_rerolls_max > 0
            ? `<span class="small muted">${appState.canRerollToday ? 'Relance disponible aujourd’hui' : 'Relance utilisée · prochaine demain à 3 h'}</span>`
            : ''
        }
      </div>
      ${
        hasGames
          ? quests.length
            ? `<div class="grid-3">${quests.map(questCard).join('')}</div>`
            : emptyCard('Pas de défi pour l’instant', 'Les défis sont tirés chaque nuit à 3 h.')
          : `<div class="banner banner--gold">${icon('target')}<span>Coche au moins <b>${minGames} jeux</b> ci-dessous puis enregistre : tes ${cfg.daily_quests_count || 3} défis arrivent tout de suite.</span></div>`
      }
    </div>
    ${hasGames ? `<div class="section"><h2 class="section-title">Ta progression</h2>${renderMyStats()}</div>` : ''}
    <div class="section" id="my-games">${renderGames()}</div>
  `;

  root.querySelectorAll('[data-proof]').forEach((b) => b.addEventListener('click', () => openDailyProof(Number(b.dataset.proof))));
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
  const cfg = appState.eventSettings || {};
  const lb = (appState.leaderboard || []).slice(0, 5);
  const canLogin = appState.oauthConfigured || appState.devMode;
  return `
    <div class="hgw-card hero">
      <div>
        <p class="hgw-stat__label t-gold">${esc(cfg.event_name || 'Hextaz Games Week')}</p>
        <h1 class="hero__title" id="today-title" style="margin-top: var(--space-2)">${esc(cfg.event_subtitle || 'Défis quotidiens et tournois live.')}</h1>
        <p class="hero__lead">Joue à ton rythme : ${cfg.daily_quests_count || 3} défis par jour sur tes jeux${cfg.featured?.enabled ? `, l’épreuve ${esc(cfg.featured.title)}` : ''}${(appState.tournaments || []).length ? ` et ${(appState.tournaments || []).length} tournois live pour finir` : ''}.</p>
        <div class="row" style="margin-top: var(--space-6)">
          ${appState.oauthConfigured ? `<button type="button" class="hgw-btn hgw-btn--primary hgw-btn--lg" id="hero-login">Se connecter avec Discord</button>` : ''}
          ${appState.devMode ? `<button type="button" class="hgw-btn hgw-btn--${appState.oauthConfigured ? 'ghost' : 'primary hgw-btn--lg'}" id="hero-dev">Connexion de test</button>` : ''}
          ${!canLogin ? `<span class="small muted">La connexion ouvrira bientôt.</span>` : ''}
          <a class="hgw-btn hgw-btn--ghost" href="/aide" data-link>Comment ça marche</a>
        </div>
      </div>
      <ol class="hero__steps">
        <li><span><b>Coche tes jeux</b><span class="muted small">Au moins ${cfg.min_selected_games || 4}, les jeux web gratuits sont inclus.</span></span></li>
        <li><span><b>Relève tes ${cfg.daily_quests_count || 3} défis du jour</b><span class="muted small">Envoie une capture, un orga valide, les points tombent.</span></span></li>
        <li><span><b>Grimpe au classement</b><span class="muted small">${fmt(appState.tombolaThreshold)} points = un ticket pour la tombola.</span></span></li>
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
  const nextFeat = closestFeaturedTier();
  if (nextFeat && items.length < 3) {
    items.push(['flag', `${esc(nextFeat.label)} sur <b>${esc(nextFeat.code)}</b>`, `+${nextFeat.gain}`]);
  }
  if (m && !m.tombola_eligible && items.length < 3) {
    items.push(['ticket', `Encore <b>${fmt(appState.tombolaThreshold - m.total_points)} pts</b> pour la tombola`, '']);
  }
  if (!items.length) items.push(['check', '<b>Tout est fait pour aujourd’hui.</b> Reviens après 3 h pour de nouveaux défis.', '']);

  return `<div class="hgw-card__head" style="margin-bottom: var(--space-3)"><h2 class="hgw-card__title">Ce soir</h2></div>
    <div class="tonight">${items
      .slice(0, 3)
      .map(([ic, txt, gain]) => `<div class="tonight__item">${icon(ic)}<span>${txt}</span>${gain ? `<span class="hgw-badge hgw-badge--points tonight__gain">${gain}</span>` : ''}</div>`)
      .join('')}</div>`;
}

function closestFeaturedTier() {
  const f = appState?.eventSettings?.featured;
  if (!f?.enabled || !f.stages_enabled || f.metric_type === 'binary') return null;
  const subs = new Map((appState.myFeaturedSubmissions || []).map((s) => [s.item_id, s]));
  const tiersAsc = [...(f.tiers || [])].sort((a, b) => a.points - b.points);
  let best = null;
  for (const item of (appState.featuredItems || []).filter((x) => !x.is_ladder)) {
    const sub = subs.get(item.id);
    if (!sub || sub.best_value === null) continue;
    const next = tiersAsc.find((t) => {
      const th = item.thresholds?.[t.key];
      if (th === undefined) return false;
      return f.metric_type === 'time_asc' ? sub.best_value > th : sub.best_value < th;
    });
    if (!next) continue;
    const th = item.thresholds[next.key];
    const gap = Math.abs(sub.best_value - th);
    const gain = next.points - (sub.best_points || 0);
    if (gain > 0 && (!best || gap < best.gap)) {
      best = { code: item.code, label: next.label, gap, gain };
    }
  }
  return best;
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
  const canReroll = appState.eventSettings?.daily_rerolls_max > 0;

  let actions = '';
  if (q.status === 'open') {
    actions = `<button type="button" class="hgw-btn hgw-btn--primary" data-proof="${q.id}">Envoyer ma preuve</button>
      ${
        canReroll
          ? `<button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--icon" data-reroll="${q.id}" ${appState.canRerollToday ? '' : 'disabled'}
              title="${appState.canRerollToday ? 'Relancer ce défi' : 'Prochaine relance demain à 3 h'}">${icon('dice')}</button>`
          : ''
      }`;
  } else if (q.status === 'rejected') {
    actions = `<button type="button" class="hgw-btn hgw-btn--primary" data-proof="${q.id}">Renvoyer une preuve</button>`;
  }

  return `<article class="hgw-quest ${st.cls}">
    <div class="hgw-quest__top">
      <span class="hgw-quest__game">${monogram(game, true)}${esc(q.game_name)} <span class="quota ${used >= cap ? 'is-full' : ''}">${used}/${cap}</span></span>
      ${st.badge}
    </div>
    <div>
      ${diffPips(q.difficulty)}
      <h3 class="hgw-quest__title" style="margin-top: var(--space-2)">${esc(plain(q.title))}</h3>
      <p class="hgw-quest__desc">${esc(plain(q.description))}</p>
      ${q.status === 'submitted' ? `<p class="small faint" style="margin-top: var(--space-2)">Envoyée ${esc(timeAgo(q.submitted_at))}.</p>` : ''}
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
  const maxDays = reg.tiers?.length ? reg.tiers[reg.tiers.length - 1].days : 12;
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
      <div class="hgw-split" style="margin-top: var(--space-2)"><span class="a" style="flex:${m.async_points || 0}"></span><span class="l" style="flex:${m.live_points || 0}"></span></div>
      <div class="hgw-stat__meta">Semaine ${fmt(m.async_points)} · week-end ${fmt(m.live_points)}</div>
    </div>
    <div class="hgw-stat">
      <div class="hgw-stat__label">Tombola</div>
      ${m.tombola_eligible ? `<div class="hgw-stat__value t-success">Qualifié</div><div class="hgw-stat__meta">Ton ticket est dans l’urne.</div>` : `<div class="hgw-stat__value">${fmt(left)}<small>pts restants</small></div><div class="hgw-progress"><span style="width:${m.tombola_progress_pct}%"></span></div>`}
    </div>
    <div class="hgw-stat">
      <div class="hgw-stat__label">Régularité</div>
      <div class="hgw-stat__value">${reg.activeDaysCount}<small>/ ${maxDays} j</small></div>
      <div class="tiers">${(reg.tiers || []).map((t) => `<span class="tier ${t.unlocked ? 'is-on' : ''}" title="${t.days} jours actifs : +${t.points} pts"><b>+${t.points}</b><span>${t.days} j</span></span>`).join('')}</div>
      ${nextTier || !reg.tiers?.length ? '' : `<div class="hgw-stat__meta">Tous les paliers débloqués (+${reg.totalBonusPoints}).</div>`}
    </div>
  </div>`;
}

function selectableGames() {
  return (appState.games || []).filter((g) => g.is_universal || (g.active !== 0 && g.active_quest_count > 0));
}

function renderGames() {
  const games = selectableGames();
  const minGames = appState.minSelectedGames || 4;
  const cap = appState.maxWeeklyQuestsPerGame || 4;
  const counts = appState.myWeeklyGameCounts || {};
  const selectedCount = games.filter((g) => !g.is_universal && selectedGameIds.has(g.id)).length;

  return `<div class="section-head">
      <div>
        <h2 class="section-title">Mes jeux</h2>
        <p class="small muted" style="margin-top: var(--space-1)">${selectedCount} coché${selectedCount > 1 ? 's' : ''} · minimum ${minGames} · ${cap} défis max par jeu et par semaine</p>
      </div>
      <button type="button" class="hgw-btn hgw-btn--${gamesDirty || (appState.mySelectedGames || []).length < minGames ? 'primary' : 'secondary'} hgw-btn--sm" id="save-games" ${gamesDirty ? '' : 'disabled'}>Enregistrer mes jeux</button>
    </div>
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
          <span><span class="game-tile__name">${esc(g.name)}</span><span class="game-tile__meta">${full ? 'Complet cette semaine' : on ? `${used}/${cap} cette semaine` : esc(plain(g.platforms))}</span></span>
          <span class="game-tile__check" aria-hidden="true">${on ? icon('check') : ''}</span>
        </button>`;
      })
      .join('')}</div>`;
}

function bindGames(root) {
  const minGames = appState.minSelectedGames || 4;
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
    if (n < minGames) return toast({ title: `Coche encore ${minGames - n} jeu${minGames - n > 1 ? 'x' : ''}`, text: `Il en faut au moins ${minGames}.`, type: 'danger' });
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

// ============================================================================
// CLASSEMENT
// ============================================================================
function lbRow(p, rank, withSplit = true, extra = '') {
  const isMe = p.id === appState.user?.id;
  const feat = appState.eventSettings?.featured;
  const featSub = feat?.enabled && feat.stages_enabled ? ` · ${p.featured_stages_count || 0} ${feat.connector === 'tmnf_gbx' ? 'médaille(s)' : 'épreuve(s)'}` : '';
  const sub = `${p.quests_validated || 0} défis${featSub}`;
  const left = appState.tombolaThreshold - p.total_points;
  return `<tr class="${isMe ? 'is-me' : ''} ${extra}" data-player="${esc(p.id)}">
    <td class="hgw-rank ${rank === 1 ? 'hgw-rank--1' : ''}">${rank}</td>
    <td><button type="button" class="linklike hgw-player" data-player-btn="${esc(p.id)}">
      ${avatar(p)}
      <span style="min-width:0"><span class="hgw-player__name">${esc(p.display_name)}${isMe ? ' <span class="hgw-badge" style="height:18px">toi</span>' : ''}</span><span class="hgw-player__sub" style="display:block">${sub}</span></span>
    </button></td>
    ${withSplit ? `<td class="split-cell"><div class="hgw-split" title="Semaine ${p.async_points} · week-end ${p.live_points}"><span class="a" style="flex:${p.async_points}"></span><span class="l" style="flex:${p.live_points}"></span></div></td>` : ''}
    <td class="r"><div class="hgw-pts">${fmt(p.total_points)}</div>${p.tombola_eligible ? `<div class="hgw-ticket">Tombola ✓</div>` : isMe ? `<div class="hgw-player__sub">${fmt(left)} pts avant tombola</div>` : ''}</td>
  </tr>`;
}

function renderLeaderboard() {
  const cfg = appState.eventSettings || {};
  const all = appState.leaderboard || [];
  $('lb-desc').innerHTML = `À partir de <b>${fmt(appState.tombolaThreshold)} points</b>, tu as un ticket pour la grande tombola (${esc(cfg.tombola_prize || 'Lot tombola')}). Clique sur un joueur pour voir le détail de ses points.`;
  $('lb-n-all').textContent = all.length;
  $('lb-n-tombola').textContent = all.filter((p) => p.tombola_eligible).length;

  const prizes = cfg.prizes || ['1re place', '2e place', '3e place'];
  const card = (p, place) => {
    const prize = prizes[place - 1] || `Top ${place}`;
    if (!p) return `<div class="podium__card is-empty is-${place}"><span class="podium__place">${place}${place === 1 ? 're' : 'e'} place</span><span class="muted">Place libre</span><span class="podium__prize">${esc(prize)}</span></div>`;
    return `<button type="button" class="podium__card is-${place}" data-player-btn="${esc(p.id)}">
      <span class="podium__place">${place}${place === 1 ? 're' : 'e'} place</span>
      <span class="row" style="gap: var(--space-3)">${avatar(p, 'hgw-avatar--lg')}<span><span class="hgw-player__name" style="font-size:16px;display:block">${esc(p.display_name)}</span><span class="hgw-player__sub">${place > 1 && all[0] ? `${fmt(all[0].total_points - p.total_points)} pts derrière` : 'En tête'}</span></span></span>
      <span class="podium__pts">${fmt(p.total_points)} <small class="muted" style="font-size:14px">pts</small></span>
      <span class="podium__prize">${icon('gift')} ${esc(prize)}</span>
    </button>`;
  };
  $('podium').innerHTML = card(all[1], 2) + card(all[0], 1) + card(all[2], 3);

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
// JEU VEDETTE ADAPTATIF (Connecteur Trackmania GBX ou Standard Preuve)
// ============================================================================
function renderFeatured() {
  const root = $('view-featured');
  const cfg = appState.eventSettings || {};
  const f = cfg.featured;
  if (!f?.enabled) {
    root.innerHTML = emptyCard('Aucun jeu vedette', 'Cette édition ne propose pas de jeu vedette.');
    return;
  }

  const isTmnf = f.connector === 'tmnf_gbx';
  const items = appState.featuredItems || [];
  const ladderItem = items.find((i) => i.is_ladder);
  const stageItems = items.filter((i) => !i.is_ladder);
  const ladderRows = appState.featuredLadder || [];
  const subs = new Map((appState.myFeaturedSubmissions || []).map((s) => [s.item_id, s]));

  const unlocked = Boolean(cfg.ladder_unlocked);
  const locked = Boolean(cfg.ladder_locked);
  const unlockAct = (cfg.acts || []).find((a) => a.index === f.ladder_unlock_act);

  let ladderStateBadge = `<span class="hgw-badge">${icon('lock')}${esc(unlockAct?.name || `Acte ${f.ladder_unlock_act}`)}</span>`;
  if (unlocked) ladderStateBadge = `<span class="hgw-badge hgw-badge--success"><span class="hgw-badge__dot"></span>Ouvert</span>`;
  else if (locked) ladderStateBadge = `<span class="hgw-badge">Terminé</span>`;

  const topScalePreview = (f.ladder_points_scale || []).slice(0, 5).join(' · ');

  const safeJoinUrl = safeUrl(f.server_info?.join_url, ['https:', 'http:', 'tmtp:']);
  const ladderCard = f.ladder_enabled
    ? `<div class="hgw-card">
        <div class="hgw-card__head">
          <div>
            <h2 class="hgw-card__title">${esc(f.ladder_title || 'Ladder')}</h2>
            <p class="hgw-card__desc">Top ${(f.ladder_points_scale || []).length} : ${esc(topScalePreview)} pts${f.ladder_cutoff_at ? ` · jusqu’au ${esc(fmtDate(f.ladder_cutoff_at))}` : ''}</p>
          </div>
          ${ladderStateBadge}
        </div>
        ${
          unlocked && f.server_info?.enabled && f.server_info?.address
            ? `<div class="addr"><div><div class="hgw-stat__label">${esc(f.server_info.label || 'Serveur')}</div><div class="addr__v">${esc(f.server_info.address)}</div></div>
                <div class="row"><button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--sm" id="copy-feat-addr">${icon('copy')}Copier</button>
                ${safeJoinUrl ? `<a class="hgw-btn hgw-btn--primary hgw-btn--sm" href="${esc(safeJoinUrl)}">${icon('play')}Rejoindre</a>` : ''}</div></div>`
            : !unlocked && !locked
            ? `<div class="banner">${icon('lock')}<span>Ouvre au début de ${esc(unlockAct?.name || `l’Acte ${f.ladder_unlock_act}`)}${unlockAct?.start_at ? `, le ${esc(fmtDate(unlockAct.start_at))}` : ''}.</span></div>`
            : locked
            ? `<div class="banner">${icon('flag')}<span>Le ${esc(f.ladder_title)} est terminé : le classement est figé.</span></div>`
            : ''
        }
        ${
          !isTmnf && unlocked && ladderItem
            ? `<div class="row" style="margin-top: var(--space-3)">
                <button type="button" class="hgw-btn hgw-btn--primary hgw-btn--sm" data-feat-submit="${esc(ladderItem.id)}">Soumettre un résultat au ${esc(f.ladder_title)}</button>
                <span class="small muted">${esc(plain(ladderItem.name))}</span>
              </div>`
            : ''
        }
        <div class="table-wrap" style="margin-top: var(--space-4)">
          <table class="hgw-table">
            <thead><tr><th>#</th><th>Joueur</th><th class="r">Résultat</th><th class="r">Points</th></tr></thead>
            <tbody>${
              ladderRows.length
                ? ladderRows
                    .slice(0, 10)
                    .map(
                      (r) => `<tr class="${r.user_id === appState.user?.id ? 'is-me' : ''}"><td class="hgw-rank ${r.rank === 1 ? 'hgw-rank--1' : ''}">${r.rank}</td><td class="hgw-player__name">${esc(r.display_name)}</td><td class="r hgw-num">${esc(r.formatted_value)}</td><td class="r"><span class="hgw-badge hgw-badge--points">+${r.projected_points}</span></td></tr>`
                    )
                    .join('')
                : `<tr><td colspan="4"><div class="hgw-empty" style="padding: var(--space-5)">${unlocked ? '<strong>Aucun résultat</strong>Sois le premier à poser une marque.' : '<strong>Pas encore ouvert</strong>Démarre bientôt.'}</div></td></tr>`
            }</tbody>
          </table>
        </div>
      </div>`
    : '';

  const tmnfUploadCard = isTmnf
    ? `<div class="hgw-card">
        <div class="hgw-card__head">
          <div>
            <h2 class="hgw-card__title">Envoyer mes replays</h2>
            <p class="hgw-card__desc">Vérification automatique, points crédités tout de suite.</p>
          </div>
        </div>
        <label class="hgw-drop" id="gbx-drop" for="gbx-input">
          ${icon('upload')}
          <span class="hgw-drop__title">Glisse tes fichiers .Replay.gbx</span>
          <span class="hgw-drop__hint">ou clique pour parcourir · jusqu’à 12 fichiers<br />Documents\\TrackMania\\Tracks\\Replays</span>
          <input type="file" id="gbx-input" accept=".gbx" multiple hidden />
        </label>
        <div class="hgw-files" id="gbx-results" aria-live="polite"></div>
        <form id="tmnf-login-form" class="hgw-field" style="margin-top: var(--space-5)">
          <label class="hgw-field__label" for="tmnf-login-input">Ton login Trackmania</label>
          <div class="row" style="flex-wrap: nowrap">
            <input id="tmnf-login-input" class="hgw-input hgw-input--mono" value="${esc(appState.user?.tmnf_login || '')}" placeholder="ex. hextaz_tm" autocomplete="off" maxlength="40" />
            <button type="submit" class="hgw-btn hgw-btn--secondary">Lier</button>
          </div>
          <span class="hgw-field__help">${esc(f.server_info?.help_text || 'Visible en haut à droite du menu du jeu.')}</span>
        </form>
      </div>`
    : '';

  const topBlock =
    ladderCard && tmnfUploadCard
      ? `<div class="grid-2">${ladderCard}${tmnfUploadCard}</div>`
      : ladderCard || tmnfUploadCard;

  const maxTierPts = Math.max(0, ...(f.tiers || []).map((t) => t.points));
  const totalEarned = stageItems.reduce((acc, it) => acc + (subs.get(it.id)?.best_points || 0), 0);
  const totalMax = stageItems.length * maxTierPts;
  const tiersDesc = [...(f.tiers || [])].sort((a, b) => b.points - a.points);
  const medalDotClass = { author: 'm-author', gold: 'm-gold', silver: 'm-silver', bronze: 'm-bronze' };

  const stagesBlock = f.stages_enabled
    ? `<div class="section">
        <div class="section-head">
          <h2 class="section-title">${esc(f.stages_title || 'Épreuves')}</h2>
          <span class="hgw-badge hgw-badge--points">${totalEarned} / ${totalMax} pts</span>
        </div>
        ${
          stageItems.length
            ? `<div class="grid-auto">${stageItems
                .map((m) => {
                  const sub = subs.get(m.id);
                  const myVal = sub?.best_value ?? null;
                  const pts = sub?.best_points || 0;
                  const pending = sub?.pending;

                  let tiersHtml = '';
                  if (f.metric_type !== 'binary') {
                    tiersHtml = `<div class="hgw-medals--dynamic">${tiersDesc
                      .map((t) => {
                        const th = m.thresholds?.[t.key];
                        const got =
                          myVal !== null &&
                          th !== undefined &&
                          (f.metric_type === 'time_asc' ? myVal <= th : myVal >= th);
                        const dot = medalDotClass[t.key] ? `<i class="${medalDotClass[t.key]}"></i>` : '';
                        return `<div class="hgw-medal ${got ? 'got' : ''}">
                          <div class="hgw-medal__k">${dot}${esc(t.label)}</div>
                          <div class="hgw-medal__t">${th !== undefined ? esc(formatMetric(th, f.metric_type, f.metric_unit)) : '—'}</div>
                        </div>`;
                      })
                      .join('')}</div>`;
                  } else if (m.description) {
                    tiersHtml = `<p class="small muted">${esc(m.description)}</p>`;
                  }

                  let statusLine = '';
                  if (pending?.status === 'pending') {
                    statusLine = `<span class="hgw-badge hgw-badge--info"><span class="hgw-badge__dot"></span>Preuve en vérification</span>`;
                  } else if (pending?.status === 'rejected') {
                    statusLine = `<span class="hgw-badge hgw-badge--danger" title="${esc(pending.reject_reason || '')}">Refusée · renvoyer</span>`;
                  }

                  const pb =
                    myVal !== null
                      ? `<span>Ton meilleur <b class="hgw-num" style="color:var(--ink-1)">${esc(formatMetric(myVal, f.metric_type, f.metric_unit))}</b></span>`
                      : `<span>Pas encore validé</span>`;
                  const wr = m.wr_formatted
                    ? `<span class="small muted">Record ${esc(m.wr_holder)} <b class="hgw-num" style="color:var(--ink-1)">${esc(m.wr_formatted)}</b></span>`
                    : '';

                  return `<article class="hgw-track">
                    <div class="hgw-track__head">
                      <div><span class="hgw-track__code">${esc(m.code)}</span><h3 class="hgw-track__name">${esc(trackName(m))}</h3></div>
                      <span class="hgw-badge ${pts ? 'hgw-badge--points' : ''}">${pts} / ${maxTierPts}</span>
                    </div>
                    ${tiersHtml}
                    <div class="hgw-track__pb">${pb}${wr}${statusLine}</div>
                    <div class="row">
                      ${!isTmnf ? `<button type="button" class="hgw-btn hgw-btn--primary hgw-btn--sm" data-feat-submit="${esc(m.id)}">Soumettre une preuve</button>` : ''}
                      <button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--sm" data-track="${esc(m.id)}">Classement</button>
                      ${isTmnf && appState.devMode && appState.user ? `<a class="hgw-btn hgw-btn--ghost hgw-btn--sm" href="/api/tmnf/sample-replay/${encodeURIComponent(m.id)}">Replay test</a>` : ''}
                    </div>
                  </article>`;
                })
                .join('')}</div>`
            : emptyCard('Aucune épreuve configurée', 'Ajoute des épreuves dans Organisation › Jeu vedette.')
        }
      </div>`
    : '';

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title" id="feat-title">${esc(f.title)}</h1>
        <p class="view-desc">${esc(f.subtitle || '')}</p>
      </div>
      <div class="row">
        ${isTmnf ? `<button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--sm" id="copy-replays-btn">${icon('copy')}Copier le dossier des replays</button>` : ''}
        <a href="/aide" class="hgw-btn hgw-btn--ghost hgw-btn--sm" data-link>${icon('help')}Comment ça marche</a>
      </div>
    </div>
    ${topBlock}
    ${stagesBlock}`;

  $('copy-feat-addr')?.addEventListener('click', () => copyText(f.server_info.address, 'Adresse copiée'));
  $('copy-replays-btn')?.addEventListener('click', () => copyText(REPLAYS_PATH, 'Chemin copié'));
  root.querySelectorAll('[data-track]').forEach((b) => b.addEventListener('click', () => openTrack(b.dataset.track)));
  root.querySelectorAll('[data-feat-submit]').forEach((b) => b.addEventListener('click', () => openFeaturedProof(b.dataset.featSubmit)));

  if (isTmnf) {
    const drop = $('gbx-drop');
    $('gbx-input')?.addEventListener('change', (e) => uploadReplays(e.target.files));
    drop?.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
    drop?.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop?.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      uploadReplays(e.dataTransfer?.files);
    });
    $('tmnf-login-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!appState?.user) return openLogin();
      const tmnfLogin = $('tmnf-login-input').value.trim();
      if (!tmnfLogin) return $('tmnf-login-input').focus();
      const { ok, data } = await api('/api/profile/tmnf-login', { json: { tmnfLogin } });
      if (!ok) return toastError(data);
      toast({ title: 'Login Trackmania lié', text: `${tmnfLogin} enregistré.`, type: 'success' });
      fetchState();
    });
  }
}

async function uploadReplays(files) {
  if (!appState?.user) return openLogin();
  const list = Array.from(files || []).filter((f) => /\.gbx$/i.test(f.name));
  if (!list.length) return toast({ title: 'Aucun fichier .Replay.gbx', type: 'danger' });
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
        ? `<div class="hgw-file"><span class="hgw-file__name">${esc(r.mapCode)} · ${esc(r.formattedTime)}</span><span class="hgw-badge ${r.deltaPoints > 0 ? 'hgw-badge--success' : ''}">${esc(r.medal)}${r.deltaPoints > 0 ? ` · +${r.deltaPoints}` : ' · pas mieux'}</span></div>`
        : `<div class="hgw-file"><span class="hgw-file__name">${esc(r.fileName)}</span><span class="hgw-badge hgw-badge--danger" title="${esc(plain(r.error))}">${esc(plain(r.error)).slice(0, 48)}</span></div>`
    )
    .join('');
  toast({
    title: data.totalDeltaPoints > 0 ? `+${data.totalDeltaPoints} pts · ${data.validCount} replay(s)` : `${data.validCount} replay(s) analysé(s)`,
    type: data.errorCount ? 'danger' : data.totalDeltaPoints > 0 ? 'points' : 'success',
  });
  $('gbx-input').value = '';
  fetchState();
}

async function openTrack(itemId) {
  const { ok, data } = await api(`/api/featured/${encodeURIComponent(itemId)}/leaderboard`);
  if (!ok) return toastError(data);
  const f = appState.eventSettings?.featured || {};
  const isTmnf = f.connector === 'tmnf_gbx';
  const m = data.item || data.map;
  const entries = data.entries || [];
  $('track-title').textContent = `${m.code} · ${trackName(m)}`;
  $('track-sub').textContent =
    f.metric_type === 'binary'
      ? m.description || 'Validation simple'
      : (f.tiers || [])
          .filter((t) => m.thresholds?.[t.key] !== undefined)
          .map((t) => `${t.label} ${formatMetric(m.thresholds[t.key], f.metric_type, f.metric_unit)}`)
          .join(' · ');

  $('track-wr').innerHTML = entries.length
    ? `<div class="banner banner--gold">${icon('trophy')}<span style="flex:1">Record : <b>${esc(entries[0].display_name)}</b> · <b class="hgw-num">${esc(entries[0].formatted_value)}</b></span>
        ${isTmnf ? `<a class="hgw-btn hgw-btn--secondary hgw-btn--sm" href="/api/tmnf/map/${encodeURIComponent(m.id)}/ghost/${encodeURIComponent(entries[0].user_id)}">${icon('download')}Ghost du record</a>` : ''}</div>`
    : '';
  $('track-tbody').innerHTML = entries.length
    ? entries
        .map(
          (e) => `<tr class="${e.user_id === appState.user?.id ? 'is-me' : ''}"><td class="hgw-rank ${e.rank === 1 ? 'hgw-rank--1' : ''}">${e.rank}</td><td class="hgw-player__name">${esc(e.display_name)}</td>
          <td class="r hgw-num">${esc(e.formatted_value)}</td>
          <td class="r hgw-delta">${e.delta_wr_ms === 0 ? 'record' : f.metric_type === 'time_asc' ? deltaSec(e.delta_wr_ms) : `−${fmt(e.delta_wr_ms)}`}</td>
          <td><span class="hgw-badge">${esc(e.tier_label || '—')}</span></td>
          <td class="r">${isTmnf ? `<a class="hgw-btn hgw-btn--ghost hgw-btn--sm" href="/api/tmnf/map/${encodeURIComponent(m.id)}/ghost/${encodeURIComponent(e.user_id)}">${icon('download')}Ghost</a>` : ''}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="6"><div class="hgw-empty"><strong>Aucun résultat</strong>Sois le premier à te classer sur cette épreuve.</div></td></tr>`;
  $('track-dialog').showModal();
}

// ============================================================================
// TOURNOIS
// ============================================================================
function renderTournaments() {
  const ts = appState.tournaments || [];
  const myId = appState.user?.id;
  const hasTeamTourney = ts.some((t) => t.team_size > 1);
  $('t-desc').textContent = ts.length
    ? `${ts.length} tournoi${ts.length > 1 ? 's' : ''} live pour jouer ensemble.${hasTeamTourney ? ' Pour les tournois en équipes, les équipes sont équilibrées par chapeaux.' : ''}`
    : 'Aucun tournoi programmé pour cette édition.';

  $('tournaments-grid').innerHTML = ts.length
    ? ts
        .map((t) => {
          const mine = t.registrations.some((r) => r.user_id === myId);
          const teams = teamsOf(t);
          const isTeam = t.team_size > 1;
          const gameObj = (appState.games || []).find((g) => g.id === t.game_id) || { name: tName(t) };
          const safeBracket = safeUrl(t.bracket_url);
          return `<article class="hgw-card">
            <div class="hgw-card__head">
              <div class="row" style="gap: var(--space-3); flex-wrap: nowrap">${monogram(gameObj)}
                <div><h2 class="hgw-card__title">${esc(tName(t))}</h2><p class="hgw-card__desc">${esc(plain(t.scheduled_label))}</p></div></div>
              <span class="hgw-badge hgw-badge--points">1er · ${t.points_scale?.['1'] ?? 0}</span>
            </div>
            <p class="muted">${esc(plain(t.mode_label))}</p>
            <div class="row-between" style="margin-top: var(--space-4)">
              <div class="row">
                <span class="small muted">${t.registrations.length} inscrit${t.registrations.length > 1 ? 's' : ''}</span>
                ${safeBracket ? `<a href="${esc(safeBracket)}" target="_blank" rel="noopener noreferrer" class="hgw-btn hgw-btn--ghost hgw-btn--sm">${icon('external')}Bracket</a>` : ''}
              </div>
              <button type="button" class="hgw-btn ${mine ? 'hgw-btn--secondary' : 'hgw-btn--primary'} hgw-btn--sm" data-toggle-t="${esc(t.id)}">${mine ? `${icon('check')}Inscrit · se désinscrire` : 'M’inscrire'}</button>
            </div>
            ${t.registrations.length ? `<div class="row" style="margin-top: var(--space-3)">${t.registrations.map((r) => `<span class="hgw-badge" title="${isTeam ? `Chapeau ${r.pool}` : ''}">${esc(r.display_name)}${isTeam ? ` · C${r.pool}` : ''}</span>`).join('')}</div>` : ''}
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
        .join('')
    : emptyCard('Aucun tournoi actif', 'Les tournois apparaîtront ici dès qu’ils seront programmés.');

  $('tournaments-grid')
    .querySelectorAll('[data-toggle-t]')
    .forEach((b) =>
      b.addEventListener('click', async () => {
        if (!appState.user) return openLogin();
        b.disabled = true;
        const { ok, data } = await api(`/api/tournaments/${encodeURIComponent(b.dataset.toggleT)}/toggle`, { method: 'POST' });
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
// HALL OF FAME (Éditions archivées)
// ============================================================================
function renderHof() {
  const root = $('view-hof');
  const archives = appState.archivedEditions || [];
  if (!archives.length) {
    root.innerHTML = `<div class="view-head"><div><h1 class="view-title" id="hof-title">Hall of Fame</h1><p class="view-desc">Les éditions passées archivées apparaîtront ici.</p></div></div>${emptyCard('Aucune édition archivée', 'Le palmarès s’affichera dès la première clôture.')}`;
    return;
  }

  if (!archives.find((a) => a.id === hofSelectedId)) hofSelectedId = archives[0].id;
  const active = archives.find((a) => a.id === hofSelectedId);
  const snap = active.snapshot;
  const isAdmin = appState.user?.is_admin === 1;

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title" id="hof-title">Hall of Fame</h1>
        <p class="view-desc">Archives officielles des éditions passées.</p>
      </div>
      ${isAdmin ? `<button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--sm" id="hof-delete">${icon('trash')}Supprimer cette archive</button>` : ''}
    </div>
    ${
      archives.length > 1
        ? `<div class="hgw-seg" style="margin-bottom: var(--space-5)" id="hof-seg">${archives
            .map((a) => `<button type="button" data-hof="${esc(a.id)}" aria-pressed="${a.id === hofSelectedId}">${esc(a.name)}</button>`)
            .join('')}</div>`
        : ''
    }
    <div class="stack">
      <div class="hgw-card hof-card">
        <div class="hgw-card__head">
          <div>
            <h2 class="hgw-card__title">${esc(active.name)}</h2>
            <p class="hgw-card__desc">${esc(active.subtitle || '')} · ${snap.stats?.total_users || 0} joueurs · ${fmt(snap.stats?.total_quests_validated || 0)} défis validés · ${fmt(snap.stats?.total_points || 0)} pts distribués</p>
          </div>
          ${snap.tombola_winner ? `<span class="hgw-badge hgw-badge--points">${icon('ticket')}Tombola : ${esc(snap.tombola_winner.display_name)}</span>` : ''}
        </div>
        <div class="hof-podium">
          ${[0, 1, 2]
            .map((i) => {
              const p = snap.podium?.[i];
              if (!p) return '';
              return `<div class="hgw-stat"><div class="hgw-stat__label">${i + 1}${i === 0 ? 're' : 'e'} place · ${esc(snap.prizes?.[i] || '')}</div>
                <div class="hgw-stat__value ${i === 0 ? 'hgw-stat__value--gold' : ''}" style="font-size:20px">${esc(p.display_name)}</div>
                <div class="hgw-stat__meta">${fmt(p.total_points)} pts (Semaine ${fmt(p.async_points)} · Live ${fmt(p.live_points)})</div></div>`;
            })
            .join('')}
        </div>
      </div>

      <div class="grid-2">
        <div class="hgw-card">
          <div class="hgw-card__head"><h2 class="hgw-card__title">Classement final</h2></div>
          <div class="table-wrap"><table class="hgw-table">
            <thead><tr><th>#</th><th>Joueur</th><th class="r">Points</th></tr></thead>
            <tbody>${(snap.leaderboard || [])
              .slice(0, 20)
              .map(
                (p) => `<tr><td class="hgw-rank ${p.rank === 1 ? 'hgw-rank--1' : ''}">${p.rank}</td><td class="hgw-player__name">${esc(p.display_name)}</td><td class="r hgw-pts">${fmt(p.total_points)}</td></tr>`
              )
              .join('')}</tbody>
          </table></div>
        </div>

        <div class="stack">
          ${
            snap.tournaments?.length
              ? `<div class="hgw-card"><div class="hgw-card__head"><h2 class="hgw-card__title">Tournois live</h2></div>
                  <div class="stack-sm">${snap.tournaments
                    .map(
                      (t) => `<div class="hgw-stat"><div class="body-strong">${esc(plain(t.name))}</div>
                        <div class="small muted">${t.top_players?.length ? t.top_players.slice(0, 3).map((tp) => `#${tp.placement || '?'} ${esc(tp.display_name)}`).join(' · ') : 'Aucun résultat enregistré'}</div></div>`
                    )
                    .join('')}</div></div>`
              : ''
          }
          ${
            snap.featured?.enabled && snap.featured.ladder_top?.length
              ? `<div class="hgw-card"><div class="hgw-card__head"><h2 class="hgw-card__title">${esc(snap.featured.title)} · ${esc(snap.featured.ladder_title)}</h2></div>
                  <div class="stack-sm">${snap.featured.ladder_top
                    .slice(0, 5)
                    .map((r) => `<div class="row-between small"><span>#${r.rank} <b>${esc(r.display_name)}</b></span><span class="hgw-num">${esc(r.formatted_value || r.formatted_time)}</span></div>`)
                    .join('')}</div></div>`
              : ''
          }
        </div>
      </div>
    </div>`;

  $('hof-seg')
    ?.querySelectorAll('[data-hof]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        hofSelectedId = b.dataset.hof;
        renderHof();
      })
    );

  $('hof-delete')?.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Supprimer cette archive ?',
      message: `Supprimer définitivement l’archive « ${active.name} » ?`,
      confirmLabel: 'Supprimer',
    });
    if (!confirmed) return;
    const { ok, data } = await api(`/api/admin/editions/${encodeURIComponent(active.id)}`, { method: 'DELETE' });
    if (!ok) return toastError(data);
    hofSelectedId = null;
    toast({ title: 'Archive supprimée', type: 'success' });
    fetchState();
  });
}

// ============================================================================
// AIDE (100% DYNAMIQUE)
// ============================================================================
function renderHelp() {
  const root = $('view-aide');
  const cfg = appState.eventSettings || {};
  const f = cfg.featured || {};
  const qp = cfg.quest_points || { easy: 10, medium: 15, hard: 25 };
  const regTiers = cfg.regularity_tiers || [];
  const ts = appState.tournaments || [];
  const stageCount = (appState.featuredItems || []).filter((i) => !i.is_ladder).length;

  const featuredHelpCard = f.enabled
    ? `<div class="hgw-card">
        <div class="hgw-card__head"><h2 class="hgw-card__title">${esc(f.title)} (jeu vedette)</h2></div>
        <ol>
          ${f.stages_enabled ? `<li><b>${esc(f.stages_title)} (${stageCount} épreuve${stageCount > 1 ? 's' : ''}) :</b> ${(f.tiers || []).map((t) => `${esc(t.label)} ${t.points} pts`).join(' · ')}.</li>` : ''}
          ${
            f.connector === 'tmnf_gbx'
              ? `<li><b>Envoie tes replays .Replay.gbx</b> depuis <code>Documents\\TrackMania\\Tracks\\Replays</code> : validation et points instantanés.</li>`
              : `<li><b>Envoie une preuve</b> (capture/clip + résultat si demandé) depuis l’onglet ${esc(f.title)} : validation par un orga.</li>`
          }
          ${
            f.ladder_enabled
              ? `<li><b>${esc(f.ladder_title)} :</b> ouvre à l’Acte ${f.ladder_unlock_act}${f.ladder_cutoff_at ? ` jusqu’au ${esc(fmtDate(f.ladder_cutoff_at))}` : ''}. Top ${(f.ladder_points_scale || []).length} : ${(f.ladder_points_scale || []).slice(0, 5).join(', ')} pts…</li>`
              : ''
          }
        </ol>
      </div>`
    : '';

  const scheduleRows = [
    ...ts.map(
      (t) =>
        `<div class="schedule__row"><span class="schedule__when">${esc(plain(t.scheduled_label) || 'À définir')}</span><span>${esc(tName(t))}</span><span class="hgw-badge hgw-badge--points">1er · ${t.points_scale?.['1'] ?? 0}</span></div>`
    ),
    `<div class="schedule__row"><span class="schedule__when">${esc(fmtDate(cfg.end_at))}</span><span>Clôture, podium final & tirage de la tombola</span><span></span></div>`,
  ];

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title" id="help-title">Aide · ${esc(cfg.event_name || 'HGW')}</h1>
        <p class="view-desc">Toutes les règles de l’édition en cours, mises à jour automatiquement.</p>
      </div>
    </div>
    <div class="grid-2">
      <div class="hgw-card">
        <div class="hgw-card__head"><h2 class="hgw-card__title">Les défis du jour</h2></div>
        <ul>
          <li><b>Coche au moins ${cfg.min_selected_games || 4} jeux.</b> Les jeux web gratuits sont inclus d’office.</li>
          <li><b>Chaque nuit à 3 h</b>, tu reçois ${cfg.daily_quests_count || 3} défis : Facile (${qp.easy} pts), Moyen (${qp.medium} pts), Difficile (${qp.hard} pts).</li>
          <li><b>Envoie une preuve</b> : capture avec <kbd>Win</kbd> + <kbd>Maj</kbd> + <kbd>S</kbd>, puis <kbd>Ctrl</kbd> + <kbd>V</kbd> dans la fenêtre d’envoi.</li>
          ${cfg.daily_rerolls_max > 0 ? `<li><b>Relance :</b> ${cfg.daily_rerolls_max} reroll gratuit par jour (même difficulté).</li>` : ''}
          <li><b>Cap par jeu :</b> ${cfg.max_quests_per_game_per_act || 4} défis max par jeu et par semaine.</li>
          ${regTiers.length ? `<li><b>Régularité :</b> ${regTiers.map((t) => `${t.days} j = +${t.points} pts`).join(' · ')}.</li>` : ''}
        </ul>
      </div>
      ${featuredHelpCard}
      <div class="hgw-card">
        <div class="hgw-card__head"><h2 class="hgw-card__title">Lots & Tombola</h2></div>
        <ul>
          ${(cfg.prizes || []).map((pr, i) => `<li><b>${i + 1}${i === 0 ? 're' : 'e'} place :</b> ${esc(pr)}</li>`).join('')}
          <li><b>Grande Tombola :</b> ${esc(cfg.tombola_prize || 'Lot surprise')} — accessible dès <b>${fmt(appState.tombolaThreshold)} points</b>.</li>
        </ul>
      </div>
      <div class="hgw-card">
        <div class="hgw-card__head"><h2 class="hgw-card__title">Planning des tournois & clôture</h2></div>
        <div class="schedule">${scheduleRows.join('')}</div>
      </div>
    </div>`;
}

// ============================================================================
// DIALOGUES JOUEUR (Preuve Quotidienne / Preuve Vedette / Historique)
// ============================================================================
function resetProofDialog() {
  pastedProofFile = null;
  $('proof-form').reset();
  $('proof-preview').hidden = true;
  $('proof-drop-title').textContent = 'Colle une capture (Ctrl+V) ou glisse un fichier';
  $('proof-drop').classList.remove('is-over');
  $('proof-error').textContent = '';
}

function openDailyProof(id) {
  const q = (appState.myDailyQuests || []).find((x) => x.id === id);
  if (!q) return;
  resetProofDialog();
  $('proof-mode').value = 'daily';
  $('proof-assignment-id').value = id;
  $('proof-metric-wrap').hidden = true;
  $('proof-title').textContent = q.status === 'rejected' ? 'Renvoyer une preuve' : 'Envoyer ma preuve';
  $('proof-context').textContent = `${plain(q.title)} · ${q.game_name} · +${q.points} pts`;
  $('proof-hint').innerHTML = `${icon('info')}<span>${esc(plain(q.proof_hint) || 'Capture de l’écran de fin de partie ou clip court.')}</span>`;
  $('proof-dialog').showModal();
}

function openFeaturedProof(itemId) {
  if (!appState?.user) return openLogin();
  const f = appState.eventSettings?.featured;
  const item = (appState.featuredItems || []).find((x) => x.id === itemId);
  if (!f || !item) return;
  resetProofDialog();
  $('proof-mode').value = 'featured';
  $('proof-assignment-id').value = itemId;
  $('proof-title').textContent = `Soumettre · ${item.code}`;
  $('proof-context').textContent = `${f.title} · ${plain(item.name)}`;
  $('proof-hint').innerHTML = `${icon('info')}<span>${esc(item.description || 'Envoie une capture ou un clip montrant ton résultat : un orga validera ta preuve.')}</span>`;

  const needMetric = f.metric_type !== 'binary';
  $('proof-metric-wrap').hidden = !needMetric;
  if (needMetric) {
    $('proof-metric-label').textContent = f.metric_type === 'time_asc' ? 'Ton chrono' : `Ton score${f.metric_unit ? ` (${f.metric_unit})` : ''}`;
    $('proof-metric').placeholder = f.metric_type === 'time_asc' ? 'ex. 0:42.500' : 'ex. 125000';
    $('proof-metric-help').textContent = f.metric_type === 'time_asc' ? 'Format M:SS.mmm (ex. 1:12.450) ou secondes.' : 'Indique le score exact visible sur ta preuve.';
  }
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
          (e) => `<div class="feed__item"><div><div class="feed__who" style="font-weight:500">${esc(plain(e.label))}</div><div class="feed__what">${e.category === 'live' ? 'Week-end live' : 'Semaine'} · ${esc(timeAgo(e.updated_at))}</div></div><span class="hgw-badge hgw-badge--points">${signed(e.points)}</span></div>`
        )
        .join('')
    : `<div class="hgw-empty"><strong>Aucun point pour l’instant</strong>${isMe ? 'Relève un défi pour marquer tes premiers points.' : ''}</div>`;
  $('ledger-dialog').showModal();
}

// ============================================================================
// SCÈNES STREAM (Tirage d'équipes dynamique + Tombola)
// ============================================================================
function openTeamsStage(tourneyId) {
  const allT = appState?.admin?.allTournaments || appState?.tournaments || [];
  const t = allT.find((x) => x.id === tourneyId) || allT.find((x) => x.team_size > 1);
  if (!t) return;
  stageTourneyId = t.id;
  $('teams-stage-sub').textContent = `${tName(t)} · Équipes ${t.team_size}v${t.team_size}`;
  const pools = [1, 2, 3].map((n) => t.registrations.filter((r) => r.pool === n));
  $('stage-pools').innerHTML = pools
    .map(
      (list, i) =>
        `<div class="hgw-card hgw-card--flat"><div class="hgw-stat__label" style="margin-bottom: var(--space-2)">Chapeau ${i + 1}</div><div class="row">${list.map((p) => `<span class="hgw-badge">${esc(p.display_name)}</span>`).join('') || '<span class="faint small">Vide</span>'}</div></div>`
    )
    .join('');
  const teams = teamsOf(t);
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
  const thr = appState?.tombolaThreshold || 300;
  $('tombola-status').textContent = `${qualified.length} joueur${qualified.length > 1 ? 's' : ''} dans l’urne · ${fmt(thr)} pts et plus`;
  $('tombola-wheel').className = 'wheel';
  $('tombola-wheel').textContent = qualified.length ? 'Prêt pour le tirage' : `Personne n’a encore atteint ${fmt(thr)} pts`;
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
// TEMPS RÉEL SSE
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
      if (payload.type === 'catalog_updated') markCatalogStale();
      if (payload.message) toast({ title: plain(payload.message), type: payload.type === 'points_updated' ? 'points' : 'info' });
      scheduleFetch();
    } catch (err) {
      console.warn('SSE message ignoré:', err);
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

  initAdmin({
    getState: () => appState,
    getRoute: () => route,
    fetchState,
    scheduleFetch,
    renderUser,
    openTeamsStage,
    openTombolaStage,
    phaseInfo,
  });

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

  document.querySelectorAll('dialog').forEach((d) => {
    d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
  });

  // Classement
  $('lb-filters')
    .querySelectorAll('[data-filter]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        leaderboardFilter = b.dataset.filter;
        $('lb-filters')
          .querySelectorAll('[data-filter]')
          .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        renderLeaderboard();
      })
    );
  $('lb-search').addEventListener('input', (e) => {
    leaderboardSearch = e.target.value || '';
    renderLeaderboard();
  });

  // Preuve (quotidienne ou vedette)
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
    const mode = $('proof-mode').value;
    const targetId = $('proof-assignment-id').value;
    const url = $('proof-url').value.trim();
    if (!pastedProofFile && !url) {
      $('proof-error').textContent = 'Ajoute une capture, un fichier ou un lien.';
      return;
    }

    const fd = new FormData();
    if (pastedProofFile) fd.append('proofFile', pastedProofFile);
    fd.append('proofUrl', url);
    fd.append('proofNote', $('proof-note').value.trim());

    if (mode === 'featured') {
      const f = appState.eventSettings?.featured;
      if (f?.metric_type !== 'binary') {
        const parsed = parseMetricInput($('proof-metric').value, f.metric_type);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          $('proof-error').textContent = f.metric_type === 'time_asc' ? 'Saisis un chrono valide (ex. 0:42.500).' : 'Saisis un score valide (> 0).';
          return;
        }
        fd.append('metricValue', String(parsed));
      } else {
        fd.append('metricValue', '1');
      }
    }

    const btn = $('proof-submit');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="hgw-spinner"></span>Envoi…';
    const endpoint =
      mode === 'featured'
        ? `/api/featured/${encodeURIComponent(targetId)}/submit`
        : `/api/quests/${encodeURIComponent(targetId)}/submit`;
    const { ok, data } = await api(endpoint, { method: 'POST', body: fd });
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

  // Dev login
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

  // Scènes
  $('stage-next-btn').addEventListener('click', revealNext);
  $('stage-all-btn').addEventListener('click', () => {
    while (stageIndex < stageQueue.length) revealNext();
  });
  $('stage-reset-btn').addEventListener('click', () => openTeamsStage(stageTourneyId));
  $('stage-close-btn').addEventListener('click', () => $('teams-stage').classList.remove('is-open'));
  $('open-tombola-btn').addEventListener('click', openTombolaStage);
  $('tombola-spin-btn').addEventListener('click', spinTombola);
  $('tombola-close-btn').addEventListener('click', () => $('tombola-stage').classList.remove('is-open'));

  // Raccourcis clavier globaux
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
    if (route.view === 'admin' && route.pane === 'moderation' && visibleProofs(appState).length) {
      const k = e.key.toLowerCase();
      if (k === 'v') decideProof('approve');
      else if (k === 'r') {
        e.preventDefault();
        decideProof('reject');
      } else if (e.key === 'ArrowRight') decideProof('skip');
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
