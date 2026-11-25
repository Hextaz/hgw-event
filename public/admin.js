// HGW — Back-office Admin modulaire (ES Module).
import {
  $,
  api,
  avatar,
  confirmDialog,
  diffPips,
  emptyCard,
  esc,
  fmt,
  formatMetric,
  icon,
  monogram,
  parseMetricInput,
  plain,
  promptDialog,
  safeUrl,
  signed,
  timeAgo,
  tName,
  toast,
  toastError,
  toLocalInput,
} from './shared.js';

const DIFF_LABEL = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile' };
const DIFFS = ['easy', 'medium', 'hard'];
const REJECT_REASONS = [
  'La capture ne montre pas ton pseudo.',
  'Le résultat demandé n’est pas visible.',
  'Capture coupée ou illisible : renvoie l’écran de fin complet.',
  'Preuve d’une autre partie ou antérieure au défi.',
  'Lien inaccessible : vérifie qu’il est public.',
];

let ctx = null; // { getState, getRoute, fetchState, scheduleFetch, renderUser, openTeamsStage, openTombolaStage, phaseInfo }

// État local Admin
let reviewIndex = 0;
const decidedProofs = new Set(); // key: `${kind}:${id}`
const pendingDecisions = new Map();
let rejectTarget = null;

let editionDirty = false;
let featuredDirty = false;
let adminTourneyId = null;

let adminCatalog = null;
let catalogStale = true;
let catalogLoading = false;
let catGameId = null;
let catFilter = 'all';
let catSearch = '';
let gameEdit = null;
let questEdit = null;
let sgdbType = 'icons';
let sgdbGameId = null;
let sgdbTimer = null;

let featItemEdit = null;
let tourneyEdit = null;
let tourneyEditPresets = [];

export function markCatalogStale() {
  catalogStale = true;
}

export function visibleProofs(state) {
  const s = state || ctx?.getState();
  return (s?.admin?.pendingProofs || []).filter((p) => !decidedProofs.has(proofKey(p)));
}

function proofKey(p) {
  return `${p.kind || 'daily'}:${p.id}`;
}

export function initAdmin(context) {
  ctx = context;
  bindModeration();
  bindCatalog();
  bindFeaturedItemDialog();
  bindTourneyDialog();
  bindNewEditionDialog();
  bindManualPoints();
  bindMaintenance();
}

export function renderAdmin() {
  const state = ctx.getState();
  const route = ctx.getRoute();
  if (state?.user?.is_admin !== 1) return;

  const pending = visibleProofs(state).length;
  const panes = [
    ['/admin', 'moderation', 'shield', 'Modération', pending],
    ['/admin/evenement', 'evenement', 'calendar', 'Édition & barèmes', 0],
    ['/admin/vedette', 'vedette', 'star', 'Jeu vedette', 0],
    ['/admin/tournois', 'tournois', 'swords', 'Tournois', 0],
    ['/admin/catalogue', 'catalogue', 'list', 'Jeux et défis', 0],
    ['/admin/points', 'points', 'gift', 'Points et tombola', 0],
  ];
  $('admin-nav').innerHTML =
    panes
      .map(
        ([href, id, ic, label, n]) =>
          `<a href="${href}" data-link ${route.pane === id ? 'aria-current="page"' : ''}>${icon(ic)}${label}${n ? `<span class="hgw-tab__count">${n}</span>` : ''}</a>`
      )
      .join('') +
    `<div class="admin-nav__sep"></div><a href="/admin/maintenance" data-link ${route.pane === 'maintenance' ? 'aria-current="page"' : ''}>${icon('wrench')}Accès & maintenance</a>`;

  const p = ctx.phaseInfo();
  $('admin-desc').textContent = `${state.eventSettings?.event_name || 'HGW'} · ${p.label}${p.day ? ` · jour ${p.day}` : ''}${p.manual ? ' · phase forcée' : ''}`;

  renderKpis();
  renderReview();
  if (route.pane === 'evenement') renderEditionEditor();
  if (route.pane === 'vedette') renderFeaturedAdmin();
  if (route.pane === 'tournois') renderAdminTournaments();
  if (route.pane === 'catalogue') renderCatalog();
  if (route.pane === 'points') renderPointsPane();
  if (route.pane === 'maintenance') renderMaintenancePane();
}

// ============================================================================
// 1. MODÉRATION UNIFIÉE (Défis quotidiens + Jeu Vedette standard)
// ============================================================================
function renderKpis() {
  const state = ctx.getState();
  const s = state.admin?.stats;
  if (!s) return;
  const pending = visibleProofs(state).length;
  const feat = state.eventSettings?.featured;
  $('admin-kpis').innerHTML = `
    <button type="button" class="hgw-stat ${pending ? 'kpi--action' : ''}" id="kpi-pending" style="${pending ? '' : 'border:0;text-align:left;color:inherit;font:inherit'}">
      <div class="hgw-stat__label">Preuves à vérifier</div><div class="hgw-stat__value">${pending}</div><div class="hgw-stat__meta">${pending ? 'Commencer la modération' : 'Tout est à jour'}</div>
    </button>
    <div class="hgw-stat"><div class="hgw-stat__label">Joueurs</div><div class="hgw-stat__value">${fmt(s.totalUsers)}</div><div class="hgw-stat__meta">${fmt(s.tombolaQualifiedCount)} qualifiés tombola</div></div>
    <div class="hgw-stat"><div class="hgw-stat__label">Défis validés</div><div class="hgw-stat__value">${fmt(s.totalValidatedQuests)}</div></div>
    <div class="hgw-stat"><div class="hgw-stat__label">Points distribués</div><div class="hgw-stat__value">${fmt(s.totalPoints)}</div><div class="hgw-stat__meta">${feat?.enabled ? `${fmt(s.totalFeaturedSubs || 0)} soumissions ${esc(feat.title)}` : 'Jeu vedette désactivé'}</div></div>`;
  $('kpi-pending')?.addEventListener('click', () => $('review-zone').querySelector('[data-decide="approve"]')?.focus());
}

