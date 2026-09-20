'use strict';

/**
 * Welcome + Autorole + Role Panels bot.
 * Everything is configured from /panel (Components V2 control panel).
 * Only the owners can open the panel. The main owner manages the extra owners from the panel itself.
 *
 * Env vars:
 *   DISCORD_TOKEN  (required)
 *   DATA_DIR       (optional, default ./data). On Railway: mount a volume on /data and set DATA_DIR=/data
 *   GUILD_ID       (optional) registers /panel instantly in one server while testing
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThumbnailBuilder,
  UserSelectMenuBuilder,
  escapeMarkdown,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}

/* ========================================================================== */
/*  DATABASE (JSON file)                                                      */
/* ========================================================================== */

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_PANELS = 15;

// The one and only main owner. Only this user can add or remove other owners.
const MAIN_OWNER_ID = '1278794685367975948';
const MAX_OWNERS = 20;

const DEFAULTS = {
  welcome: {
    enabled: false,
    channelId: null,
    title: 'Welcome',
    message: 'Welcome to **{server}**, {user}.\nYou are member **#{count}**.',
    imageUrl: null,
    showAvatar: true,
    dm: false,
    ping: true,
  },
  autorole: {
    enabled: false,
    roles: [],
    botRoles: [],
  },
};

let db = { guilds: {}, owners: [] };
let saveTimer = null;

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.guilds ??= {};
    db.owners ??= [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[db] Could not read the database, keeping a backup and starting fresh:', err.message);
      try { fs.copyFileSync(DB_FILE, `${DB_FILE}.corrupt`); } catch { /* ignore */ }
    }
    db = { guilds: {}, owners: [] };
  }
  console.log(`[db] Using ${DB_FILE}`);
}

function flushDb() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = `${DB_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[db] Failed to write the database:', err);
  }
}

/** Debounced, atomic write. */
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(flushDb, 300);
}

/** Returns the (mutable) config of a guild, filling in any missing defaults. */
function getGuild(id) {
  const g = (db.guilds[id] ??= {});
  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    g[section] ??= {};
    for (const [key, value] of Object.entries(defaults)) {
      g[section][key] ??= structuredClone(value);
    }
  }
  g.panels ??= {};
  return g;
}

const isMainOwner = (userId) => userId === MAIN_OWNER_ID;
const isOwner = (userId) => isMainOwner(userId) || db.owners.includes(userId);

/* ========================================================================== */
/*  HELPERS                                                                   */
/* ========================================================================== */

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Replaces the welcome placeholders. */
function fill(template, member) {
  return template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', escapeMarkdown(member.user.username))
    .replaceAll('{server}', escapeMarkdown(member.guild.name))
    .replaceAll('{count}', String(member.guild.memberCount));
}

/** Returns a readable reason if the bot cannot hand out this role, otherwise null. */
function roleIssue(guild, roleId) {
  const role = guild.roles.cache.get(roleId);
  const me = guild.members.me;
  if (!role) return 'role no longer exists';
  if (role.id === guild.id) return '@everyone cannot be assigned';
  if (role.managed) return 'managed by an integration';
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return 'I am missing the Manage Roles permission';
  if (role.position >= me.roles.highest.position) return 'above my highest role';
  return null;
}

/** Drops @everyone and integration-managed roles from a selection. */
function filterRoles(guild, ids) {
  const kept = ids.filter((id) => {
    const role = guild.roles.cache.get(id);
    return role && role.id !== guild.id && !role.managed;
  });
  return { kept, dropped: ids.length - kept.length };
}

/* ========================================================================== */
/*  UI BUILDING BLOCKS                                                        */
/* ========================================================================== */

// Containers are created without an accent colour on purpose: no side border.
const text = (content) => new TextDisplayBuilder().setContent(content);
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const view = (...containers) => ({ components: containers, flags: MessageFlags.IsComponentsV2 });
const row = (...components) => new ActionRowBuilder().addComponents(...components);

const button = (id, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

const section = (content, accessory) =>
  new SectionBuilder().addTextDisplayComponents(text(content)).setButtonAccessory(accessory);

const enableButton = (id, enabled) =>
  button(id, enabled ? 'Disable' : 'Enable', enabled ? ButtonStyle.Secondary : ButtonStyle.Primary);

const onOff = (value) => (value ? 'On' : 'Off');
const status = (value) => (value ? 'Enabled' : 'Disabled');

const roleList = (guild, ids) => {
  const valid = ids.filter((id) => guild.roles.cache.has(id));
  return valid.length ? valid.map((id) => `<@&${id}>`).join(' ') : 'None';
};

const header = (title, subtitle, notice) => {
  const c = new ContainerBuilder().addTextDisplayComponents(text(`## ${title}\n-# ${subtitle}`));
  if (notice) c.addTextDisplayComponents(text(`> ${notice}`));
  return c.addSeparatorComponents(divider());
};

