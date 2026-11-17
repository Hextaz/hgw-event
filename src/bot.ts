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
  type TextChannel,
} from 'discord.js';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  drawDailyQuestsForUser,
  getGlobalLeaderboard,
  reviewDailyAssignment,
  TOMBOLA_POINTS_THRESHOLD,
} from './engine.js';

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
      } catch (err: any) {
        console.error('❌ [Discord Bot] Erreur interaction:', err);
        const msg = err?.message || 'Une erreur interne est survenue.';
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `❌ ${msg}`, ephemeral: true }).catch(() => {});
        }
      }
    });

    try {
      await this.client.login(token);
    } catch (err: any) {
      console.error('⚠️ [Discord Bot] Échec de connexion Discord:', err?.message || err);
    }
  }

  private async registerSlashCommands(token: string, clientId: string): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID?.trim();
    if (!guildId) return;

    const commands = [
      new SlashCommandBuilder()
        .setName('defis')
        .setDescription('Affiche vos 3 défis quotidiens HGW du jour et leur statut'),
      new SlashCommandBuilder()
        .setName('classement')
        .setDescription('Affiche le Top 10 général de la Hextaz Games Week'),
      new SlashCommandBuilder()
        .setName('profil')
        .setDescription('Affiche votre récapitulatif de points (Async / Live / Tombola)'),
    ].map((c) => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('⚡ [Discord Bot] Slash commands (/defis, /classement, /profil) enregistrées.');
    } catch (err: any) {
      console.error('⚠️ [Discord Bot] Impossible d’enregistrer les slash commands:', err?.message || err);
    }
  }

  private isDiscordUserAdmin(userId: string, memberPermissions?: Readonly<any>): boolean {
    const adminIds = (process.env.ADMIN_DISCORD_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (adminIds.includes(userId)) return true;

    const dbUser = this.db.prepare(`SELECT is_admin FROM users WHERE id = ?`).get(userId) as
      | { is_admin: number }
      | undefined;
    if (dbUser?.is_admin === 1) return true;

    if (memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
    return false;
  }

  private async handleSlashCommand(interaction: any): Promise<void> {
    const baseUrl = process.env.BASE_URL || 'https://hgw.hextaz.dev';

    if (interaction.commandName === 'classement') {
      const lb = getGlobalLeaderboard(this.db).slice(0, 10);
      if (lb.length === 0) {
        await interaction.reply({ content: 'Aucun joueur classé pour le moment !', ephemeral: true });
        return;
      }

      const lines = lb.map((p: any, i: number) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`#${i + 1}\``;
        const ticket = p.tombola_eligible ? '🎟️' : '';
        return `${medal} **${p.display_name}** — **${p.total_points} pts** *(Async: ${p.async_points} | Live: ${p.live_points})* ${ticket}`;
      });

      const embed = new EmbedBuilder()
        .setTitle('🏆 Classement Général — Hextaz Games Week')
        .setColor(0xf59e0b)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Ticket Tombola dès ${TOMBOLA_POINTS_THRESHOLD} pts • ${baseUrl}` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (interaction.commandName === 'defis') {
      const quests = drawDailyQuestsForUser(this.db, interaction.user.id);
      if (quests.length === 0) {
        await interaction.reply({
          content: `🎮 Vous n'avez pas encore configuré vos jeux (min. 4 requis) ! Rendez-vous sur **${baseUrl}** pour générer vos 3 défis du jour.`,
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
        (q: any) =>
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
      const me = lb.find((u: any) => u.id === interaction.user.id);
      if (!me) {
        await interaction.reply({
          content: `Connectez-vous une première fois sur **${baseUrl}** pour créer votre profil HGW !`,
          ephemeral: true,
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`👤 Profil HGW — ${me.display_name}`)
        .setColor(0x3b82f6)
        .addFields(
          { name: 'Rang Général', value: `#${me.rank} / ${lb.length}`, inline: true },
          { name: 'Points Totaux', value: `**${me.total_points} pts**`, inline: true },
          {
            name: 'Ticket Tombola (300 pts)',
            value: me.tombola_eligible ? '🎟️ **Qualifié !**' : `⏳ ${me.total_points}/${TOMBOLA_POINTS_THRESHOLD} pts`,
            inline: true,
          },
          { name: 'Points Semaine (Async)', value: `${me.async_points} pts`, inline: true },
          { name: 'Points Week-end (Live)', value: `${me.live_points} pts`, inline: true },
          { name: 'Défis Validés / Médailles TM', value: `${me.quests_validated} défis • ${me.tmnf_medals_count}/8 maps`, inline: true }
        )
        .setFooter({ text: baseUrl });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  private async handleButtonInteraction(interaction: any): Promise<void> {
    const [prefix, rawId] = (interaction.customId || '').split(':');
    if (prefix !== 'hgw_approve' && prefix !== 'hgw_reject') return;

    if (!this.isDiscordUserAdmin(interaction.user.id, interaction.memberPermissions)) {
      await interaction.reply({
        content: '⛔ Seuls les administrateurs HGW peuvent valider ou refuser une preuve.',
        ephemeral: true,
      });
      return;
    }

    const assignmentId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(assignmentId)) return;

    if (prefix === 'hgw_approve') {
      const updated = reviewDailyAssignment(this.db, {
        assignmentId,
        action: 'approve',
        reviewerId: interaction.user.username,
      });

      const approvedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0x10b981)
        .setFooter({
          text: `✅ Validé par ${interaction.user.username} (+${updated.points} pts crédités)`,
        });

      await interaction.update({
        embeds: [approvedEmbed],
        components: [],
      });
      this.onStateChanged?.(`✅ ${updated.display_name} a validé "${updated.title}" (+${updated.points} pts)`);
      return;
    }

    if (prefix === 'hgw_reject') {
      const modal = new ModalBuilder()
        .setCustomId(`hgw_reject_modal:${assignmentId}`)
        .setTitle(`Refuser la preuve #${assignmentId}`);

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

  private async handleModalSubmit(interaction: any): Promise<void> {
    const [prefix, rawId] = (interaction.customId || '').split(':');
    if (prefix !== 'hgw_reject_modal') return;

    if (!this.isDiscordUserAdmin(interaction.user.id, interaction.memberPermissions)) {
      await interaction.reply({ content: '⛔ Action réservée aux admins.', ephemeral: true });
      return;
    }

    const assignmentId = Number.parseInt(rawId, 10);
    const reason = interaction.fields.getTextInputValue('reject_reason')?.trim() || 'Preuve non conforme';

    const updated = reviewDailyAssignment(this.db, {
      assignmentId,
      action: 'reject',
      reviewerId: interaction.user.username,
      rejectReason: reason,
    });

    if (interaction.message) {
      const rejectedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0xef4444)
        .addFields({ name: '❌ Motif du refus', value: reason })
        .setFooter({
          text: `❌ Refusé par ${interaction.user.username} (le joueur peut re-soumettre)`,
        });

      await interaction.message.edit({
        embeds: [rejectedEmbed],
        components: [],
      });
    }

    this.onStateChanged?.(`Preuve #${assignmentId} mise à jour`);
    await interaction.reply({
      content: `❌ Preuve #${assignmentId} de **${updated.display_name}** refusée (${reason}).`,
      ephemeral: true,
    });
  }

  /**
   * Poste un embed dans `#preuves` avec les boutons `[ ✅ Valider (+XX pts) ]` et `[ ❌ Refuser ]` (Section 4.4).
   */
  public async notifyProofSubmitted(assignment: any): Promise<string | null> {
    const channelId = process.env.DISCORD_PROOFS_CHANNEL_ID?.trim();
    if (!this.client || !this.isReady || !channelId) return null;

    try {
      const channel = (await this.client.channels.fetch(channelId)) as TextChannel | null;
      if (!channel || !channel.isTextBased()) return null;

      const diffLabel =
        assignment.difficulty === 'easy'
          ? 'Facile (15 pts)'
          : assignment.difficulty === 'medium'
          ? 'Moyen (25 pts)'
          : 'Difficile (40 pts)';

      const embed = new EmbedBuilder()
        .setTitle(`${assignment.game_emoji} Preuve Défi #${assignment.id} — ${assignment.title}`)
        .setColor(0xf59e0b)
        .addFields(
          { name: 'Joueur', value: `**${assignment.display_name}**`, inline: true },
          { name: 'Jeu', value: assignment.game_name, inline: true },
          { name: 'Difficulté & Points', value: `**${diffLabel}**`, inline: true },
          { name: 'Objectif', value: assignment.description }
        )
        .setTimestamp();

      if (assignment.proof_note) {
        embed.addFields({ name: 'Commentaire du joueur', value: assignment.proof_note });
      }
      if (assignment.proof_url) {
        embed.addFields({ name: '🔗 Lien externe', value: assignment.proof_url });
      }

      const files: AttachmentBuilder[] = [];
      if (assignment.proof_file) {
        const fullPath = path.join(this.proofsDir, assignment.proof_file);
        const attachment = new AttachmentBuilder(fullPath, { name: assignment.proof_file });
        files.push(attachment);
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
      this.db
        .prepare(`UPDATE daily_assignments SET discord_message_id = ? WHERE id = ?`)
        .run(sent.id, assignment.id);
      return sent.id;
    } catch (err: any) {
      console.error('⚠️ [Discord Bot] Échec envoi embed #preuves:', err?.message || err);
      return null;
    }
  }

  /**
   * Publie les équipes tirées au sort par Chapeaux dans le salon Discord d'annonces (Section 4.2).
   */
  public async announceTeams(tournament: any, teams: any[]): Promise<boolean> {
    const channelId =
      process.env.DISCORD_ANNOUNCE_CHANNEL_ID?.trim() || process.env.DISCORD_PROOFS_CHANNEL_ID?.trim();
    if (!this.client || !this.isReady || !channelId) return false;

    try {
      const channel = (await this.client.channels.fetch(channelId)) as TextChannel | null;
      if (!channel || !channel.isTextBased()) return false;

      const embed = new EmbedBuilder()
        .setTitle(`${tournament.emoji} Tirage Officiel des Équipes — ${tournament.name}`)
        .setColor(0x10b981)
        .setDescription(
          'Les équipes ont été tirées au sort en direct via le système d’équilibrage par **Chapeaux (Pool 1 / 2 / 3)** !'
        )
        .setTimestamp();

      for (const t of teams) {
        const list = t.members
          .map((m: any) => `• **${m.display_name}** *(Chapeau ${m.pool})*`)
          .join('\n');
        embed.addFields({
          name: `${t.teamName} (Moy. Chapeau ${t.averagePool})`,
          value: list || 'Aucun joueur',
          inline: true,
        });
      }

      await channel.send({ embeds: [embed] });
      return true;
    } catch (err: any) {
      console.error('⚠️ [Discord Bot] Échec annonce équipes:', err?.message || err);
      return false;
    }
  }
}