function renderReview() {
  const list = visibleProofs();
  const zone = $('review-zone');
  if (!list.length) {
    zone.innerHTML = emptyCard('Aucune preuve en attente', 'Tout est à jour. Les preuves des défis et du jeu vedette arrivent aussi dans #preuves sur Discord.');
    return;
  }
  if (reviewIndex >= list.length) reviewIndex = 0;
  const p = list[reviewIndex];
  const isFeat = p.kind === 'featured';
  const isImg = p.proof_file && /\.(png|jpe?g|webp|gif)$/i.test(p.proof_file);
  const fileUrl = p.proof_file ? `/uploads/proofs/${encodeURIComponent(p.proof_file)}` : '';
  const safeProofLink = safeUrl(p.proof_url);
  const media = isImg
    ? `<button type="button" class="hgw-review__media review-media" id="review-zoom" aria-label="Agrandir la capture"><img src="${fileUrl}" alt="Preuve de ${esc(p.display_name)}" /></button>`
    : `<div class="hgw-review__media">${p.proof_file ? `<a href="${fileUrl}" target="_blank" rel="noopener noreferrer">${icon('play')} Ouvrir le fichier</a>` : safeProofLink ? `<a href="${esc(safeProofLink)}" target="_blank" rel="noopener noreferrer">${icon('external')} Ouvrir le lien</a>` : 'Aucun fichier'}</div>`;

  const badges = isFeat
    ? `<span class="hgw-badge hgw-badge--info">${icon('star')}Jeu vedette</span>
       ${p.formatted_value ? `<span class="hgw-badge hgw-badge--points">${esc(p.formatted_value)}</span>` : ''}
       ${p.points > 0 ? `<span class="hgw-badge hgw-badge--success">+${p.points} pts</span>` : ''}`
    : `<span class="hgw-badge hgw-badge--points">+${p.points}</span>${diffPips(p.difficulty)}`;

  zone.innerHTML = `
    <div class="hgw-review">
      ${media}
      <div>
        <div class="hgw-review__meta">${avatar(p)}<b style="color:var(--ink-1)">${esc(p.display_name)}</b><span>· ${esc(p.game_name)} · ${esc(timeAgo(p.submitted_at))}</span>
          ${badges}
          <span class="hgw-review__queue" style="margin-left:auto">${reviewIndex + 1} / ${list.length}</span></div>
        <h3 class="hgw-review__title">${esc(plain(p.title))}</h3>
        <p class="muted"><b style="color:var(--ink-1)">Consigne :</b> ${esc(plain(p.description))}</p>
        ${safeProofLink && p.proof_file ? `<p class="small" style="margin-top: var(--space-2)"><a href="${esc(safeProofLink)}" target="_blank" rel="noopener noreferrer">Lien joint</a></p>` : ''}
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
  zone.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', () => decideProof(b.dataset.decide)));
}

export function decideProof(kind) {
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

function reviewEndpoint(p) {
  return p.kind === 'featured' ? `/api/admin/featured/submissions/${p.id}/review` : `/api/admin/proofs/${p.id}/review`;
}

function queueDecision(p, body) {
  const key = proofKey(p);
  decidedProofs.add(key);
  const send = async () => {
    pendingDecisions.delete(key);
    const { ok, data } = await api(reviewEndpoint(p), { json: body });
    if (!ok) {
      decidedProofs.delete(key);
      toastError(data, 'La décision n’a pas pu être enregistrée.');
    }
    ctx.scheduleFetch();
  };
  const timer = setTimeout(send, 5000);
  pendingDecisions.set(key, { timer, send, p, body });
  renderAdmin();
  ctx.renderUser();
  toast({
    title: body.action === 'approve' ? `Validé · ${p.display_name}` : `Refusé · ${p.display_name}`,
    type: body.action === 'approve' ? 'success' : 'info',
    duration: 5000,
    action: {
      label: 'Annuler',
      fn: () => {
        const pd = pendingDecisions.get(key);
        if (pd) clearTimeout(pd.timer);
        pendingDecisions.delete(key);
        decidedProofs.delete(key);
        renderAdmin();
        ctx.renderUser();
      },
    },
  });
}

function openReject(p) {
  rejectTarget = p;
  $('reject-form').reset();
  $('reject-title').textContent = `Refuser la preuve de ${p.display_name}`;
  $('reject-reasons').innerHTML = REJECT_REASONS.map(
    (r, i) => `<button type="button" class="reason" data-reason="${i}" aria-pressed="false"><kbd>${i + 1}</kbd>${esc(r)}</button>`
  ).join('');
  $('reject-reasons')
    .querySelectorAll('[data-reason]')
    .forEach((b) => b.addEventListener('click', () => pickReason(Number(b.dataset.reason))));
  $('reject-dialog').showModal();
  $('reject-reasons').querySelector('[data-reason]')?.focus();
}

function pickReason(i) {
  if (!REJECT_REASONS[i]) return;
  $('reject-text').value = REJECT_REASONS[i];
  $('reject-reasons')
    .querySelectorAll('[data-reason]')
    .forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.reason) === i)));
}

function openLightbox(src, caption) {
  $('lightbox-img').src = src;
  $('lightbox-img').alt = caption;
  $('lightbox-cap').textContent = caption;
  $('lightbox').showModal();
}

function bindModeration() {
  window.addEventListener('pagehide', () => {
    for (const [, pd] of pendingDecisions) {
      clearTimeout(pd.timer);
      fetch(reviewEndpoint(pd.p), {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pd.body),
      });
    }
    pendingDecisions.clear();
  });

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
}

// ============================================================================
// 2. ÉDITION, ACTES, BARÈMES & CYCLE NOUVELLE ÉDITION
// ============================================================================
function renderEditionEditor() {
  if (editionDirty) return;
  const state = ctx.getState();
  const cfg = state.eventSettings;
  if (!cfg) return;
  const p = ctx.phaseInfo();
  const root = $('edition-editor-root');
  const manual = cfg.status_mode && cfg.status_mode !== 'auto';

  const actsHtml = (count, acts) =>
    Array.from({ length: count }, (_, i) => {
      const a = acts[i] || { index: i + 1, name: `Acte ${['I', 'II', 'III'][i]}`, start_at: cfg.start_at };
      return `<div class="inline-row inline-row--act" data-act-row="${i + 1}">
        <input type="text" class="hgw-input" data-act-name value="${esc(a.name)}" maxlength="40" placeholder="Acte ${i + 1}" />
        <input type="datetime-local" class="hgw-input hgw-input--mono" data-act-start value="${esc(toLocalInput(a.start_at))}" required />
      </div>`;
    }).join('');

  const regRows = (tiers) =>
    tiers
      .map(
        (t) => `<div class="inline-row inline-row--3" data-reg-row>
          <input type="number" class="hgw-input hgw-input--mono" data-reg-days value="${t.days}" min="1" max="90" placeholder="Jours" />
          <input type="number" class="hgw-input hgw-input--mono" data-reg-pts value="${t.points}" min="1" max="5000" placeholder="Points" />
          <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--icon hgw-btn--sm" data-reg-del aria-label="Retirer">${icon('trash')}</button>
        </div>`
      )
      .join('');

  const scaleKeys = ['1', '2', '3', '4', '5', '6', '7', '8', 'default'];
  const defScale = cfg.default_tournament_scale || {};

  root.innerHTML = `
    <form class="stack" id="edition-config-form" novalidate>
      <div class="hgw-card">
        <div class="hgw-card__head">
          <div>
            <h2 class="hgw-card__title">Identité & lots de l’édition</h2>
            <p class="hgw-card__desc">Alimente le titre du site, le podium, la page d’aide, l’overlay OBS et le bot Discord.</p>
          </div>
          <span class="hgw-badge ${manual ? 'hgw-badge--danger' : ''}">${esc(p.label)}${manual ? ' · forcée' : ''}</span>
        </div>
        <div class="form-grid">
          <div class="hgw-field">
            <label class="hgw-field__label" for="ed-name">Nom de l’édition</label>
            <input id="ed-name" class="hgw-input" value="${esc(cfg.event_name)}" maxlength="100" required />
          </div>
          <div class="hgw-field">
            <label class="hgw-field__label" for="ed-tombola-threshold">Seuil tombola (points)</label>
            <input id="ed-tombola-threshold" type="number" class="hgw-input hgw-input--mono" value="${cfg.tombola_threshold}" min="1" />
          </div>
          <div class="hgw-field span-2">
            <label class="hgw-field__label" for="ed-subtitle">Accroche / sous-titre</label>
            <input id="ed-subtitle" class="hgw-input" value="${esc(cfg.event_subtitle)}" maxlength="260" />
          </div>
          <div class="hgw-field">
            <label class="hgw-field__label" for="ed-prize-1">Lot 1re place</label>
            <input id="ed-prize-1" class="hgw-input" value="${esc(cfg.prizes?.[0] || '')}" maxlength="80" />
          </div>
          <div class="hgw-field">
            <label class="hgw-field__label" for="ed-prize-2">Lot 2e place</label>
            <input id="ed-prize-2" class="hgw-input" value="${esc(cfg.prizes?.[1] || '')}" maxlength="80" />
          </div>
          <div class="hgw-field">
            <label class="hgw-field__label" for="ed-prize-3">Lot 3e place</label>
            <input id="ed-prize-3" class="hgw-input" value="${esc(cfg.prizes?.[2] || '')}" maxlength="80" />
          </div>
          <div class="hgw-field">
            <label class="hgw-field__label" for="ed-prize-tombola">Lot Tombola</label>
            <input id="ed-prize-tombola" class="hgw-input" value="${esc(cfg.tombola_prize || '')}" maxlength="100" />
          </div>
        </div>
      </div>

      <div class="hgw-card">
        <div class="hgw-card__head">
          <div>
            <h2 class="hgw-card__title">Actes, calendrier & phase</h2>
            <p class="hgw-card__desc">Heure de Paris. Choisis entre 1, 2 ou 3 actes selon la durée de ton événement.</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="hgw-field">
            <label class="hgw-field__label" for="ed-acts-count">Nombre d’actes</label>
            <select id="ed-acts-count" class="hgw-input">
              <option value="1" ${cfg.acts_count === 1 ? 'selected' : ''}>1 acte (format court / 1 semaine)</option>
              <option value="2" ${cfg.acts_count === 2 ? 'selected' : ''}>2 actes (format 2 semaines)</option>
              <option value="3" ${cfg.acts_count === 3 ? 'selected' : ''}>3 actes (format 3 semaines)</option>
            </select>
          </div>
          <div class="hgw-field">
            <label class="hgw-field__label" for="ed-end-at">Clôture de l’événement</label>
            <input id="ed-end-at" type="datetime-local" class="hgw-input hgw-input--mono" value="${esc(toLocalInput(cfg.end_at))}" required />
          </div>
        </div>
        <div class="hgw-field" style="margin-top: var(--space-4)">
          <span class="hgw-field__label">Dates de début de chaque acte</span>
          <div class="inline-rows" id="ed-acts-list">${actsHtml(cfg.acts_count, cfg.acts)}</div>
        </div>

        <div class="hgw-card hgw-card--flat danger-zone" style="margin-top: var(--space-5); padding: var(--space-4)">
          <label class="switch"><input type="checkbox" id="ed-manual" ${manual ? 'checked' : ''} />Forcer une phase manuellement (dont mode Préparation)</label>
          <p class="small muted" style="margin-top: var(--space-2)">En mode <b>Préparation</b>, les joueurs voient un écran d’attente pendant que tu configures l’édition.</p>
          <div class="hgw-field" id="ed-manual-wrap" style="margin-top: var(--space-3)" ${manual ? '' : 'hidden'}>
            <label class="hgw-field__label" for="ed-status-mode">Phase forcée</label>
            <select id="ed-status-mode" class="hgw-input">
              <option value="draft" ${cfg.status_mode === 'draft' ? 'selected' : ''}>Préparation (brouillon caché aux joueurs)</option>
              <option value="registration" ${cfg.status_mode === 'registration' ? 'selected' : ''}>Inscriptions</option>
              <option value="act_1" ${['act_1', 'week1'].includes(cfg.status_mode) ? 'selected' : ''}>Acte 1</option>
              <option value="act_2" ${['act_2', 'week2', 'live'].includes(cfg.status_mode) ? 'selected' : ''}>Acte 2</option>
              <option value="act_3" ${cfg.status_mode === 'act_3' ? 'selected' : ''}>Acte 3</option>
              <option value="closed" ${cfg.status_mode === 'closed' ? 'selected' : ''}>Clôturée (points gelés)</option>
            </select>
          </div>
        </div>
      </div>

      <div class="hgw-card">
        <div class="hgw-card__head">
          <div>
            <h2 class="hgw-card__title">Barème des défis, régularité & tournois par défaut</h2>
            <p class="hgw-card__desc">Appliqué globalement au tirage quotidien et pré-rempli à la création de nouveaux tournois.</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="hgw-field"><label class="hgw-field__label" for="ed-min-games">Jeux min. à cocher</label><input id="ed-min-games" type="number" class="hgw-input hgw-input--mono" value="${cfg.min_selected_games}" min="1" max="20" /></div>
          <div class="hgw-field"><label class="hgw-field__label" for="ed-cap-game">Cap défis / jeu / semaine</label><input id="ed-cap-game" type="number" class="hgw-input hgw-input--mono" value="${cfg.max_quests_per_game_per_act}" min="1" max="50" /></div>
          <div class="hgw-field"><label class="hgw-field__label" for="ed-daily-count">Défis tirés / jour</label><input id="ed-daily-count" type="number" class="hgw-input hgw-input--mono" value="${cfg.daily_quests_count}" min="1" max="6" /></div>
          <div class="hgw-field"><label class="hgw-field__label" for="ed-rerolls">Rerolls gratuits / jour</label><input id="ed-rerolls" type="number" class="hgw-input hgw-input--mono" value="${cfg.daily_rerolls_max}" min="0" max="5" /></div>
        </div>
        <div class="grid-3" style="margin-top: var(--space-4)">
          <div class="hgw-field"><label class="hgw-field__label" for="ed-qp-easy">Points Facile</label><input id="ed-qp-easy" type="number" class="hgw-input hgw-input--mono" value="${cfg.quest_points.easy}" min="1" /></div>
          <div class="hgw-field"><label class="hgw-field__label" for="ed-qp-med">Points Moyen</label><input id="ed-qp-med" type="number" class="hgw-input hgw-input--mono" value="${cfg.quest_points.medium}" min="1" /></div>
          <div class="hgw-field"><label class="hgw-field__label" for="ed-qp-hard">Points Difficile</label><input id="ed-qp-hard" type="number" class="hgw-input hgw-input--mono" value="${cfg.quest_points.hard}" min="1" /></div>
        </div>

        <div style="margin-top: var(--space-5)">
          <div class="row-between" style="margin-bottom: var(--space-2)">
            <span class="hgw-field__label">Paliers de régularité (jours actifs → bonus points)</span>
            <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--sm" id="ed-add-reg">${icon('plus')}Ajouter un palier</button>
          </div>
          <div class="inline-rows" id="ed-reg-list">${regRows(cfg.regularity_tiers || [])}</div>
        </div>

        <div style="margin-top: var(--space-5)">
          <span class="hgw-field__label" style="display:block; margin-bottom: var(--space-2)">Barème tournois par défaut</span>
          <div class="scale-grid" id="ed-def-scale">
            ${scaleKeys
              .map(
                (k) => `<div class="scale-cell"><label>${k === 'default' ? 'Part.' : `#${k}`}</label><input type="number" class="hgw-input hgw-input--mono" data-def-scale="${k}" value="${defScale[k] ?? 0}" min="0" /></div>`
              )
              .join('')}
          </div>
        </div>

        <p class="hgw-field__help t-danger" id="ed-error" role="alert" style="margin-top: var(--space-3)"></p>
        <div class="hgw-card__foot">
          <button type="submit" class="hgw-btn hgw-btn--primary">Enregistrer la configuration</button>
        </div>
      </div>

      <div class="hgw-card">
        <div class="hgw-card__head">
          <div>
            <h2 class="hgw-card__title">Cycle d’édition & Hall of Fame</h2>
            <p class="hgw-card__desc">Archive cette édition pour figer son podium et prépare la suivante sans perdre ton catalogue de jeux et défis.</p>
          </div>
        </div>
        <div class="row">
          <button type="button" class="hgw-btn hgw-btn--secondary" id="ed-archive-btn">${icon('trophy')}Archiver dans le Hall of Fame</button>
          <button type="button" class="hgw-btn hgw-btn--danger" id="ed-new-btn">${icon('zap')}Préparer une nouvelle édition…</button>
        </div>
      </div>
    </form>`;

  const form = $('edition-config-form');
  form.addEventListener('input', () => (editionDirty = true));
  $('ed-manual').addEventListener('change', (e) => {
    editionDirty = true;
    $('ed-manual-wrap').hidden = !e.target.checked;
  });
  $('ed-acts-count').addEventListener('change', (e) => {
    editionDirty = true;
    const n = Number(e.target.value);
    const currentActs = [...document.querySelectorAll('#ed-acts-list [data-act-row]')].map((row, idx) => ({
      index: idx + 1,
      name: row.querySelector('[data-act-name]').value,
      start_at: row.querySelector('[data-act-start]').value,
    }));
    $('ed-acts-list').innerHTML = actsHtml(n, currentActs);
  });
  $('ed-add-reg').addEventListener('click', () => {
    editionDirty = true;
    $('ed-reg-list').insertAdjacentHTML(
      'beforeend',
      `<div class="inline-row inline-row--3" data-reg-row>
        <input type="number" class="hgw-input hgw-input--mono" data-reg-days value="15" min="1" max="90" />
        <input type="number" class="hgw-input hgw-input--mono" data-reg-pts value="50" min="1" max="5000" />
        <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--icon hgw-btn--sm" data-reg-del aria-label="Retirer">${icon('trash')}</button>
      </div>`
    );
  });
  $('ed-reg-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-reg-del]');
    if (del) {
      editionDirty = true;
      del.closest('[data-reg-row]').remove();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const acts = [...document.querySelectorAll('#ed-acts-list [data-act-row]')].map((row, idx) => ({
      index: idx + 1,
      name: row.querySelector('[data-act-name]').value.trim() || `Acte ${idx + 1}`,
      start_at: row.querySelector('[data-act-start]').value,
    }));
    const regularity_tiers = [...document.querySelectorAll('#ed-reg-list [data-reg-row]')]
      .map((row) => ({
        days: Number(row.querySelector('[data-reg-days]').value),
        points: Number(row.querySelector('[data-reg-pts]').value),
      }))
      .filter((t) => t.days > 0 && t.points > 0);
    const default_tournament_scale = {};
    document.querySelectorAll('#ed-def-scale [data-def-scale]').forEach((inp) => {
      default_tournament_scale[inp.dataset.defScale] = Number(inp.value) || 0;
    });

    const payload = {
      event_name: $('ed-name').value.trim(),
      event_subtitle: $('ed-subtitle').value.trim(),
      prizes: [$('ed-prize-1').value.trim(), $('ed-prize-2').value.trim(), $('ed-prize-3').value.trim()].filter(Boolean),
      tombola_prize: $('ed-prize-tombola').value.trim(),
      tombola_threshold: Number($('ed-tombola-threshold').value),
      acts_count: Number($('ed-acts-count').value),
      acts,
      end_at: $('ed-end-at').value,
      status_mode: $('ed-manual').checked ? $('ed-status-mode').value : 'auto',
      min_selected_games: Number($('ed-min-games').value),
      max_quests_per_game_per_act: Number($('ed-cap-game').value),
      daily_quests_count: Number($('ed-daily-count').value),
      daily_rerolls_max: Number($('ed-rerolls').value),
      quest_points: {
        easy: Number($('ed-qp-easy').value),
        medium: Number($('ed-qp-med').value),
        hard: Number($('ed-qp-hard').value),
      },
      regularity_tiers,
      default_tournament_scale,
    };

    const { ok, data } = await api('/api/admin/config', { json: payload });
    if (!ok) {
      $('ed-error').textContent = plain(data.error) || 'Enregistrement impossible.';
      return;
    }
    editionDirty = false;
    catalogStale = true;
    toast({ title: 'Configuration enregistrée', type: 'success' });
    ctx.fetchState();
  });

  $('ed-archive-btn').addEventListener('click', async () => {
    const customName = await promptDialog({
      title: 'Archiver dans le Hall of Fame',
      message: 'Choisis le nom de cette archive officielle.',
      label: 'Nom de l’archive',
      defaultValue: cfg.event_name,
      confirmLabel: 'Archiver',
    });
    if (!customName) return;
    const { ok, data } = await api('/api/admin/editions/archive', { json: { name: customName } });
    if (!ok) return toastError(data);
    toast({ title: 'Édition archivée dans le Hall of Fame', type: 'success' });
    ctx.fetchState();
  });

  $('ed-new-btn').addEventListener('click', () => {
    $('new-edition-form').reset();
    $('ne-name').value = `${cfg.event_name.replace(/\s*#\d+$/, '')} #${(state.archivedEditions?.length || 0) + 2}`;
    $('ne-confirm').value = '';
    $('ne-submit').disabled = true;
    $('ne-error').textContent = '';
    $('new-edition-dialog').showModal();
    $('ne-name').focus();
  });
}