const backRow = (target = 'p:home') => row(button(target, 'Back'));

function roleSelect(id, placeholder, selected, guild) {
  const menu = new RoleSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder)
    .setMinValues(0)
    .setMaxValues(25);
  const valid = selected.filter((r) => guild.roles.cache.has(r));
  if (valid.length) menu.setDefaultRoles(...valid);
  return menu;
}

function channelSelect(id, placeholder, selected, guild) {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (selected && guild.channels.cache.has(selected)) menu.setDefaultChannels(selected);
  return menu;
}

function channelIssue(guild, channelId) {
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return 'The selected channel no longer exists.';
  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return `I cannot send messages in <#${channel.id}>.`;
  }
  return null;
}

function roleIssues(guild, ids) {
  return ids
    .map((id) => [id, roleIssue(guild, id)])
    .filter(([, issue]) => issue && issue !== 'role no longer exists')
    .map(([id, issue]) => `-# <@&${id}>: ${issue}`);
}

/* ========================================================================== */
/*  VIEWS                                                                     */
/* ========================================================================== */

const viewNotice = (message) => view(new ContainerBuilder().addTextDisplayComponents(text(message)));

/* ------------------------------- Home ------------------------------------- */

function viewHome(guild, userId) {
  const g = getGuild(guild.id);
  const { welcome: w, autorole: a } = g;
  const panels = Object.values(g.panels);
  const published = panels.filter((p) => p.published).length;
  const roleCount = a.roles.length + a.botRoles.length;

  const c = new ContainerBuilder().addTextDisplayComponents(
    text(`## Control Panel\n-# ${escapeMarkdown(guild.name)}`),
  );

  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    c.addTextDisplayComponents(
      text('> I am missing the **Manage Roles** permission. Autorole and role panels will not work until it is granted.'),
    );
  }

  c.addSeparatorComponents(divider());
  c.addSectionComponents(
    section(
      `**Welcome**\n${status(w.enabled)} · ${w.channelId ? `<#${w.channelId}>` : 'No channel'}`,
      button('p:wel', 'Configure'),
    ),
  );
  c.addSectionComponents(
    section(
      `**Autorole**\n${status(a.enabled)} · ${roleCount} ${roleCount === 1 ? 'role' : 'roles'}`,
      button('p:auto', 'Configure'),
    ),
  );
  c.addSectionComponents(
    section(
      `**Role Panels**\n${panels.length} ${panels.length === 1 ? 'panel' : 'panels'} · ${published} published`,
      button('p:rp', 'Configure'),
    ),
  );
  if (isMainOwner(userId)) {
    c.addSectionComponents(
      section(
        `**Owners**\n${db.owners.length} additional ${db.owners.length === 1 ? 'owner' : 'owners'}`,
        button('p:own', 'Configure'),
      ),
    );
  }
  c.addSeparatorComponents(divider());
  c.addTextDisplayComponents(text('-# Every change is saved automatically.'));
  return view(c);
}

/* ------------------------------- Owners ----------------------------------- */

function viewOwners(guild, message) {
  const c = header('Owners', 'Owners can use the control panel. Only you can change this list.', message);

  c.addTextDisplayComponents(text(`**Main owner**\n<@${MAIN_OWNER_ID}>`));
  c.addTextDisplayComponents(
    text(`**Additional owners**\n${db.owners.length ? db.owners.map((id) => `<@${id}>`).join(' ') : 'None'}`),
  );

  c.addActionRowComponents(
    row(
      new UserSelectMenuBuilder()
        .setCustomId('p:own:add')
        .setPlaceholder('Add owners')
        .setMinValues(1)
        .setMaxValues(5),
    ),
  );

  if (db.owners.length) {
    c.addActionRowComponents(
      row(
        new StringSelectMenuBuilder()
          .setCustomId('p:own:remove')
          .setPlaceholder('Remove an owner')
          .addOptions(
            db.owners.map((id) => ({
              label: truncate(client.users.cache.get(id)?.username ?? id, 100),
              value: id,
              description: id,
            })),
          ),
      ),
    );
  }

  c.addSeparatorComponents(divider());
  c.addActionRowComponents(backRow());
  return view(c);
}

/* ------------------------------ Welcome ----------------------------------- */

/** The actual welcome card sent to new members. */
function welcomeContainer(member, w) {
  const c = new ContainerBuilder();

  if (w.imageUrl) {
    c.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(w.imageUrl)),
    );
  }

  const body = `${w.title ? `## ${fill(w.title, member)}\n` : ''}${fill(w.message, member)}`;

  if (w.showAvatar) {
    c.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(body))
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(member.displayAvatarURL({ extension: 'png', size: 256 })),
        ),
    );
  } else {
    c.addTextDisplayComponents(text(body));
  }
  return c;
}

