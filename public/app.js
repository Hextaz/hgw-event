let appState = null;
let selectedGameIds = new Set();

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

function switchView(viewName) {
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === `view-${viewName}`);
  });
}

async function fetchState() {
  const res = await fetch('/api/state');
  appState = await res.json();
  selectedGameIds = new Set(appState.mySelectedGames || []);
  renderAll();
}

function renderAll() {
  if (!appState) return;

  document.getElementById('cycle-indicator').textContent = `Cycle ${appState.dayKey} • Reset 03h00`;

  // Admin tab visibility
  const adminTab = document.getElementById('tab-admin');
  if (appState.user?.is_admin === 1) {
    adminTab.style.display = 'inline-flex';
    const pendingCount = appState.admin?.pendingProofs?.length || 0;
    document.getElementById('nav-admin-badge').textContent = String(pendingCount);
  } else {
    adminTab.style.display = 'none';
  }

  // Hero metrics
  const tombolaCount = (appState.leaderboard || []).filter((p) => p.tombola_eligible).length;
  document.getElementById('hero-tombola-count').textContent = `${tombolaCount} qualifié(s)`;
  document.getElementById('hero-tombola-sub').textContent = `Seuil : ≥ ${appState.tombolaThreshold} pts`;

  const topTm = appState.weeklyTmnfLeaderboard?.[0];
  if (topTm) {
    document.getElementById('hero-tm-leader').textContent = topTm.formatted_time;
    document.getElementById('hero-tm-leader-name').textContent = `1er : ${topTm.display_name} (+150 pts)`;
  } else {
    document.getElementById('hero-tm-leader').textContent = 'Ouvert 24/7';
    document.getElementById('hero-tm-leader-name').textContent = 'Dépose le 1er temps de la semaine !';
  }

  renderAuthZone();
  renderLeaderboard();
  renderQuestsAndGames();
  renderTrackmania();
  renderTournaments();
  if (appState.user?.is_admin === 1) {
    renderAdmin();
  }
}