function bindNewEditionDialog() {
  $('ne-confirm').addEventListener('input', (e) => {
    $('ne-submit').disabled = e.target.value.trim().toUpperCase() !== 'NOUVELLE EDITION';
  });
  $('new-edition-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('ne-submit').disabled) return;
    const payload = {
      newName: $('ne-name').value.trim(),
      archiveCurrent: $('ne-archive').checked,
      keepTournaments: $('ne-keep-tourneys').checked,
      keepFeaturedItems: $('ne-keep-featured').checked,
    };
    const { ok, data } = await api('/api/admin/editions/new', { json: payload });
    if (!ok) {
      $('ne-error').textContent = plain(data.error) || 'Création impossible.';
      return;
    }
    $('new-edition-dialog').close();
    editionDirty = false;
    featuredDirty = false;
    toast({ title: `Nouvelle édition « ${payload.newName} » créée`, text: 'Active en mode Préparation.', type: 'success' });
    ctx.fetchState();
  });
}

// ============================================================================
// 3. JEU VEDETTE (Config + CRUD épreuves + Import .Challenge.gbx / .Replay.gbx)
// ============================================================================
function renderFeaturedAdmin() {
  const state = ctx.getState();
  const cfg = state.eventSettings;
  const f = cfg?.featured;
  if (!f) return;
  const items = state.admin?.allFeaturedItems || [];
  const root = $('featured-admin-root');

  if (!featuredDirty) {
    const games = state.games || [];
    const tierRows = (f.tiers || [])
      .map(
        (t) => `<div class="inline-row inline-row--4" data-tier-row>
          <input class="hgw-input hgw-input--mono" data-tier-key value="${esc(t.key)}" placeholder="clé (ex. gold)" />
          <input class="hgw-input" data-tier-label value="${esc(t.label)}" placeholder="Libellé (ex. Or)" />
          <input type="number" class="hgw-input hgw-input--mono" data-tier-pts value="${t.points}" min="0" placeholder="Pts" />
          <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--icon hgw-btn--sm" data-tier-del aria-label="Retirer">${icon('trash')}</button>
        </div>`
      )
      .join('');

    root.innerHTML = `
      <div class="stack">
        <form class="hgw-card" id="feat-cfg-form" novalidate>
          <div class="hgw-card__head">
            <div>
              <h2 class="hgw-card__title">Configuration du jeu vedette</h2>
              <p class="hgw-card__desc">Optionnel (0 ou 1 par édition). Connecteur Trackmania GBX ou mode Preuve standard pour tout autre jeu.</p>
            </div>
            <label class="switch switch--ok"><input type="checkbox" id="fc-enabled" ${f.enabled ? 'checked' : ''} />Activer l’onglet</label>
          </div>

          <div id="fc-body" ${f.enabled ? '' : 'style="opacity:.5"'}>
            <div class="form-grid">
              <div class="hgw-field">
                <label class="hgw-field__label" for="fc-title">Nom de l’onglet</label>
                <input id="fc-title" class="hgw-input" value="${esc(f.title)}" maxlength="60" placeholder="ex. Trackmania, TETR.IO, Balatro…" />
              </div>
              <div class="hgw-field">
                <label class="hgw-field__label" for="fc-game">Jeu lié (optionnel, pour le logo)</label>
                <select id="fc-game" class="hgw-input">
                  <option value="">Aucun</option>
                  ${games.map((g) => `<option value="${esc(g.id)}" ${f.game_id === g.id ? 'selected' : ''}>${esc(g.short_name)}</option>`).join('')}
                </select>
              </div>
              <div class="hgw-field span-2">
                <label class="hgw-field__label" for="fc-subtitle">Sous-titre / règles résumées</label>
                <input id="fc-subtitle" class="hgw-input" value="${esc(f.subtitle)}" maxlength="260" />
              </div>
              <div class="hgw-field">
                <label class="hgw-field__label" for="fc-connector">Connecteur / validation</label>
                <select id="fc-connector" class="hgw-input">
                  <option value="tmnf_gbx" ${f.connector === 'tmnf_gbx' ? 'selected' : ''}>Trackmania Nations Forever (.Replay.gbx + XML-RPC)</option>
                  <option value="standard" ${f.connector === 'standard' ? 'selected' : ''}>Standard — Preuve & modération #preuves (tout jeu)</option>
                </select>
              </div>
              <div class="hgw-field" id="fc-metric-wrap" ${f.connector === 'tmnf_gbx' ? 'hidden' : ''}>
                <label class="hgw-field__label" for="fc-metric">Type de résultat</label>
                <select id="fc-metric" class="hgw-input">
                  <option value="score_desc" ${f.metric_type === 'score_desc' ? 'selected' : ''}>Score (le plus haut gagne)</option>
                  <option value="time_asc" ${f.metric_type === 'time_asc' ? 'selected' : ''}>Chrono (le plus bas gagne)</option>
                  <option value="binary" ${f.metric_type === 'binary' ? 'selected' : ''}>Objectif simple (validé / non validé)</option>
                </select>
              </div>
              <div class="hgw-field" id="fc-unit-wrap" ${f.connector === 'tmnf_gbx' || f.metric_type !== 'score_desc' ? 'hidden' : ''}>
                <label class="hgw-field__label" for="fc-unit">Unité du score (facultatif)</label>
                <input id="fc-unit" class="hgw-input" value="${esc(f.metric_unit || '')}" maxlength="20" placeholder="ex. pts, WPM, lignes…" />
              </div>
            </div>

            <div class="hgw-card hgw-card--flat" style="margin-top: var(--space-5); padding: var(--space-4)">
              <div class="row-between" style="margin-bottom: var(--space-3)">
                <label class="switch switch--ok"><input type="checkbox" id="fc-stages-on" ${f.stages_enabled ? 'checked' : ''} />Bloc A : Liste d’épreuves à paliers</label>
                <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--sm" id="fc-add-tier">${icon('plus')}Palier</button>
              </div>
              <div class="hgw-field" style="margin-bottom: var(--space-3)">
                <label class="hgw-field__label" for="fc-stages-title">Titre de la section épreuves</label>
                <input id="fc-stages-title" class="hgw-input" value="${esc(f.stages_title)}" maxlength="60" />
              </div>
              <div class="inline-rows" id="fc-tiers-list">${tierRows}</div>
            </div>

            <div class="hgw-card hgw-card--flat" style="margin-top: var(--space-4); padding: var(--space-4)">
              <label class="switch switch--ok" style="margin-bottom: var(--space-3)"><input type="checkbox" id="fc-ladder-on" ${f.ladder_enabled ? 'checked' : ''} />Bloc B : Ladder / classement ouvert (Top N)</label>
              <div class="form-grid">
                <div class="hgw-field">
                  <label class="hgw-field__label" for="fc-ladder-title">Titre du Ladder</label>
                  <input id="fc-ladder-title" class="hgw-input" value="${esc(f.ladder_title)}" maxlength="60" />
                </div>
                <div class="hgw-field">
                  <label class="hgw-field__label" for="fc-ladder-act">Acte de déblocage</label>
                  <select id="fc-ladder-act" class="hgw-input">
                    ${Array.from({ length: cfg.acts_count }, (_, i) => `<option value="${i + 1}" ${f.ladder_unlock_act === i + 1 ? 'selected' : ''}>Acte ${i + 1}</option>`).join('')}
                  </select>
                </div>
                <div class="hgw-field">
                  <label class="hgw-field__label" for="fc-ladder-cutoff">Date de clôture du Ladder</label>
                  <input id="fc-ladder-cutoff" type="datetime-local" class="hgw-input hgw-input--mono" value="${esc(toLocalInput(f.ladder_cutoff_at))}" />
                </div>
                <div class="hgw-field">
                  <label class="hgw-field__label" for="fc-ladder-scale">Points Top N (séparés par virgules)</label>
                  <input id="fc-ladder-scale" class="hgw-input hgw-input--mono" value="${esc((f.ladder_points_scale || []).join(', '))}" placeholder="150, 110, 80, 50, 50, 50, 30, 30, 30, 30" />
                </div>
              </div>
            </div>

            <div class="hgw-card hgw-card--flat" style="margin-top: var(--space-4); padding: var(--space-4)">
              <label class="switch" style="margin-bottom: var(--space-3)"><input type="checkbox" id="fc-srv-on" ${f.server_info?.enabled ? 'checked' : ''} />Afficher une carte Serveur dédié / Rejoindre</label>
              <div class="form-grid" id="fc-srv-grid" ${f.server_info?.enabled ? '' : 'hidden'}>
                <div class="hgw-field"><label class="hgw-field__label" for="fc-srv-addr">Adresse du serveur</label><input id="fc-srv-addr" class="hgw-input hgw-input--mono" value="${esc(f.server_info?.address || '')}" /></div>
                <div class="hgw-field"><label class="hgw-field__label" for="fc-srv-join">Lien Rejoindre (ex. tmtp://#join=…)</label><input id="fc-srv-join" class="hgw-input hgw-input--mono" value="${esc(f.server_info?.join_url || '')}" /></div>
                <div class="hgw-field"><label class="hgw-field__label" for="fc-srv-login">Login serveur</label><input id="fc-srv-login" class="hgw-input hgw-input--mono" value="${esc(f.server_info?.login || '')}" /></div>
                <div class="hgw-field"><label class="hgw-field__label" for="fc-srv-label">Libellé serveur</label><input id="fc-srv-label" class="hgw-input" value="${esc(f.server_info?.label || '')}" /></div>
              </div>
            </div>
          </div>

          <div class="hgw-card__foot">
            <button type="submit" class="hgw-btn hgw-btn--primary">Enregistrer le jeu vedette</button>
          </div>
        </form>

        <div class="hgw-card">
          <div class="hgw-card__head">
            <div>
              <h2 class="hgw-card__title">Épreuves / Pistes configurées (${items.length})</h2>
              <p class="hgw-card__desc">${f.connector === 'tmnf_gbx' ? 'Choisis librement tes pistes : glisse un .Challenge.gbx dans la fenêtre d’ajout pour importer UID et médailles.' : 'Ajoute les épreuves de paliers et/ou l’épreuve du Ladder.'}</p>
            </div>
            <button type="button" class="hgw-btn hgw-btn--primary hgw-btn--sm" id="fc-add-item">${icon('plus')}Nouvelle épreuve</button>
          </div>
          <div class="stack-sm" id="fc-items-list"></div>
        </div>
      </div>`;

    const form = $('feat-cfg-form');
    form.addEventListener('input', () => (featuredDirty = true));
    $('fc-enabled').addEventListener('change', (e) => {
      featuredDirty = true;
      $('fc-body').style.opacity = e.target.checked ? '1' : '.5';
    });
    $('fc-connector').addEventListener('change', (e) => {
      featuredDirty = true;
      const isTm = e.target.value === 'tmnf_gbx';
      $('fc-metric-wrap').hidden = isTm;
      $('fc-unit-wrap').hidden = isTm || $('fc-metric').value !== 'score_desc';
    });
    $('fc-metric').addEventListener('change', (e) => {
      featuredDirty = true;
      $('fc-unit-wrap').hidden = e.target.value !== 'score_desc';
    });
    $('fc-srv-on').addEventListener('change', (e) => {
      featuredDirty = true;
      $('fc-srv-grid').hidden = !e.target.checked;
    });
    $('fc-add-tier').addEventListener('click', () => {
      featuredDirty = true;
      $('fc-tiers-list').insertAdjacentHTML(
        'beforeend',
        `<div class="inline-row inline-row--4" data-tier-row>
          <input class="hgw-input hgw-input--mono" data-tier-key value="tier_${Date.now().toString().slice(-3)}" placeholder="clé" />
          <input class="hgw-input" data-tier-label value="Nouveau palier" placeholder="Libellé" />
          <input type="number" class="hgw-input hgw-input--mono" data-tier-pts value="15" min="0" />
          <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--icon hgw-btn--sm" data-tier-del aria-label="Retirer">${icon('trash')}</button>
        </div>`
      );
    });
    $('fc-tiers-list').addEventListener('click', (e) => {
      const del = e.target.closest('[data-tier-del]');
      if (del) {
        featuredDirty = true;
        del.closest('[data-tier-row]').remove();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const connector = $('fc-connector').value;
      const tiers = [...document.querySelectorAll('#fc-tiers-list [data-tier-row]')]
        .map((r) => ({
          key: r.querySelector('[data-tier-key]').value.trim(),
          label: r.querySelector('[data-tier-label]').value.trim(),
          points: Number(r.querySelector('[data-tier-pts]').value) || 0,
        }))
        .filter((t) => t.key && t.label);
      const ladderScale = $('fc-ladder-scale')
        .value.split(/[,;\s]+/)
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0);

      const payload = {
        enabled: $('fc-enabled').checked,
        title: $('fc-title').value.trim() || 'Jeu vedette',
        subtitle: $('fc-subtitle').value.trim(),
        game_id: $('fc-game').value || null,
        connector,
        metric_type: connector === 'tmnf_gbx' ? 'time_asc' : $('fc-metric').value,
        metric_unit: $('fc-unit').value.trim(),
        stages_enabled: $('fc-stages-on').checked,
        stages_title: $('fc-stages-title').value.trim() || 'Épreuves',
        tiers: tiers.length ? tiers : f.tiers,
        ladder_enabled: $('fc-ladder-on').checked,
        ladder_title: $('fc-ladder-title').value.trim() || 'Ladder',
        ladder_unlock_act: Number($('fc-ladder-act').value) || 1,
        ladder_cutoff_at: $('fc-ladder-cutoff').value,
        ladder_points_scale: ladderScale.length ? ladderScale : f.ladder_points_scale,
        server_info: {
          enabled: $('fc-srv-on').checked,
          label: $('fc-srv-label').value.trim() || 'Serveur',
          address: $('fc-srv-addr').value.trim(),
          join_url: $('fc-srv-join').value.trim(),
          login: $('fc-srv-login').value.trim(),
          help_text: f.server_info?.help_text || '',
        },
      };

      const { ok, data } = await api('/api/admin/featured/config', { json: payload });
      if (!ok) return toastError(data);
      featuredDirty = false;
      toast({ title: 'Jeu vedette enregistré', type: 'success' });
      ctx.fetchState();
    });

    $('fc-add-item').addEventListener('click', () => openFeaturedItemDialog(null));
  }

  // Toujours rafraîchir la liste des épreuves
  const listEl = $('fc-items-list');
  if (listEl) {
    listEl.innerHTML = items.length
      ? items
          .map(
            (it) => `<div class="admin-list-row ${it.active ? '' : 'is-off'}">
              <div style="min-width:0">
                <div class="row" style="gap: var(--space-2)">
                  <span class="hgw-badge hgw-badge--points">${esc(it.code)}</span>
                  <b>${esc(plain(it.name))}</b>
                  ${it.is_ladder ? '<span class="hgw-badge hgw-badge--info">Ladder</span>' : ''}
                  ${it.active ? '' : '<span class="hgw-badge hgw-badge--danger">Inactif</span>'}
                </div>
                <div class="small muted" style="margin-top: 2px">
                  ${it.external_uid ? `UID <span class="mono">${esc(it.external_uid)}</span> · ` : ''}
                  ${it.submission_count || 0} soumission(s)
                  ${
                    f.metric_type !== 'binary' && Object.keys(it.thresholds_formatted || {}).length
                      ? ` · ${Object.entries(it.thresholds_formatted)
                          .map(([k, v]) => `${esc(k)}: ${esc(v)}`)
                          .join(' · ')}`
                      : ''
                  }
                </div>
              </div>
              <div class="row">
                <button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--sm" data-fi-edit="${esc(it.id)}">${icon('edit')}Modifier</button>
              </div>
            </div>`
          )
          .join('')
      : emptyCard('Aucune épreuve', 'Clique sur « Nouvelle épreuve » pour ajouter une piste ou un défi vedette.');

    listEl.querySelectorAll('[data-fi-edit]').forEach((b) =>
      b.addEventListener('click', () => openFeaturedItemDialog(b.dataset.fiEdit))
    );
  }
}