const viewWelcomeMessage = (member, w) => view(welcomeContainer(member, w));

const viewWelcomePreview = (member, w) => ({
  components: [text('-# Preview: this is how the message will look.'), welcomeContainer(member, w)],
  flags: MessageFlags.IsComponentsV2,
});

function viewWelcome(guild, message) {
  const w = getGuild(guild.id).welcome;
  const c = header('Welcome', 'Greet new members with a message in the channel of your choice.', message);

  c.addSectionComponents(section(`**Status**\n${status(w.enabled)}`, enableButton('p:wel:toggle', w.enabled)));

  const warning = channelIssue(guild, w.channelId);
  c.addTextDisplayComponents(
    text(`**Channel**\n${w.channelId ? `<#${w.channelId}>` : 'Not set'}${warning ? `\n-# ${warning}` : ''}`),
  );
  c.addActionRowComponents(row(channelSelect('p:wel:channel', 'Select a channel', w.channelId, guild)));

  c.addSeparatorComponents(divider());

  const quoted = truncate(w.message, 300)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  c.addTextDisplayComponents(
    text(
      `**Message**\n${w.title ? `-# Title: ${truncate(w.title, 80)}\n` : ''}${quoted}\n` +
        `-# Banner: ${w.imageUrl ? 'Set' : 'None'} · Placeholders: {user} {username} {server} {count}`,
    ),
  );
  c.addActionRowComponents(
    row(
      button('p:wel:edit', 'Edit Message', ButtonStyle.Primary),
      button('p:wel:avatar', `Avatar: ${onOff(w.showAvatar)}`),
      button('p:wel:dm', `DM: ${onOff(w.dm)}`),
      button('p:wel:ping', `Ping: ${onOff(w.ping)}`),
      button('p:wel:preview', 'Preview'),
    ),
  );

  c.addSeparatorComponents(divider());
  c.addActionRowComponents(backRow());
  return view(c);
}

/* ------------------------------ Autorole ---------------------------------- */

function viewAutorole(guild, message) {
  const a = getGuild(guild.id).autorole;
  const c = header('Autorole', 'Assign roles automatically as soon as someone joins.', message);

  c.addSectionComponents(section(`**Status**\n${status(a.enabled)}`, enableButton('p:auto:toggle', a.enabled)));

  c.addTextDisplayComponents(text(`**Member roles**\n${roleList(guild, a.roles)}`));
  c.addActionRowComponents(row(roleSelect('p:auto:roles', 'Select roles for new members', a.roles, guild)));

  c.addTextDisplayComponents(text(`**Bot roles**\n${roleList(guild, a.botRoles)}`));
  c.addActionRowComponents(row(roleSelect('p:auto:bots', 'Select roles for new bots', a.botRoles, guild)));

  const issues = roleIssues(guild, [...a.roles, ...a.botRoles]);
  if (issues.length) c.addTextDisplayComponents(text(issues.join('\n')));

  c.addSeparatorComponents(divider());
  c.addActionRowComponents(backRow());
  return view(c);
}

/* -------------------------- Role panels: management ------------------------ */

const styleName = (p) => (p.style === 'select' ? 'Dropdown' : 'Buttons');

function viewPanelList(guild, message) {
  const panels = Object.values(getGuild(guild.id).panels);
  const c = header('Role Panels', 'Let members pick their own roles with buttons or a dropdown.', message);

  if (!panels.length) {
    c.addTextDisplayComponents(text('No role panels yet. Create your first one below.'));
  } else {
    c.addTextDisplayComponents(
      text(
        panels
          .map(
            (p) =>
              `**${escapeMarkdown(p.name)}**\n-# ${p.roles.length} ${p.roles.length === 1 ? 'role' : 'roles'} · ${styleName(p)} · ` +
              (p.published ? `Published in <#${p.published.channelId}>` : 'Not published'),
          )
          .join('\n\n'),
      ),
    );
    c.addActionRowComponents(
      row(
        new StringSelectMenuBuilder()
          .setCustomId('p:rp:pick')
          .setPlaceholder('Select a panel to edit')
          .addOptions(
            panels.map((p) => ({
              label: truncate(p.name, 100),
              value: p.id,
              description: `${p.roles.length} ${p.roles.length === 1 ? 'role' : 'roles'} · ${styleName(p)}`,
            })),
          ),
      ),
    );
  }

  c.addSeparatorComponents(divider());
  c.addActionRowComponents(row(button('p:rp:new', 'New Panel', ButtonStyle.Primary), button('p:home', 'Back')));
  return view(c);
}

function viewPanelEdit(guild, id, message) {
  const p = getGuild(guild.id).panels[id];
  if (!p) return viewPanelList(guild, 'That panel no longer exists.');

  const c = header(escapeMarkdown(p.name), 'Role panel', message);

  const link = p.published
    ? `[Published message](https://discord.com/channels/${guild.id}/${p.published.channelId}/${p.published.messageId})`
    : 'Not published';
  const description = p.description ? truncate(p.description.replace(/\s+/g, ' '), 100) : 'None';
  c.addTextDisplayComponents(
    text(`**Title** ${truncate(p.title, 80)}\n**Description** ${description}\n**Status** ${link}`),
  );

  c.addTextDisplayComponents(text(`**Roles**\n${roleList(guild, p.roles)}`));
  c.addActionRowComponents(row(roleSelect(`p:rp:roles:${p.id}`, 'Select the roles to offer', p.roles, guild)));

  const issues = roleIssues(guild, p.roles);
  if (issues.length) c.addTextDisplayComponents(text(issues.join('\n')));

  const warning = channelIssue(guild, p.channelId);
  const moved = p.published && p.channelId && p.published.channelId !== p.channelId;
  c.addTextDisplayComponents(
    text(
      `**Channel**\n${p.channelId ? `<#${p.channelId}>` : 'Not set'}` +
        `${warning ? `\n-# ${warning}` : ''}${moved ? '\n-# Use Repost to move the panel to this channel.' : ''}`,
    ),
  );
  c.addActionRowComponents(row(channelSelect(`p:rp:chan:${p.id}`, 'Select a channel to publish in', p.channelId, guild)));

  c.addSeparatorComponents(divider());
  c.addActionRowComponents(
    row(
      button(`p:rp:content:${p.id}`, 'Edit Text', ButtonStyle.Primary),
      button(`p:rp:style:${p.id}`, `Style: ${styleName(p)}`),
      button(`p:rp:excl:${p.id}`, `Mode: ${p.exclusive ? 'Exclusive' : 'Multiple'}`),
    ),
  );
  c.addActionRowComponents(
    row(
      button(`p:rp:pub:${p.id}`, p.published ? 'Repost' : 'Publish', ButtonStyle.Primary),
      button(`p:rp:del:${p.id}`, 'Delete', ButtonStyle.Danger),
      button('p:rp', 'Back'),
    ),
  );
  return view(c);
}

function viewPanelDelete(p) {
  const c = new ContainerBuilder()
    .addTextDisplayComponents(
      text(
        `## Delete panel\nAre you sure you want to delete **${escapeMarkdown(p.name)}**?` +
          `${p.published ? '\nThe published message will be removed as well.' : ''}`,
      ),
    )
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      row(button(`p:rp:delc:${p.id}`, 'Delete', ButtonStyle.Danger), button(`p:rp:e:${p.id}`, 'Cancel')),
    );
  return view(c);
}

