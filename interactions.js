'use strict';

const crypto = require('node:crypto');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');

const store = require('./store');
const views = require('./views');
const modals = require('./modals');
const services = require('./services');
const { filterRoles } = require('./util');

const EPHEMERAL = MessageFlags.Ephemeral;
const ephemeral = (v) => ({ ...v, flags: v.flags | EPHEMERAL });

/** Updates the panel message, whether or not the interaction was already deferred. */
const respond = (i, v) => (i.deferred || i.replied ? i.editReply(v) : i.update(v));

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

async function route(i) {
  if (i.isChatInputCommand()) return onCommand(i);

  if (i.isMessageComponent() || i.isModalSubmit()) {
    const namespace = i.customId.split(':')[0];
    if (namespace === 'p') return onPanel(i);
    if (namespace === 'rg') return onRolePanel(i);
  }
}

async function handle(i) {
  try {
    await route(i);
  } catch (err) {
    console.error('[interaction]', err);
    const v = ephemeral(views.notice('Something went wrong. Please try again.'));
    try {
      if (i.deferred || i.replied) await i.followUp(v);
      else await i.reply(v);
    } catch { /* nothing more we can do */ }
  }
}

/* -------------------------------------------------------------------------- */
/*  /panel                                                                    */
/* -------------------------------------------------------------------------- */

const denied = () => ephemeral(views.notice('You need the **Manage Server** permission to use this panel.'));

async function onCommand(i) {
  if (i.commandName !== 'panel') return;
  if (!i.inGuild() || !i.guild) return;
  if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return i.reply(denied());
  return i.reply(ephemeral(views.home(i.guild)));
}

/* -------------------------------------------------------------------------- */
/*  Control panel (admins only)                                               */
/* -------------------------------------------------------------------------- */

async function onPanel(i) {
  if (!i.inGuild() || !i.guild) return;
  if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return i.reply(denied());

  const [, sectionName, action, arg] = i.customId.split(':');
  switch (sectionName) {
    case 'wel': return welcome(i, action);
    case 'auto': return autorole(i, action);
    case 'rp': return rolePanels(i, action, arg);
    default: return respond(i, views.home(i.guild));
  }
}

/* ------------------------------- Welcome ---------------------------------- */

async function welcome(i, action) {
  const w = store.guild(i.guildId).welcome;
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

    case 'edit': return i.showModal(modals.welcome(w));
    case 'preview': return i.reply(ephemeral(views.welcomePreview(i.member, w)));

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

  store.save();
  return respond(i, views.welcome(i.guild, notice));
}

/* ------------------------------- Autorole --------------------------------- */

async function autorole(i, action) {
  const a = store.guild(i.guildId).autorole;
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

  store.save();
  return respond(i, views.autorole(i.guild, notice));
}

/* ----------------------------- Role panels -------------------------------- */

// Actions that talk to Discord and may take a moment.
const SLOW = new Set(['newm', 'roles', 'style', 'excl', 'contentm', 'pub', 'delc']);
// Actions that need an existing panel.
const NEEDS_PANEL = new Set(['e', 'roles', 'chan', 'content', 'contentm', 'style', 'excl', 'pub', 'del', 'delc']);

async function rolePanels(i, action, arg) {
  const g = store.guild(i.guildId);
  const panel = arg ? g.panels[arg] : null;
  let notice;

  if (SLOW.has(action)) await i.deferUpdate();
  if (NEEDS_PANEL.has(action) && !panel) return respond(i, views.panelList(i.guild, 'That panel no longer exists.'));

  switch (action) {
    case undefined:
      return respond(i, views.panelList(i.guild));

    case 'new':
      if (Object.keys(g.panels).length >= store.MAX_PANELS) {
        return respond(i, views.panelList(i.guild, `You can create up to ${store.MAX_PANELS} panels.`));
      }
      return i.showModal(modals.newPanel());

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
      store.save();
      return respond(i, views.panelEdit(i.guild, id, 'Panel created. Pick its roles and a channel, then publish it.'));
    }

    case 'pick':
      return respond(i, views.panelEdit(i.guild, i.values[0]));

    case 'e':
      return respond(i, views.panelEdit(i.guild, panel.id));

    case 'roles': {
      const { kept, dropped } = filterRoles(i.guild, i.values);
      panel.roles = kept;
      if (dropped) notice = '@everyone and integration-managed roles cannot be assigned, they were skipped.';
      store.save();
      await services.syncPanel(i.guild, panel);
      break;
    }

    case 'chan':
      panel.channelId = i.values[0];
      store.save();
      break;

    case 'content':
      return i.showModal(modals.panelContent(panel));

    case 'contentm':
      panel.name = i.fields.getTextInputValue('name').trim();
      panel.title = i.fields.getTextInputValue('title').trim();
      panel.description = i.fields.getTextInputValue('description').trim();
      store.save();
      await services.syncPanel(i.guild, panel);
      break;

    case 'style':
      panel.style = panel.style === 'select' ? 'buttons' : 'select';
      store.save();
      await services.syncPanel(i.guild, panel);
      break;

    case 'excl':
      panel.exclusive = !panel.exclusive;
      store.save();
      await services.syncPanel(i.guild, panel);
      break;

    case 'pub': {
      const error = await services.publishPanel(i.guild, panel);
      notice = error ?? `Published in <#${panel.published.channelId}>.`;
      break;
    }

    case 'del':
      return respond(i, views.panelDelete(panel));

    case 'delc':
      await services.removePanelMessage(i.guild, panel);
      delete g.panels[panel.id];
      store.save();
      return respond(i, views.panelList(i.guild, 'Panel deleted.'));

    default:
      return respond(i, views.home(i.guild));
  }

  return respond(i, views.panelEdit(i.guild, panel.id, notice));
}

/* -------------------------------------------------------------------------- */
/*  Role panels: member interactions (public)                                 */
/* -------------------------------------------------------------------------- */

const busy = new Set();

async function onRolePanel(i) {
  if (!i.inGuild() || !i.guild) return;

  const [, kind, panelId, roleId] = i.customId.split(':');
  const panel = store.guild(i.guildId).panels[panelId];
  if (!panel) return i.reply(ephemeral(views.notice('This role panel is no longer available.')));

  // Prevents two overlapping requests from the same member from overwriting each other.
  const key = `${i.guildId}:${i.user.id}`;
  if (busy.has(key)) return i.reply(ephemeral(views.notice('One moment, your previous request is still running.')));
  busy.add(key);

  try {
    if (kind === 'b') {
      await i.deferReply({ flags: EPHEMERAL });
      const result = await services.applySelection(i.member, panel, [roleId]);
      await i.editReply(views.roleResult(result));
    } else {
      await i.deferUpdate();
      const result = await services.applySelection(i.member, panel, i.values);
      // Re-render the menu so the selection resets and can be used again.
      await i.editReply({ ...views.publicPanel(i.guild, panel), allowedMentions: { parse: [] } }).catch(() => {});
      await i.followUp(ephemeral(views.roleResult(result)));
    }
  } finally {
    busy.delete(key);
  }
}

module.exports = { handle };
