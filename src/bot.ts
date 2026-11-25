import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type PermissionsBitField,
  type TextChannel,
} from 'discord.js';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getEventConfig, isPlayablePhase } from './config.js';
import { drawDailyQuestsForUser, getGlobalLeaderboard, reviewDailyAssignment } from './engine.js';
import { formatMetricValue, reviewFeaturedSubmission } from './featured.js';
import {
  errorMessage,
  type DailyAssignmentDetailRow,
  type FeaturedSubmissionDetailRow,
  type TournamentRow,
} from './types.js';

export interface AnnouncedTeam {
  teamNumber: number;
  teamName: string;
  averagePool: number;
  members: { user_id: string; display_name: string; avatar: string | null; pool: number }[];
}

export class HgwDiscordBot {
  private client: Client | null = null;
  private db: Database.Database;
  private proofsDir: string;
  private isReady = false;
  private onStateChanged?: (eventLabel: string) => void;

  constructor(db: Database.Database, proofsDir: string, onStateChanged?: (eventLabel: string) => void) {
    this.db = db;
    this.proofsDir = proofsDir;
    this.onStateChanged = onStateChanged;
  }

  public getStatus(): { enabled: boolean; ready: boolean; tag?: string } {
    return {
      enabled: Boolean(process.env.DISCORD_BOT_TOKEN),
      ready: this.isReady,
      tag: this.client?.user?.tag,
    };
  }