/* ------------------------ Role panels: public message ---------------------- */

function viewPublicPanel(guild, p) {
  const roles = p.roles.map((id) => guild.roles.cache.get(id)).filter(Boolean);
  const c = new ContainerBuilder().addTextDisplayComponents(
    text(`## ${p.title}${p.description ? `\n${p.description}` : ''}`),
  );
  c.addSeparatorComponents(divider());

  if (!roles.length) {
    c.addTextDisplayComponents(text('No roles are available right now.'));
  } else if (p.style === 'select') {
    c.addActionRowComponents(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`rg:s:${p.id}`)
          .setPlaceholder(p.exclusive ? 'Choose a role' : 'Choose roles to add or remove')
          .setMinValues(1)
          .setMaxValues(p.exclusive ? 1 : roles.length)
          .addOptions(
            roles.map((r) => ({
              label: truncate(r.name, 100),
              value: r.id,
              ...(r.unicodeEmoji ? { emoji: { name: r.unicodeEmoji } } : {}),
            })),
          ),
      ),
    );
  } else {
    for (let i = 0; i < roles.length; i += 5) {
      c.addActionRowComponents(
        row(
          ...roles.slice(i, i + 5).map((r) => {
            const b = button(`rg:b:${p.id}:${r.id}`, truncate(r.name, 80));
            if (r.unicodeEmoji) b.setEmoji(r.unicodeEmoji);
            return b;
          }),
        ),
      );
    }
  }

  const hint = p.exclusive
    ? 'You can hold one role from this panel at a time.'
    : p.style === 'select'
      ? 'Selecting a role adds it, selecting it again removes it.'
      : 'Press a button to add or remove the role.';
  c.addTextDisplayComponents(text(`-# ${hint}`));
  return view(c);
}