function openFeaturedItemDialog(id) {
  const state = ctx.getState();
  const f = state.eventSettings.featured;
  const item = id ? (state.admin?.allFeaturedItems || []).find((x) => x.id === id) : null;
  featItemEdit = { id: item?.id || null };

  $('fi-title').textContent = item ? `Modifier ${item.code}` : 'Nouvelle épreuve vedette';
  $('fi-sub').textContent =
    f.connector === 'tmnf_gbx'
      ? 'Glisse une map .Challenge.gbx ou .Replay.gbx pour pré-remplir automatiquement l’UID et les temps.'
      : `Mode ${f.metric_type === 'binary' ? 'Objectif simple' : f.metric_type === 'time_asc' ? 'Chrono' : 'Score'}.`;
  $('fi-gbx-drop').hidden = f.connector !== 'tmnf_gbx';
  $('fi-uid-wrap').hidden = f.connector !== 'tmnf_gbx';
  $('fi-code').value = item?.code || '';
  $('fi-name').value = item?.name || '';
  $('fi-desc').value = item?.description || '';
  $('fi-uid').value = item?.external_uid || '';
  $('fi-order').value = item?.sort_order ?? (state.admin?.allFeaturedItems?.length || 1);
  $('fi-is-ladder').checked = Boolean(item?.is_ladder);
  $('fi-active').checked = item ? Boolean(item.active) : true;
  $('fi-error').textContent = '';

  const showThresholds = f.metric_type !== 'binary';
  $('fi-thresholds-wrap').hidden = !showThresholds;
  if (showThresholds) {
    const th = item?.thresholds || {};
    $('fi-thresholds-grid').innerHTML = (f.tiers || [])
      .map((t) => {
        const val = th[t.key] !== undefined ? (f.metric_type === 'time_asc' ? formatMetric(th[t.key], 'time_asc') : th[t.key]) : '';
        return `<div class="hgw-field">
          <label class="hgw-field__label">${esc(t.label)} (+${t.points} pts)</label>
          <input class="hgw-input hgw-input--mono" data-fi-th="${esc(t.key)}" value="${esc(val)}" placeholder="${f.metric_type === 'time_asc' ? '0:24.500' : '100000'}" />
        </div>`;
      })
      .join('');
    $('fi-thresholds-help').textContent =
      f.metric_type === 'time_asc'
        ? 'Format accepté : M:SS.mmm (ex. 0:24.500) ou millisecondes.'
        : 'Score minimum à atteindre pour débloquer chaque palier.';
  }

  $('fi-delete').hidden = !item;
  $('fi-delete').disabled = Boolean(item && item.submission_count > 0);
  $('feat-item-dialog').showModal();
  $('fi-code').focus();
}

