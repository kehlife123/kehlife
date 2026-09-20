'use strict';

const { Client, Events, GatewayIntentBits } = require('discord.js');

const store = require('./store');
const services = require('./services');
const commands = require('./commands');
const { handle } = require('./interactions');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}

store.load();

// Server Members is a privileged intent: enable it in the Developer Portal (Bot > Privileged Gateway Intents).
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Logged in as ${c.user.tag} (${c.guilds.cache.size} servers)`);
  try {
    // GUILD_ID is optional: it registers the command instantly in one server, handy while testing.
    if (process.env.GUILD_ID) await c.application.commands.set(commands, process.env.GUILD_ID);
    else await c.application.commands.set(commands);
    console.log('[bot] Slash commands registered.');
  } catch (err) {
    console.error('[bot] Could not register slash commands:', err);
  }
});

client.on(Events.InteractionCreate, handle);

client.on(Events.GuildMemberAdd, async (member) => {
  const results = await Promise.allSettled([services.applyAutorole(member), services.sendWelcome(member)]);
  for (const r of results) if (r.status === 'rejected') console.error(`[join:${member.guild.id}]`, r.reason?.message ?? r.reason);
});

// Keep the saved config clean when roles or channels are deleted.
client.on(Events.GuildRoleDelete, async (role) => {
  const g = store.guild(role.guild.id);
  g.autorole.roles = g.autorole.roles.filter((id) => id !== role.id);
  g.autorole.botRoles = g.autorole.botRoles.filter((id) => id !== role.id);
  for (const panel of Object.values(g.panels)) {
    if (!panel.roles.includes(role.id)) continue;
    panel.roles = panel.roles.filter((id) => id !== role.id);
    await services.syncPanel(role.guild, panel);
  }
  store.save();
});

client.on(Events.ChannelDelete, (channel) => {
  if (!channel.guildId) return;
  const g = store.guild(channel.guildId);
  if (g.welcome.channelId === channel.id) {
    g.welcome.channelId = null;
    g.welcome.enabled = false;
  }
  for (const panel of Object.values(g.panels)) {
    if (panel.channelId === channel.id) panel.channelId = null;
    if (panel.published?.channelId === channel.id) panel.published = null;
  }
  store.save();
});

client.on(Events.Error, (err) => console.error('[client]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    store.flush();
    client.destroy();
    process.exit(0);
  });
}

client.login(token);
