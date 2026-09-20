'use strict';

const { PermissionFlagsBits } = require('discord.js');
const store = require('./store');
const views = require('./views');
const { roleIssue } = require('./util');

// Discord API error codes: Unknown Channel / Unknown Message.
const GONE = new Set([10003, 10008]);

/* -------------------------------------------------------------------------- */
/*  Autorole + welcome (on member join)                                       */
/* -------------------------------------------------------------------------- */

async function applyAutorole(member) {
  const a = store.guild(member.guild.id).autorole;
  if (!a.enabled) return;

  const wanted = member.user.bot ? a.botRoles : a.roles;
  const ids = wanted.filter((id) => !roleIssue(member.guild, id));
  if (!ids.length) return;

  await member.roles.add(ids, 'Autorole');
}

async function sendWelcome(member) {
  if (member.user.bot) return;
  const w = store.guild(member.guild.id).welcome;
  if (!w.enabled) return;

  const payload = views.welcomeMessage(member, w);

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

/* -------------------------------------------------------------------------- */
/*  Role panels: publishing                                                   */
/* -------------------------------------------------------------------------- */

const noPings = { allowedMentions: { parse: [] } };

/** Edits the published message in place so it always reflects the saved config. */
async function syncPanel(guild, panel) {
  if (!panel.published) return;
  try {
    const channel = await guild.channels.fetch(panel.published.channelId);
    await channel.messages.edit(panel.published.messageId, { ...views.publicPanel(guild, panel), ...noPings });
  } catch (err) {
    if (GONE.has(err.code)) {
      panel.published = null;
      store.save();
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
    const message = await channel.send({ ...views.publicPanel(guild, panel), ...noPings });
    panel.published = { channelId: channel.id, messageId: message.id };
    store.save();
    return null;
  } catch (err) {
    console.error(`[panel:${panel.id}] Publish failed:`, err.message);
    store.save();
    return 'Discord rejected the message. Check my permissions in that channel.';
  }
}

/* -------------------------------------------------------------------------- */
/*  Role panels: what happens when a member clicks                            */
/* -------------------------------------------------------------------------- */

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

module.exports = { applyAutorole, sendWelcome, syncPanel, removePanelMessage, publishPanel, applySelection };
