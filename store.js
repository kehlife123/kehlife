'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'db.json');

const MAX_PANELS = 15;

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

let db = { guilds: {} };
let timer = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db.guilds ??= {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[store] Could not read the database, keeping a backup and starting fresh:', err.message);
      try { fs.copyFileSync(FILE, `${FILE}.corrupt`); } catch { /* ignore */ }
    }
    db = { guilds: {} };
  }
  console.log(`[store] Using ${FILE}`);
}

function flush() {
  clearTimeout(timer);
  timer = null;
  const tmp = `${FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[store] Failed to write the database:', err);
  }
}

/** Debounced, atomic write. */
function save() {
  if (timer) return;
  timer = setTimeout(flush, 300);
}

/** Returns the (mutable) config of a guild, filling in any missing defaults. */
function guild(id) {
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

module.exports = { load, save, flush, guild, MAX_PANELS };