function bindFeaturedItemDialog() {
  const handleGbxFile = async (file) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    const { ok, data } = await api('/api/admin/featured/parse-gbx', { method: 'POST', body: fd });
    if (!ok) {
      $('fi-error').textContent = plain(data.error) || 'Lecture GBX impossible.';
      return;
    }
    const p = data.parsed;
    $('fi-error').textContent = '';
    if (p.mapUid) $('fi-uid').value = p.mapUid;
    if (p.name) {
      if (!$('fi-name').value) $('fi-name').value = p.name;
      if (!$('fi-code').value) $('fi-code').value = p.name.slice(0, 20);
    }
    const setTh = (k, ms) => {
      const inp = document.querySelector(`[data-fi-th="${k}"]`);
      if (inp && ms) inp.value = formatMetric(ms, 'time_asc');
    };
    setTh('author', p.authorMs);
    setTh('gold', p.goldMs);
    setTh('silver', p.silverMs);
    setTh('bronze', p.bronzeMs);
    toast({ title: `Piste lue : ${p.name}`, text: `UID ${p.mapUid}`, type: 'success' });
  };

  $('fi-gbx-file').addEventListener('change', (e) => {
    handleGbxFile(e.target.files?.[0]);
    e.target.value = '';
  });
  const drop = $('fi-gbx-drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    handleGbxFile(e.dataTransfer?.files?.[0]);
  });

  $('feat-item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('fi-error').textContent = '';
    const f = ctx.getState().eventSettings.featured;
    const thresholds = {};
    document.querySelectorAll('#fi-thresholds-grid [data-fi-th]').forEach((inp) => {
      const raw = inp.value.trim();
      if (!raw) return;
      const n = parseMetricInput(raw, f.metric_type);
      if (Number.isFinite(n)) thresholds[inp.dataset.fiTh] = n;
    });

    const payload = {
      code: $('fi-code').value.trim(),
      name: $('fi-name').value.trim(),
      description: $('fi-desc').value.trim(),
      external_uid: $('fi-uid').value.trim() || null,
      sort_order: Number($('fi-order').value) || 0,
      is_ladder: $('fi-is-ladder').checked,
      active: $('fi-active').checked,
      thresholds,
    };

    const isNew = !featItemEdit.id;
    const { ok, data } = await api(
      isNew ? '/api/admin/featured/items' : `/api/admin/featured/items/${encodeURIComponent(featItemEdit.id)}`,
      { method: isNew ? 'POST' : 'PUT', json: payload }
    );
    if (!ok) {
      $('fi-error').textContent = plain(data.error) || 'Enregistrement impossible.';
      return;
    }
    $('feat-item-dialog').close();
    toast({ title: isNew ? 'Épreuve ajoutée' : 'Épreuve enregistrée', type: 'success' });
    ctx.fetchState();
  });

  $('fi-delete').addEventListener('click', async () => {
    if (!featItemEdit?.id) return;
    const confirmed = await confirmDialog({
      title: 'Supprimer cette épreuve ?',
      message: 'Cette action est définitive.',
      confirmLabel: 'Supprimer',
    });
    if (!confirmed) return;
    const { ok, data } = await api(`/api/admin/featured/items/${encodeURIComponent(featItemEdit.id)}`, { method: 'DELETE' });
    if (!ok) {
      $('fi-error').textContent = plain(data.error);
      return;
    }
    $('feat-item-dialog').close();
    toast({ title: 'Épreuve supprimée', type: 'success' });
    ctx.fetchState();
  });
}

// ============================================================================
// 4. TOURNOIS (CRUD + GESTION LIVE CHAPEAUX / ÉQUIPES MANUELLES / MANCHES)
// ============================================================================
function buildPlacementOptions(scale) {
  const entries = Object.entries(scale || {})
    .filter(([k]) => /^\d+$/.test(k))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const opts = [['', '—']];
  for (const [rank, pts] of entries) {
    opts.push([rank, `#${rank} (${pts} pts)`]);
  }
  if (scale?.default !== undefined) {
    opts.push(['99', `Participation (${scale.default} pts)`]);
  }
  return opts;
}