function viewRoleResult({ added, removed, failed }) {
  const lines = [];
  if (added.length) lines.push(`Added ${added.map((id) => `<@&${id}>`).join(' ')}`);
  if (removed.length) lines.push(`Removed ${removed.map((id) => `<@&${id}>`).join(' ')}`);
  for (const f of failed) lines.push(`Could not change <@&${f.id}>: ${f.issue}`);

  const title = added.length || removed.length ? 'Roles updated' : 'No changes made';
  return view(
    new ContainerBuilder().addTextDisplayComponents(text(`**${title}**${lines.length ? `\n${lines.join('\n')}` : ''}`)),
  );
}

/* ========================================================================== */
/*  MODALS                                                                    */
/* ========================================================================== */

function modalField({ id, label, style = TextInputStyle.Short, value, max, required = true, placeholder }) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setRequired(required)
    .setMaxLength(max);
  if (value) input.setValue(value);
  if (placeholder) input.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(input);
}

const modalWelcome = (w) =>
  new ModalBuilder()
    .setCustomId('p:wel:modal')
    .setTitle('Welcome message')
    .addComponents(
      modalField({ id: 'title', label: 'Title', value: w.title, max: 100, required: false, placeholder: 'Welcome' }),
      modalField({
        id: 'message',
        label: 'Message',
        style: TextInputStyle.Paragraph,
        value: w.message,
        max: 1500,
        placeholder: '{user} {username} {server} {count}',
      }),
      modalField({
        id: 'image',
        label: 'Banner image URL (optional)',
        value: w.imageUrl,
        max: 500,
        required: false,
        placeholder: 'https://...',
      }),
    );

const modalNewPanel = () =>
  new ModalBuilder()
    .setCustomId('p:rp:newm')
    .setTitle('New role panel')
    .addComponents(
      modalField({ id: 'name', label: 'Panel name', max: 50, placeholder: 'Colors, Notifications, Pronouns...' }),
    );

const modalPanelContent = (p) =>
  new ModalBuilder()
    .setCustomId(`p:rp:contentm:${p.id}`)
    .setTitle('Panel text')
    .addComponents(
      modalField({ id: 'name', label: 'Internal name', value: p.name, max: 50 }),
      modalField({ id: 'title', label: 'Title shown to members', value: p.title, max: 100 }),
      modalField({
        id: 'description',
        label: 'Description',
        style: TextInputStyle.Paragraph,
        value: p.description,
        max: 1000,
        required: false,
      }),
    );

/* ========================================================================== */
/*  SERVICES                                                                  */
/* ========================================================================== */

// Discord API error codes: Unknown Channel / Unknown Message.
const GONE = new Set([10003, 10008]);
const noPings = { allowedMentions: { parse: [] } };

async function applyAutorole(member) {
  const a = getGuild(member.guild.id).autorole;
  if (!a.enabled) return;

  const wanted = member.user.bot ? a.botRoles : a.roles;
  const ids = wanted.filter((id) => !roleIssue(member.guild, id));
  if (!ids.length) return;

  await member.roles.add(ids, 'Autorole');
}

async function sendWelcome(member) {
  if (member.user.bot) return;
  const w = getGuild(member.guild.id).welcome;
  if (!w.enabled) return;

  const payload = viewWelcomeMessage(member, w);

  if (w.channelId) {
    const channel = member.guild.channels.cache.get(w.channelId);
    if (channel?.isTextBased()) {
      await channel.send({
        ...payload,
        allowedMentions: w.ping ? { users: [member.id] } : { parse: [] },
      });
    }
  }

  if (w.dm) await member.send(payload).catch(() => {}); // DMs may be closed
}

/** Edits the published message in place so it always reflects the saved config. */
async function syncPanel(guild, panel) {
  if (!panel.published) return;
  try {
    const channel = await guild.channels.fetch(panel.published.channelId);
    await channel.messages.edit(panel.published.messageId, { ...viewPublicPanel(guild, panel), ...noPings });
  } catch (err) {
    if (GONE.has(err.code)) {
      panel.published = null;
      saveDb();
    } else {
      console.error(`[panel:${panel.id}] Could not sync the published message:`, err.message);
    }
  }
}

async function removePanelMessage(guild, panel) {
  if (!panel.published) return;
  try {
    const channel = await guild.channels.fetch(panel.published.channelId);
    await channel.messages.delete(panel.published.messageId);
  } catch { /* already gone */ }
  panel.published = null;
}

