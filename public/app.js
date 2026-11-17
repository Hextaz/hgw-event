let appState = null;
let selectedGameIds = new Set();
let gamesDrawerOpen = false;
let pastedProofFile = null;
let streamRevealQueue = [];
let streamRevealIndex = 0;

function showToast(message) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDeltaSeconds(msDiff) {
  const sec = (msDiff / 1000).toFixed(3);
  return msDiff > 0 ? `+${sec}s` : `${sec}s`;
}

function switchView(viewName) {
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === `view-${viewName}`);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Compte à rebours en direct jusqu'au prochain tirage de 03h00 (Europe/Paris).
 */
function updateResetCountdown() {
  const el = document.getElementById('live-reset-countdown');
  if (!el) return;

  const now = new Date();
  const parisStr = now.toLocaleString('en-US', { timeZone: 'Europe/Paris' });
  const parisNow = new Date(parisStr);
  const nextReset = new Date(parisNow);
  nextReset.setHours(3, 0, 0, 0);
  if (parisNow >= nextReset) {
    nextReset.setDate(nextReset.getDate() + 1);
  }

  const diffSec = Math.max(0, Math.floor((nextReset.getTime() - parisNow.getTime()) / 1000));
  const h = String(Math.floor(diffSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((diffSec % 3600) / 60)).padStart(2, '0');
  const s = String(diffSec % 60).padStart(2, '0');
  el.textContent = `${h}h ${m}m ${s}s`;
}

async function fetchState() {
  const res = await fetch('/api/state');
  appState = await res.json();
  selectedGameIds = new Set(appState.mySelectedGames || []);
  renderAll();
}

function renderAll() {
  if (!appState) return;

  document.getElementById('cycle-indicator').textContent = `Cycle ${appState.dayKey} • Semaine ${appState.weekKey}`;

  const adminTab = document.getElementById('tab-admin');
  if (appState.user?.is_admin === 1) {
    adminTab.style.display = 'inline-flex';
    const pendingCount = appState.admin?.pendingProofs?.length || 0;
    document.getElementById('nav-admin-badge').textContent = String(pendingCount);
  } else {
    adminTab.style.display = 'none';
  }

  renderAuthZone();
  renderPersonalStatusBar();
  renderPodium();
  renderLeaderboardAndFeed();
  renderQuestsAndGames();
  renderTrackmania();
  renderTournaments();
  if (appState.user?.is_admin === 1) {
    renderAdmin();
  }
}

function renderAuthZone() {
  const slot = document.getElementById('auth-user-slot');
  if (!appState.user) {
    slot.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" id="open-login-modal-btn">
        🎮 Connexion Discord
      </button>
    `;
    document.getElementById('open-login-modal-btn').addEventListener('click', () => {
      document.getElementById('login-modal').classList.add('open');
    });
    return;
  }

  const meInLb = (appState.leaderboard || []).find((u) => u.id === appState.user.id);
  const myPts = meInLb ? meInLb.total_points : 0;

  slot.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.5rem;">
      <div class="user-chip" id="my-profile-chip" title="Voir le détail de mes points">
        <span>👤 <strong>${escapeHtml(appState.user.display_name)}</strong></span>
        <span class="user-chip-pts">${myPts} pts</span>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" id="logout-btn" title="Se déconnecter">⏻</button>
    </div>
  `;

  document.getElementById('my-profile-chip').addEventListener('click', () => {
    openPlayerLedgerModal(appState.user.id);
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    await fetchState();
    showToast('Déconnecté.');
  });
}

function renderPersonalStatusBar() {
  const bar = document.getElementById('personal-status-bar');
  const lb = appState.leaderboard || [];
  const topTm = appState.weeklyTmnfLeaderboard?.[0];

  if (!appState.user) {
    bar.innerHTML = `
      <div style="grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
        <div>
          <strong style="font-family: var(--font-display); font-size: 1.15rem;">
            🔥 Bienvenue sur la Hextaz Games Week (HGW) !
          </strong>
          <p style="font-size: 0.88rem; color: var(--text-secondary); margin-top: 0.15rem;">
            Connecte-toi avec Discord pour tirer tes <strong>3 défis quotidiens (80 pts/j)</strong>, envoyer tes
            <code>.Replay.gbx</code> Trackmania et viser le <strong>Ticket Tombola (300 pts)</strong>.
          </p>
        </div>
        <button type="button" class="btn btn-primary" id="banner-login-btn">
          🎮 Se connecter & Commencer
        </button>
      </div>
    `;
    document.getElementById('banner-login-btn').addEventListener('click', () => {
      document.getElementById('login-modal').classList.add('open');
    });
    return;
  }

  const me = lb.find((u) => u.id === appState.user.id) || {
    rank: '—',
    total_points: 0,
    async_points: 0,
    live_points: 0,
    quests_validated: 0,
    tmnf_medals_count: 0,
    tombola_eligible: false,
    tombola_progress_pct: 0,
  };

  const questsToday = appState.myDailyQuests || [];
  const doneToday = questsToday.filter((q) => q.status === 'validated').length;
  const remainingTombola = Math.max(0, appState.tombolaThreshold - me.total_points);

  bar.innerHTML = `
    <div>
      <div style="font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-gold); font-weight: 700;">
        Mon Tableau de Bord • ${escapeHtml(appState.user.display_name)}
      </div>
      <div style="font-family: var(--font-display); font-size: 1.25rem; font-weight: 700; margin-top: 0.1rem;">
        Rang #${me.rank} <span style="font-size: 0.88rem; color: var(--text-secondary); font-weight: 500;">sur ${lb.length} joueurs</span>
      </div>
      <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem;">
        Async : <strong class="mono">${me.async_points} pts</strong> • Live : <strong class="mono">${me.live_points} pts</strong>
      </div>
    </div>

    <div class="status-stat">
      <div class="status-stat-label">Points Totaux</div>
      <div class="status-stat-val" style="color: var(--accent-gold)">${me.total_points} pts</div>
      <div style="font-size: 0.73rem; color: var(--text-muted)">Clique pour voir l'historique</div>
    </div>

    <div class="status-stat">
      <div class="status-stat-label">Ticket Tombola (300 pts)</div>
      <div class="status-stat-val" style="color: ${me.tombola_eligible ? 'var(--accent-emerald)' : 'var(--text-primary)'}">
        ${me.tombola_eligible ? '🎟️ Qualifié !' : `Encore ${remainingTombola} pts`}
      </div>
      <div class="progress-track" style="margin-top: 0.35rem">
        <div class="progress-fill" style="width: ${me.tombola_progress_pct}%"></div>
      </div>
    </div>

    <div class="status-stat">
      <div class="status-stat-label">Défis du Jour</div>
      <div class="status-stat-val">${doneToday} / ${questsToday.length || 3} validés</div>
      <div style="font-size: 0.73rem; color: var(--text-secondary)">
        ${appState.canRerollToday ? '🎲 1 Reroll dispo' : '✓ Reroll utilisé'}
      </div>
    </div>

    <div class="status-stat">
      <div class="status-stat-label">Chasse Médailles TMNF</div>
      <div class="status-stat-val">${me.tmnf_medals_count} / 8 pistes</div>
      <div style="font-size: 0.73rem; color: var(--text-secondary)">
        ${topTm ? `WR Hebdo : ${topTm.formatted_time}` : 'Serveur 24/7'}
      </div>
    </div>
  `;
}

function renderPodium() {
  const grid = document.getElementById('podium-grid');
  const lb = appState.leaderboard || [];
  if (lb.length === 0) {
    grid.innerHTML = '';
    return;
  }

  const p1 = lb[0];
  const p2 = lb[1];
  const p3 = lb[2];
  const leaderPts = p1 ? p1.total_points : 0;

  const buildPodiumCard = (player, rank, prizeLabel, badgeLabel) => {
    if (!player) {
      return `
        <div class="podium-card podium-rank-${rank}" style="opacity:0.5;cursor:default;">
          <div class="card-header">
            <span class="badge">${badgeLabel}</span>
          </div>
          <div style="color:var(--text-muted);font-size:0.9rem;">Place sur le podium disponible</div>
          <div class="prize-tag">🎁 ${prizeLabel}</div>
        </div>
      `;
    }

    const initials = (player.display_name || 'H').slice(0, 2).toUpperCase();
    const gap = rank === 1 ? 'Leader HGW' : `-${leaderPts - player.total_points} pts du 1er`;
    const total = Math.max(1, player.total_points);
    const asyncPct = Math.round((player.async_points / total) * 100);
    const livePct = 100 - asyncPct;

    return `
      <div class="podium-card podium-rank-${rank}" data-inspect-uid="${player.id}">
        <div>
          <div class="card-header" style="margin-bottom:0.75rem;">
            <span class="badge ${rank === 1 ? 'badge-hard' : rank === 2 ? 'badge-medium' : 'badge-easy'}">
              ${badgeLabel}
            </span>
            <span class="mono" style="font-size:0.75rem;color:var(--text-muted);">${gap}</span>
          </div>

          <div style="display:flex;align-items:center;gap:0.85rem;margin-bottom:0.85rem;">
            <div class="podium-avatar">${escapeHtml(initials)}</div>
            <div>
              <div style="font-family:var(--font-display);font-size:1.2rem;font-weight:700;line-height:1.15;">
                ${escapeHtml(player.display_name)}
              </div>
              <div style="font-size:0.78rem;color:var(--text-secondary);margin-top:0.15rem;">
                ${player.quests_validated} défis • ${player.tmnf_medals_count}/8 médailles TM
              </div>
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.35rem;">
            <span class="mono" style="font-size:1.5rem;font-weight:700;color:var(--accent-gold);">
              ${player.total_points} pts
            </span>
            <span class="mono" style="font-size:0.74rem;color:var(--text-secondary);">
              Async ${player.async_points} • Live ${player.live_points}
            </span>
          </div>

          <div class="split-bar" title="Semaine Async (${player.async_points} pts) vs Week-end Live (${player.live_points} pts)">
            <div class="split-bar-async" style="width:${asyncPct}%"></div>
            <div class="split-bar-live" style="width:${livePct}%"></div>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;">
          <span class="prize-tag">🎁 ${prizeLabel}</span>
          ${player.tombola_eligible ? `<span class="badge badge-easy">🎟️ Tombola</span>` : ''}
        </div>
      </div>
    `;
  };

  // Ordre visuel classique d'un podium : 2e à gauche, 1er au centre, 3e à droite
  grid.innerHTML = [
    buildPodiumCard(p2, 2, 'Discord Nitro', '🥈 2e Place'),
    buildPodiumCard(p1, 1, 'Carte Cadeau 10€ + Rôle Custom', '🥇 1re Place — Champion'),
    buildPodiumCard(p3, 3, '1 Sub Twitch', '🥉 3e Place'),
  ].join('');

  grid.querySelectorAll('[data-inspect-uid]').forEach((card) => {
    card.addEventListener('click', () => openPlayerLedgerModal(card.dataset.inspectUid));
  });
}

function renderLeaderboardAndFeed() {
  const tbody = document.getElementById('leaderboard-tbody');
  const rows = appState.leaderboard || [];

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Aucun joueur inscrit pour l'instant.
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = rows
      .map((p) => {
        const rankBadge =
          p.rank === 1 ? '🥇 1er' : p.rank === 2 ? '🥈 2e' : p.rank === 3 ? '🥉 3e' : `#${p.rank}`;
        const total = Math.max(1, p.total_points);
        const asyncPct = Math.round((p.async_points / total) * 100);
        const livePct = 100 - asyncPct;

        const tombolaBadge = p.tombola_eligible
          ? `<span class="badge badge-easy">🎟️ Qualifié (${p.total_points} pts)</span>`
          : `<div style="display:flex;align-items:center;gap:0.55rem;">
               <div class="progress-track" style="max-width:110px;">
                 <div class="progress-fill" style="width:${p.tombola_progress_pct}%"></div>
               </div>
               <span class="mono" style="font-size:0.74rem;color:var(--text-muted);">${p.total_points}/300</span>
             </div>`;

        return `
          <tr class="clickable-row" data-inspect-uid="${p.id}" title="Cliquer pour voir le détail des points de ${escapeHtml(p.display_name)}">
            <td class="rank-cell">${rankBadge}</td>
            <td>
              <strong>${escapeHtml(p.display_name)}</strong>
              ${p.tmnf_login ? `<span class="mono" style="font-size:0.7rem;color:var(--text-muted);margin-left:0.35rem;">[${escapeHtml(p.tmnf_login)}]</span>` : ''}
            </td>
            <td style="min-width:160px;">
              <div style="display:flex;justify-content:space-between;font-size:0.74rem;margin-bottom:0.2rem;" class="mono">
                <span style="color:var(--accent-emerald)">${p.async_points} Async</span>
                <span style="color:var(--accent-sky)">${p.live_points} Live</span>
              </div>
              <div class="split-bar">
                <div class="split-bar-async" style="width:${asyncPct}%"></div>
                <div class="split-bar-live" style="width:${livePct}%"></div>
              </div>
            </td>
            <td style="font-size:0.8rem;color:var(--text-secondary);">
              ${p.quests_validated} défis • ${p.tmnf_medals_count}/8 TM
            </td>
            <td>${tombolaBadge}</td>
            <td class="mono" style="font-weight:700;font-size:1.05rem;color:var(--accent-gold);">
              ${p.total_points} pts
            </td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('[data-inspect-uid]').forEach((tr) => {
      tr.addEventListener('click', () => openPlayerLedgerModal(tr.dataset.inspectUid));
    });
  }

  // Render Live Feed
  const feedEl = document.getElementById('live-feed-list');
  const feed = appState.recentFeed || [];
  if (feed.length === 0) {
    feedEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.84rem;">Aucune activité enregistrée.</div>`;
  } else {
    feedEl.innerHTML = feed
      .map(
        (item) => `
        <div class="feed-item">
          <div>
            <strong style="color:var(--text-primary);">${escapeHtml(item.display_name)}</strong>
            <div style="color:var(--text-secondary);font-size:0.78rem;margin-top:0.1rem;">
              ${escapeHtml(item.label)}
            </div>
          </div>
          <span class="feed-pts">+${item.points} pts</span>
        </div>
      `
      )
      .join('');
  }
}

async function openPlayerLedgerModal(userId) {
  const res = await fetch(`/api/player/${encodeURIComponent(userId)}/ledger`);
  if (!res.ok) return;
  const data = await res.json();

  document.getElementById('player-ledger-title').textContent = `📜 Journal des Points — ${data.player.display_name}`;
  const gamesBox = document.getElementById('player-ledger-games');
  gamesBox.innerHTML = (data.selectedGames || [])
    .map((g) => `<span class="badge badge-medium">${g.emoji} ${escapeHtml(g.short_name)}</span>`)
    .join('');

  const entriesBox = document.getElementById('player-ledger-entries');
  if (!data.entries || data.entries.length === 0) {
    entriesBox.innerHTML = `<div style="color:var(--text-muted);font-size:0.86rem;">Aucun point crédité pour le moment.</div>`;
  } else {
    entriesBox.innerHTML = data.entries
      .map(
        (e) => `
        <div class="feed-item">
          <div>
            <div style="font-weight:600;color:var(--text-primary);">${escapeHtml(e.label)}</div>
            <div class="mono" style="font-size:0.72rem;color:var(--text-muted);margin-top:0.15rem;">
              Catégorie : ${e.category.toUpperCase()} • Réf : ${escapeHtml(e.source_ref)}
            </div>
          </div>
          <span class="feed-pts">+${e.points} pts</span>
        </div>
      `
      )
      .join('');
  }

  document.getElementById('player-ledger-modal').classList.add('open');
}

function renderQuestsAndGames() {
  const questsContainer = document.getElementById('quests-container');
  const gamesGrid = document.getElementById('games-selector-grid');
  const drawer = document.getElementById('games-selector-drawer');
  const toggleBtn = document.getElementById('toggle-games-drawer-btn');
  const masterySection = document.getElementById('weekly-mastery-section');
  const masteryStrip = document.getElementById('weekly-mastery-strip');

  const hasEnoughGames = (appState.mySelectedGames || []).length >= 4;

  if (appState.user && hasEnoughGames) {
    toggleBtn.style.display = 'inline-flex';
    toggleBtn.textContent = gamesDrawerOpen
      ? '🔼 Masquer la sélection de jeux'
      : `⚙️ Modifier mes jeux (${appState.mySelectedGames.length} cochés)`;
    drawer.style.display = gamesDrawerOpen ? 'block' : 'none';
    masterySection.style.display = 'block';

    // Render mastery strip (X/5 per game)
    const counts = appState.myWeeklyGameCounts || {};
    const myGamesObjs = (appState.games || []).filter(
      (g) => g.is_universal || appState.mySelectedGames.includes(g.id)
    );

    masteryStrip.innerHTML = myGamesObjs
      .map((g) => {
        const cnt = Math.min(5, counts[g.id] || 0);
        const pipsHtml = [0, 1, 2, 3, 4]
          .map((i) => `<span class="pip ${i < cnt ? 'filled' : ''}"></span>`)
          .join('');
        return `
          <div class="mastery-chip ${cnt >= 5 ? 'capped' : ''}" title="${cnt}/5 défis validés ou soumis cette semaine sur ${escapeHtml(g.name)}">
            <span>${g.emoji} <strong>${escapeHtml(g.short_name)}</strong></span>
            <span class="pips">${pipsHtml}</span>
            <span class="mono" style="font-size:0.74rem;color:var(--text-secondary);">${cnt}/5</span>
          </div>
        `;
      })
      .join('');
  } else {
    toggleBtn.style.display = 'none';
    drawer.style.display = 'block';
    masterySection.style.display = 'none';
  }

  if (!appState.user) {
    questsContainer.innerHTML = `
      <div class="card" style="text-align:center;padding:2rem;">
        <h3 class="card-title" style="margin-bottom:0.5rem;">Connecte-toi pour découvrir tes 3 défis du jour !</h3>
        <p style="color:var(--text-secondary);font-size:0.9rem;margin-bottom:1rem;">
          Chaque nuit à 03h00, le site tire au sort 1 défi Facile (15 pts), 1 Moyen (25 pts) et 1 Difficile (40 pts) uniquement sur tes jeux cochés.
        </p>
        <button type="button" class="btn btn-primary" id="quests-login-btn">🎮 Se connecter</button>
      </div>
    `;
    document.getElementById('quests-login-btn')?.addEventListener('click', () => {
      document.getElementById('login-modal').classList.add('open');
    });
  } else if (!hasEnoughGames) {
    questsContainer.innerHTML = `
      <div class="card" style="border-color:var(--accent-gold);">
        <h3 class="card-title">👇 Coche au moins 4 jeux ci-dessous pour générer immédiatement tes 3 défis !</h3>
        <p style="color:var(--text-secondary);font-size:0.88rem;margin-top:0.35rem;">
          Pas besoin d'attendre 03h00 du matin : tes 3 premiers défis tombent dès la sauvegarde.
        </p>
      </div>
    `;
  } else {
    const quests = appState.myDailyQuests || [];
    const doneCount = quests.filter((q) => q.status === 'validated').length;
    document.getElementById('nav-quests-badge').textContent = `${doneCount}/${quests.length}`;

    questsContainer.innerHTML = `
      <div class="grid-3">
        ${quests
          .map((q) => {
            const diffBadge =
              q.difficulty === 'easy'
                ? `<span class="badge badge-easy">Facile • +${q.points} pts</span>`
                : q.difficulty === 'medium'
                ? `<span class="badge badge-medium">Moyen • +${q.points} pts</span>`
                : `<span class="badge badge-hard">Difficile • +${q.points} pts</span>`;

            const gameWeekCnt = appState.myWeeklyGameCounts?.[q.game_id] || 0;

            let actionArea = '';
            if (q.status === 'open') {
              actionArea = `
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                  <button type="button" class="btn btn-primary btn-sm open-proof-btn" data-id="${q.id}" data-title="${escapeHtml(q.title)}" data-hint="${escapeHtml(q.proof_hint)}">
                    📤 Envoyer ma preuve (Ctrl+V)
                  </button>
                  ${
                    appState.canRerollToday
                      ? `<button type="button" class="btn btn-secondary btn-sm reroll-quest-btn" data-id="${q.id}">🎲 Reroll (1/j)</button>`
                      : ''
                  }
                </div>
              `;
            } else if (q.status === 'submitted') {
              actionArea = `<span class="badge badge-medium">🕵️ Preuve envoyée — En attente dans #preuves</span>`;
            } else if (q.status === 'validated') {
              actionArea = `<span class="badge badge-easy">✅ Validé (+${q.points} pts crédités)</span>`;
            } else if (q.status === 'rejected') {
              actionArea = `
                <div>
                  <div style="font-size:0.78rem;color:hsl(0,90%,72%);margin-bottom:0.45rem;">
                    ❌ Refusé : ${escapeHtml(q.reject_reason || 'Preuve incomplète')}
                  </div>
                  <button type="button" class="btn btn-primary btn-sm open-proof-btn" data-id="${q.id}" data-title="${escapeHtml(q.title)}" data-hint="${escapeHtml(q.proof_hint)}">
                    🔄 Renvoyer une nouvelle preuve
                  </button>
                </div>
              `;
            }

            return `
              <article class="quest-card ${q.status}">
                <div>
                  <div class="card-header">
                    <span style="font-size:0.84rem;font-weight:700;color:var(--text-secondary);">
                      ${q.game_emoji} ${escapeHtml(q.game_name)} <span class="mono" style="font-size:0.72rem;color:var(--text-muted);">(${gameWeekCnt}/5 sem.)</span>
                    </span>
                    ${diffBadge}
                  </div>
                  <h3 class="card-title" style="margin-bottom:0.45rem;">${escapeHtml(q.title)}</h3>
                  <p style="font-size:0.88rem;color:var(--text-secondary);margin-bottom:0.75rem;">
                    ${escapeHtml(q.description)}
                  </p>
                  <p style="font-size:0.76rem;color:var(--text-muted);">
                    📸 <em>${escapeHtml(q.proof_hint)}</em>
                  </p>
                </div>
                <div style="padding-top:0.75rem;border-top:1px solid var(--border-subtle);">
                  ${actionArea}
                </div>
              </article>
            `;
          })
          .join('')}
      </div>
    `;

    questsContainer.querySelectorAll('.open-proof-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        resetProofModal();
        document.getElementById('proof-assignment-id').value = btn.dataset.id;
        document.getElementById('proof-modal-title').textContent = `Preuve — ${btn.dataset.title}`;
        document.getElementById('proof-modal-hint').textContent = btn.dataset.hint;
        document.getElementById('proof-modal').classList.add('open');
      });
    });

    questsContainer.querySelectorAll('.reroll-quest-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await fetch(`/api/quests/${btn.dataset.id}/reroll`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
          showToast(`❌ ${data.error}`);
          return;
        }
        showToast('🎲 Défi relancé avec succès (même difficulté conservée) !');
        await fetchState();
      });
    });
  }

  // Render games selector
  gamesGrid.innerHTML = (appState.games || [])
    .map((g) => {
      if (g.is_universal) {
        return `
          <div class="game-tile universal">
            <div class="game-tile-emoji">${g.emoji}</div>
            <div class="game-tile-info">
              <strong>${escapeHtml(g.short_name)} (Inclus d'office)</strong>
              <span>${escapeHtml(g.platforms)}</span>
            </div>
          </div>
        `;
      }
      const isSelected = selectedGameIds.has(g.id);
      return `
        <div class="game-tile ${isSelected ? 'selected' : ''}" data-game-id="${g.id}">
          <div class="game-tile-emoji">${g.emoji}</div>
          <div class="game-tile-info">
            <strong>${escapeHtml(g.name)}</strong>
            <span>${escapeHtml(g.platforms)}</span>
          </div>
        </div>
      `;
    })
    .join('');

  gamesGrid.querySelectorAll('.game-tile[data-game-id]').forEach((tile) => {
    tile.addEventListener('click', () => {
      const gid = tile.dataset.gameId;
      if (selectedGameIds.has(gid)) {
        selectedGameIds.delete(gid);
        tile.classList.remove('selected');
      } else {
        selectedGameIds.add(gid);
        tile.classList.add('selected');
      }
    });
  });
}

function renderTrackmania() {
  if (appState.tmnfServer) {
    document.getElementById('tmnf-playit-addr').textContent = appState.tmnfServer.playitAddress;
    document.getElementById('tmnf-join-link').href = appState.tmnfServer.joinUrl;
  }

  // Top 10 Weekly
  const weeklyTbody = document.getElementById('weekly-tmnf-tbody');
  const weeklyRows = appState.weeklyTmnfLeaderboard || [];
  if (weeklyRows.length === 0) {
    weeklyTbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align:center;color:var(--text-muted);padding:1.25rem;">
          Aucun temps enregistré sur la map de la semaine.
        </td>
      </tr>
    `;
  } else {
    weeklyTbody.innerHTML = weeklyRows
      .slice(0, 10)
      .map(
        (r) => `
        <tr>
          <td class="rank-cell">#${r.rank}</td>
          <td><strong>${escapeHtml(r.display_name)}</strong></td>
          <td class="mono" style="color:var(--accent-emerald);font-weight:700;">${r.formatted_time}</td>
          <td class="mono" style="color:var(--accent-gold);font-weight:700;">+${r.projected_points} pts</td>
        </tr>
      `
      )
      .join('');
  }

  // 8 Cartes de Pistes Chasse aux Médailles
  const cardsGrid = document.getElementById('track-cards-grid');
  const mySubs = new Map((appState.myTmnfSubmissions || []).map((s) => [s.map_id, s]));
  const medalMaps = (appState.tmnfMaps || []).filter((m) => !m.is_weekly);

  cardsGrid.innerHTML = medalMaps
    .map((m) => {
      const sub = mySubs.get(m.id);
      const myMs = sub ? sub.best_time_ms : null;
      const myPts = sub ? sub.best_points : 0;

      const hasAuthor = myMs !== null && myMs <= m.author_ms;
      const hasGold = myMs !== null && myMs <= m.gold_ms;
      const hasSilver = myMs !== null && myMs <= m.silver_ms;
      const hasBronze = myMs !== null && myMs <= m.bronze_ms;

      // Calcul du prochain objectif au millième
      let nextGoalHtml = '';
      if (myMs === null) {
        nextGoalHtml = `<span style="color:var(--text-muted);">Aucun replay déposé — Auteur à <strong class="mono">${m.author_formatted}</strong></span>`;
      } else if (hasAuthor) {
        const margin = m.author_ms - myMs;
        nextGoalHtml = `<span style="color:var(--tm-author);font-weight:600;">👑 Médaille Auteur verrouillée (-${(margin / 1000).toFixed(3)}s sous le seuil)</span>`;
      } else if (hasGold) {
        const diff = myMs - m.author_ms;
        nextGoalHtml = `<span style="color:var(--accent-gold);">🎯 À <strong class="mono">${formatDeltaSeconds(diff)}</strong> de l'Auteur (+10 pts bonus)</span>`;
      } else if (hasSilver) {
        const diff = myMs - m.gold_ms;
        nextGoalHtml = `<span style="color:var(--accent-sky);">🎯 À <strong class="mono">${formatDeltaSeconds(diff)}</strong> de l'Or (+10 pts bonus)</span>`;
      } else {
        const diff = myMs - m.silver_ms;
        nextGoalHtml = `<span>🎯 À <strong class="mono">${formatDeltaSeconds(diff)}</strong> de l'Argent</span>`;
      }

      return `
        <article class="track-card ${hasAuthor ? 'has-author' : ''}">
          <div>
            <div class="card-header" style="margin-bottom:0.55rem;">
              <div>
                <strong style="font-family:var(--font-display);font-size:1.05rem;">${escapeHtml(m.code)}</strong>
                <div style="font-size:0.76rem;color:var(--text-muted);">${escapeHtml(m.name)}</div>
              </div>
              <span class="badge ${myPts === 30 ? 'badge-easy' : myPts >= 20 ? 'badge-hard' : 'badge-medium'}">
                ${myPts} / 30 pts
              </span>
            </div>

            <div class="wr-strip" style="margin-bottom:0.65rem;">
              <span>🏆 WR Discord : <strong>${m.wr_holder ? escapeHtml(m.wr_holder) : '—'}</strong></span>
              <span class="mono" style="color:var(--accent-gold);font-weight:700;">${m.wr_formatted || '—'}</span>
            </div>

            <div class="medal-pips-row">
              <div class="medal-box ${hasAuthor ? 'unlocked' : ''}">
                <div style="font-size:0.68rem;font-weight:700;"><span class="medal-dot author"></span>Auteur</div>
                <div class="mono" style="font-size:0.72rem;margin-top:2px;">${m.author_formatted}</div>
              </div>
              <div class="medal-box ${hasGold ? 'unlocked' : ''}">
                <div style="font-size:0.68rem;font-weight:700;"><span class="medal-dot gold"></span>Or</div>
                <div class="mono" style="font-size:0.72rem;margin-top:2px;">${m.gold_formatted}</div>
              </div>
              <div class="medal-box ${hasSilver ? 'unlocked' : ''}">
                <div style="font-size:0.68rem;font-weight:700;"><span class="medal-dot silver"></span>Argent</div>
                <div class="mono" style="font-size:0.72rem;margin-top:2px;">${m.silver_formatted}</div>
              </div>
              <div class="medal-box ${hasBronze ? 'unlocked' : ''}">
                <div style="font-size:0.68rem;font-weight:700;"><span class="medal-dot bronze"></span>Bronze</div>
                <div class="mono" style="font-size:0.72rem;margin-top:2px;">${m.bronze_formatted}</div>
              </div>
            </div>
          </div>

          <div style="padding-top:0.65rem;border-top:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;font-size:0.78rem;">
            <div>
              Mon record : <strong class="mono">${sub ? sub.best_time_formatted : '—'}</strong>
              <div style="margin-top:0.15rem;">${nextGoalHtml}</div>
            </div>
            <a href="/api/tmnf/sample-replay/${m.id}" class="btn btn-secondary btn-sm" title="Télécharger un replay .gbx d'exemple sur cette piste">
              🧪 .gbx
            </a>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderTournaments() {
  const grid = document.getElementById('tournaments-grid');
  const myId = appState.user?.id;

  grid.innerHTML = (appState.tournaments || [])
    .map((t) => {
      const isRegistered = t.registrations.some((r) => r.user_id === myId);
      const teamsMap = new Map();
      for (const r of t.registrations) {
        if (r.team_number) {
          if (!teamsMap.has(r.team_number)) {
            teamsMap.set(r.team_number, { name: r.team_name || `Équipe #${r.team_number}`, members: [] });
          }
          teamsMap.get(r.team_number).members.push(r);
        }
      }

      const teamsHtml =
        teamsMap.size > 0
          ? `
          <div style="margin-top:1rem;padding-top:0.85rem;border-top:1px solid var(--border-subtle);">
            <div style="font-size:0.76rem;text-transform:uppercase;color:var(--accent-gold);font-weight:700;margin-bottom:0.5rem;">
              ⚡ Équipes Équilibrées (Tirage Chapeaux 1 / 2 / 3)
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:0.6rem;">
              ${Array.from(teamsMap.values())
                .map(
                  (tm) => `
                  <div style="background:var(--bg-elevated);padding:0.65rem;border-radius:var(--radius-sm);border:1px solid var(--border-subtle);">
                    <strong style="font-size:0.84rem;display:block;margin-bottom:0.3rem;">${escapeHtml(tm.name)}</strong>
                    ${tm.members
                      .map(
                        (m) => `
                        <div style="font-size:0.78rem;display:flex;justify-content:space-between;">
                          <span>${escapeHtml(m.display_name)}</span>
                          <span class="mono" style="color:var(--text-muted);">Ch.${m.pool}</span>
                        </div>
                      `
                      )
                      .join('')}
                  </div>
                `
                )
                .join('')}
            </div>
          </div>
        `
          : '';

      return `
        <div class="card">
          <div class="card-header">
            <span class="card-title">${t.emoji} ${escapeHtml(t.name)}</span>
            <span class="badge ${t.is_major ? 'badge-hard' : 'badge-medium'}">
              1er = ${t.points_scale['1']} pts
            </span>
          </div>
          <div style="font-size:0.85rem;color:var(--accent-gold);font-weight:600;margin-bottom:0.35rem;">
            📅 ${escapeHtml(t.scheduled_label)}
          </div>
          <p style="font-size:0.86rem;color:var(--text-secondary);margin-bottom:1rem;">
            ${escapeHtml(t.mode_label)}
          </p>

          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.6rem;">
            <span style="font-size:0.82rem;color:var(--text-muted);">
              👥 <strong>${t.registrations.length}</strong> joueur(s) inscrit(s)
            </span>
            <button
              type="button"
              class="btn ${isRegistered ? 'btn-danger' : 'btn-primary'} btn-sm toggle-tourney-btn"
              data-id="${t.id}"
            >
              ${isRegistered ? '✓ Inscrit (Se désinscrire)' : 'S’inscrire au tournoi'}
            </button>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-top:0.85rem;">
            ${t.registrations
              .map(
                (r) => `
                <span class="badge badge-pool-${r.pool}" title="Chapeau ${r.pool}">
                  ${escapeHtml(r.display_name)} (Ch.${r.pool})
                </span>
              `
              )
              .join('')}
          </div>
          ${teamsHtml}
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('.toggle-tourney-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!appState.user) {
        document.getElementById('login-modal').classList.add('open');
        return;
      }
      const res = await fetch(`/api/tournaments/${btn.dataset.id}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast(data.registered ? '✅ Inscription au tournoi confirmée !' : 'Inscription retirée.');
        await fetchState();
      }
    });
  });
}

