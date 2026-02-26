/**
 * Vide toutes les données des tables (garde le schéma).
 * Usage : node scripts/clear-db.js
 * Nécessite DATABASE_URL dans .env.
 */
try { require('dotenv').config(); } catch (_) {}
const { pool } = require('../db');

if (!pool) {
  console.error('Set DATABASE_URL in .env to run the script.');
  process.exit(1);
}

const tables = ['play_history', 'room_players', 'user_likes', 'rooms', 'players'];

(async () => {
  await pool.query(
    `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`
  );
  console.log('Données supprimées. Tables vidées.');
  process.exit(0);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