function renderAuthZone() {
  const zone = document.getElementById('auth-zone');
  if (!appState.user) {
    zone.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" id="open-login-modal-btn">
        🎮 Se connecter avec Discord
      </button>
    `;
    document.getElementById('open-login-modal-btn').addEventListener('click', () => {
      document.getElementById('login-modal').classList.add('open');
    });
    return;
  }

  const meInLb = (appState.leaderboard || []).find((u) => u.id === appState.user.id);
  const myPts = meInLb ? meInLb.total_points : 0;

  zone.innerHTML = `
    <div class="user-chip">
      <span>👤 <strong>${escapeHtml(appState.user.display_name)}</strong></span>
      <span class="user-chip-pts">${myPts} pts</span>
    </div>
    <button type="button" class="btn btn-secondary btn-sm" id="logout-btn">Déconnexion</button>
  `;

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    await fetchState();
    showToast('Déconnecté.');
  });
}

function renderLeaderboard() {
  const tbody = document.getElementById('leaderboard-tbody');
  const rows = appState.leaderboard || [];

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Aucun joueur inscrit pour l'instant. Connecte-toi ou clique sur « Peupler 12 Joueurs de Démo » dans l'onglet Admin !
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows
    .map((p) => {
      const rankBadge =
        p.rank === 1 ? '🥇 1er' : p.rank === 2 ? '🥈 2e' : p.rank === 3 ? '🥉 3e' : `#${p.rank}`;
      const tombolaBadge = p.tombola_eligible
        ? `<span class="badge badge-easy">🎟️ Ticket Validé (${p.total_points} pts)</span>`
        : `<div style="display:flex;align-items:center;gap:0.6rem;">
             <div class="progress-track" style="max-width:130px;">
               <div class="progress-fill" style="width:${p.tombola_progress_pct}%"></div>
             </div>
             <span class="mono" style="font-size:0.76rem;color:var(--text-muted);">${p.total_points}/300</span>
           </div>`;

      return `
        <tr>
          <td class="rank-cell">${rankBadge}</td>
          <td>
            <strong>${escapeHtml(p.display_name)}</strong>
            ${p.tmnf_login ? `<span class="mono" style="font-size:0.72rem;color:var(--text-muted);margin-left:0.4rem;">[TM: ${escapeHtml(p.tmnf_login)}]</span>` : ''}
          </td>
          <td class="mono">${p.async_points} pts</td>
          <td class="mono">${p.live_points} pts</td>
          <td style="font-size:0.82rem;color:var(--text-secondary);">
            ${p.quests_validated} défis • ${p.tmnf_medals_count}/8 médailles
          </td>
          <td>${tombolaBadge}</td>
          <td class="mono" style="font-weight:700;font-size:1.05rem;color:var(--accent-gold);">
            ${p.total_points} pts
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderQuestsAndGames() {
  const questsContainer = document.getElementById('quests-container');
  const gamesGrid = document.getElementById('games-selector-grid');

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
  } else if ((appState.mySelectedGames || []).length < 4) {
    questsContainer.innerHTML = `
      <div class="card" style="border-color:var(--accent-gold);">
        <h3 class="card-title">👇 Coche au moins 4 jeux ci-dessous pour générer tes 3 premiers défis !</h3>
        <p style="color:var(--text-secondary);font-size:0.88rem;margin-top:0.35rem;">
          Dès ta sélection sauvegardée, tes 3 défis personnels sont tirés immédiatement sans attendre 03h00.
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

            let actionArea = '';
            if (q.status === 'open') {
              actionArea = `
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                  <button type="button" class="btn btn-primary btn-sm open-proof-btn" data-id="${q.id}" data-title="${escapeHtml(q.title)}" data-hint="${escapeHtml(q.proof_hint)}">
                    📤 Envoyer ma preuve
                  </button>
                  ${
                    appState.canRerollToday
                      ? `<button type="button" class="btn btn-secondary btn-sm reroll-quest-btn" data-id="${q.id}">🎲 Reroll (1/j)</button>`
                      : ''
                  }
                </div>
              `;
            } else if (q.status === 'submitted') {
              actionArea = `<span class="badge badge-medium">🕵️ Preuve envoyée — En attente de validation dans #preuves</span>`;
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
                    <span style="font-size:0.85rem;font-weight:700;color:var(--text-secondary);">
                      ${q.game_emoji} ${escapeHtml(q.game_name)}
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
        <td colspan="4" style="text-align:center;color:var(--text-muted);padding:1.5rem;">
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

  // 8 Maps Médailles
  const medalsTbody = document.getElementById('medals-tmnf-tbody');
  const mySubs = new Map((appState.myTmnfSubmissions || []).map((s) => [s.map_id, s]));
  const medalMaps = (appState.tmnfMaps || []).filter((m) => !m.is_weekly);

  medalsTbody.innerHTML = medalMaps
    .map((m) => {
      const sub = mySubs.get(m.id);
      const ptsBadge = sub?.best_points
        ? `<span class="badge badge-easy">+${sub.best_points} pts</span>`
        : `<span class="mono" style="color:var(--text-muted);">0 pt</span>`;
      return `
        <tr>
          <td>
            <strong>${escapeHtml(m.code)}</strong>
            <div style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(m.name)}</div>
          </td>
          <td class="mono" style="font-size:0.82rem;">${m.author_formatted}</td>
          <td class="mono" style="font-size:0.82rem;">${m.gold_formatted}</td>
          <td class="mono" style="font-weight:700;">${sub ? sub.best_time_formatted : '—'}</td>
          <td>${ptsBadge}</td>
        </tr>
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

  // Render Chapeaux table for selected tournament
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

  // Render Fall Guys 5-Show table
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

// ============================================================================
// INITIALISATION & ÉVÉNEMENTS DOM
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  // Navigation par onglets
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.getElementById('hero-go-quests-btn').addEventListener('click', () => switchView('defis'));
  document.getElementById('hero-go-tm-btn').addEventListener('click', () => switchView('trackmania'));
  document.getElementById('hero-go-tournois-btn').addEventListener('click', () => switchView('tournois'));

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
    showToast('✅ Jeux sauvegardés et 3 défis du jour générés !');
    await fetchState();
  });

  // Modale preuve
  const closeProofModal = () => document.getElementById('proof-modal').classList.remove('open');
  document.getElementById('proof-modal-close').addEventListener('click', closeProofModal);
  document.getElementById('proof-modal-cancel').addEventListener('click', closeProofModal);

  document.getElementById('proof-submit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const assignmentId = document.getElementById('proof-assignment-id').value;
    const formData = new FormData(e.target);

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
    e.target.reset();
    showToast('🚀 Preuve envoyée ! Les modérateurs peuvent la valider en 1 clic sur Discord.');
    await fetchState();
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
      gbxLabel.textContent = `Fichier sélectionné : ${gbxInput.files[0].name}`;
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
      <div style="padding:0.85rem;border-radius:6px;background:var(--accent-emerald-soft);color:hsl(158,78%,62%);font-size:0.88rem;">
        ✅ <strong>${escapeHtml(data.mapName)}</strong> — Temps validé : <strong class="mono">${data.formattedTime}</strong>
        (Médaille : <strong>${data.medal.toUpperCase()}</strong> • ${data.deltaPoints > 0 ? `+${data.deltaPoints} pts ajoutés !` : 'Temps enregistré'})
      </div>
    `;
    showToast(`🏁 Replay validé : ${data.formattedTime} sur ${data.mapCode} !`);
    await fetchState();
  });

  // Animation Stream Révélation des équipes RL Rumble
  document.getElementById('stream-reveal-rl-btn').addEventListener('click', () => {
    const rl = (appState?.tournaments || []).find((t) => t.id === 'rl_rumble');
    const stage = document.getElementById('stream-reveal-stage');
    if (!rl) return;

    const teamsMap = new Map();
    for (const r of rl.registrations) {
      if (r.team_number) {
        if (!teamsMap.has(r.team_number)) {
          teamsMap.set(r.team_number, { name: r.team_name, members: [] });
        }
        teamsMap.get(r.team_number).members.push(r);
      }
    }

    const teams = Array.from(teamsMap.values());
    if (teams.length === 0) {
      showToast('ℹ️ Aucune équipe tirée pour le moment. Utilise le bouton dans Admin ou lance la Démo !');
      return;
    }

    stage.style.display = 'block';
    stage.innerHTML = `
      <div class="card-header">
        <h3 class="card-title">🎬 Révélation en Direct — Équipes Rocket League RUMBLE</h3>
        <span class="badge badge-hard">Chapeau 1 + Chapeau 2 + Chapeau 3</span>
      </div>
      <div class="grid-4" id="stream-cards-box"></div>
    `;

    const box = document.getElementById('stream-cards-box');
    teams.forEach((tm, idx) => {
      setTimeout(() => {
        const div = document.createElement('div');
        div.className = 'card team-reveal-card';
        div.style.background = 'var(--bg-elevated)';
        div.innerHTML = `
          <div style="font-weight:700;color:var(--accent-gold);margin-bottom:0.5rem;">${escapeHtml(tm.name)}</div>
          ${tm.members
            .map(
              (m) => `
              <div style="display:flex;justify-content:space-between;padding:0.3rem 0;border-bottom:1px solid var(--border-subtle);font-size:0.88rem;">
                <strong>${escapeHtml(m.display_name)}</strong>
                <span class="badge badge-pool-${m.pool}">Chapeau ${m.pool}</span>
              </div>
            `
            )
            .join('')}
        `;
        box.appendChild(div);
      }, idx * 450);
    });
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

  await fetchState();
});
