'use strict';

const { PermissionFlagsBits, escapeMarkdown } = require('discord.js');

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Replaces the welcome placeholders. */
function fill(template, member) {
  return template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', escapeMarkdown(member.user.username))
    .replaceAll('{server}', escapeMarkdown(member.guild.name))
    .replaceAll('{count}', String(member.guild.memberCount));
}

/** Returns a human readable reason if the bot cannot hand out this role, otherwise null. */
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

module.exports = { truncate, fill, roleIssue, filterRoles };