function renderAdminTournaments() {
  const state = ctx.getState();
  const allT = state.admin?.allTournaments || state.tournaments || [];
  if (!allT.find((t) => t.id === adminTourneyId) && allT[0]) adminTourneyId = allT[0].id;
  const activeT = allT.find((t) => t.id === adminTourneyId) || null;
  const root = $('tournaments-admin-root');

  const isTeam = activeT && activeT.team_size > 1;
  const isRounds = activeT && activeT.scoring_mode === 'rounds';
  const maxTeams = activeT ? Math.max(4, Math.ceil((activeT.registrations.length || 4) / Math.max(2, activeT.team_size))) : 4;
  const placeOpts = activeT ? buildPlacementOptions(activeT.points_scale) : [['', '—']];

  let liveCard = '';
  if (activeT) {
    const regs = activeT.registrations || [];
    if (isRounds) {
      const roundsCount = activeT.rounds_count || 5;
      const presets = activeT.round_presets || [];
      const roundHeaders = Array.from({ length: roundsCount }, (_, i) => `<th>M${i + 1}</th>`).join('');
      liveCard = `
        <div class="hgw-card">
          <div class="hgw-card__head">
            <div>
              <h2 class="hgw-card__title">${esc(tName(activeT))} · Cumul sur ${roundsCount} manches</h2>
              <p class="hgw-card__desc">${presets.length ? presets.map((p) => `${esc(p.label)} ${p.points}`).join(' · ') : 'Saisis le score de chaque manche ; le total calcule automatiquement le classement et les points HGW.'}</p>
            </div>
            <button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--sm" id="at-edit-active">${icon('edit')}Configurer</button>
          </div>
          <div class="table-wrap">
            <table class="hgw-table">
              <thead><tr><th>Joueur</th>${roundHeaders}<th class="r">Total</th><th class="r">Points</th></tr></thead>
              <tbody id="admin-rounds-tbody">${
                regs.length
                  ? regs
                      .map((r) => {
                        const scores = r.round_scores || [];
                        return `<tr data-round-user="${esc(r.user_id)}">
                          <td class="hgw-player__name">${esc(r.display_name)}</td>
                          ${Array.from({ length: roundsCount }, (_, i) => {
                            const val = scores[i] ?? 0;
                            const chips = presets.length
                              ? `<div class="preset-chips">${presets.map((pr) => `<button type="button" class="preset-chip" data-preset-val="${pr.points}" title="${esc(pr.label)}">${pr.points}</button>`).join('')}</div>`
                              : '';
                            return `<td><input type="number" class="hgw-input compact hgw-input--mono" data-r-idx="${i}" value="${val}" min="0" style="width:72px" />${chips}</td>`;
                          }).join('')}
                          <td class="r hgw-num" data-r-total>${r.round_total_score || 0}</td>
                          <td class="r"><span class="hgw-badge hgw-badge--points">+${r.points_awarded || 0}</span></td>
                        </tr>`;
                      })
                      .join('')
                  : `<tr><td colspan="${roundsCount + 3}"><div class="hgw-empty"><strong>Aucun inscrit</strong>Les joueurs s’inscrivent depuis l’onglet Tournois.</div></td></tr>`
              }</tbody>
            </table>
          </div>
          <div class="hgw-card__foot">
            <button type="button" class="hgw-btn hgw-btn--primary hgw-btn--sm" id="save-rounds-btn">Calculer et attribuer les points</button>
          </div>
        </div>`;
    } else {
      liveCard = `
        <div class="hgw-card">
          <div class="hgw-card__head">
            <div>
              <h2 class="hgw-card__title">${esc(tName(activeT))} · ${isTeam ? `Équipes ${activeT.team_size}v${activeT.team_size}` : 'Solo'}</h2>
              <p class="hgw-card__desc">${isTeam ? 'Classe les joueurs par chapeaux, coche les présents, tire les équipes (ajustables manuellement) puis saisis les places.' : 'Coche les présents et saisis les places finales pour créditer les points live.'}</p>
            </div>
            <div class="row">
              ${isTeam ? `<button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--sm" id="open-stage-btn">${icon('tv')}Scène de tirage</button>` : ''}
              <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--sm" id="at-edit-active">${icon('edit')}Configurer</button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="hgw-table">
              <thead><tr><th>Joueur</th>${isTeam ? '<th>Chapeau</th>' : ''}<th>Présent</th>${isTeam ? '<th>Équipe (ajustable)</th>' : ''}<th>Place finale</th></tr></thead>
              <tbody id="admin-pools-tbody">${
                regs.length
                  ? regs
                      .map(
                        (r) => `<tr>
                          <td class="hgw-player__name">${esc(r.display_name)}</td>
                          ${
                            isTeam
                              ? `<td><select class="hgw-input compact" data-pool="${esc(r.user_id)}">${[1, 2, 3].map((n) => `<option value="${n}" ${r.pool === n ? 'selected' : ''}>Chapeau ${n}</option>`).join('')}</select></td>`
                              : ''
                          }
                          <td><input type="checkbox" class="check" data-checkin="${esc(r.user_id)}" ${r.checked_in ? 'checked' : ''} aria-label="${esc(r.display_name)} présent" /></td>
                          ${
                            isTeam
                              ? `<td><select class="hgw-input compact" data-team-num="${esc(r.user_id)}"><option value="">—</option>${Array.from({ length: maxTeams }, (_, i) => `<option value="${i + 1}" ${r.team_number === i + 1 ? 'selected' : ''}>Équipe ${i + 1}</option>`).join('')}</select></td>`
                              : ''
                          }
                          <td><select class="hgw-input compact" data-place="${esc(r.user_id)}">${placeOpts.map(([v, l]) => `<option value="${v}" ${String(r.placement ?? '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
                        </tr>`
                      )
                      .join('')
                  : `<tr><td colspan="${isTeam ? 5 : 3}"><div class="hgw-empty"><strong>Aucun inscrit</strong>Les joueurs s’inscrivent depuis l’onglet Tournois.</div></td></tr>`
              }</tbody>
            </table>
          </div>
          <div class="hgw-card__foot" style="justify-content: space-between">
            <div class="row">
              ${
                isTeam
                  ? `<button type="button" class="hgw-btn hgw-btn--secondary hgw-btn--sm" id="draw-teams-btn">Tirer les équipes</button>
                     <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--sm" id="draw-discord-btn">Tirer et annoncer sur Discord</button>`
                  : '<span></span>'
              }
            </div>
            <button type="button" class="hgw-btn hgw-btn--primary hgw-btn--sm" id="save-placements-btn">Enregistrer les résultats</button>
          </div>
        </div>`;
    }
  }

  root.innerHTML = `
    <div class="stack">
      <div class="hgw-card">
        <div class="hgw-card__head">
          <div>
            <h2 class="hgw-card__title">Programme des tournois (${allT.length})</h2>
            <p class="hgw-card__desc">Ajoute, modifie ou désactive les tournois du week-end. Le planning et /aide se mettent à jour tout seuls.</p>
          </div>
          <button type="button" class="hgw-btn hgw-btn--primary hgw-btn--sm" id="at-new-btn">${icon('plus')}Nouveau tournoi</button>
        </div>
        <div class="hgw-seg" role="group" aria-label="Tournoi" id="admin-tourney-seg" style="margin-bottom: var(--space-4)">
          ${allT
            .map(
              (t) =>
                `<button type="button" data-t="${esc(t.id)}" aria-pressed="${t.id === adminTourneyId}">${esc(tName(t))}${t.active ? '' : ' (inactif)'} <span class="hgw-seg__n">${t.registrations.length}</span></button>`
            )
            .join('')}
        </div>
        ${!allT.length ? emptyCard('Aucun tournoi', 'Crée ton premier tournoi du week-end.') : ''}
      </div>
      ${liveCard}
    </div>`;

  $('at-new-btn').addEventListener('click', () => openTourneyDialog(null));
  $('at-edit-active')?.addEventListener('click', () => openTourneyDialog(activeT.id));
  $('admin-tourney-seg')
    .querySelectorAll('[data-t]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        adminTourneyId = b.dataset.t;
        renderAdminTournaments();
      })
    );

  // Bind Live Direct / Équipes
  const tbody = $('admin-pools-tbody');
  const encActiveT = activeT ? encodeURIComponent(activeT.id) : '';
  if (tbody && activeT) {
    tbody.querySelectorAll('[data-pool]').forEach((s) =>
      s.addEventListener('change', async () => {
        const { ok, data } = await api(`/api/admin/tournaments/${encActiveT}/player`, { json: { userId: s.dataset.pool, pool: Number(s.value) } });
        if (!ok) toastError(data);
        ctx.scheduleFetch();
      })
    );
    tbody.querySelectorAll('[data-checkin]').forEach((c) =>
      c.addEventListener('change', async () => {
        const { ok, data } = await api(`/api/admin/tournaments/${encActiveT}/player`, { json: { userId: c.dataset.checkin, checkedIn: c.checked } });
        if (!ok) toastError(data);
        ctx.scheduleFetch();
      })
    );
    tbody.querySelectorAll('[data-team-num]').forEach((s) =>
      s.addEventListener('change', async () => {
        const val = s.value ? Number(s.value) : null;
        const { ok, data } = await api(`/api/admin/tournaments/${encActiveT}/player`, { json: { userId: s.dataset.teamNum, teamNumber: val } });
        if (!ok) toastError(data);
        else toast({ title: 'Équipe ajustée', type: 'success' });
        ctx.scheduleFetch();
      })
    );
  }

  const draw = async (announceDiscord) => {
    const { ok, data } = await api(`/api/admin/tournaments/${encActiveT}/draw-teams`, { json: { onlyCheckedIn: true, announceDiscord } });
    if (!ok) return toastError(data);
    toast({ title: `${data.teams.length} équipes tirées`, text: announceDiscord ? 'Annonce envoyée sur Discord.' : 'Ouvre la scène pour les révéler en stream.', type: 'success' });
    ctx.fetchState();
  };
  $('draw-teams-btn')?.addEventListener('click', () => draw(false));
  $('draw-discord-btn')?.addEventListener('click', () => draw(true));
  $('open-stage-btn')?.addEventListener('click', () => ctx.openTeamsStage(activeT.id));

  $('save-placements-btn')?.addEventListener('click', async () => {
    const placements = [...document.querySelectorAll('#admin-pools-tbody [data-place]')]
      .filter((s) => s.value)
      .map((s) => ({ userId: s.dataset.place, placement: Number(s.value) }));
    if (!placements.length) return toast({ title: 'Aucune place renseignée', type: 'danger' });
    const { ok, data } = await api(`/api/admin/tournaments/${encActiveT}/placements`, { json: { placements } });
    if (!ok) return toastError(data);
    toast({ title: 'Résultats enregistrés', text: 'Les points live sont crédités.', type: 'success' });
    ctx.fetchState();
  });

  // Bind Live Manches (Rounds)
  const rTbody = $('admin-rounds-tbody');
  if (rTbody && activeT) {
    const recalcRow = (tr) => {
      const tot = [...tr.querySelectorAll('[data-r-idx]')].reduce((acc, i) => acc + (Number(i.value) || 0), 0);
      const cell = tr.querySelector('[data-r-total]');
      if (cell) cell.textContent = tot;
    };
    rTbody.addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-round-user]');
      if (tr) recalcRow(tr);
    });
    rTbody.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-preset-val]');
      if (!chip) return;
      const td = chip.closest('td');
      const inp = td?.querySelector('[data-r-idx]');
      if (inp) {
        inp.value = chip.dataset.presetVal;
        recalcRow(td.closest('tr'));
      }
    });
    $('save-rounds-btn')?.addEventListener('click', async () => {
      const scores = [...rTbody.querySelectorAll('tr[data-round-user]')].map((tr) => ({
        userId: tr.dataset.roundUser,
        scores: [...tr.querySelectorAll('[data-r-idx]')].map((i) => Number(i.value) || 0),
      }));
      if (!scores.length) return;
      const { ok, data } = await api(`/api/admin/tournaments/${encActiveT}/rounds`, { json: { scores } });
      if (!ok) return toastError(data);
      toast({ title: 'Manches calculées et points attribués', type: 'success' });
      ctx.fetchState();
    });
  }
}

function renderTourneyPresets() {
  $('tf-presets-list').innerHTML = tourneyEditPresets
    .map(
      (p, idx) => `<div class="inline-row inline-row--3" data-tp-idx="${idx}">
        <input class="hgw-input" data-tp-label value="${esc(p.label)}" placeholder="Libellé (ex. Couronne)" />
        <input type="number" class="hgw-input hgw-input--mono" data-tp-pts value="${p.points}" min="0" />
        <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--icon hgw-btn--sm" data-tp-del="${idx}" aria-label="Retirer">${icon('trash')}</button>
      </div>`
    )
    .join('');
}

function openTourneyDialog(id) {
  const state = ctx.getState();
  const t = id ? (state.admin?.allTournaments || []).find((x) => x.id === id) : null;
  tourneyEdit = { id: t?.id || null };
  const defScale = state.eventSettings?.default_tournament_scale || { 1: 200, 2: 140, 3: 90, 4: 90, 5: 50, 6: 50, 7: 50, 8: 50, default: 25 };
  const scale = t?.points_scale || defScale;

  $('tf-title').textContent = t ? `Modifier ${tName(t)}` : 'Nouveau tournoi';
  $('tf-game').innerHTML =
    '<option value="">Libre / hors catalogue</option>' +
    (state.games || []).map((g) => `<option value="${esc(g.id)}">${esc(g.short_name)}</option>`).join('');
  $('tf-name').value = t?.name || '';
  $('tf-game').value = t?.game_id || '';
  $('tf-schedule').value = t?.scheduled_label || '';
  $('tf-order').value = t?.sort_order ?? (state.admin?.allTournaments?.length || 0) + 1;
  $('tf-mode-label').value = t?.mode_label || '';
  $('tf-team-size').value = String(t?.team_size || 1);
  $('tf-scoring-mode').value = t?.scoring_mode || 'direct';
  $('tf-rounds-count').value = t?.rounds_count || 5;
  $('tf-bracket').value = t?.bracket_url || '';
  $('tf-major').checked = Boolean(t?.is_major);
  $('tf-active').checked = t ? Boolean(t.active) : true;
  $('tf-error').textContent = '';

  tourneyEditPresets = (t?.round_presets || []).map((p) => ({ ...p }));
  $('tf-rounds-box').hidden = $('tf-scoring-mode').value !== 'rounds';
  renderTourneyPresets();

  const scaleKeys = ['1', '2', '3', '4', '5', '6', '7', '8', 'default'];
  $('tf-scale-grid').innerHTML = scaleKeys
    .map(
      (k) => `<div class="scale-cell"><label>${k === 'default' ? 'Part.' : `#${k}`}</label><input type="number" class="hgw-input hgw-input--mono" data-tf-scale="${k}" value="${scale[k] ?? 0}" min="0" /></div>`
    )
    .join('');

  $('tf-delete').hidden = !t;
  $('tf-delete').disabled = Boolean(t && t.registrations?.length > 0);
  $('tourney-dialog').showModal();
  $('tf-name').focus();
}

function bindTourneyDialog() {
  $('tf-scoring-mode').addEventListener('change', (e) => {
    $('tf-rounds-box').hidden = e.target.value !== 'rounds';
  });
  $('tf-add-preset').addEventListener('click', () => {
    syncPresetsFromDom();
    tourneyEditPresets.push({ label: 'Palier', points: 5 });
    renderTourneyPresets();
  });
  $('tf-presets-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-tp-del]');
    if (!del) return;
    syncPresetsFromDom();
    tourneyEditPresets.splice(Number(del.dataset.tpDel), 1);
    renderTourneyPresets();
  });

  function syncPresetsFromDom() {
    tourneyEditPresets = [...document.querySelectorAll('#tf-presets-list [data-tp-idx]')].map((row) => ({
      label: row.querySelector('[data-tp-label]').value.trim(),
      points: Number(row.querySelector('[data-tp-pts]').value) || 0,
    }));
  }

  $('tourney-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('tf-error').textContent = '';
    syncPresetsFromDom();
    const points_scale = {};
    document.querySelectorAll('#tf-scale-grid [data-tf-scale]').forEach((inp) => {
      points_scale[inp.dataset.tfScale] = Number(inp.value) || 0;
    });
    const payload = {
      name: $('tf-name').value.trim(),
      game_id: $('tf-game').value,
      scheduled_label: $('tf-schedule').value.trim(),
      sort_order: Number($('tf-order').value) || 1,
      mode_label: $('tf-mode-label').value.trim(),
      team_size: Number($('tf-team-size').value) || 1,
      scoring_mode: $('tf-scoring-mode').value,
      rounds_count: Number($('tf-rounds-count').value) || 5,
      round_presets: tourneyEditPresets.filter((p) => p.label),
      bracket_url: $('tf-bracket').value.trim() || null,
      is_major: $('tf-major').checked,
      active: $('tf-active').checked,
      points_scale,
    };

    const isNew = !tourneyEdit.id;
    const { ok, data } = await api(
      isNew ? '/api/admin/tournaments' : `/api/admin/tournaments/${encodeURIComponent(tourneyEdit.id)}`,
      { method: isNew ? 'POST' : 'PUT', json: payload }
    );
    if (!ok) {
      $('tf-error').textContent = plain(data.error) || 'Enregistrement impossible.';
      return;
    }
    $('tourney-dialog').close();
    adminTourneyId = data.tournament.id;
    toast({ title: isNew ? 'Tournoi créé' : 'Tournoi mis à jour', type: 'success' });
    ctx.fetchState();
  });

  $('tf-delete').addEventListener('click', async () => {
    if (!tourneyEdit?.id) return;
    const confirmed = await confirmDialog({
      title: 'Supprimer ce tournoi ?',
      message: 'Cette action est définitive.',
      confirmLabel: 'Supprimer',
    });
    if (!confirmed) return;
    const { ok, data } = await api(`/api/admin/tournaments/${encodeURIComponent(tourneyEdit.id)}`, { method: 'DELETE' });
    if (!ok) {
      $('tf-error').textContent = plain(data.error);
      return;
    }
    $('tourney-dialog').close();
    adminTourneyId = null;
    toast({ title: 'Tournoi supprimé', type: 'success' });
    ctx.fetchState();
  });
}

// ============================================================================
// 5. CATALOGUE JEUX & DÉFIS (+ DIAGNOSTIC DE SANTÉ + IMPORT / EXPORT JSON)
// ============================================================================
async function loadCatalog() {
  if (catalogLoading) return;
  catalogLoading = true;
  const { ok, data } = await api('/api/admin/catalog');
  catalogLoading = false;
  if (!ok) return toastError(data, 'Impossible de charger le catalogue.');
  adminCatalog = data;
  catalogStale = false;
  if (!adminCatalog.games.find((g) => g.id === catGameId)) catGameId = adminCatalog.games[0]?.id || null;
  if (ctx.getRoute().pane === 'catalogue') renderCatalog();
}

function catGame(id = catGameId) {
  return adminCatalog?.games.find((g) => g.id === id) || null;
}

function catQuests(gameId = catGameId) {
  return (adminCatalog?.quests || []).filter((q) => q.game_id === gameId);
}

function coverage(gameId) {
  const actsCount = adminCatalog?.actsCount || 2;
  const qs = catQuests(gameId).filter((q) => q.active);
  const count = (act, d) => qs.filter((q) => q.difficulty === d && (q.unlock_week || 1) <= act).length;
  const out = {};
  for (let a = 1; a <= actsCount; a++) out[a] = DIFFS.map((d) => count(a, d));
  return out;
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

  // Diagnostic de santé global
  const health = adminCatalog.health;
  const healthZone = $('cat-health-zone');
  if (health && health.warnings?.length) {
    healthZone.innerHTML = `<div class="health-list">${health.warnings
      .slice(0, 4)
      .map(
        (w) =>
          `<div class="banner ${w.level === 'danger' ? 'banner--danger' : 'banner--info'}">${icon('alert')}<span>${esc(w.message)}</span></div>`
      )
      .join('')}</div>`;
  } else {
    healthZone.innerHTML = '';
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
        ${hasCoverageHole(g) ? `<span class="cat-game__warn" title="Il manque une difficulté dès l’Acte I">${icon('alert')}</span>` : ''}
      </button>`
    )
    .join('');

  $('cat-games')
    .querySelectorAll('[data-cat-game]')
    .forEach((b) =>
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
  const actsCount = adminCatalog.actsCount || 2;
  const acts = adminCatalog.acts || [];
  const cov = coverage(g.id);
  const pts = adminCatalog.pointsByDifficulty;
  const all = catQuests(g.id);
  const covRows = Array.from({ length: actsCount }, (_, i) => {
    const a = i + 1;
    const label = acts[i]?.name || `Acte ${a}`;
    return `<span class="coverage__h">${esc(label)}</span>${cov[a].map((c) => `<span class="coverage__n ${c === 0 ? 'is-empty' : ''}">${c}</span>`).join('')}`;
  }).join('');

  const filterButtons = [
    ['all', 'Tous', all.length],
    ...Array.from({ length: actsCount }, (_, i) => [`w${i + 1}`, acts[i]?.name || `Acte ${i + 1}`, all.filter((q) => q.unlock_week === i + 1 && q.active).length]),
    ['off', 'Archivés', all.filter((q) => !q.active).length],
  ];

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
    <div class="coverage" title="Défis actifs pouvant être tirés, par difficulté et par acte">
      <span></span>${DIFFS.map((d) => `<span class="coverage__h">${DIFF_LABEL[d]} · ${pts[d]} pts</span>`).join('')}
      ${covRows}
    </div>
    ${g.active && cov[1].some((c) => c === 0) ? `<div class="banner banner--info" style="margin-bottom: var(--space-4)">${icon('alert')}<span>Prévois au moins un défi facile, moyen et difficile dès l’Acte I pour éviter les répétitions.</span></div>` : ''}
    <div class="row" style="justify-content: space-between; margin-bottom: var(--space-3)">
      <div class="hgw-seg" role="group" aria-label="Filtrer les défis" id="cat-filter">
        ${filterButtons.map(([k, l, c]) => `<button type="button" data-f="${k}" aria-pressed="${catFilter === k}">${esc(l)} <span class="hgw-seg__n">${c}</span></button>`).join('')}
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
    if (catFilter === 'w3' && (q.unlock_week !== 3 || !q.active)) return false;
    if (catFilter === 'off' && q.active) return false;
    if (term && !`${q.title} ${q.description}`.toLowerCase().includes(term)) return false;
    return true;
  });
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="hgw-empty" style="padding: var(--space-6)"><strong>Aucun défi</strong>${term ? 'Rien ne correspond à ta recherche.' : 'Crée le premier avec « Nouveau défi ».'}</div></td></tr>`;
    return;
  }
  const roman = { 1: 'I', 2: 'II', 3: 'III' };
  tbody.innerHTML = rows
    .map(
      (q) => `<tr data-quest="${esc(q.id)}" class="${q.active ? '' : 'is-archived'}">
        <td>${diffPips(q.difficulty)}</td>
        <td><div class="cat-quest-title">${esc(plain(q.title))}</div><div class="cat-quest-desc">${esc(plain(q.description))}</div></td>
        <td>${roman[q.unlock_week] || q.unlock_week}</td>
        <td class="r mono" style="white-space: nowrap">${q.usage_count}<span class="faint"> / ${q.validated_count}</span></td>
        <td class="r" style="white-space: nowrap">
          <button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--icon hgw-btn--sm" data-q-toggle="${esc(q.id)}" title="${q.active ? 'Archiver' : 'Réactiver'}">${icon(q.active ? 'archive' : 'restore')}</button>
          ${q.usage_count === 0 ? `<button type="button" class="hgw-btn hgw-btn--ghost hgw-btn--icon hgw-btn--sm" data-q-delete="${esc(q.id)}" title="Supprimer">${icon('trash')}</button>` : ''}
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
      type: 'success',
      action: { label: 'Annuler', fn: () => toggleQuest(id, true) },
    });
  }
}