/** Posts (or reposts) the panel. Returns an error message, or null on success. */
async function publishPanel(guild, panel) {
  if (!panel.channelId) return 'Select a channel first.';
  if (!panel.roles.length) return 'Select at least one role first.';

  const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
  if (!channel?.isTextBased()) return 'That channel is no longer available.';

  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return `I cannot send messages in <#${channel.id}>.`;
  }

  await removePanelMessage(guild, panel);

  try {
    const message = await channel.send({ ...viewPublicPanel(guild, panel), ...noPings });
    panel.published = { channelId: channel.id, messageId: message.id };
    saveDb();
    return null;
  } catch (err) {
    console.error(`[panel:${panel.id}] Publish failed:`, err.message);
    saveDb();
    return 'Discord rejected the message. Check my permissions in that channel.';
  }
}

/**
 * Toggles the picked roles for a member.
 * Exclusive panels allow one role at a time, everything else is a plain toggle.
 */
async function applySelection(member, panel, picked) {
  const guild = member.guild;
  const has = (id) => member.roles.cache.has(id);
  const valid = picked.filter((id) => panel.roles.includes(id));

  const add = new Set();
  const remove = new Set();

  if (panel.exclusive) {
    const target = valid[0];
    if (target) {
      if (has(target)) {
        remove.add(target);
      } else {
        add.add(target);
        for (const id of panel.roles) if (id !== target && has(id)) remove.add(id);
      }
    }
  } else {
    for (const id of valid) (has(id) ? remove : add).add(id);
  }

  const failed = [];
  for (const id of [...add, ...remove]) {
    const issue = roleIssue(guild, id);
    if (issue) {
      failed.push({ id, issue });
      add.delete(id);
      remove.delete(id);
    }
  }

  if (add.size || remove.size) {
    // One single request: the full, final list of roles.
    const next = new Set(member.roles.cache.keys());
    add.forEach((id) => next.add(id));
    remove.forEach((id) => next.delete(id));

    try {
      await member.roles.set([...next], `Role panel: ${panel.name}`);
    } catch (err) {
      console.error(`[panel:${panel.id}] Could not update roles:`, err.message);
      for (const id of [...add, ...remove]) failed.push({ id, issue: 'Discord rejected the change' });
      add.clear();
      remove.clear();
    }
  }

  return { added: [...add], removed: [...remove], failed };
}

/* ========================================================================== */
/*  INTERACTIONS                                                              */
/* ========================================================================== */

const EPHEMERAL = MessageFlags.Ephemeral;
const ephemeral = (v) => ({ ...v, flags: v.flags | EPHEMERAL });

/** Updates the panel message, whether or not the interaction was already deferred. */
const respond = (i, v) => (i.deferred || i.replied ? i.editReply(v) : i.update(v));

const denied = () => ephemeral(viewNotice('Only the bot owners can use this panel.'));

async function routeInteraction(i) {
  if (i.isChatInputCommand()) return onCommand(i);

  if (i.isMessageComponent() || i.isModalSubmit()) {
    const namespace = i.customId.split(':')[0];
    if (namespace === 'p') return onPanel(i);
    if (namespace === 'rg') return onRolePanel(i);
  }
}

async function handleInteraction(i) {
  try {
    await routeInteraction(i);
  } catch (err) {
    console.error('[interaction]', err);
    const v = ephemeral(viewNotice('Something went wrong. Please try again.'));
    try {
      if (i.deferred || i.replied) await i.followUp(v);
      else await i.reply(v);
    } catch { /* nothing more we can do */ }
  }
}

/* -------------------------------- /panel ---------------------------------- */

async function onCommand(i) {
  if (i.commandName !== 'panel') return;
  if (!i.inGuild() || !i.guild) return;
  if (!isOwner(i.user.id)) return i.reply(denied());
  return i.reply(ephemeral(viewHome(i.guild, i.user.id)));
}

/* ------------------------ Control panel (admins only) ---------------------- */

async function onPanel(i) {
  if (!i.inGuild() || !i.guild) return;
  if (!isOwner(i.user.id)) return i.reply(denied());

  const [, area, action, arg] = i.customId.split(':');
  switch (area) {
    case 'wel': return handleWelcome(i, action);
    case 'auto': return handleAutorole(i, action);
    case 'rp': return handleRolePanels(i, action, arg);
    case 'own': return handleOwners(i, action);
    default: return respond(i, viewHome(i.guild, i.user.id));
  }
}

/** Main owner only: add and remove the other owners. */
async function handleOwners(i, action) {
  if (!isMainOwner(i.user.id)) {
    return i.reply(ephemeral(viewNotice('Only the main owner can manage owners.')));
  }
  await i.deferUpdate();

  let notice;
  switch (action) {
    case 'add': {
      const added = [];
      for (const id of i.values) {
        const user = i.users.get(id);
        if (!user || user.bot || isMainOwner(id) || db.owners.includes(id)) continue;
        if (db.owners.length >= MAX_OWNERS) break;
        db.owners.push(id);
        added.push(id);
      }
      notice = added.length
        ? `Added ${added.map((id) => `<@${id}>`).join(' ')}.`
        : 'Nobody was added. Bots, the main owner and existing owners are skipped.';
      break;
    }
    case 'remove': {
      const id = i.values[0];
      db.owners = db.owners.filter((o) => o !== id);
      notice = `Removed <@${id}>.`;
      break;
    }
    default: break;
  }

  saveDb();
  // Load usernames for the "remove" menu.
  await Promise.all(db.owners.map((id) => client.users.fetch(id).catch(() => null)));
  return respond(i, viewOwners(i.guild, notice));
}

