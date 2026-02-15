try { require('dotenv').config(); } catch (_) {}
const { pool } = require('../db');
const fs = require('fs');
const path = require('path');

if (!pool) {
  console.error('Set DATABASE_URL in .env to run the schema.');
  process.exit(1);
}

const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const statements = sql
  .split(';')
  .map(s => s.replace(/--[^\n]*/g, '').trim())
  .filter(s => s.length > 0);

(async () => {
  for (const st of statements) {
    await pool.query(st + ';');
  }
  console.log('Schema applied.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
