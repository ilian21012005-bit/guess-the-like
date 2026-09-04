try { require('dotenv').config(); } catch (_) {}
const { pool } = require('../db');
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname);
const TABLE = 'migration_history';

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getApplied(client) {
  const r = await client.query(`SELECT name FROM ${TABLE}`);
  return new Set((r.rows || []).map((row) => row.name));
}

async function recordApplied(client, name) {
  await client.query(`INSERT INTO ${TABLE} (name) VALUES ($1)`, [name]);
}

/**
 * Applique les migrations idempotentes.
 * No-op si pool (DATABASE_URL) absent.
 */
async function runMigrations() {
  if (!pool) {
    console.log('[migrate] Pas de DATABASE_URL — skip.');
    return;
  }
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    console.log('[migrate] Aucune migration .sql.');
    return;
  }
  await ensureMigrationTable(pool);
  const applied = await getApplied(pool);
  for (const file of files) {
    const name = path.basename(file, '.sql');
    if (applied.has(name)) {
      console.log('[migrate] Skip:', file);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = sql
      .split(';')
      .map((s) => s.replace(/--[^\n]*/g, '').trim())
      .filter((s) => s.length > 0);
    for (const st of statements) {
      await pool.query(st + ';');
    }
    await recordApplied(pool, name);
    console.log('[migrate] Appliquée:', file);
  }
  console.log('[migrate] Terminé.');
}

module.exports = { runMigrations };

if (require.main === module) {
  if (!pool) {
    console.error('[migrate] Pas de DATABASE_URL — impossible d\'exécuter les migrations en CLI.');
    process.exit(1);
  }
  runMigrations()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e.message || e);
      if (e.code === 'ENOTFOUND' || e.message?.includes('getaddrinfo')) {
        console.error("\n→ Utilise l'URL EXTERNE de la base (Render → Connections → External Database URL).");
      }
      process.exit(1);
    });
}
