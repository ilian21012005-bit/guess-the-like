/**
 * Reset complet de la base : supprime toutes les tables puis réapplique le schéma.
 * Usage : node scripts/reset-db.js
 * Nécessite DATABASE_URL dans .env (URL EXTERNE depuis ton PC).
 */
try { require('dotenv').config(); } catch (_) {}
const { pool } = require('../db');
const fs = require('fs');
const path = require('path');

if (!pool) {
  console.error('Set DATABASE_URL in .env to run the reset.');
  process.exit(1);
}

const dropOrder = [
  'room_players',
  'play_history',
  'user_likes',
  'rooms',
  'players',
];

(async () => {
  for (const table of dropOrder) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    console.log('Dropped:', table);
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const statements = sql
    .split(';')
    .map(s => s.replace(/--[^\n]*/g, '').trim())
    .filter(s => s.length > 0);
  for (const st of statements) {
    await pool.query(st + ';');
  }
  console.log('Schema reapplied. Database reset done.');
  process.exit(0);
})().catch((e) => {
  console.error(e.message || e);
  if (e.code === 'ENOTFOUND' || e.message?.includes('getaddrinfo')) {
    console.error('\n→ Depuis ton PC, utilise l’URL EXTERNE de la base (Render → Connections → External Database URL).');
  }
  process.exit(1);
});
