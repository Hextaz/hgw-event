import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGame,
  createQuest,
  deleteGame,
  deleteQuest,
  exportCatalog,
  importCatalog,
  listCatalog,
  normalizeLogoUrl,
  updateGame,
  updateQuest,
} from '../src/catalog.js';
import { getEventConfig, updateEventConfig } from '../src/config.js';
import { initDb } from '../src/db.js';
import { archiveCurrentEdition, listArchivedEditions, startNewEdition } from '../src/editions.js';
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
import {
  createFeaturedItem,
  deleteFeaturedItem,
  listFeaturedItems,
  listPendingFeaturedProofs,
  recalculateFeaturedLadder,
  reviewFeaturedSubmission,
  submitFeaturedStandard,
  updateFeaturedItem,
} from '../src/featured.js';
import { buildSampleChallengeGbx, buildSampleReplayGbx, parseChallengeGbx } from '../src/gbx.js';
import {
  createTournament,
  deleteTournament,
  listTournamentsWithRegistrations,
  updateTournament,
  updateTournamentPlayer,
  updateTournamentRoundScores,
} from '../src/tournaments.js';

async function runTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgw-test-'));
  console.log(`🧪 Exécution de la suite de tests HGW dans ${tmpDir}...`);

  const { db } = initDb(tmpDir);

  // 1. Création d'un joueur et règle des 4 jeux minimum
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

  // 2. Tirage stratifié (10 + 15 + 25 = 50 pts/jour)
  const day1Quests = drawDailyQuestsForUser(db, 'u1', new Date('2026-11-16T12:00:00Z'));
  assert.equal(day1Quests.length, 3);
  assert.equal(day1Quests.reduce((acc, q) => acc + q.points, 0), 50);

  // 3. Reroll quotidien
  const questToReroll = day1Quests[0];
  const afterReroll = rerollDailyAssignment(db, 'u1', questToReroll.id, new Date('2026-11-16T12:05:00Z'));
  assert.equal(afterReroll.length, 3);
  assert.notEqual(
    afterReroll.find((q: any) => q.difficulty === questToReroll.difficulty).quest_id,
    questToReroll.quest_id
  );
  assert.throws(
    () => rerollDailyAssignment(db, 'u1', afterReroll[0].id, new Date('2026-11-16T12:10:00Z')),
    /déjà utilisé votre Reroll/
  );

  // 4. Simulation des 12 jours complets
  for (let dayOffset = 1; dayOffset < 12; dayOffset++) {
    const simDate = new Date(Date.UTC(2026, 10, 16 + dayOffset, 10, 0, 0));
    const resetRes = runNightlyDailyReset(db, simDate);
    assert.equal(resetRes.usersProcessed, 1);
    const drawn = drawDailyQuestsForUser(db, 'u1', simDate);
    assert.equal(drawn.length, 3);
  }

  // 5. Soumission de preuve, refus avec motif, re-soumission et validation
  const latestQuests = drawDailyQuestsForUser(db, 'u1', new Date(Date.UTC(2026, 10, 27, 10, 0, 0)));
  const qTarget = latestQuests[0];
  submitDailyProof(db, { userId: 'u1', assignmentId: qTarget.id, proofUrl: 'https://medal.tv/clip/1', proofNote: 'Essai 1' });
  reviewDailyAssignment(db, { assignmentId: qTarget.id, action: 'reject', reviewerId: 'Modo', rejectReason: 'Coupé' });
  submitDailyProof(db, { userId: 'u1', assignmentId: qTarget.id, proofUrl: 'https://medal.tv/clip/2', proofNote: 'Complet' });
  reviewDailyAssignment(db, { assignmentId: qTarget.id, action: 'approve', reviewerId: 'Modo' });

  // 6. Connecteur TMNF .Replay.gbx : Argent (10 pts) puis Auteur (30 pts) -> delta +20 pts
  const mapA01 = listFeaturedItems(db, true).find((m) => m.id === 'medal_1')!;
  const silverReplay = buildSampleReplayGbx({
    mapUid: mapA01.uid,
    bestTimeMs: mapA01.silver_ms - 100,
    playerLogin: 'hextaz_tm',
    nonce: 'run_silver',
  });
  const subSilver = submitTmnfReplay(db, { userId: 'u1', buffer: silverReplay, fileName: 'A01_silver.Replay.gbx' });
  assert.equal(subSilver.medal, 'silver');
  assert.equal(subSilver.newPoints, 10);
  assert.equal(subSilver.deltaPoints, 10);

  assert.throws(
    () => submitTmnfReplay(db, { userId: 'u1', buffer: silverReplay, fileName: 'A01_dup.Replay.gbx' }),
    /déjà été soumis/
  );

  const otherLoginReplay = buildSampleReplayGbx({
    mapUid: mapA01.uid,
    bestTimeMs: mapA01.author_ms - 200,
    playerLogin: 'autre_joueur_tm',
    nonce: 'run_spoof',
  });
  assert.throws(
    () => submitTmnfReplay(db, { userId: 'u1', buffer: otherLoginReplay, fileName: 'spoof.Replay.gbx' }),
    /enregistré par le compte TMNF/
  );

  const authorReplay = buildSampleReplayGbx({
    mapUid: mapA01.uid,
    bestTimeMs: mapA01.author_ms - 150,
    playerLogin: 'hextaz_tm',
    nonce: 'run_author',
  });
  const subAuthor = submitTmnfReplay(db, { userId: 'u1', buffer: authorReplay, fileName: 'A01_author.Replay.gbx' });
  assert.equal(subAuthor.medal, 'author');
  assert.equal(subAuthor.previousPoints, 10);
  assert.equal(subAuthor.newPoints, 30);
  assert.equal(subAuthor.deltaPoints, 20);

  // 7. Tirage équilibré par Chapeaux + retouche manuelle d'équipe + Fall Guys 5-Show
  for (let i = 2; i <= 9; i++) {
    const uid = `u${i}`;
    const pool = ((i - 1) % 3) + 1;
    db.prepare(`INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)`).run(uid, `player${i}`, `Player ${i}`);
    db.prepare(`INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES ('rl_rumble', ?, ?, 1)`).run(uid, pool);
    db.prepare(`INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES ('fall_guys', ?, ?, 1)`).run(uid, pool);
  }
  db.prepare(`INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES ('rl_rumble', 'u1', 1, 1)`).run();
  db.prepare(`INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES ('fall_guys', 'u1', 1, 1)`).run();

  const teamDraw = generateBalancedTeams(db, 'rl_rumble', true);
  assert.equal(teamDraw.teams.length, 3);
  for (const t of teamDraw.teams) {
    assert.equal(t.members.length, 3);
    assert.equal(t.averagePool, 2);
  }

  // Retouche manuelle d'équipe en live
  updateTournamentPlayer(db, 'rl_rumble', { userId: 'u2', teamNumber: 1 });
  const regU2 = db
    .prepare(`SELECT team_number FROM tournament_registrations WHERE tournament_id = 'rl_rumble' AND user_id = 'u2'`)
    .get() as { team_number: number };
  assert.equal(regU2.team_number, 1);

  const fgStandings = updateFallGuysScoresAndRankings(db, [
    { userId: 'u1', shows: [10, 10, 6, 6, 10] },
    { userId: 'u2', shows: [6, 6, 10, 3, 6] },
    { userId: 'u3', shows: [3, 3, 3, 3, 3] },
  ]);
  assert.equal(fgStandings[0].user_id, 'u1');
  assert.equal(fgStandings[0].round_total_score, 42);
  assert.equal(fgStandings[0].points_awarded, 200);

  const lb = getGlobalLeaderboard(db);
  assert.equal(lb.find((r) => r.id === 'u1').total_points, qTarget.points + 30 + 200);

  // 8. Phasage Acte 1 -> Acte 2 + Webhook XML-RPC Serveur Dédié
  const weeklyMap = listFeaturedItems(db, true).find((m) => m.is_ladder)!;
  updateEventSettings(db, { status_mode: 'week1' });
  assert.equal(getEventSettings(db).tmnf_weekly_unlocked, false);

  const weeklyReplayBuf = buildSampleReplayGbx({
    mapUid: weeklyMap.uid,
    bestTimeMs: 42100,
    playerLogin: 'hextaz_tm',
    nonce: 'week1_blocked_weekly',
  });
  assert.throws(
    () => submitTmnfReplay(db, { userId: 'u1', buffer: weeklyReplayBuf, fileName: 'weekly_s1.Replay.gbx' }),
    /Acte 2/
  );

  updateEventSettings(db, { status_mode: 'week2' });
  assert.equal(getEventSettings(db).tmnf_weekly_unlocked, true);

  const liveFinishWeekly = recordTmnfLiveServerFinish(db, {
    playerLogin: 'hextaz_tm',
    playerNickname: 'Hextaz',
    mapUid: weeklyMap.uid,
    timeMs: 41250,
  });
  assert.equal(liveFinishWeekly.isPersonalBest, true);
  assert.equal(getGlobalLeaderboard(db).find((r) => r.id === 'u1').total_points, qTarget.points + 30 + 200 + 150);

  // 8b. Bonus Régularité (4 jours actifs -> +20 pts)
  const otherDays = db
    .prepare(`SELECT id, day_key FROM daily_assignments WHERE user_id = 'u1' AND day_key != '2026-11-27' GROUP BY day_key LIMIT 3`)
    .all() as any[];
  assert.equal(otherDays.length, 3);
  for (const a of otherDays) {
    db.prepare(`UPDATE daily_assignments SET status = 'open' WHERE id = ?`).run(a.id);
    submitDailyProof(db, { userId: 'u1', assignmentId: a.id, proofUrl: `https://medal.tv/clip/${a.day_key}` });
    reviewDailyAssignment(db, { assignmentId: a.id, action: 'approve', reviewerId: 'Modo' });
  }
  const regEntry = db.prepare(`SELECT * FROM points_ledger WHERE source_ref = 'regularity:tier_4:u1'`).get() as any;
  assert.equal(regEntry.points, 20);

  // 9. Anti-partage login TMNF + Classement piste + Verrouillage fin d'événement
  assert.throws(
    () =>
      submitTmnfReplay(db, {
        userId: 'u2',
        buffer: buildSampleReplayGbx({ mapUid: mapA01.uid, bestTimeMs: mapA01.author_ms - 500, playerLogin: 'hextaz_tm', nonce: 'stolen' }),
        fileName: 'stolen.Replay.gbx',
      }),
    /appartient déjà au joueur/
  );

  submitTmnfReplay(db, {
    userId: 'u2',
    buffer: buildSampleReplayGbx({ mapUid: mapA01.uid, bestTimeMs: mapA01.gold_ms - 50, playerLogin: 'player2_tm', nonce: 'u2_gold' }),
    fileName: 'u2_gold.Replay.gbx',
  });
  const mapLb = getMapLeaderboard(db, 'medal_1');
  assert.equal(mapLb.entries.length, 2);
  assert.equal(mapLb.entries[0].user_id, 'u1');
  assert.equal(mapLb.entries[0].delta_wr_ms, 0);

  updateEventSettings(db, { status_mode: 'closed' });
  assert.equal(getEventSettings(db).effective_phase, 'closed');
  assert.throws(
    () =>
      submitTmnfReplay(db, {
        userId: 'u2',
        buffer: buildSampleReplayGbx({ mapUid: mapA01.uid, bestTimeMs: mapA01.author_ms - 10, playerLogin: 'player2_tm', nonce: 'late' }),
        fileName: 'late.Replay.gbx',
      }),
    /clôturé/
  );

  // 10. Parser .Challenge.gbx (Import pistes TMNF dans l'admin)
  {
    const challengeBuf = buildSampleChallengeGbx({
      mapUid: 'CUSTOM_UID_2026_ABC',
      name: '$0f0HGW $fffCircuit Test',
      author: '$ff0Hextaz',
      authorMs: 31200,
      goldMs: 33500,
      silverMs: 37000,
      bronzeMs: 44000,
    });
    const parsedChallenge = parseChallengeGbx(challengeBuf);
    assert.equal(parsedChallenge.valid, true);
    assert.equal(parsedChallenge.mapUid, 'CUSTOM_UID_2026_ABC');
    assert.equal(parsedChallenge.name, 'HGW Circuit Test');
    assert.equal(parsedChallenge.authorMs, 31200);
    assert.equal(parsedChallenge.goldMs, 33500);
    console.log('✅ Parser .Challenge.gbx (import pistes admin) OK');
  }

  // 11. Catalogue CRUD, Santé, Export / Import JSON & Seed non destructif
  {
    db.prepare(`UPDATE quests SET title = 'Titre modifié admin' WHERE id = 'wii_easy_1'`).run();
    db.prepare(`DELETE FROM quests WHERE id = 'splatoon_hard_1'`).run();
    initDb(tmpDir);
    assert.equal((db.prepare(`SELECT title FROM quests WHERE id = 'wii_easy_1'`).get() as any).title, 'Titre modifié admin');
    assert.equal(db.prepare(`SELECT 1 FROM quests WHERE id = 'splatoon_hard_1'`).get(), undefined);

    assert.throws(() => normalizeLogoUrl('javascript:alert(1)'), /invalide|https/);
    assert.throws(() => normalizeLogoUrl('http://exemple.fr/logo.png'), /https/);
    assert.equal(normalizeLogoUrl('/uploads/logos/mk_ab12.png'), '/uploads/logos/mk_ab12.png');

    const mk = createGame(db, { name: 'Mario Kart 8 Deluxe', short_name: 'Mario Kart', logo_url: 'https://cdn.exemple.fr/mk.png' });
    const q1 = createQuest(db, { game_id: mk.id, title: 'Premier tour', description: 'Finir une course 150cc dans le top 3.', difficulty: 'hard' });
    assert.equal(q1.points, 25);
    const q2 = createQuest(db, { game_id: mk.id, title: 'Jamais tiré', description: 'Ce défi ne sera jamais tiré.', difficulty: 'medium' });
    deleteQuest(db, q2.id);

    // Export / Import JSON
    const exported = exportCatalog(db, mk.id);
    assert.equal(exported.games.length, 1);
    assert.equal(exported.quests.length, 1);
    const impRes = importCatalog(db, {
      games: [{ id: 'balatro', name: 'Balatro', short_name: 'Balatro', platforms: 'PC / Mobile' }],
      quests: [
        { game_id: 'balatro', title: 'Première Mise', description: 'Gagner une partie en mise blanche.', difficulty: 'easy', unlock_week: 1 },
        { game_id: 'balatro', title: 'Acte 3 Boss', description: 'Atteindre Ante 10 en mode infini.', difficulty: 'hard', unlock_week: 3 },
      ],
    });
    assert.equal(impRes.gamesCreated, 1);
    assert.equal(impRes.questsCreated, 2);

    const cat = listCatalog(db);
    assert.ok(cat.health.warnings.some((w) => w.gameId === 'balatro'), 'Le diagnostic doit repérer les difficultés manquantes');
    console.log('✅ Catalogue : CRUD, santé, export/import JSON & seed non destructif OK');
  }

  // 12. Tournois modulaires (CRUD + scoring multi-manches sur un nouveau tournoi)
  {
    const mkTourney = createTournament(db, {
      name: 'Grand Prix Mario Kart',
      game_id: 'mario_kart',
      scheduled_label: 'Dimanche 14h',
      team_size: 2,
      scoring_mode: 'rounds',
      rounds_count: 4,
      round_presets: [
        { label: '1er', points: 15 },
        { label: '2e', points: 12 },
      ],
      bracket_url: 'https://tournamenthub.hextaz.dev/mk',
    });
    assert.equal(mkTourney.scoring_mode, 'rounds');
    assert.equal(mkTourney.rounds_count, 4);
    assert.equal(mkTourney.bracket_url, 'https://tournamenthub.hextaz.dev/mk');

    db.prepare(`INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES (?, 'u1', 1, 1)`).run(mkTourney.id);
    db.prepare(`INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES (?, 'u2', 2, 1)`).run(mkTourney.id);
    const standings = updateTournamentRoundScores(db, mkTourney.id, [
      { userId: 'u1', scores: [15, 12, 15, 15] },
      { userId: 'u2', scores: [12, 15, 10, 10] },
    ]);
    assert.equal(standings[0].user_id, 'u1');
    assert.equal(standings[0].round_total_score, 57);
    assert.throws(() => deleteTournament(db, mkTourney.id), /Désactive/);
    updateTournament(db, mkTourney.id, { active: false });
    assert.ok(!listTournamentsWithRegistrations(db, false).some((t) => t.id === mkTourney.id));

    const tempT = createTournament(db, { name: 'Tournoi Éphémère' });
    deleteTournament(db, tempT.id);
    console.log('✅ Tournois modulaires : CRUD, presets, multi-manches générique & archivage OK');
  }

  // 13. Cycle Nouvelle Édition & Hall of Fame + Jeu Vedette NON-COURSE (TETR.IO en mode Standard)
  {
    const lbBefore = getGlobalLeaderboard(db);
    const editionRes = startNewEdition(db, {
      newName: 'Hextaz Games Week #2 — TETR.IO',
      leaderboard: lbBefore,
      archiveCurrent: true,
      keepTournaments: true,
      keepFeaturedItems: false,
    });

    assert.ok(editionRes.archived, 'L’édition 1 doit être archivée automatiquement');
    assert.equal(editionRes.eventConfig.effective_phase, 'draft', 'La nouvelle édition démarre en mode Préparation');
    assert.equal(editionRes.eventConfig.event_name, 'Hextaz Games Week #2 — TETR.IO');

    // Vérifier la remise à zéro des scores mais conservation des users et du catalogue
    assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM points_ledger`).get() as any).c, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM daily_assignments`).get() as any).c, 0);
    assert.ok((db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as any).c >= 9, 'Les comptes Discord sont conservés');
    assert.ok((db.prepare(`SELECT COUNT(*) AS c FROM quests`).get() as any).c > 60, 'Le catalogue de défis est conservé');

    const archives = listArchivedEditions(db);
    assert.equal(archives.length, 1);
    assert.equal(archives[0].snapshot.podium[0].id, 'u1');

    // Configurer un Jeu Vedette NON-COURSE (TETR.IO, score_desc, connecteur standard) + 3 actes + barème custom
    updateEventConfig(db, {
      status_mode: 'act_2',
      acts_count: 3,
      quest_points: { easy: 15, medium: 25, hard: 40 },
      featured: {
        enabled: true,
        title: 'TETR.IO',
        subtitle: 'Défis de score Blitz & Ladder ouvert !',
        connector: 'standard',
        metric_type: 'score_desc',
        metric_unit: 'pts',
        stages_enabled: true,
        stages_title: 'Épreuves Score',
        tiers: [
          { key: 'b', label: 'Rang B', points: 10 },
          { key: 'a', label: 'Rang A', points: 20 },
          { key: 's', label: 'Rang S', points: 35 },
        ],
        ladder_enabled: true,
        ladder_title: 'Ladder Blitz 2 min',
        ladder_unlock_act: 1,
        ladder_points_scale: [120, 80, 50],
      },
    });

    const cfg2 = getEventConfig(db);
    assert.equal(cfg2.acts_count, 3);
    assert.equal(cfg2.quest_points.hard, 40);
    assert.equal(cfg2.featured.connector, 'standard');
    assert.equal(cfg2.featured.metric_type, 'score_desc');

    // Créer une épreuve paliers + un ladder TETR.IO
    const stage1 = createFeaturedItem(db, {
      code: 'BLITZ-1',
      name: 'Blitz 2 minutes',
      thresholds: { b: 50000, a: 100000, s: 180000 },
    });
    const ladder1 = createFeaturedItem(db, {
      code: 'LADDER-BLITZ',
      name: 'Record absolu Blitz',
      is_ladder: true,
    });

    // Soumission preuve standard -> en attente de modération unifiée
    const subA = submitFeaturedStandard(db, {
      userId: 'u1',
      itemId: stage1.id,
      metricValue: 115000, // Rang A (+20 pts)
      proofUrl: 'https://imgur.com/tetrio-a.png',
    });
    assert.equal(subA.status, 'pending');
    assert.equal(listPendingFeaturedProofs(db).length, 1);

    // Validation admin -> crédite +20 pts
    reviewFeaturedSubmission(db, { submissionId: subA.id, action: 'approve', reviewerId: 'Hextaz' });
    assert.equal(getGlobalLeaderboard(db).find((p) => p.id === 'u1').total_points, 20);

    // Amélioration vers Rang S (195000 -> 35 pts total, différentiel +15 pts)
    const subS = submitFeaturedStandard(db, {
      userId: 'u1',
      itemId: stage1.id,
      metricValue: 195000,
      proofUrl: 'https://imgur.com/tetrio-s.png',
    });
    reviewFeaturedSubmission(db, { submissionId: subS.id, action: 'approve', reviewerId: 'Hextaz' });
    assert.equal(getGlobalLeaderboard(db).find((p) => p.id === 'u1').total_points, 35);

    // Ladder TETR.IO (u2 bat u1 -> u2 prend 120 pts, u1 prend 80 pts)
    const ladU1 = submitFeaturedStandard(db, { userId: 'u1', itemId: ladder1.id, metricValue: 180000, proofUrl: 'https://imgur.com/l1.png' });
    const ladU2 = submitFeaturedStandard(db, { userId: 'u2', itemId: ladder1.id, metricValue: 240000, proofUrl: 'https://imgur.com/l2.png' });
    reviewFeaturedSubmission(db, { submissionId: ladU1.id, action: 'approve', reviewerId: 'Hextaz' });
    reviewFeaturedSubmission(db, { submissionId: ladU2.id, action: 'approve', reviewerId: 'Hextaz' });

    const ladBoard = recalculateFeaturedLadder(db);
    assert.equal(ladBoard[0].user_id, 'u2');
    assert.equal(ladBoard[0].projected_points, 120);
    assert.equal(ladBoard[1].user_id, 'u1');
    assert.equal(ladBoard[1].projected_points, 80);
    assert.equal(getGlobalLeaderboard(db).find((p) => p.id === 'u1').total_points, 35 + 80);
    assert.equal(getGlobalLeaderboard(db).find((p) => p.id === 'u2').total_points, 120);

    // Suppression d'une épreuve jamais utilisée
    const tmpStage = createFeaturedItem(db, { code: 'TMP', name: 'Épreuve temporaire' });
    updateFeaturedItem(db, tmpStage.id, { name: 'Épreuve renommée' });
    deleteFeaturedItem(db, tmpStage.id);
    console.log('✅ Cycle Nouvelle Édition + Hall of Fame + Jeu Vedette Standard (TETR.IO) OK');
  }

  // 14. Test de migration douce d'une ancienne base V1 (tmnf_maps + ancien CHECK points_ledger)
  {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgw-legacy-'));
    fs.mkdirSync(path.join(legacyDir, 'db'), { recursive: true });
    const legacyDb = new Database(path.join(legacyDir, 'db', 'hgw.sqlite'));
    legacyDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL, avatar TEXT, tmnf_login TEXT, is_admin INTEGER NOT NULL DEFAULT 0, reroll_day_key TEXT, rerolls_used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE tmnf_maps (id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, uid TEXT NOT NULL UNIQUE, environment TEXT NOT NULL DEFAULT 'Stadium', is_weekly INTEGER NOT NULL DEFAULT 0, author_ms INTEGER NOT NULL, gold_ms INTEGER NOT NULL, silver_ms INTEGER NOT NULL, bronze_ms INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE tmnf_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, map_id TEXT NOT NULL, time_ms INTEGER NOT NULL, medal TEXT NOT NULL, points_awarded INTEGER NOT NULL DEFAULT 0, player_login TEXT NOT NULL, player_nickname TEXT, replay_sha256 TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE points_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, source_type TEXT NOT NULL CHECK (source_type IN ('daily', 'tmnf_medal', 'tmnf_weekly', 'tournament', 'manual')), source_ref TEXT NOT NULL UNIQUE, category TEXT NOT NULL CHECK (category IN ('async', 'live')), points INTEGER NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO users (id, username, display_name, is_admin) VALUES ('leg_u1', 'legacy', 'Legacy', 1);
      INSERT INTO tmnf_maps (id, code, name, uid, is_weekly, author_ms, gold_ms, silver_ms, bronze_ms, sort_order) VALUES ('m_leg', 'LEG-01', 'Legacy Track', 'LEG_UID_1', 0, 20000, 22000, 25000, 30000, 1);
      INSERT INTO tmnf_submissions (user_id, map_id, time_ms, medal, points_awarded, player_login, replay_sha256, file_name) VALUES ('leg_u1', 'm_leg', 19500, 'author', 30, 'leg_tm', 'hash_legacy_1', 'leg.Replay.gbx');
      INSERT INTO points_ledger (user_id, source_type, source_ref, category, points, label) VALUES ('leg_u1', 'tmnf_medal', 'tmnf_medal:leg_u1:m_leg', 'async', 30, 'Legacy medal');
    `);
    legacyDb.close();

    const upgraded = initDb(legacyDir);
    const migratedItems = listFeaturedItems(upgraded.db, true);
    assert.equal(migratedItems.length, 1);
    assert.equal(migratedItems[0].external_uid, 'LEG_UID_1');
    // Doit maintenant accepter source_type = 'featured_stage'
    upgraded.db
      .prepare(`INSERT INTO points_ledger (user_id, source_type, source_ref, category, points, label) VALUES ('leg_u1', 'featured_stage', 'featured_stage:leg_u1:test', 'async', 10, 'Test migration')`)
      .run();
    upgraded.db.close();
    console.log('✅ Migration douce depuis une ancienne base SQLite V1 OK');
  }

  console.log('🎉 Tous les tests unitaires, modulaires et de migration HGW sont passés avec succès !');
}

runTests().catch((err) => {
  console.error('❌ Échec des tests:', err);
  process.exit(1);
});
