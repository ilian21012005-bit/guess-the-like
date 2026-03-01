const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

/**
 * Exécute une requête SQL. En cas d'erreur DB, propage l'erreur (fail-hard) pour ne pas masquer les pannes.
 * Retourne null uniquement quand DATABASE_URL n'est pas défini (mode sans DB).
 */
async function query(text, params) {
  if (!pool) return null;
  const result = await pool.query(text, params);
  return result;
}

async function getOrCreatePlayer(username, tiktokUsername = null, avatarUrl = null) {
  const existing = await query(
    'SELECT id, username, tiktok_username, avatar_url FROM players WHERE LOWER(TRIM(tiktok_username)) = LOWER(TRIM($1)) OR LOWER(TRIM(username)) = LOWER(TRIM($2)) LIMIT 1',
    [tiktokUsername || username, username]
  );
  if (existing && existing.rows.length) return existing.rows[0];

  const insert = await query(
    'INSERT INTO players (username, tiktok_username, avatar_url) VALUES ($1, $2, $3) RETURNING id, username, tiktok_username, avatar_url',
    [username.trim(), (tiktokUsername || username).trim().replace(/^@/, ''), avatarUrl]
  );
  return insert && insert.rows[0] ? insert.rows[0] : null;
}

async function createRoom(code) {
  const res = await query('INSERT INTO rooms (code, status) VALUES ($1, $2) RETURNING id, code', [code, 'lobby']);
  return res && res.rows[0] ? res.rows[0] : null;
}

async function getRoomByCode(code) {
  const res = await query('SELECT id, code, host_socket_id, status FROM rooms WHERE code = $1', [code]);
  return res && res.rows[0] ? res.rows[0] : null;
}

async function addPlayerToRoom(roomId, playerId, socketId) {
  await query(
    'INSERT INTO room_players (room_id, player_id, socket_id) VALUES ($1, $2, $3) ON CONFLICT (room_id, player_id) DO UPDATE SET socket_id = $3',
    [roomId, playerId, socketId]
  );
}

async function saveLikes(playerId, videoUrls) {
  if (!pool || !playerId || !videoUrls.length) return 0;
  const urls = [];
  const videoIdsTiktok = [];
  for (const url of videoUrls) {
    const idMatch = url.match(/\/video\/(\d+)/);
    urls.push(url);
    videoIdsTiktok.push(idMatch ? idMatch[1] : null);
  }
  const res = await query(
    'INSERT INTO user_likes (player_id, video_url, video_id_tiktok) SELECT $1, unnest($2::text[]), unnest($3::text[]) ON CONFLICT (video_id_tiktok) DO NOTHING RETURNING id',
    [playerId, urls, videoIdsTiktok]
  );
  return res && res.rows ? res.rows.length : 0;
}

/**
 * Récupère jusqu'à limit vidéos pour une partie.
 * Priorité : vidéos JAMAIS utilisées dans AUCUNE partie (toutes rooms confondues),
 * pour les joueurs indiqués. Si pas assez, on complète avec les vidéos les moins
 * jouées / les plus anciennes.
 *
 * NB : roomCode est conservé pour compatibilité d'appel mais n'est plus utilisé
 * dans le filtre (logique « global player centric »).
 *
 * @param {string} roomCode - Code du salon (non utilisé dans le filtre, conservé pour compatibilité)
 * @param {number[]} playerIds - Liste des ids joueurs présents dans le salon
 * @param {number} limit - 10, 25 ou 50
 */
async function getVideosForRoom(roomCode, playerIds, limit = 50) {
  if (!pool || !playerIds.length) return [];
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 50);
  const placeholders = playerIds.map((_, i) => `$${i + 1}`).join(',');
  const params = [...playerIds];
  let res = await query(
    `SELECT ul.id, ul.video_url, ul.player_id FROM user_likes ul
     WHERE ul.player_id IN (${placeholders})
     AND NOT EXISTS (
       SELECT 1
       FROM play_history ph
       WHERE ph.video_id = ul.id
     )
     ORDER BY RANDOM() LIMIT ${cap}`,
    params
  );
  let list = res && res.rows ? res.rows : [];
  if (list.length > 0 && list.length < cap) {
    const fallback = await query(
      `SELECT ul.id, ul.video_url, ul.player_id FROM user_likes ul
       WHERE ul.player_id IN (${placeholders})
       ORDER BY ul.play_count ASC, ul.last_played_at ASC NULLS FIRST
       LIMIT 100`,
      params
    );
    const existingIds = new Set(list.map(r => r.id));
    const extra = (fallback && fallback.rows ? fallback.rows : []).filter(r => !existingIds.has(r.id));
    list = [...list, ...extra].slice(0, cap);
  }
  return list.map(r => ({ id: r.id, video_url: r.video_url, owner_id: r.player_id }));
}

async function get50VideosForRoom(roomCode, playerIds) {
  return getVideosForRoom(roomCode, playerIds, 50);
}

async function recordPlayedVideo(roomCode, videoId) {
  await query('INSERT INTO play_history (room_code, video_id) VALUES ($1, $2)', [roomCode, videoId]);
  await query('UPDATE user_likes SET play_count = play_count + 1, last_played_at = NOW() WHERE id = $1', [videoId]);
}

async function getPlayerById(playerId) {
  const res = await query('SELECT id, username, tiktok_username, avatar_url FROM players WHERE id = $1', [playerId]);
  return res && res.rows[0] ? res.rows[0] : null;
}

/**
 * Nombre de vidéos encore jouables (jamais dans play_history) par joueur.
 * @param {number[]} playerIds
 * @returns {Promise<Record<number, number>>} playerId -> count
 */
async function getPlayableVideoCount(playerIds) {
  if (!pool || !playerIds.length) return {};
  const placeholders = playerIds.map((_, i) => `$${i + 1}`).join(',');
  const res = await query(
    `SELECT ul.player_id, COUNT(*)::int AS c
     FROM user_likes ul
     WHERE ul.player_id IN (${placeholders})
     AND NOT EXISTS (SELECT 1 FROM play_history ph WHERE ph.video_id = ul.id)
     GROUP BY ul.player_id`,
    playerIds
  );
  const out = {};
  if (res && res.rows) for (const row of res.rows) out[row.player_id] = row.c;
  return out;
}

module.exports = {
  pool,
  query,
  getOrCreatePlayer,
  createRoom,
  getRoomByCode,
  addPlayerToRoom,
  saveLikes,
  get50VideosForRoom,
  getVideosForRoom,
  recordPlayedVideo,
  getPlayerById,
  getPlayableVideoCount,
};
