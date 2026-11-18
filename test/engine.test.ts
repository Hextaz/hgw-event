import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../src/db.js';
import {
  drawDailyQuestsForUser,
  generateBalancedTeams,
  getEventSettings,
  getGlobalLeaderboard,
  getMapLeaderboard,
  recordTmnfLiveServerFinish,
  rerollDailyAssignment,
  reviewDailyAssignment,
  runNightlyDailyReset,
  saveUserSelectedGames,
  submitDailyProof,
  submitTmnfReplay,
  updateEventSettings,
  updateFallGuysScoresAndRankings,
} from '../src/engine.js';
import { buildSampleReplayGbx } from '../src/gbx.js';

async function runTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgw-test-'));
  console.log(`🧪 Exécution de la suite de tests HGW dans ${tmpDir}...`);

  const { db } = initDb(tmpDir);

  // 1. Création d'un joueur et vérification de la règle des 4 jeux minimum
  db.prepare(`INSERT INTO users (id, username, display_name, is_admin) VALUES ('u1', 'hextaz', 'Hextaz', 1)`).run();

  assert.throws(
    () => saveUserSelectedGames(db, 'u1', ['rocket_league', 'tmnf', 'valorant']),
    /au moins 4 jeux/,
    'Moins de 4 jeux doit être refusé'
  );

  const saved = saveUserSelectedGames(
    db,
    'u1',
    ['rocket_league', 'tmnf', 'brawlhalla', 'fall_guys'],
    new Date('2026-11-16T12:00:00Z')
  );
  assert.equal(saved.selectedGames.length, 4);
  assert.equal(saved.assignmentsCreated, 3, '3 défis doivent être tirés immédiatement à l’inscription');

  // 2. Vérification du tirage stratifié (1 Facile 10 pts + 1 Moyen 15 pts + 1 Difficile 25 pts = 50 pts/jour)
  const day1Quests = drawDailyQuestsForUser(db, 'u1', new Date('2026-11-16T12:00:00Z'));
  assert.equal(day1Quests.length, 3);
  const totalDay1Potential = day1Quests.reduce((acc, q) => acc + q.points, 0);
  assert.equal(totalDay1Potential, 50, 'Le potentiel journalier sur 2 semaines doit être exactement de 50 pts (10 + 15 + 25)');

  // 3. Test du Reroll quotidien (1 max par jour, même difficulté conservée)
  const questToReroll = day1Quests[0];
  const afterReroll = rerollDailyAssignment(db, 'u1', questToReroll.id, new Date('2026-11-16T12:05:00Z'));
  assert.equal(afterReroll.length, 3);
  assert.notEqual(
    afterReroll.find((q: any) => q.difficulty === questToReroll.difficulty).quest_id,
    questToReroll.quest_id,
    'Le reroll doit remplacer le défi par un autre de même difficulté'
  );
  assert.throws(
    () => rerollDailyAssignment(db, 'u1', afterReroll[0].id, new Date('2026-11-16T12:10:00Z')),
    /déjà utilisé votre Reroll/,
    'Un 2e reroll le même jour doit être bloqué'
  );

  // 4. Simulation des 12 jours complets de la quinzaine (Semaine 1 + Semaine 2 avec reset du quota hebdo et déblocage Acte II)
  for (let dayOffset = 1; dayOffset < 12; dayOffset++) {
    const simDate = new Date(Date.UTC(2026, 10, 16 + dayOffset, 10, 0, 0));
    const resetRes = runNightlyDailyReset(db, simDate);
    assert.equal(resetRes.usersProcessed, 1);
    const drawn = drawDailyQuestsForUser(db, 'u1', simDate);
    assert.equal(drawn.length, 3, `Jour J+${dayOffset} doit toujours tirer 3 défis sans épuisement sur les 2 semaines`);
  }

  // 5. Soumission de preuve, refus avec motif, re-soumission et validation
  const latestQuests = drawDailyQuestsForUser(db, 'u1', new Date(Date.UTC(2026, 10, 27, 10, 0, 0)));
  const qTarget = latestQuests[0];

  submitDailyProof(db, {
    userId: 'u1',
    assignmentId: qTarget.id,
    proofUrl: 'https://medal.tv/clip/1',
    proofNote: 'Premier essai',
  });

  reviewDailyAssignment(db, {
    assignmentId: qTarget.id,
    action: 'reject',
    reviewerId: 'Modo',
    rejectReason: 'Screenshot coupé',
  });

  // Le joueur peut re-soumettre après un refus
  submitDailyProof(db, {
    userId: 'u1',
    assignmentId: qTarget.id,
    proofUrl: 'https://medal.tv/clip/2-complet',
    proofNote: 'Screenshot plein écran',
  });

  reviewDailyAssignment(db, {
    assignmentId: qTarget.id,
    action: 'approve',
    reviewerId: 'Modo',
  });

  // 6. Test du parser .Replay.gbx : Argent (10 pts) puis Auteur (30 pts) -> +20 pts différentiels (non-cumulatif)
  const mapA01 = db.prepare(`SELECT * FROM tmnf_maps WHERE id = 'medal_1'`).get() as any;

  const silverReplay = buildSampleReplayGbx({
    mapUid: mapA01.uid,
    bestTimeMs: mapA01.silver_ms - 100, // Médaille Argent (10 pts)
    playerLogin: 'hextaz_tm',
    nonce: 'run_silver',
  });

  const subSilver = submitTmnfReplay(db, {
    userId: 'u1',
    buffer: silverReplay,
    fileName: 'A01_silver.Replay.gbx',
  });
  assert.equal(subSilver.medal, 'silver');
  assert.equal(subSilver.newPoints, 10);
  assert.equal(subSilver.deltaPoints, 10);

  // Doublon SHA-256 interdit
  assert.throws(
    () =>
      submitTmnfReplay(db, {
        userId: 'u1',
        buffer: silverReplay,
        fileName: 'A01_silver_copy.Replay.gbx',
      }),
    /déjà été soumis/,
    'Le même fichier binaire .gbx ne peut pas être soumis 2 fois'
  );

  // Usurpation de login TMNF interdite
  const otherLoginReplay = buildSampleReplayGbx({
    mapUid: mapA01.uid,
    bestTimeMs: mapA01.author_ms - 200,
    playerLogin: 'autre_joueur_tm',
    nonce: 'run_spoof',
  });
  assert.throws(
    () =>
      submitTmnfReplay(db, {
        userId: 'u1',
        buffer: otherLoginReplay,
        fileName: 'spoof.Replay.gbx',
      }),
    /enregistré par le compte TMNF/,
    'Un replay enregistré par un autre login TMNF doit être bloqué'
  );

  // Passage à la médaille Auteur (30 pts) -> delta = +20 pts (total map = 30 pts, pas 40 !)
  const authorReplay = buildSampleReplayGbx({
    mapUid: mapA01.uid,
    bestTimeMs: mapA01.author_ms - 150,
    playerLogin: 'hextaz_tm',
    nonce: 'run_author',
  });
  const subAuthor = submitTmnfReplay(db, {
    userId: 'u1',
    buffer: authorReplay,
    fileName: 'A01_author.Replay.gbx',
  });
  assert.equal(subAuthor.medal, 'author');
  assert.equal(subAuthor.previousPoints, 10);
  assert.equal(subAuthor.newPoints, 30);
  assert.equal(subAuthor.deltaPoints, 20, 'Seule la différence (+20 pts) doit être créditée');

  // 7. Test du tirage équilibré par Chapeaux (Pool 1 / 2 / 3) et du calculateur Fall Guys
  for (let i = 2; i <= 9; i++) {
    const uid = `u${i}`;
    const pool = ((i - 1) % 3) + 1;
    db.prepare(`INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)`).run(uid, `player${i}`, `Player ${i}`);
    db.prepare(
      `INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES ('rl_rumble', ?, ?, 1)`
    ).run(uid, pool);
    db.prepare(
      `INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES ('fall_guys', ?, ?, 1)`
    ).run(uid, pool);
  }
  db.prepare(
    `INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES ('rl_rumble', 'u1', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES ('fall_guys', 'u1', 1, 1)`
  ).run();

  const teamDraw = generateBalancedTeams(db, 'rl_rumble', true);
  assert.equal(teamDraw.teams.length, 3, '9 joueurs en 3v3 donnent 3 équipes équilibrées');
  for (const t of teamDraw.teams) {
    assert.equal(t.members.length, 3);
    assert.equal(t.averagePool, 2, 'Chaque équipe doit avoir une moyenne exacte de Chapeau 2.0 (1 + 2 + 3)');
  }

  // Test Fall Guys 5-Show Calculator
  const fgStandings = updateFallGuysScoresAndRankings(db, [
    { userId: 'u1', shows: [10, 10, 6, 6, 10] }, // 42 pts -> 1er (200 pts HGW)
    { userId: 'u2', shows: [6, 6, 10, 3, 6] }, // 31 pts -> 2e (140 pts HGW)
    { userId: 'u3', shows: [3, 3, 3, 3, 3] }, // 15 pts -> 3e (90 pts HGW)
  ]);
  assert.equal(fgStandings[0].user_id, 'u1');
  assert.equal(fgStandings[0].fg_total_score, 42);
  assert.equal(fgStandings[0].points_awarded, 200);

  const lb = getGlobalLeaderboard(db);
  const u1Row = lb.find((r) => r.id === 'u1');
  assert.equal(
    u1Row.total_points,
    qTarget.points + 30 + 200,
    'Le total de u1 dans points_ledger doit être Défi + Médaille Auteur (30) + 1er Fall Guys (200)'
  );

  // 8. Test du phasage 2 Semaines : Map Serveur 24/7 verrouillée en Semaine 1 puis débloquée en Semaine 2
  const weeklyMap = db.prepare(`SELECT * FROM tmnf_maps WHERE is_weekly = 1 LIMIT 1`).get() as any;
  updateEventSettings(db, { status_mode: 'week1' });
  assert.equal(getEventSettings(db).tmnf_weekly_unlocked, false);

  const weeklyReplayBuf = buildSampleReplayGbx({
    mapUid: weeklyMap.uid,
    bestTimeMs: 42100,
    playerLogin: 'hextaz_tm',
    nonce: 'week1_blocked_weekly',
  });
  assert.throws(
    () =>
      submitTmnfReplay(db, {
        userId: 'u1',
        buffer: weeklyReplayBuf,
        fileName: 'weekly_s1.Replay.gbx',
      }),
    /Semaine 2/,
    'La Map Serveur 24/7 doit être verrouillée durant la Semaine 1 (Acte I)'
  );

  // Déblocage en Semaine 2 (Acte II) + remontée automatique depuis le serveur dédié Trackmania (XML-RPC Webhook)
  updateEventSettings(db, { status_mode: 'week2' });
  assert.equal(getEventSettings(db).tmnf_weekly_unlocked, true);

  const liveFinishWeekly = recordTmnfLiveServerFinish(db, {
    playerLogin: 'hextaz_tm',
    playerNickname: 'Hextaz',
    mapUid: weeklyMap.uid,
    timeMs: 41250,
  });
  assert.equal(liveFinishWeekly.isPersonalBest, true);
  assert.equal(liveFinishWeekly.matchedUser.id, 'u1');

  const lbAfterLive = getGlobalLeaderboard(db);
  const u1AfterLive = lbAfterLive.find((r) => r.id === 'u1');
  assert.equal(
    u1AfterLive.total_points,
    qTarget.points + 30 + 200 + 150,
    'Le 1er temps sur la map hebdo depuis le serveur dédié doit créditer automatiquement +150 pts au classement général'
  );

  // 8b. Test du Bonus de Régularité (+20 pts dès 4 jours actifs validés)
  const otherDaysAssignments = db
    .prepare(
      `SELECT id, day_key FROM daily_assignments WHERE user_id = 'u1' AND day_key != '2026-11-27' GROUP BY day_key LIMIT 3`
    )
    .all() as any[];
  assert.equal(otherDaysAssignments.length, 3);
  for (const a of otherDaysAssignments) {
    db.prepare(`UPDATE daily_assignments SET status = 'open' WHERE id = ?`).run(a.id);
    submitDailyProof(db, { userId: 'u1', assignmentId: a.id, proofUrl: `https://medal.tv/clip/${a.day_key}` });
    reviewDailyAssignment(db, { assignmentId: a.id, action: 'approve', reviewerId: 'Modo' });
  }
  const regEntry = db
    .prepare(`SELECT * FROM points_ledger WHERE source_ref = 'regularity:tier_4:u1'`)
    .get() as any;
  assert.ok(regEntry, '4 jours actifs distincts doivent déclencher automatiquement le palier +20 pts de Régularité');
  assert.equal(regEntry.points, 20);

  // 9. Tests V3 : Anti-partage de login TMNF inter-joueurs, Classement par piste & Verrouillage de fin d'événement
  const stolenLoginReplay = buildSampleReplayGbx({
    mapUid: mapA01.uid,
    bestTimeMs: mapA01.author_ms - 500,
    playerLogin: 'hextaz_tm', // déjà lié à u1
    nonce: 'stolen_by_u2',
  });
  assert.throws(
    () =>
      submitTmnfReplay(db, {
        userId: 'u2',
        buffer: stolenLoginReplay,
        fileName: 'stolen.Replay.gbx',
      }),
    /appartient déjà au joueur/,
    'Deux comptes Discord différents ne peuvent pas partager le même login Trackmania'
  );

  const u2ValidReplay = buildSampleReplayGbx({
    mapUid: mapA01.uid,
    bestTimeMs: mapA01.gold_ms - 50,
    playerLogin: 'player2_tm',
    nonce: 'u2_gold_run',
  });
  submitTmnfReplay(db, {
    userId: 'u2',
    buffer: u2ValidReplay,
    fileName: 'u2_gold.Replay.gbx',
  });

  const mapLb = getMapLeaderboard(db, 'medal_1');
  assert.equal(mapLb.entries.length, 2, 'La piste medal_1 doit compter 2 joueurs classés');
  assert.equal(mapLb.entries[0].user_id, 'u1');
  assert.equal(mapLb.entries[0].delta_wr_ms, 0);
  assert.equal(mapLb.entries[1].user_id, 'u2');
  assert.ok(mapLb.entries[1].delta_wr_ms > 0, 'Le 2e joueur doit avoir un delta positif par rapport au WR');

  updateEventSettings(db, { status_mode: 'closed' });
  const settingsClosed = getEventSettings(db);
  assert.equal(settingsClosed.effective_phase, 'closed');
  assert.throws(
    () =>
      submitTmnfReplay(db, {
        userId: 'u2',
        buffer: buildSampleReplayGbx({
          mapUid: mapA01.uid,
          bestTimeMs: mapA01.author_ms - 10,
          playerLogin: 'player2_tm',
          nonce: 'after_close',
        }),
        fileName: 'late.Replay.gbx',
      }),
    /clôturée/,
    'Aucun replay ne peut être soumis lorsque l’événement est clôturé'
  );

  console.log('✅ Tous les tests unitaires et d’intégration HGW (V1 + V2 + V3 + Format 2 Semaines) sont passés avec succès !');
}

runTests().catch((err) => {
  console.error('❌ Échec des tests:', err);
  process.exit(1);
});
