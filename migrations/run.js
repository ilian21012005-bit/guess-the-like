/**
 * Exécute les migrations SQL dans l'ordre (fichiers 001_*.sql, 002_*.sql, …).
 * Utilise la table migration_history pour ne lancer que les migrations pas encore appliquées.
 *
 * Usage: node migrations/run.js
 * Prérequis: DATABASE_URL dans .env
 */
try { require('dotenv').config(); } catch (_) {}
const { pool } = require('../db');
const fs = require('fs');
const path = require('path');

if (!pool) {
  console.error('Définis DATABASE_URL dans .env pour exécuter les migrations.');
  process.exit(1);
}

const migrationsDir = path.join(__dirname);
const TABLE = 'migration_history';

async function ensureMigrationTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getApplied() {
  const r = await pool.query(`SELECT name FROM ${TABLE}`);
  return new Set((r.rows || []).map((row) => row.name));
}

async function recordApplied(name) {
  await pool.query(`INSERT INTO ${TABLE} (name) VALUES ($1)`, [name]);
}

async function run() {
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    console.log('Aucune migration .sql trouvée.');
    process.exit(0);
    return;
  }
  await ensureMigrationTable();
  const applied = await getApplied();
  for (const file of files) {
    const name = path.basename(file, '.sql');
    if (applied.has(name)) {
      console.log('Skip (déjà appliquée):', file);
      continue;
    }
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    const statements = sql
      .split(';')
      .map((s) => s.replace(/--[^\n]*/g, '').trim())
      .filter((s) => s.length > 0);
    for (const st of statements) {
      await pool.query(st + ';');
    }
    await recordApplied(name);
    console.log('Appliquée:', file);
  }
  console.log('Migrations terminées.');
  process.exit(0);
}

run().catch((e) => {
  console.error(e.message || e);
  if (e.code === 'ENOTFOUND' || e.message?.includes('getaddrinfo')) {
    console.error('\n→ Utilise l’URL EXTERNE de la base (Render → Connections → External Database URL).');
  }
  process.exit(1);
});