/**
 * Mode Show Stream Plein Écran (Révélation dramatique joueur par joueur : Chapeau 3 -> Chapeau 2 -> Capitaines Chapeau 1)
 */
function openStreamRevealStage() {
  const rl = (appState?.tournaments || []).find((t) => t.id === 'rl_rumble');
  if (!rl) return;

  const overlay = document.getElementById('stream-stage-overlay');
  const poolsOverview = document.getElementById('stream-pools-overview');
  const teamsStage = document.getElementById('stream-teams-stage');

  const p1 = rl.registrations.filter((r) => r.pool === 1);
  const p2 = rl.registrations.filter((r) => r.pool === 2);
  const p3 = rl.registrations.filter((r) => r.pool === 3);

  poolsOverview.innerHTML = [
    { title: '🔥 Chapeau 1 (Tryhard / Capitaines)', badge: 'badge-pool-1', list: p1 },
    { title: '⚡ Chapeau 2 (Intermédiaire)', badge: 'badge-pool-2', list: p2 },
    { title: '🌱 Chapeau 3 (Chill)', badge: 'badge-pool-3', list: p3 },
  ]
    .map(
      (col) => `
      <div class="card" style="padding:1rem;">
        <div style="font-weight:700;font-size:0.9rem;margin-bottom:0.5rem;">${col.title}</div>
        <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">
          ${col.list.map((p) => `<span class="badge ${col.badge}">${escapeHtml(p.display_name)}</span>`).join('')}
        </div>
      </div>
    `
    )
    .join('');

  const teamsMap = new Map();
  for (const r of rl.registrations) {
    if (r.team_number) {
      if (!teamsMap.has(r.team_number)) {
        teamsMap.set(r.team_number, { num: r.team_number, name: r.team_name, members: [] });
      }
      teamsMap.get(r.team_number).members.push(r);
    }
  }

  const teams = Array.from(teamsMap.values());
  streamRevealQueue = [];
  streamRevealIndex = 0;

  // Construire les cartes d'équipes avec des slots masqués
  teamsStage.innerHTML = teams
    .map((tm) => {
      // Trier les membres du Chapeau 3 vers le Chapeau 1 pour garder le suspense des capitaines à la fin
      const sortedMembers = [...tm.members].sort((a, b) => b.pool - a.pool);
      return `
        <div class="card" style="background:var(--bg-surface);">
          <div class="card-header">
            <strong class="card-title" style="color:var(--accent-gold);">${escapeHtml(tm.name)}</strong>
            <span class="mono" style="font-size:0.75rem;color:var(--text-muted);">Équipe #${tm.num}</span>
          </div>
          <div>
            ${sortedMembers
              .map((m, idx) => {
                const slotId = `stream-slot-${tm.num}-${idx}`;
                streamRevealQueue.push({
                  slotId,
                  name: m.display_name,
                  pool: m.pool,
                });
                return `
                  <div class="stream-slot hidden-slot" id="${slotId}">
                    <span>❓ En attente du tirage (Chapeau ${m.pool})</span>
                    <span class="badge badge-pool-${m.pool}">Ch.${m.pool}</span>
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>
      `;
    })
    .join('');

  // Trier l'ordre de révélation pour révéler tous les Chapeaux 3 d'abord, puis Chapeaux 2, puis Capitaines Chapeau 1
  streamRevealQueue.sort((a, b) => b.pool - a.pool);

  overlay.classList.add('open');
}

function revealNextStreamSlot() {
  if (streamRevealIndex >= streamRevealQueue.length) {
    showToast('🎉 Toutes les équipes ont été révélées !');
    return;
  }
  const item = streamRevealQueue[streamRevealIndex++];
  const el = document.getElementById(item.slotId);
  if (el) {
    el.className = 'stream-slot revealed-slot';
    el.innerHTML = `
      <strong>👤 ${escapeHtml(item.name)}</strong>
      <span class="badge badge-pool-${item.pool}">Chapeau ${item.pool}</span>
    `;
  }
}

function renderAdmin() {
  const proofsList = document.getElementById('admin-proofs-list');
  const pending = appState.admin?.pendingProofs || [];

  if (pending.length === 0) {
    proofsList.innerHTML = `<p style="color:var(--text-muted);font-size:0.88rem;">Aucune preuve en attente de validation.</p>`;
  } else {
    proofsList.innerHTML = `
      <div class="grid-2">
        ${pending
          .map(
            (p) => `
            <div style="background:var(--bg-elevated);padding:1rem;border-radius:var(--radius-md);border:1px solid var(--border-subtle);display:flex;flex-direction:column;justify-content:space-between;gap:0.75rem;">
              <div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem;">
                  <strong>👤 ${escapeHtml(p.display_name)}</strong>
                  <span class="badge badge-hard">${p.game_emoji} +${p.points} pts</span>
                </div>
                <div style="font-weight:600;font-size:0.92rem;">${escapeHtml(p.title)}</div>
                <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:0.2rem;">${escapeHtml(p.description)}</p>
                ${
                  p.proof_url
                    ? `<div style="margin-top:0.5rem;font-size:0.82rem;"><a href="${escapeHtml(p.proof_url)}" target="_blank" rel="noopener" style="color:var(--accent-gold);">🔗 Ouvrir le lien de preuve externe</a></div>`
                    : ''
                }
                ${
                  p.proof_file
                    ? `<div style="margin-top:0.5rem;"><a href="/uploads/proofs/${encodeURIComponent(p.proof_file)}" target="_blank" style="color:var(--accent-emerald);font-size:0.82rem;">🖼️ Voir le fichier envoyé (${escapeHtml(p.proof_file)})</a></div>`
                    : ''
                }
                ${
                  p.proof_note
                    ? `<div style="margin-top:0.35rem;font-size:0.78rem;color:var(--text-muted);">💬 "${escapeHtml(p.proof_note)}"</div>`
                    : ''
                }
              </div>
              <div style="display:flex;gap:0.5rem;">
                <button type="button" class="btn btn-emerald btn-sm admin-approve-btn" data-id="${p.id}">
                  ✅ Valider (+${p.points} pts)
                </button>
                <button type="button" class="btn btn-danger btn-sm admin-reject-btn" data-id="${p.id}">
                  ❌ Refuser
                </button>
              </div>
            </div>
          `
          )
          .join('')}
      </div>
    `;

    proofsList.querySelectorAll('.admin-approve-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/admin/proofs/${btn.dataset.id}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve' }),
        });
        showToast('✅ Preuve validée et points crédités dans points_ledger !');
        await fetchState();
      });
    });

    proofsList.querySelectorAll('.admin-reject-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const reason = prompt('Motif du refus (le joueur pourra re-soumettre une preuve valide) :', 'Screenshot incomplet');
        if (!reason) return;
        await fetch(`/api/admin/proofs/${btn.dataset.id}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reject', rejectReason: reason }),
        });
        showToast('❌ Preuve refusée.');
        await fetchState();
      });
    });
  }

  const selectEl = document.getElementById('admin-tournament-select');
  const selectedTourneyId = selectEl.value || 'rl_rumble';
  const tourney = (appState.tournaments || []).find((t) => t.id === selectedTourneyId);
  const poolsTbody = document.getElementById('admin-pools-tbody');

  if (tourney) {
    poolsTbody.innerHTML = tourney.registrations
      .map(
        (r) => `
        <tr>
          <td><strong>${escapeHtml(r.display_name)}</strong></td>
          <td>
            <select class="select-field admin-pool-change" data-uid="${r.user_id}" style="padding:0.25rem 0.5rem;font-size:0.8rem;">
              <option value="1" ${r.pool === 1 ? 'selected' : ''}>Chapeau 1 (Tryhard)</option>
              <option value="2" ${r.pool === 2 ? 'selected' : ''}>Chapeau 2 (Intermédiaire)</option>
              <option value="3" ${r.pool === 3 ? 'selected' : ''}>Chapeau 3 (Chill)</option>
            </select>
          </td>
          <td>
            <input type="checkbox" class="admin-checkin-toggle" data-uid="${r.user_id}" ${r.checked_in ? 'checked' : ''} />
          </td>
          <td class="mono" style="font-size:0.8rem;color:var(--accent-gold);">
            ${r.team_name ? escapeHtml(r.team_name) : '—'}
          </td>
        </tr>
      `
      )
      .join('');

    poolsTbody.querySelectorAll('.admin-pool-change').forEach((sel) => {
      sel.addEventListener('change', async () => {
        await fetch(`/api/admin/tournaments/${selectedTourneyId}/player`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: sel.dataset.uid, pool: Number(sel.value) }),
        });
        await fetchState();
      });
    });

    poolsTbody.querySelectorAll('.admin-checkin-toggle').forEach((chk) => {
      chk.addEventListener('change', async () => {
        await fetch(`/api/admin/tournaments/${selectedTourneyId}/player`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: chk.dataset.uid, checkedIn: chk.checked }),
        });
        await fetchState();
      });
    });
  }

  const fgTourney = (appState.tournaments || []).find((t) => t.id === 'fall_guys');
  const fgTbody = document.getElementById('admin-fg-tbody');
  if (fgTourney) {
    fgTbody.innerHTML = fgTourney.registrations
      .map((r) => {
        const shows = r.fg_shows || [0, 0, 0, 0, 0];
        return `
          <tr data-fg-uid="${r.user_id}">
            <td><strong>${escapeHtml(r.display_name)}</strong></td>
            ${[0, 1, 2, 3, 4]
              .map(
                (idx) => `
                <td>
                  <select class="select-field fg-show-input" data-idx="${idx}" style="padding:0.2rem;font-size:0.78rem;min-width:54px;">
                    <option value="0" ${shows[idx] === 0 ? 'selected' : ''}>0</option>
                    <option value="1" ${shows[idx] === 1 ? 'selected' : ''}>1 (Élim)</option>
                    <option value="3" ${shows[idx] === 3 ? 'selected' : ''}>3 (Qualif)</option>
                    <option value="6" ${shows[idx] === 6 ? 'selected' : ''}>6 (Finale)</option>
                    <option value="10" ${shows[idx] === 10 ? 'selected' : ''}>10 (👑)</option>
                  </select>
                </td>
              `
              )
              .join('')}
            <td class="mono" style="font-weight:700;">${r.fg_total_score || 0}</td>
            <td class="mono" style="color:var(--accent-gold);font-weight:700;">+${r.points_awarded || 0}</td>
          </tr>
        `;
      })
      .join('');
  }
}