async function handleWelcome(i, action) {
  const w = getGuild(i.guildId).welcome;
  let notice;

  switch (action) {
    case 'toggle':
      if (!w.enabled && !w.channelId) {
        notice = 'Select a channel before enabling the welcome message.';
        break;
      }
      w.enabled = !w.enabled;
      break;

    case 'channel': w.channelId = i.values[0]; break;
    case 'avatar': w.showAvatar = !w.showAvatar; break;
    case 'dm': w.dm = !w.dm; break;
    case 'ping': w.ping = !w.ping; break;

    case 'edit': return i.showModal(modalWelcome(w));
    case 'preview': return i.reply(ephemeral(viewWelcomePreview(i.member, w)));

    case 'modal': {
      w.title = i.fields.getTextInputValue('title').trim();
      w.message = i.fields.getTextInputValue('message').trim();
      const image = i.fields.getTextInputValue('image').trim();
      if (!image) {
        w.imageUrl = null;
      } else if (/^https?:\/\/\S+$/i.test(image)) {
        w.imageUrl = image;
      } else {
        w.imageUrl = null;
        notice = 'The banner was ignored: the URL must start with http:// or https://.';
      }
      break;
    }
    default: break;
  }

  saveDb();
  return respond(i, viewWelcome(i.guild, notice));
}

async function handleAutorole(i, action) {
  const a = getGuild(i.guildId).autorole;
  let notice;

  const pick = () => {
    const { kept, dropped } = filterRoles(i.guild, i.values);
    if (dropped) notice = '@everyone and integration-managed roles cannot be assigned, they were skipped.';
    return kept;
  };

  switch (action) {
    case 'toggle':
      if (!a.enabled && !a.roles.length && !a.botRoles.length) {
        notice = 'Select at least one role before enabling autorole.';
        break;
      }
      a.enabled = !a.enabled;
      break;

    case 'roles': a.roles = pick(); break;
    case 'bots': a.botRoles = pick(); break;
    default: break;
  }

  saveDb();
  return respond(i, viewAutorole(i.guild, notice));
}

// Actions that talk to Discord and may take a moment.
const SLOW = new Set(['newm', 'roles', 'style', 'excl', 'contentm', 'pub', 'delc']);
// Actions that need an existing panel.
const NEEDS_PANEL = new Set(['e', 'roles', 'chan', 'content', 'contentm', 'style', 'excl', 'pub', 'del', 'delc']);

async function handleRolePanels(i, action, arg) {
  const g = getGuild(i.guildId);
  const panel = arg ? g.panels[arg] : null;
  let notice;

  if (SLOW.has(action)) await i.deferUpdate();
  if (NEEDS_PANEL.has(action) && !panel) return respond(i, viewPanelList(i.guild, 'That panel no longer exists.'));

  switch (action) {
    case undefined:
      return respond(i, viewPanelList(i.guild));

    case 'new':
      if (Object.keys(g.panels).length >= MAX_PANELS) {
        return respond(i, viewPanelList(i.guild, `You can create up to ${MAX_PANELS} panels.`));
      }
      return i.showModal(modalNewPanel());

    case 'newm': {
      const name = i.fields.getTextInputValue('name').trim();
      const id = crypto.randomBytes(4).toString('hex');
      g.panels[id] = {
        id,
        name,
        title: name,
        description: 'Choose the roles you would like.',
        roles: [],
        style: 'buttons',
        exclusive: false,
        channelId: null,
        published: null,
      };
      saveDb();
      return respond(i, viewPanelEdit(i.guild, id, 'Panel created. Pick its roles and a channel, then publish it.'));
    }

    case 'pick':
      return respond(i, viewPanelEdit(i.guild, i.values[0]));

    case 'e':
      return respond(i, viewPanelEdit(i.guild, panel.id));

    case 'roles': {
      const { kept, dropped } = filterRoles(i.guild, i.values);
      panel.roles = kept;
      if (dropped) notice = '@everyone and integration-managed roles cannot be assigned, they were skipped.';
      saveDb();
      await syncPanel(i.guild, panel);
      break;
    }

    case 'chan':
      panel.channelId = i.values[0];
      saveDb();
      break;

    case 'content':
      return i.showModal(modalPanelContent(panel));

    case 'contentm':
      panel.name = i.fields.getTextInputValue('name').trim();
      panel.title = i.fields.getTextInputValue('title').trim();
      panel.description = i.fields.getTextInputValue('description').trim();
      saveDb();
      await syncPanel(i.guild, panel);
      break;

    case 'style':
      panel.style = panel.style === 'select' ? 'buttons' : 'select';
      saveDb();
      await syncPanel(i.guild, panel);
      break;

    case 'excl':
      panel.exclusive = !panel.exclusive;
      saveDb();
      await syncPanel(i.guild, panel);
      break;

    case 'pub': {
      const error = await publishPanel(i.guild, panel);
      notice = error ?? `Published in <#${panel.published.channelId}>.`;
      break;
    }

    case 'del':
      return respond(i, viewPanelDelete(panel));

    case 'delc':
      await removePanelMessage(i.guild, panel);
      delete g.panels[panel.id];
      saveDb();
      return respond(i, viewPanelList(i.guild, 'Panel deleted.'));

    default:
      return respond(i, viewHome(i.guild, i.user.id));
  }

  return respond(i, viewPanelEdit(i.guild, panel.id, notice));
}