async function removeQuest(id) {
  const q = adminCatalog.quests.find((x) => x.id === id);
  if (!q) return false;
  const confirmed = await confirmDialog({
    title: 'Supprimer ce défi ?',
    message: `Supprimer définitivement « ${plain(q.title)} » ?`,
    confirmLabel: 'Supprimer',
  });
  if (!confirmed) return false;
  const { ok, data } = await api(`/api/admin/quests/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!ok) {
    toastError(data);
    return false;
  }
  toast({ title: 'Défi supprimé', type: 'success' });
  await loadCatalog();
  return true;
}

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
  $('gf-sgdb').hidden = false;
  $('gf-sgdb-results').innerHTML = adminCatalog.logoSearchEnabled
    ? ''
    : `<p class="small faint">Recherche de logos désactivée. Ajoute <span class="mono">STEAMGRIDDB_API_KEY</span> dans <span class="mono">.env</span>.</p>`;
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
  if (q.length < 2) return ($('gf-sgdb-results').innerHTML = '');
  const { ok, data } = await api(`/api/admin/logo-search?q=${encodeURIComponent(q)}`);
  if (!ok) return ($('gf-sgdb-results').innerHTML = `<p class="small t-danger">${esc(plain(data.error))}</p>`);
  if (!data.results.length) return ($('gf-sgdb-results').innerHTML = `<p class="small faint">Aucun jeu trouvé.</p>`);
  $('gf-sgdb-results').innerHTML = data.results
    .map((r) => `<button type="button" class="reason" data-sgdb="${r.id}" aria-pressed="${r.id === sgdbGameId}">${esc(r.name)}${r.year ? ` <span class="faint">${r.year}</span>` : ''}</button>`)
    .join('');
  $('gf-sgdb-results')
    .querySelectorAll('[data-sgdb]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        sgdbGameId = Number(b.dataset.sgdb);
        $('gf-sgdb-results')
          .querySelectorAll('[data-sgdb]')
          .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        loadLogoImages();
      })
    );
  if (!sgdbGameId) $('gf-sgdb-results').querySelector('[data-sgdb]').click();
}

async function loadLogoImages() {
  if (!sgdbGameId) return;
  $('gf-sgdb-images').innerHTML = `<p class="small faint">Chargement…</p>`;
  const { ok, data } = await api(`/api/admin/logo-search/${sgdbGameId}/images?type=${sgdbType}`);
  if (!ok) return ($('gf-sgdb-images').innerHTML = `<p class="small t-danger">${esc(plain(data.error))}</p>`);
  const safeImages = (data.images || [])
    .map((i) => ({ ...i, safeUrl: safeUrl(i.url, ['https:']), safeThumb: safeUrl(i.thumb, ['https:']) }))
    .filter((i) => i.safeUrl && i.safeThumb);
  if (!safeImages.length) return ($('gf-sgdb-images').innerHTML = `<p class="small faint">Aucune image de ce type.</p>`);
  $('gf-sgdb-images').innerHTML = safeImages
    .map((i) => `<button type="button" data-img="${esc(i.safeUrl)}" title="${esc(i.width)} × ${esc(i.height)}"><img src="${esc(i.safeThumb)}" alt="" loading="lazy" /></button>`)
    .join('');
  $('gf-sgdb-images')
    .querySelectorAll('[data-img]')
    .forEach((b) => b.addEventListener('click', () => pickLogo(b.dataset.img)));
}

async function pickLogo(url) {
  if (!gameEdit.id) {
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
  toast({ title: 'Logo importé', type: 'success' });
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
  if (!pendingLocal) payload.logo_url = logo || null;
  const isNew = !gameEdit.id;
  const { ok, data } = await api(isNew ? '/api/admin/games' : `/api/admin/games/${encodeURIComponent(gameEdit.id)}`, {
    method: isNew ? 'POST' : 'PUT',
    json: payload,
  });
  if (!ok) return ($('gf-error').textContent = plain(data.error) || 'Enregistrement impossible.');
  const id = data.game.id;
  if (gameEdit.pendingFile) await uploadLogo(id, gameEdit.pendingFile);
  else if (gameEdit.pendingImport) {
    const r = await api(`/api/admin/games/${encodeURIComponent(id)}/logo-import`, { json: { url: gameEdit.pendingImport } });
    if (!r.ok) toastError(r.data);
  }
  $('game-dialog').close();
  toast({ title: isNew ? 'Jeu ajouté' : 'Jeu enregistré', type: 'success' });
  catGameId = id;
  await loadCatalog();
  ctx.fetchState();
}

function renderQuestSegs() {
  const pts = adminCatalog.pointsByDifficulty;
  const actsCount = adminCatalog.actsCount || 2;
  const acts = adminCatalog.acts || [];
  $('qf-diff').innerHTML = DIFFS.map(
    (d) => `<button type="button" data-d="${d}" aria-pressed="${questEdit.difficulty === d}">${DIFF_LABEL[d]} <span class="hgw-seg__n">${pts[d]} pts</span></button>`
  ).join('');
  $('qf-diff')
    .querySelectorAll('[data-d]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        questEdit.difficulty = b.dataset.d;
        renderQuestSegs();
      })
    );
  $('qf-week').innerHTML = Array.from({ length: actsCount }, (_, i) => {
    const a = i + 1;
    return `<button type="button" data-week="${a}" aria-pressed="${questEdit.unlock_week === a}">${esc(acts[i]?.name || `Acte ${a}`)}</button>`;
  }).join('');
  $('qf-week')
    .querySelectorAll('[data-week]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        questEdit.unlock_week = Number(b.dataset.week);
        renderQuestSegs();
      })
    );
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
  const locked = Boolean(q && q.validated_count > 0);
  $('qf-game').disabled = locked;
  $('qf-diff').classList.toggle('is-disabled', locked);
  $('qf-delete').hidden = !q;
  $('qf-delete').disabled = Boolean(q && q.usage_count > 0);
  renderQuestSegs();
  $('qf-diff')
    .querySelectorAll('button')
    .forEach((b) => (b.disabled = locked));
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
  if (!ok) return ($('qf-error').textContent = plain(data.error) || 'Enregistrement impossible.');
  $('quest-dialog').close();
  toast({ title: isNew ? 'Défi créé' : 'Défi enregistré', type: 'success' });
  catGameId = data.quest.game_id;
  if (isNew && catFilter === 'off') catFilter = 'all';
  await loadCatalog();
}

function bindCatalog() {
  $('cat-add-game').addEventListener('click', () => openGameDialog(null));
  $('cat-export').addEventListener('click', () => (location.href = '/api/admin/catalog/export'));
  $('cat-import').addEventListener('click', () => {
    $('cat-import-form').reset();
    $('ci-error').textContent = '';
    $('cat-import-dialog').showModal();
  });
  $('ci-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) $('ci-json').value = await f.text();
  });
  $('cat-import-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('ci-error').textContent = '';
    let parsed;
    try {
      parsed = JSON.parse($('ci-json').value);
    } catch {
      $('ci-error').textContent = 'JSON invalide : vérifie la syntaxe.';
      return;
    }
    const { ok, data } = await api('/api/admin/catalog/import', {
      json: { ...parsed, mode: $('ci-overwrite').checked ? 'overwrite_matching' : 'merge' },
    });
    if (!ok) {
      $('ci-error').textContent = plain(data.error) || 'Import impossible.';
      return;
    }
    $('cat-import-dialog').close();
    toast({
      title: 'Catalogue importé',
      text: `+${data.gamesCreated} jeux, +${data.questsCreated} défis (${data.gamesUpdated + data.questsUpdated} mis à jour, ${data.skipped} ignorés).`,
      type: 'success',
    });
    await loadCatalog();
    ctx.fetchState();
  });

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
    if (!g) return;
    const confirmed = await confirmDialog({
      title: 'Supprimer ce jeu ?',
      message: `Supprimer définitivement ${g.name} et ses ${g.quest_count} défis ?`,
      confirmLabel: 'Supprimer',
    });
    if (!confirmed) return;
    const { ok, data } = await api(`/api/admin/games/${encodeURIComponent(g.id)}`, { method: 'DELETE' });
    if (!ok) return ($('gf-error').textContent = plain(data.error));
    $('game-dialog').close();
    toast({ title: 'Jeu supprimé', type: 'success' });
    catGameId = null;
    await loadCatalog();
    ctx.fetchState();
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
  $('gf-sgdb-type')
    .querySelectorAll('[data-type]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        sgdbType = b.dataset.type;
        $('gf-sgdb-type')
          .querySelectorAll('[data-type]')
          .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        loadLogoImages();
      })
    );
  $('qf-delete').addEventListener('click', async () => {
    if (questEdit?.id && (await removeQuest(questEdit.id))) $('quest-dialog').close();
  });
}

// ============================================================================
// 6. POINTS & TOMBOLA
// ============================================================================
function renderPointsPane() {
  const state = ctx.getState();
  const sel = $('mp-user');
  const users = state.admin?.allUsers || [];
  const current = sel.value;
  sel.innerHTML = users.map((u) => `<option value="${esc(u.id)}">${esc(u.display_name)} (@${esc(u.username)})</option>`).join('');
  if (current) sel.value = current;
  updateManualPreview();
  const qualified = (state.leaderboard || []).filter((x) => x.tombola_eligible).length;
  $('tombola-desc').textContent = `${qualified} joueur${qualified > 1 ? 's' : ''} qualifié${qualified > 1 ? 's' : ''} (${state.tombolaThreshold} pts et plus) · Lot : ${state.eventSettings?.tombola_prize || 'Tombola'}.`;
}

function updateManualPreview() {
  const state = ctx.getState();
  const uid = $('mp-user').value;
  const amount = Math.round(Number($('mp-amount').value));
  const lb = state?.leaderboard || [];
  const player = lb.find((p) => p.id === uid);
  const user = (state?.admin?.allUsers || []).find((u) => u.id === uid);
  if (!user || !Number.isFinite(amount) || amount === 0) {
    $('mp-preview').innerHTML = `<span class="faint">Choisis un joueur et un montant non nul.</span>`;
    return;
  }
  const before = player?.total_points || 0;
  const after = before + amount;
  const newRank = lb.filter((p) => p.id !== uid && p.total_points > after).length + 1;
  $('mp-preview').innerHTML = `<b>${esc(user.display_name)}</b> : <span class="hgw-num">${fmt(before)} → ${fmt(after)}</span> pts · ${player ? `rang ${player.rank} → ${newRank}` : `entre au rang ${newRank}`}`;
}

function bindManualPoints() {
  ['mp-user', 'mp-amount'].forEach((id) => $(id).addEventListener('input', updateManualPreview));
  $('manual-points-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = $('mp-label').value.trim();
    const points = Math.round(Number($('mp-amount').value));
    const field = $('mp-label').closest('.hgw-field');
    field.classList.toggle('hgw-field--error', label.length < 3);
    if (!points) return $('mp-amount').focus();
    if (label.length < 3) return $('mp-label').focus();
    const { ok, data } = await api('/api/admin/manual-points', {
      json: { userId: $('mp-user').value, category: $('mp-cat').value, points, label },
    });
    if (!ok) return toastError(data);
    $('mp-label').value = '';
    toast({ title: `${signed(points)} pts appliqués`, text: label, type: 'success' });
    ctx.fetchState();
  });
}

// ============================================================================
// 7. ACCÈS ADMINS & MAINTENANCE
// ============================================================================
function renderMaintenancePane() {
  const state = ctx.getState();
  $('dev-tools').hidden = !state.devMode;
  const users = state.admin?.allUsers || [];
  const tbody = $('admin-users-tbody');
  tbody.innerHTML = users
    .map(
      (u) => `<tr>
        <td><div class="hgw-player">${avatar(u)}<span class="hgw-player__name">${esc(u.display_name)}${u.id === state.user?.id ? ' <span class="hgw-badge" style="height:18px">toi</span>' : ''}</span></div></td>
        <td class="small muted">@${esc(u.username)}</td>
        <td class="r"><input type="checkbox" class="check" data-admin-toggle="${esc(u.id)}" ${u.is_admin ? 'checked' : ''} aria-label="Droits admin pour ${esc(u.display_name)}" /></td>
      </tr>`
    )
    .join('');

  tbody.querySelectorAll('[data-admin-toggle]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const { ok, data } = await api(`/api/admin/users/${encodeURIComponent(cb.dataset.adminToggle)}/admin`, {
        json: { isAdmin: cb.checked },
      });
      if (!ok) {
        cb.checked = !cb.checked;
        return toastError(data);
      }
      toast({ title: cb.checked ? 'Droits admin accordés' : 'Droits admin retirés', type: 'success' });
      ctx.fetchState();
    })
  );
}

function bindMaintenance() {
  $('cron-confirm').addEventListener('input', (e) => ($('cron-btn').disabled = e.target.value.trim().toUpperCase() !== 'RELANCER'));
  $('cron-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('cron-btn').disabled) return;
    const { ok, data } = await api('/api/admin/cron/trigger', { method: 'POST' });
    if (!ok) return toastError(data);
    $('cron-confirm').value = '';
    $('cron-btn').disabled = true;
    toast({ title: 'Tirage relancé', text: `${data.usersProcessed} joueurs traités.`, type: 'success' });
    ctx.fetchState();
  });

  $('seed-demo-btn').addEventListener('click', async () => {
    const { ok, data } = await api('/api/admin/seed-demo', { method: 'POST' });
    if (!ok) return toastError(data);
    toast({ title: plain(data.message) || 'Joueurs fictifs ajoutés', type: 'success' });
    ctx.fetchState();
  });

  $('sim-finish-btn').addEventListener('click', async () => {
    const state = ctx.getState();
    const ladder = (state?.featuredItems || []).find((m) => m.is_ladder);
    if (!ladder) return toast({ title: 'Aucune épreuve Ladder configurée', type: 'danger' });
    const best = state?.featuredLadder?.[0]?.best_value || 42500;
    const { ok, data } = await api('/api/tmnf/webhook', {
      json: {
        playerLogin: state.user.tmnf_login || state.user.username,
        playerNickname: state.user.display_name,
        mapUid: ladder.external_uid || ladder.uid,
        timeMs: Math.max(38500, best - Math.floor(Math.random() * 280) - 40),
      },
    });
    if (!ok) return toastError(data);
    toast({ title: `Chrono simulé : ${data.formattedTime}`, type: 'success' });
  });
}
