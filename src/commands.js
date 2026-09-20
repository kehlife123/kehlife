'use strict';

const { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

const panel = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('Open the control panel (welcome, autorole and role panels)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild);

module.exports = [panel.toJSON()];
