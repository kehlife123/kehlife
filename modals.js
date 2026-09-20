'use strict';

const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

function field({ id, label, style = TextInputStyle.Short, value, max, required = true, placeholder }) {
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

function welcome(w) {
  return new ModalBuilder()
    .setCustomId('p:wel:modal')
    .setTitle('Welcome message')
    .addComponents(
      field({ id: 'title', label: 'Title', value: w.title, max: 100, required: false, placeholder: 'Welcome' }),
      field({
        id: 'message',
        label: 'Message',
        style: TextInputStyle.Paragraph,
        value: w.message,
        max: 1500,
        placeholder: '{user} {username} {server} {count}',
      }),
      field({
        id: 'image',
        label: 'Banner image URL (optional)',
        value: w.imageUrl,
        max: 500,
        required: false,
        placeholder: 'https://...',
      }),
    );
}

function newPanel() {
  return new ModalBuilder()
    .setCustomId('p:rp:newm')
    .setTitle('New role panel')
    .addComponents(field({ id: 'name', label: 'Panel name', max: 50, placeholder: 'Colors, Notifications, Pronouns...' }));
}

function panelContent(p) {
  return new ModalBuilder()
    .setCustomId(`p:rp:contentm:${p.id}`)
    .setTitle('Panel text')
    .addComponents(
      field({ id: 'name', label: 'Internal name', value: p.name, max: 50 }),
      field({ id: 'title', label: 'Title shown to members', value: p.title, max: 100 }),
      field({
        id: 'description',
        label: 'Description',
        style: TextInputStyle.Paragraph,
        value: p.description,
        max: 1000,
        required: false,
      }),
    );
}

module.exports = { welcome, newPanel, panelContent };