function resetProofModal() {
  pastedProofFile = null;
  document.getElementById('proof-submit-form').reset();
  const preview = document.getElementById('proof-paste-preview');
  const zone = document.getElementById('proof-paste-zone');
  const promptEl = document.getElementById('proof-paste-prompt');
  preview.style.display = 'none';
  preview.src = '';
  zone.classList.remove('has-file');
  promptEl.innerHTML = `
    <strong>Appuie sur Ctrl+V pour coller une capture d'écran</strong>
    <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 0.2rem">
      ou clique ici pour sélectionner une image (≤ 10 Mo) / vidéo courte (≤ 20 Mo)
    </div>
  `;
}

function displaySelectedProofFile(file) {
  pastedProofFile = file;
  const preview = document.getElementById('proof-paste-preview');
  const zone = document.getElementById('proof-paste-zone');
  const promptEl = document.getElementById('proof-paste-prompt');

  zone.classList.add('has-file');
  promptEl.innerHTML = `✅ Fichier prêt : <strong>${escapeHtml(file.name)}</strong> (${Math.round(file.size / 1024)} Ko)`;

  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      preview.src = ev.target.result;
      preview.style.display = 'inline-block';
    };
    reader.readAsDataURL(file);
  } else {
    preview.style.display = 'none';
  }
}