/* ----------------------- Role panels: members click ------------------------ */

const busy = new Set();

async function onRolePanel(i) {
  if (!i.inGuild() || !i.guild) return;

  const [, kind, panelId, roleId] = i.customId.split(':');
  const panel = getGuild(i.guildId).panels[panelId];
  if (!panel) return i.reply(ephemeral(viewNotice('This role panel is no longer available.')));

  // Prevents two overlapping requests from the same member from overwriting each other.
  const key = `${i.guildId}:${i.user.id}`;
  if (busy.has(key)) return i.reply(ephemeral(viewNotice('One moment, your previous request is still running.')));
  busy.add(key);

  try {
    if (kind === 'b') {
      await i.deferReply({ flags: EPHEMERAL });
      const result = await applySelection(i.member, panel, [roleId]);
      await i.editReply(viewRoleResult(result));
    } else {
      await i.deferUpdate();
      const result = await applySelection(i.member, panel, i.values);
      // Re-render the menu so the selection resets and can be used again.
      await i.editReply({ ...viewPublicPanel(i.guild, panel), ...noPings }).catch(() => {});
      await i.followUp(ephemeral(viewRoleResult(result)));
    }
  } finally {
    busy.delete(key);
  }
}

/* ========================================================================== */
/*  BOT                                                                       */
/* ========================================================================== */

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Open the control panel (welcome, autorole and role panels)')
    .setContexts(InteractionContextType.Guild)
    .toJSON(),
];

loadDb();

// Server Members is a privileged intent: enable it in the Developer Portal (Bot > Privileged Gateway Intents).
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Logged in as ${c.user.tag} (${c.guilds.cache.size} servers)`);
  try {
    if (process.env.GUILD_ID) await c.application.commands.set(commands, process.env.GUILD_ID);
    else await c.application.commands.set(commands);
    console.log('[bot] Slash commands registered.');
  } catch (err) {
    console.error('[bot] Could not register slash commands:', err);
  }
});

client.on(Events.InteractionCreate, handleInteraction);

client.on(Events.GuildMemberAdd, async (member) => {
  const results = await Promise.allSettled([applyAutorole(member), sendWelcome(member)]);
  for (const r of results) {
    if (r.status === 'rejected') console.error(`[join:${member.guild.id}]`, r.reason?.message ?? r.reason);
  }
});

// Keep the saved config clean when roles or channels are deleted.
client.on(Events.GuildRoleDelete, async (role) => {
  const g = getGuild(role.guild.id);
  g.autorole.roles = g.autorole.roles.filter((id) => id !== role.id);
  g.autorole.botRoles = g.autorole.botRoles.filter((id) => id !== role.id);
  for (const panel of Object.values(g.panels)) {
    if (!panel.roles.includes(role.id)) continue;
    panel.roles = panel.roles.filter((id) => id !== role.id);
    await syncPanel(role.guild, panel);
  }
  saveDb();
});

client.on(Events.ChannelDelete, (channel) => {
  if (!channel.guildId) return;
  const g = getGuild(channel.guildId);
  if (g.welcome.channelId === channel.id) {
    g.welcome.channelId = null;
    g.welcome.enabled = false;
  }
  for (const panel of Object.values(g.panels)) {
    if (panel.channelId === channel.id) panel.channelId = null;
    if (panel.published?.channelId === channel.id) panel.published = null;
  }
  saveDb();
});

client.on(Events.Error, (err) => console.error('[client]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    flushDb();
    client.destroy();
    process.exit(0);
  });
}

client.login(TOKEN);