  public async start(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN?.trim();
    if (!token) {
      console.log('ℹ️ [Discord Bot] DISCORD_BOT_TOKEN non défini — fonctionnement en mode Web autonome.');
      return;
    }

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    this.client.once(Events.ClientReady, async (readyClient) => {
      this.isReady = true;
      console.log(`✅ [Discord Bot] Connecté en tant que ${readyClient.user.tag}`);
      await this.registerSlashCommands(token, readyClient.user.id);
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          await this.handleSlashCommand(interaction);
        } else if (interaction.isButton()) {
          await this.handleButtonInteraction(interaction);
        } else if (interaction.isModalSubmit()) {
          await this.handleModalSubmit(interaction);
        }
      } catch (err: unknown) {
        console.error('❌ [Discord Bot] Erreur interaction:', err);
        const msg = errorMessage(err, 'Une erreur interne est survenue.');
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `❌ ${msg}`, ephemeral: true }).catch(() => {});
        }
      }
    });

    try {
      await this.client.login(token);
    } catch (err: unknown) {
      console.error('⚠️ [Discord Bot] Échec de connexion Discord:', errorMessage(err));
    }
  }

  private async registerSlashCommands(token: string, clientId: string): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID?.trim();
    if (!guildId) return;

    const commands = [
      new SlashCommandBuilder()
        .setName('defis')
        .setDescription('Affiche vos défis quotidiens du jour et leur statut'),
      new SlashCommandBuilder()
        .setName('classement')
        .setDescription('Affiche le Top 10 général de l’édition en cours'),
      new SlashCommandBuilder()
        .setName('profil')
        .setDescription('Affiche votre récapitulatif de points (Async / Live / Tombola)'),
    ].map((c) => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('⚡ [Discord Bot] Slash commands (/defis, /classement, /profil) enregistrées.');
    } catch (err: unknown) {
      console.error('⚠️ [Discord Bot] Impossible d’enregistrer les slash commands:', errorMessage(err));
    }
  }

  private isDiscordUserAdmin(userId: string, memberPermissions?: Readonly<PermissionsBitField> | null): boolean {
    const adminIds = (process.env.ADMIN_DISCORD_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (adminIds.includes(userId)) return true;

    const dbUser = this.db.prepare(`SELECT is_admin FROM users WHERE id = ?`).get(userId) as
      | { is_admin: number }
      | undefined;
    if (dbUser?.is_admin === 1) return true;

    if (memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    return false;
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const baseUrl = process.env.BASE_URL || 'https://hgw.hextaz.dev';
    const cfg = getEventConfig(this.db);
    const isAdmin = this.isDiscordUserAdmin(interaction.user.id, interaction.memberPermissions);

    if (cfg.effective_phase === 'draft' && !isAdmin) {
      await interaction.reply({
        content: `⏳ **${cfg.event_name}** est en cours de préparation ! Revenez très vite sur **${baseUrl}** (le Hall of Fame reste consultable).`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'classement') {
      const lb = getGlobalLeaderboard(this.db).slice(0, 10);
      if (lb.length === 0) {
        await interaction.reply({ content: 'Aucun joueur classé pour le moment !', ephemeral: true });
        return;
      }

      const lines = lb.map((p, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`#${i + 1}\``;
        const ticket = p.tombola_eligible ? '🎟️' : '';
        return `${medal} **${p.display_name}** — **${p.total_points} pts** *(Défis: ${p.async_points} | Live: ${p.live_points})* ${ticket}`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Classement Général — ${cfg.event_name}`)
        .setColor(0xf59e0b)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Ticket Tombola dès ${cfg.tombola_threshold} pts • ${baseUrl}` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (interaction.commandName === 'defis') {
      if (!isPlayablePhase(cfg.effective_phase)) {
        await interaction.reply({
          content: `⏳ Les défis quotidiens ne sont pas ouverts pour le moment (phase : **${cfg.effective_phase}**).`,
          ephemeral: true,
        });
        return;
      }

      const quests = drawDailyQuestsForUser(this.db, interaction.user.id);
      if (quests.length === 0) {
        await interaction.reply({
          content: `🎮 Vous n'avez pas encore configuré vos jeux (min. ${cfg.min_selected_games} requis) ! Rendez-vous sur **${baseUrl}** pour générer vos défis du jour.`,
          ephemeral: true,
        });
        return;
      }

      const statusEmoji: Record<string, string> = {
        open: '⏳ À faire',
        submitted: '🕵️ En attente de validation',
        validated: '✅ Validé',
        rejected: '❌ Refusé (re-soumission possible)',
        expired: '⌛ Expiré',
      };

      const lines = quests.map(
        (q) =>
          `${q.game_emoji} **[${q.difficulty.toUpperCase()} • ${q.points} pts] ${q.title}** (${q.game_name})\n> ${q.description}\n> Statut : **${statusEmoji[q.status] || q.status}**`
      );

      const embed = new EmbedBuilder()
        .setTitle(`🎯 Vos Défis du Jour — ${interaction.user.username}`)
        .setColor(0x10b981)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `Envoyez vos preuves sur ${baseUrl}` });

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (interaction.commandName === 'profil') {
      const lb = getGlobalLeaderboard(this.db);
      const me = lb.find((u) => u.id === interaction.user.id);
      if (!me) {
        await interaction.reply({
          content: `Connectez-vous une première fois sur **${baseUrl}** pour créer votre profil !`,
          ephemeral: true,
        });
        return;
      }

      const totalStages = (
        this.db.prepare(`SELECT COUNT(*) AS c FROM featured_items WHERE active = 1 AND is_ladder = 0`).get() as { c: number }
      ).c;

      const fields = [
        { name: 'Rang Général', value: `#${me.rank} / ${lb.length}`, inline: true },
        { name: 'Points Totaux', value: `**${me.total_points} pts**`, inline: true },
        {
          name: `Ticket Tombola (${cfg.tombola_threshold} pts)`,
          value: me.tombola_eligible ? '🎟️ **Qualifié !**' : `⏳ ${me.total_points}/${cfg.tombola_threshold} pts`,
          inline: true,
        },
        { name: 'Points Semaine (Async)', value: `${me.async_points} pts`, inline: true },
        { name: 'Points Week-end (Live)', value: `${me.live_points} pts`, inline: true },
        {
          name: cfg.featured.enabled && totalStages > 0 ? `Défis / ${cfg.featured.title}` : 'Défis Validés',
          value:
            cfg.featured.enabled && totalStages > 0
              ? `${me.quests_validated} défis • ${me.featured_stages_count}/${totalStages} épreuves`
              : `${me.quests_validated} défis`,
          inline: true,
        },
      ];

      const embed = new EmbedBuilder()
        .setTitle(`👤 Profil — ${me.display_name}`)
        .setColor(0x3b82f6)
        .addFields(fields)
        .setFooter({ text: `${cfg.event_name} • ${baseUrl}` });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const [prefix, rawId] = (interaction.customId || '').split(':');
    const isDaily = prefix === 'hgw_approve' || prefix === 'hgw_reject';
    const isFeatured = prefix === 'hgw_feat_approve' || prefix === 'hgw_feat_reject';
    if (!isDaily && !isFeatured) return;

    if (!this.isDiscordUserAdmin(interaction.user.id, interaction.memberPermissions)) {
      await interaction.reply({
        content: '⛔ Seuls les administrateurs peuvent valider ou refuser une preuve.',
        ephemeral: true,
      });
      return;
    }

    const numericId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(numericId)) return;

    const baseEmbed = interaction.message.embeds[0]
      ? EmbedBuilder.from(interaction.message.embeds[0])
      : new EmbedBuilder().setTitle(`Preuve #${numericId}`);

    if (prefix === 'hgw_approve') {
      try {
        const updated = reviewDailyAssignment(this.db, {
          assignmentId: numericId,
          action: 'approve',
          reviewerId: interaction.user.username,
        });
        const approvedEmbed = baseEmbed
          .setColor(0x10b981)
          .setFooter({ text: `✅ Validé par ${interaction.user.username} (+${updated.points} pts crédités)` });
        await interaction.update({ embeds: [approvedEmbed], components: [] });
        this.onStateChanged?.(`✅ ${updated.display_name} a validé "${updated.title}" (+${updated.points} pts)`);
      } catch (err: unknown) {
        await interaction.message.edit({ components: [] }).catch(() => {});
        await interaction.reply({ content: `ℹ️ ${errorMessage(err)}`, ephemeral: true });
      }
      return;
    }

    if (prefix === 'hgw_feat_approve') {
      try {
        const updated = reviewFeaturedSubmission(this.db, {
          submissionId: numericId,
          action: 'approve',
          reviewerId: interaction.user.username,
        });
        const approvedEmbed = baseEmbed.setColor(0x10b981).setFooter({
          text: `✅ Validé par ${interaction.user.username}${updated.points_awarded ? ` (+${updated.points_awarded} pts)` : ' (classement mis à jour)'}`,
        });
        await interaction.update({ embeds: [approvedEmbed], components: [] });
        this.onStateChanged?.(`✅ ${updated.display_name} a validé ${updated.item_code} · ${updated.item_name}`);
      } catch (err: unknown) {
        await interaction.message.edit({ components: [] }).catch(() => {});
        await interaction.reply({ content: `ℹ️ ${errorMessage(err)}`, ephemeral: true });
      }
      return;
    }

    if (prefix === 'hgw_reject' || prefix === 'hgw_feat_reject') {
      const modalId = isFeatured ? `hgw_feat_reject_modal:${numericId}` : `hgw_reject_modal:${numericId}`;
      const modal = new ModalBuilder().setCustomId(modalId).setTitle(`Refuser la preuve #${numericId}`);
      const reasonInput = new TextInputBuilder()
        .setCustomId('reject_reason')
        .setLabel('Motif du refus (visible par le joueur)')
        .setPlaceholder('Ex: Screenshot coupé, score non visible, mauvais mode de jeu...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput));
      await interaction.showModal(modal);
    }
  }

  private async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const [prefix, rawId] = (interaction.customId || '').split(':');
    if (prefix !== 'hgw_reject_modal' && prefix !== 'hgw_feat_reject_modal') return;

    if (!this.isDiscordUserAdmin(interaction.user.id, interaction.memberPermissions)) {
      await interaction.reply({ content: '⛔ Action réservée aux admins.', ephemeral: true });
      return;
    }

    const numericId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(numericId)) return;
    const reason = interaction.fields.getTextInputValue('reject_reason')?.trim() || 'Preuve non conforme';

    let updated: { display_name?: string };
    try {
      updated =
        prefix === 'hgw_feat_reject_modal'
          ? reviewFeaturedSubmission(this.db, {
              submissionId: numericId,
              action: 'reject',
              reviewerId: interaction.user.username,
              rejectReason: reason,
            })
          : reviewDailyAssignment(this.db, {
              assignmentId: numericId,
              action: 'reject',
              reviewerId: interaction.user.username,
              rejectReason: reason,
            });
    } catch (err: unknown) {
      if (interaction.message) {
        await interaction.message.edit({ components: [] }).catch(() => {});
      }
      await interaction.reply({ content: `ℹ️ ${errorMessage(err)}`, ephemeral: true });
      return;
    }

    if (interaction.message) {
      const baseEmbed = interaction.message.embeds[0]
        ? EmbedBuilder.from(interaction.message.embeds[0])
        : new EmbedBuilder().setTitle(`Preuve #${numericId}`);
      const rejectedEmbed = baseEmbed
        .setColor(0xef4444)
        .addFields({ name: '❌ Motif du refus', value: reason.slice(0, 1000) })
        .setFooter({ text: `❌ Refusé par ${interaction.user.username} (le joueur peut re-soumettre)` });
      await interaction.message.edit({ embeds: [rejectedEmbed], components: [] }).catch(() => {});
    }

    this.onStateChanged?.(`Preuve #${numericId} mise à jour`);
    await interaction.reply({
      content: `❌ Preuve #${numericId} de **${updated.display_name || 'Joueur'}** refusée (${reason}).`,
      ephemeral: true,
    });
  }

  /**
   * Poste un embed dans `#preuves` pour un défi quotidien.
   */
  public async notifyProofSubmitted(assignment: DailyAssignmentDetailRow): Promise<string | null> {
    const channelId = process.env.DISCORD_PROOFS_CHANNEL_ID?.trim();
    if (!this.client || !this.isReady || !channelId) return null;

    try {
      const channel = (await this.client.channels.fetch(channelId)) as TextChannel | null;
      if (!channel || !channel.isTextBased()) return null;

      const diffNames: Record<string, string> = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile' };
      const diffLabel = `${diffNames[assignment.difficulty] || assignment.difficulty} (${assignment.points} pts)`;

      const embed = new EmbedBuilder()
        .setTitle(`${assignment.game_emoji} Preuve Défi #${assignment.id} — ${assignment.title}`)
        .setColor(0xf59e0b)
        .addFields(
          { name: 'Joueur', value: `**${assignment.display_name || 'Joueur'}**`, inline: true },
          { name: 'Jeu', value: assignment.game_name, inline: true },
          { name: 'Difficulté & Points', value: `**${diffLabel}**`, inline: true },
          { name: 'Objectif', value: assignment.description }
        )
        .setTimestamp();

      if (assignment.proof_note) embed.addFields({ name: 'Commentaire du joueur', value: assignment.proof_note });
      if (assignment.proof_url) embed.addFields({ name: '🔗 Lien externe', value: assignment.proof_url });

      const files: AttachmentBuilder[] = [];
      if (assignment.proof_file) {
        const fullPath = path.join(this.proofsDir, assignment.proof_file);
        files.push(new AttachmentBuilder(fullPath, { name: assignment.proof_file }));
        if (/\.(png|jpe?g|webp|gif)$/i.test(assignment.proof_file)) {
          embed.setImage(`attachment://${assignment.proof_file}`);
        }
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`hgw_approve:${assignment.id}`)
          .setLabel(`Valider (+${assignment.points} pts)`)
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`hgw_reject:${assignment.id}`)
          .setLabel('Refuser (avec motif)')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger)
      );

      const sent = await channel.send({ embeds: [embed], files, components: [row] });
      this.db.prepare(`UPDATE daily_assignments SET discord_message_id = ? WHERE id = ?`).run(sent.id, assignment.id);
      return sent.id;
    } catch (err: unknown) {
      console.error('⚠️ [Discord Bot] Échec envoi embed #preuves:', errorMessage(err));
      return null;
    }
  }

  /**
   * Poste un embed dans `#preuves` pour une preuve Jeu Vedette (connecteur standard).
   */
  public async notifyFeaturedProofSubmitted(sub: FeaturedSubmissionDetailRow): Promise<string | null> {
    const channelId = process.env.DISCORD_PROOFS_CHANNEL_ID?.trim();
    if (!this.client || !this.isReady || !channelId) return null;

    try {
      const channel = (await this.client.channels.fetch(channelId)) as TextChannel | null;
      if (!channel || !channel.isTextBased()) return null;

      const cfg = getEventConfig(this.db).featured;
      const valStr = formatMetricValue(Number(sub.metric_value), cfg.metric_type, cfg.metric_unit);

      const embed = new EmbedBuilder()
        .setTitle(`⭐ Preuve ${cfg.title} #${sub.id} — ${sub.item_code} · ${sub.item_name}`)
        .setColor(0x4cb8f7)
        .addFields(
          { name: 'Joueur', value: `**${sub.display_name}**`, inline: true },
          { name: 'Type', value: sub.is_ladder ? cfg.ladder_title : cfg.stages_title, inline: true },
          { name: 'Résultat déclaré', value: `**${valStr}**`, inline: true }
        )
        .setTimestamp();

      if (sub.item_description) embed.addFields({ name: 'Épreuve', value: sub.item_description });
      if (sub.proof_note) embed.addFields({ name: 'Commentaire du joueur', value: sub.proof_note });
      if (sub.proof_url) embed.addFields({ name: '🔗 Lien externe', value: sub.proof_url });

      const files: AttachmentBuilder[] = [];
      if (sub.proof_file) {
        const fullPath = path.join(this.proofsDir, sub.proof_file);
        files.push(new AttachmentBuilder(fullPath, { name: sub.proof_file }));
        if (/\.(png|jpe?g|webp|gif)$/i.test(sub.proof_file)) {
          embed.setImage(`attachment://${sub.proof_file}`);
        }
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`hgw_feat_approve:${sub.id}`)
          .setLabel(sub.points_awarded > 0 ? `Valider (+${sub.points_awarded} pts)` : 'Valider')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`hgw_feat_reject:${sub.id}`)
          .setLabel('Refuser (avec motif)')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger)
      );

      const sent = await channel.send({ embeds: [embed], files, components: [row] });
      this.db.prepare(`UPDATE featured_submissions SET discord_message_id = ? WHERE id = ?`).run(sent.id, sub.id);
      return sent.id;
    } catch (err: unknown) {
      console.error('⚠️ [Discord Bot] Échec envoi embed vedette #preuves:', errorMessage(err));
      return null;
    }
  }

  public async announceTeams(tournament: TournamentRow, teams: AnnouncedTeam[]): Promise<boolean> {
    const channelId =
      process.env.DISCORD_ANNOUNCE_CHANNEL_ID?.trim() || process.env.DISCORD_PROOFS_CHANNEL_ID?.trim();
    if (!this.client || !this.isReady || !channelId) return false;

    try {
      const channel = (await this.client.channels.fetch(channelId)) as TextChannel | null;
      if (!channel || !channel.isTextBased()) return false;

      const embed = new EmbedBuilder()
        .setTitle(`${tournament.emoji || '🏆'} Tirage Officiel des Équipes — ${tournament.name}`)
        .setColor(0x10b981)
        .setDescription(
          'Les équipes ont été tirées au sort en direct via le système d’équilibrage par **Chapeaux (Pool 1 / 2 / 3)** !'
        )
        .setTimestamp();

      const visibleTeams = teams.slice(0, 24);
      for (const t of visibleTeams) {
        const list = t.members.map((m) => `• **${m.display_name}** *(Chapeau ${m.pool})*`).join('\n');
        embed.addFields({
          name: `${t.teamName} (Moy. Chapeau ${t.averagePool})`,
          value: list || 'Aucun joueur',
          inline: true,
        });
      }
      if (teams.length > visibleTeams.length) {
        embed.addFields({
          name: 'Autres équipes',
          value: `+${teams.length - visibleTeams.length} équipe(s) supplémentaire(s) visibles sur le site.`,
          inline: false,
        });
      }

      await channel.send({ embeds: [embed] });
      return true;
    } catch (err: unknown) {
      console.error('⚠️ [Discord Bot] Échec annonce équipes:', errorMessage(err));
      return false;
    }
  }
}
