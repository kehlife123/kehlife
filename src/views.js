'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  escapeMarkdown,
} = require('discord.js');

const store = require('./store');
const { truncate, fill, roleIssue } = require('./util');

/* -------------------------------------------------------------------------- */
/*  Building blocks                                                           */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Generic                                                                   */
/* -------------------------------------------------------------------------- */

function notice(message) {
  return view(new ContainerBuilder().addTextDisplayComponents(text(message)));
}

/* -------------------------------------------------------------------------- */
/*  Control panel: home                                                       */
/* -------------------------------------------------------------------------- */

function home(guild) {
  const g = store.guild(guild.id);
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
  c.addSeparatorComponents(divider());
  c.addTextDisplayComponents(text('-# Every change is saved automatically.'));
  return view(c);
}

/* -------------------------------------------------------------------------- */
/*  Welcome                                                                   */
/* -------------------------------------------------------------------------- */

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

const welcomeMessage = (member, w) => view(welcomeContainer(member, w));

const welcomePreview = (member, w) => ({
  components: [text('-# Preview: this is how the message will look.'), welcomeContainer(member, w)],
  flags: MessageFlags.IsComponentsV2,
});

function welcome(guild, message) {
  const w = store.guild(guild.id).welcome;
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

/* -------------------------------------------------------------------------- */
/*  Autorole                                                                  */
/* -------------------------------------------------------------------------- */

function autorole(guild, message) {
  const a = store.guild(guild.id).autorole;
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

/* -------------------------------------------------------------------------- */
/*  Role panels: management                                                   */
/* -------------------------------------------------------------------------- */

const styleName = (p) => (p.style === 'select' ? 'Dropdown' : 'Buttons');

function panelList(guild, message) {
  const panels = Object.values(store.guild(guild.id).panels);
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

function panelEdit(guild, id, message) {
  const p = store.guild(guild.id).panels[id];
  if (!p) return panelList(guild, 'That panel no longer exists.');

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

function panelDelete(p) {
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

/* -------------------------------------------------------------------------- */
/*  Role panels: what members see                                             */
/* -------------------------------------------------------------------------- */

function publicPanel(guild, p) {
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

function roleResult({ added, removed, failed }) {
  const lines = [];
  if (added.length) lines.push(`Added ${added.map((id) => `<@&${id}>`).join(' ')}`);
  if (removed.length) lines.push(`Removed ${removed.map((id) => `<@&${id}>`).join(' ')}`);
  for (const f of failed) lines.push(`Could not change <@&${f.id}>: ${f.issue}`);

  const title = added.length || removed.length ? 'Roles updated' : 'No changes made';
  return view(
    new ContainerBuilder().addTextDisplayComponents(text(`**${title}**${lines.length ? `\n${lines.join('\n')}` : ''}`)),
  );
}

module.exports = {
  notice,
  home,
  welcome,
  welcomeMessage,
  welcomePreview,
  autorole,
  panelList,
  panelEdit,
  panelDelete,
  publicPanel,
  roleResult,
};