// ============================================================================
// INITIALISATION & ÉVÉNEMENTS DOM
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  updateResetCountdown();
  setInterval(updateResetCountdown, 1000);

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.getElementById('cta-open-quests').addEventListener('click', () => switchView('defis'));
  document.getElementById('cta-open-tm').addEventListener('click', () => switchView('trackmania'));

  document.getElementById('toggle-games-drawer-btn').addEventListener('click', () => {
    gamesDrawerOpen = !gamesDrawerOpen;
    renderQuestsAndGames();
  });

  document.getElementById('copy-playit-btn').addEventListener('click', () => {
    const addr = document.getElementById('tmnf-playit-addr').textContent.trim();
    navigator.clipboard?.writeText(addr);
    showToast(`📋 Adresse copiée : ${addr}`);
  });

  // Sauvegarde des jeux
  document.getElementById('save-games-btn').addEventListener('click', async () => {
    if (!appState?.user) {
      document.getElementById('login-modal').classList.add('open');
      return;
    }
    const res = await fetch('/api/profile/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameIds: Array.from(selectedGameIds) }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`❌ ${data.error}`);
      return;
    }
    gamesDrawerOpen = false;
    showToast('✅ Jeux sauvegardés et 3 défis du jour générés !');
    await fetchState();
  });

  // Modale Preuve + Support Ctrl+V (Clipboard Paste)
  const closeProofModal = () => document.getElementById('proof-modal').classList.remove('open');
  document.getElementById('proof-modal-close').addEventListener('click', closeProofModal);
  document.getElementById('proof-modal-cancel').addEventListener('click', closeProofModal);

  const proofFileInput = document.getElementById('proof-file-input');
  document.getElementById('proof-paste-zone').addEventListener('click', () => proofFileInput.click());
  proofFileInput.addEventListener('change', () => {
    if (proofFileInput.files?.[0]) {
      displaySelectedProofFile(proofFileInput.files[0]);
    }
  });

  window.addEventListener('paste', (e) => {
    const modalOpen = document.getElementById('proof-modal').classList.contains('open');
    if (!modalOpen) return;
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          const namedFile = new File([blob], `clipboard_${Date.now()}.png`, { type: blob.type });
          displaySelectedProofFile(namedFile);
          showToast('📸 Capture d’écran collée depuis le presse-papiers !');
          e.preventDefault();
          break;
        }
      }
    }
  });

  document.getElementById('proof-submit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const assignmentId = document.getElementById('proof-assignment-id').value;
    const formData = new FormData();
    if (pastedProofFile) {
      formData.append('proofFile', pastedProofFile);
    } else if (proofFileInput.files?.[0]) {
      formData.append('proofFile', proofFileInput.files[0]);
    }
    formData.append('proofUrl', document.getElementById('proof-url-input').value);
    formData.append('proofNote', document.getElementById('proof-note-input').value);

    const res = await fetch(`/api/quests/${assignmentId}/submit`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`❌ ${data.error}`);
      return;
    }
    closeProofModal();
    showToast('🚀 Preuve envoyée dans #preuves !');
    await fetchState();
  });

  // Modale Détail Points Joueur
  document.getElementById('player-ledger-close').addEventListener('click', () => {
    document.getElementById('player-ledger-modal').classList.remove('open');
  });

  // Modale Login
  document.getElementById('login-modal-close').addEventListener('click', () => {
    document.getElementById('login-modal').classList.remove('open');
  });

  document.getElementById('dev-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('dev-login-username').value;
    const isAdmin = document.getElementById('dev-login-admin').checked;
    const res = await fetch('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, isAdmin }),
    });
    if (res.ok) {
      document.getElementById('login-modal').classList.remove('open');
      showToast(`👋 Bienvenue ${username} !`);
      await fetchState();
    }
  });

  // Upload .Replay.gbx
  const gbxInput = document.getElementById('gbx-file-input');
  const gbxLabel = document.getElementById('gbx-file-label');
  gbxInput.addEventListener('change', () => {
    if (gbxInput.files?.[0]) {
      gbxLabel.textContent = `Fichier prêt : ${gbxInput.files[0].name}`;
    }
  });

  document.getElementById('gbx-upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!appState?.user) {
      document.getElementById('login-modal').classList.add('open');
      return;
    }
    if (!gbxInput.files?.[0]) {
      showToast('❌ Sélectionne d’abord un fichier .Replay.gbx.');
      return;
    }

    const fd = new FormData();
    fd.append('replay', gbxInput.files[0]);

    const res = await fetch('/api/tmnf/submit-replay', {
      method: 'POST',
      body: fd,
    });
    const data = await res.json();
    const banner = document.getElementById('gbx-result-banner');

    if (!res.ok) {
      banner.innerHTML = `<div style="padding:0.75rem;border-radius:6px;background:var(--accent-danger-soft);color:hsl(0,90%,72%);font-size:0.86rem;">❌ ${escapeHtml(data.error)}</div>`;
      return;
    }

    banner.innerHTML = `
      <div style="padding:0.85rem;border-radius:6px;background:var(--accent-emerald-soft);color:hsl(156,78%,62%);font-size:0.88rem;">
        ✅ <strong>${escapeHtml(data.mapName)}</strong> — Chrono : <strong class="mono">${data.formattedTime}</strong>
        (Médaille : <strong>${data.medal.toUpperCase()}</strong> • ${data.deltaPoints > 0 ? `+${data.deltaPoints} pts crédités !` : 'Temps enregistré'})
      </div>
    `;
    showToast(`🏁 Replay validé : ${data.formattedTime} sur ${data.mapCode} !`);
    await fetchState();
  });

  // Mode Show Stream Plein Écran (Chapeaux)
  document.getElementById('open-stream-show-btn').addEventListener('click', openStreamRevealStage);
  document.getElementById('stream-next-step-btn').addEventListener('click', revealNextStreamSlot);
  document.getElementById('stream-reveal-all-btn').addEventListener('click', () => {
    while (streamRevealIndex < streamRevealQueue.length) {
      revealNextStreamSlot();
    }
  });
  document.getElementById('stream-reset-reveal-btn').addEventListener('click', openStreamRevealStage);
  document.getElementById('stream-close-btn').addEventListener('click', () => {
    document.getElementById('stream-stage-overlay').classList.remove('open');
  });

  window.addEventListener('keydown', (e) => {
    const stageOpen = document.getElementById('stream-stage-overlay').classList.contains('open');
    if (stageOpen && e.code === 'Space') {
      e.preventDefault();
      revealNextStreamSlot();
    }
  });

  // Événements Admin
  document.getElementById('admin-tournament-select').addEventListener('change', () => renderAdmin());

  document.getElementById('admin-draw-teams-btn').addEventListener('click', async () => {
    const tid = document.getElementById('admin-tournament-select').value;
    const res = await fetch(`/api/admin/tournaments/${tid}/draw-teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onlyCheckedIn: true, announceDiscord: false }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`❌ ${data.error}`);
      return;
    }
    showToast(`🎲 ${data.teams.length} équipes équilibrées générées !`);
    await fetchState();
  });

  document.getElementById('admin-draw-discord-btn').addEventListener('click', async () => {
    const tid = document.getElementById('admin-tournament-select').value;
    const res = await fetch(`/api/admin/tournaments/${tid}/draw-teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onlyCheckedIn: true, announceDiscord: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`❌ ${data.error}`);
      return;
    }
    showToast(`📢 Équipes tirées et envoyées au Bot Discord !`);
    await fetchState();
  });

  document.getElementById('admin-save-fg-btn').addEventListener('click', async () => {
    const rows = document.querySelectorAll('#admin-fg-tbody tr[data-fg-uid]');
    const scores = Array.from(rows).map((tr) => {
      const userId = tr.dataset.fgUid;
      const shows = Array.from(tr.querySelectorAll('.fg-show-input')).map((s) => Number(s.value));
      return { userId, shows };
    });

    const res = await fetch('/api/admin/fall-guys/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scores }),
    });
    if (res.ok) {
      showToast('🫘 Cumul des 5 parties Fall Guys calculé et points HGW attribués !');
      await fetchState();
    }
  });

  document.getElementById('admin-seed-demo-btn').addEventListener('click', async () => {
    const res = await fetch('/api/admin/seed-demo', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(`✨ ${data.message}`);
      await fetchState();
    }
  });

  document.getElementById('admin-cron-btn').addEventListener('click', async () => {
    const res = await fetch('/api/admin/cron/trigger', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(`⏰ Reset simulé : ${data.usersProcessed} joueurs traités !`);
      await fetchState();
    }
  });

  // Formulaire de liaison du login Trackmania (pour la remontée auto depuis le serveur dédié)
  document.getElementById('tmnf-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!appState?.user) {
      document.getElementById('login-modal').classList.add('open');
      return;
    }
    const tmnfLogin = document.getElementById('tmnf-login-input').value.trim();
    const res = await fetch('/api/profile/tmnf-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmnfLogin }),
    });
    if (res.ok) {
      showToast(`🔗 Login Trackmania lié : "${tmnfLogin}" ! Tes temps sur le serveur dédié remonteront automatiquement.`);
      await fetchState();
    }
  });

  // Simulation d'un passage de ligne d'arrivée en direct sur le serveur dédié (Webhook XML-RPC)
  document.getElementById('sim-live-finish-btn').addEventListener('click', async () => {
    const weeklyMap = (appState?.tmnfMaps || []).find((m) => m.is_weekly);
    if (!weeklyMap) return;
    const currentBest = appState?.weeklyTmnfLeaderboard?.[0]?.best_time_ms || 42500;
    const newRecordMs = Math.max(38500, currentBest - Math.floor(Math.random() * 280) - 40);
    const login = appState?.user?.tmnf_login || appState?.user?.username || 'hextaz';

    const res = await fetch('/api/tmnf/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerLogin: login,
        playerNickname: appState?.user?.display_name || 'Hextaz',
        mapUid: weeklyMap.uid,
        timeMs: newRecordMs,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`🏁 [Webhook XML-RPC] Nouveau record serveur en direct : ${data.formattedTime} !`);
    }
  });

  // Connexion Temps Réel Server-Sent Events (SSE)
  function connectRealtimeSse() {
    const dot = document.getElementById('sse-status-dot');
    const es = new EventSource('/api/events');

    es.onopen = () => {
      if (dot) {
        dot.style.color = 'var(--accent-emerald)';
        dot.textContent = '● Live';
      }
    };

    es.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'connected') return;
        if (payload.message) {
          showToast(payload.message);
        }
        await fetchState();
      } catch {
        // ignore heartbeat parse
      }
    };

    es.onerror = () => {
      if (dot) {
        dot.style.color = 'var(--accent-gold)';
        dot.textContent = '○ Reconnexion...';
      }
    };
  }

  await fetchState();
  connectRealtimeSse();
});
