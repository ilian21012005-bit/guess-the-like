try { require('dotenv').config(); } catch (_) {}
const path = require('path');
const http = require('http');
const { Readable } = require('stream');
const express = require('express');
const { Server } = require('socket.io');
const { harvestLikes, getTikTokMp4Url, getTikTokMp4Buffer } = require('./scraper');
const db = require('./db');

// File d'attente pour le secours Playwright : 8 en parallèle (préchargement serveur + requêtes on-demand)
const PLAYWRIGHT_CONCURRENT = 8;
const playwrightQueue = [];
let playwrightRunning = 0;
function runPlaywrightQueue() {
  while (playwrightRunning < PLAYWRIGHT_CONCURRENT && playwrightQueue.length > 0) {
    const { pageUrl, resolve } = playwrightQueue.shift();
    playwrightRunning++;
    getTikTokMp4Buffer(pageUrl).then((result) => {
      playwrightRunning--;
      resolve(result);
      runPlaywrightQueue();
    }).catch((err) => {
      playwrightRunning--;
      resolve({ error: err.message || 'BUFFER_ERROR' });
      runPlaywrightQueue();
    });
  }
}
function enqueuePlaywrightFallback(pageUrl) {
  return new Promise((resolve) => {
    playwrightQueue.push({ pageUrl, resolve });
    runPlaywrightQueue();
  });
}

// Cache préchargement serveur : roomCode -> { rounds: Array<{buffer, contentType}|null>, createdAt }
const serverPreloadCache = new Map();
const SERVER_PRELOAD_WORKERS = 8;
const SERVER_PRELOAD_VIDEO_TIMEOUT_MS = 55000;

function fetchOneVideoForPreload(pageUrl) {
  const trimmed = pageUrl.trim();
  return new Promise((resolve) => {
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), SERVER_PRELOAD_VIDEO_TIMEOUT_MS));
    const work = (async () => {
      const result = await getTikTokMp4Url(trimmed);
      if (result.error || !result.url) return null;
      const mp4Url = result.url.startsWith('//') ? 'https:' + result.url : result.url;
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 4000);
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': trimmed.split('?')[0] || 'https://www.tiktok.com/',
        'Origin': 'https://www.tiktok.com',
        'Accept': '*/*',
      };
      let r;
      try {
        r = await fetch(mp4Url, { headers, redirect: 'follow', signal: controller.signal });
      } catch (_) {
        clearTimeout(to);
        const fallback = await enqueuePlaywrightFallback(trimmed);
        return fallback.buffer ? { buffer: fallback.buffer, contentType: fallback.contentType || 'video/mp4' } : null;
      }
      clearTimeout(to);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        return { buffer: buf, contentType: r.headers.get('Content-Type') || 'video/mp4' };
      }
      const fallback = await enqueuePlaywrightFallback(trimmed);
      return fallback.buffer ? { buffer: fallback.buffer, contentType: fallback.contentType || 'video/mp4' } : null;
    })();
    Promise.race([work, timeoutPromise]).then(resolve).catch(() => resolve(null));
  });
}

function runServerPreload(roomCode, rounds) {
  const total = rounds.length;
  const cacheEntry = { rounds: new Array(total), createdAt: Date.now() };
  serverPreloadCache.set(roomCode, cacheEntry);
  const room = getRoomByCode(roomCode);
  if (!room) return;
  let completed = 0;
  const jobs = rounds.map((r, i) => ({ roomCode, index: i, url: r.video_url }));
  const processNext = async () => {
    const job = jobs.shift();
    if (!job) return;
    const { roomCode: rc, index, url } = job;
    const result = await fetchOneVideoForPreload(url);
    const entry = serverPreloadCache.get(rc);
    if (entry) entry.rounds[index] = result;
    completed++;
    io.to(rc).emit('preload_progress', { roomCode: rc, loaded: completed, total });
    if (completed >= total) {
      const r = getRoomByCode(rc);
      if (r && r.status === 'preparing') {
        r.status = 'playing';
        const playersForClient = getPlayerListForRoom(r);
        io.to(rc).emit('game_started', { players: playersForClient, totalRounds: total });
      }
    }
    processNext();
  };
  for (let i = 0; i < Math.min(SERVER_PRELOAD_WORKERS, total); i++) processNext();
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit pour les APIs vidéo (par IP) — configurable en prod (ex. Render) pour préchargement 50 vidéos
const videoRateLimit = new Map();
const VIDEO_RATE_LIMIT_WINDOW = parseInt(process.env.VIDEO_RATE_LIMIT_WINDOW_MS, 10) || 120000;
const VIDEO_RATE_LIMIT_MAX = parseInt(process.env.VIDEO_RATE_LIMIT_MAX, 10) || 80;
function checkVideoRateLimit(ip) {
  const now = Date.now();
  let bucket = videoRateLimit.get(ip) || { count: 0, resetAt: now + VIDEO_RATE_LIMIT_WINDOW };
  if (now >= bucket.resetAt) bucket = { count: 0, resetAt: now + VIDEO_RATE_LIMIT_WINDOW };
  bucket.count++;
  videoRateLimit.set(ip, bucket);
  return bucket.count <= VIDEO_RATE_LIMIT_MAX;
}

// Nettoyer les tokens bookmarklet expirés
function cleanupBookmarkletTokens() {
  const now = Date.now();
  for (const [t, data] of bookmarkletTokens.entries()) {
    if (now - data.createdAt > BOOKMARKLET_TOKEN_TTL_MS) bookmarkletTokens.delete(t);
  }
}

// API pour le bookmarklet (récupération likes depuis la page TikTok du joueur)
app.post('/api/import-likes-from-bookmarklet', (req, res) => {
  const { token, urls } = req.body || {};
  cleanupBookmarkletTokens();
  const data = token ? bookmarkletTokens.get(token) : null;
  if (!data) return res.status(400).json({ error: 'Lien expiré ou invalide. Régénère le lien dans le lobby.' });
  bookmarkletTokens.delete(token);
  const room = getRoomByCode(data.roomCode);
  if (!room) return res.status(400).json({ error: 'Salon introuvable.' });
  const me = room.players.find(p => p.playerId === data.playerId || p.socketId === data.socketId);
  if (!me) return res.status(400).json({ error: 'Joueur introuvable dans le salon.' });
  const arr = Array.isArray(urls) ? urls : [];
  const seen = new Set();
  const list = [];
  for (const u of arr) {
    if (typeof u !== 'string' || !u.includes('/video/') || seen.has(u)) continue;
    seen.add(u);
    list.push({ id: `mem-${me.playerId}-${list.length}-${Date.now()}`, video_url: u, owner_id: me.playerId });
  }
  if (list.length === 0) return res.status(400).json({ error: 'Aucun lien vidéo TikTok trouvé. Ouvre ta page « J\'aime » sur TikTok, déroule pour charger des vidéos, puis reclique sur le favori.' });
  const key = room.code;
  if (!roomLikes.has(key)) roomLikes.set(key, {});
  roomLikes.get(key)[me.playerId] = list;
  me.isReady = true;
  io.to(key).emit('room_updated', { players: getPlayerListForRoom(room) });
  io.to(data.socketId).emit('harvest_done', { count: list.length });
  console.log('[bookmarklet] Stored %s likes for room=%s playerId=%s', list.length, key, me.playerId);
  res.json({ ok: true, count: list.length });
});

// API pour récupérer l'URL MP4 d'une vidéo TikTok (affichage sans iframe)
app.get('/api/tiktok-mp4', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!checkVideoRateLimit(ip)) return res.status(429).json({ error: 'Trop de requêtes.' });
  const url = req.query.url;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Paramètre url requis.' });
  try {
    const result = await getTikTokMp4Url(url);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ url: result.url });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

// Stream vidéo direct : on reçoit l’URL de la page TikTok, on extrait le MP4 côté serveur et on stream (évite 403 / URL à usage unique)
app.get('/api/tiktok-video', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!checkVideoRateLimit(ip)) return res.status(429).end();
  const pageUrl = req.query.url;
  if (!pageUrl || typeof pageUrl !== 'string') return res.status(400).end();
  const roomCode = (req.query.room || '').toUpperCase();
  const index = req.query.index != null ? parseInt(req.query.index, 10) : -1;
  if (roomCode && index >= 0) {
    const entry = serverPreloadCache.get(roomCode);
    if (entry && entry.rounds[index] !== undefined) {
      const cached = entry.rounds[index];
      if (cached && cached.buffer) {
        res.setHeader('Content-Type', cached.contentType || 'video/mp4');
        res.setHeader('Content-Length', cached.buffer.length);
        return res.status(200).end(cached.buffer);
      }
      // Cache null (préchargement échoué, ex. Render sans Playwright) → fallback extraction on-demand
    }
  }
  let trimmed = pageUrl.trim();
  try {
    if (trimmed.includes('%')) trimmed = decodeURIComponent(trimmed);
  } catch (_) {}
  let hostOk = false;
  try {
    const u = new URL(trimmed);
    const host = (u.hostname || '').toLowerCase();
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com') || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') hostOk = true;
  } catch (_) {}
  if (!hostOk && !/tiktok\.com/.test(trimmed)) {
    console.warn('[tiktok-video] 403 URL non autorisée. Début reçu:', pageUrl.slice(0, 80));
    return res.status(403).end();
  }
  if (!hostOk) hostOk = true;
  const t0 = Date.now();
  const VIDEO_EXTRACT_TIMEOUT_MS = 55000;
  let responseSent = false;
  function sendOnce(status, body) {
    if (responseSent) return;
    responseSent = true;
    if (body !== undefined) res.status(status).end(body);
    else res.status(status).end();
  }
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), VIDEO_EXTRACT_TIMEOUT_MS));
  const work = (async () => {
    const result = await getTikTokMp4Url(trimmed);
    const tExtract = Date.now() - t0;
    console.log('[tiktok-video] extraction MP4: ' + tExtract + ' ms' + (result.error ? ' (échec: ' + result.error + ')' : ''));
    if (result.error || !result.url) { sendOnce(404); return; }
    const mp4Url = result.url.startsWith('//') ? 'https:' + result.url : result.url;
    const controller = new AbortController();
    const fetchTimeoutMs = Math.min(4000, VIDEO_EXTRACT_TIMEOUT_MS - (Date.now() - t0) - 2000);
    const to = setTimeout(() => controller.abort(), fetchTimeoutMs);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': trimmed.split('?')[0] || 'https://www.tiktok.com/',
      'Origin': 'https://www.tiktok.com',
      'Accept': '*/*',
    };
    const range = req.headers.range;
    if (range) headers['Range'] = range;
    let r;
    try {
      r = await fetch(mp4Url, { headers, redirect: 'follow', signal: controller.signal });
    } catch (fetchErr) {
      clearTimeout(to);
      if (fetchErr.name === 'AbortError') {
        console.warn('[tiktok-video] fetch CDN timeout — secours Playwright…');
      } else {
        console.warn('[tiktok-video] fetch CDN erreur — secours Playwright…');
      }
      const fallback = await enqueuePlaywrightFallback(trimmed);
      if (fallback.buffer) {
        if (!responseSent) {
          responseSent = true;
          res.setHeader('Content-Type', fallback.contentType || 'video/mp4');
          res.setHeader('Content-Length', fallback.buffer.length);
          res.status(200).end(fallback.buffer);
        }
        return;
      }
      sendOnce(504);
      return;
    }
    clearTimeout(to);
    const tTotal = Date.now() - t0;
    if (!r.ok) {
      console.warn('[tiktok-video] CDN TikTok a retourné ' + r.status + ' — secours Playwright…');
      const fallback = await enqueuePlaywrightFallback(trimmed);
      if (fallback.buffer) {
        console.log('[tiktok-video] secours Playwright OK: ' + (Date.now() - t0) + ' ms (buffer ' + fallback.buffer.length + ' octets)');
        if (!responseSent) {
          responseSent = true;
          res.setHeader('Content-Type', fallback.contentType || 'video/mp4');
          res.setHeader('Content-Length', fallback.buffer.length);
          res.status(200).end(fallback.buffer);
        }
        return;
      }
      console.warn('[tiktok-video] secours Playwright échec:', fallback.error || '');
      sendOnce(r.status);
      return;
    }
    console.log('[tiktok-video] stream démarré: ' + tTotal + ' ms total (extraction: ' + tExtract + ' ms)');
    if (responseSent) return;
    responseSent = true;
    const ct = r.headers.get('Content-Type') || 'video/mp4';
    res.setHeader('Content-Type', ct);
    if (r.status === 206) res.setHeader('Content-Range', r.headers.get('Content-Range') || '');
    const cl = r.headers.get('Content-Length');
    if (cl) res.setHeader('Content-Length', cl);
    res.status(r.status);
    Readable.fromWeb(r.body).pipe(res);
  })();
  try {
    await Promise.race([work, timeoutPromise]);
  } catch (err) {
    if (err && err.message === 'TIMEOUT') {
      console.warn('[tiktok-video] timeout après ' + VIDEO_EXTRACT_TIMEOUT_MS + ' ms');
      sendOnce(504);
    } else if (!responseSent) {
      sendOnce(502);
    }
  }
});

// Proxy vidéo : le navigateur charge le MP4 via notre serveur (évite blocage Referer/CORS) — gardé pour compatibilité
app.get('/api/tiktok-video-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string') return res.status(400).end();
  const allowed = /^https:\/\/([a-z0-9.-]+\.)?(tiktok\.com|tiktokv\.com|tiktokcdn\.com|tiktokcdn-[a-z0-9]+\.com|muscdn\.com|byteoversea\.com)\//i;
  if (!allowed.test(targetUrl.trim())) return res.status(403).end();
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 20000);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.tiktok.com/',
      'Accept': '*/*',
    };
    const range = req.headers.range;
    if (range) headers['Range'] = range;
    const r = await fetch(targetUrl.trim(), { headers, redirect: 'follow', signal: controller.signal });
    clearTimeout(to);
    if (!r.ok) return res.status(r.status).end();
    const ct = r.headers.get('Content-Type') || 'video/mp4';
    res.setHeader('Content-Type', ct);
    if (r.status === 206) res.setHeader('Content-Range', r.headers.get('Content-Range') || '');
    const cl = r.headers.get('Content-Length');
    if (cl) res.setHeader('Content-Length', cl);
    res.status(r.status);
    Readable.fromWeb(r.body).pipe(res);
  } catch (err) {
    res.status(502).end();
  }
});

// Salles en mémoire : code -> { roomId, hostSocketId, players: [...], status, gameState }
const rooms = new Map();
// Likes en mémoire (sans DB) : code -> { playerId -> [ { id, video_url, owner_id } ] }
const roomLikes = new Map();
// Vidéos déjà jouées en mémoire : code -> Set<videoId>
const roomPlayed = new Map();
// Anti-double : dernière fois qu’on a envoyé next_round par salon (évite enchaînement auto)
const lastNextRoundSent = new Map(); // roomCode -> { index, at }
// Tokens bookmarklet (multi-joueurs) : token -> { roomCode, playerId, socketId, createdAt }
const bookmarkletTokens = new Map();
const BOOKMARKLET_TOKEN_TTL_MS = 15 * 60 * 1000;
const ROOM_EXPIRE_MS = 2 * 60 * 60 * 1000; // 2 h

function touchRoom(room) {
  if (room) room.lastActivity = Date.now();
}
function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - (room.lastActivity || now) > ROOM_EXPIRE_MS) {
      rooms.delete(code);
      roomPlayed.delete(code);
      roomLikes.delete(code);
      lastNextRoundSent.delete(code);
    }
  }
}
setInterval(cleanupExpiredRooms, 5 * 60 * 1000);

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getRoomByCode(code) {
  return rooms.get((code || '').toUpperCase());
}

function getPlayerListForRoom(room) {
  return room.players.map(p => ({
    socketId: p.socketId,
    playerId: p.playerId,
    username: p.username,
    tiktokUsername: p.tiktokUsername,
    avatarUrl: p.avatarUrl,
    isReady: p.isReady,
    score: p.score ?? 0,
    streak: p.streak ?? 0,
    isHost: room.hostSocketId === p.socketId,
  }));
}

io.on('connection', (socket) => {
  socket.on('create_room', async (data, ack) => {
    const { username, tiktokUsername, avatarUrl } = data || {};
    if (!username?.trim()) return ack?.({ error: 'Username required' });
    const player = db.pool ? await db.getOrCreatePlayer(username.trim(), (tiktokUsername || username).trim()) : { id: socket.id, username: username.trim(), tiktok_username: (tiktokUsername || username).trim(), avatar_url: null };
    const playerId = player?.id ?? socket.id;
    if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.length > 500000) return ack?.({ error: 'Image de profil trop lourde (max ~500 Ko).' });
    const avatar = (avatarUrl && typeof avatarUrl === 'string' && (avatarUrl.startsWith('http') || avatarUrl.startsWith('data:'))) ? avatarUrl : (player?.avatar_url || null);
    let code = generateCode();
    while (rooms.has(code)) code = generateCode();
    let roomId = null;
    if (db.pool) {
      const created = await db.createRoom(code);
      if (created) roomId = created.id;
    }
    const room = {
      roomId,
      code,
      hostSocketId: socket.id,
      players: [{ socketId: socket.id, playerId, username: player?.username ?? username, tiktokUsername: player?.tiktok_username ?? (tiktokUsername || username), avatarUrl: avatar, isReady: false, score: 0, streak: 0 }],
      status: 'lobby',
      gameState: null,
      lastActivity: Date.now(),
    };
    rooms.set(code, room);
    if (db.pool && roomId) await db.addPlayerToRoom(roomId, playerId, socket.id);
    socket.join(code);
    touchRoom(room);
    ack?.({ code, playerId, players: getPlayerListForRoom(room) });
  });

  socket.on('join_room', async (data, ack) => {
    const { code, username, tiktokUsername, avatarUrl } = data || {};
    const roomCode = (code || '').toUpperCase().trim();
    const room = getRoomByCode(roomCode);
    if (!room) return ack?.({ error: 'Room not found' });
    if (room.status !== 'lobby') return ack?.({ error: 'Game already started' });
    if (!username?.trim()) return ack?.({ error: 'Username required' });
    if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.length > 500000) return ack?.({ error: 'Image de profil trop lourde (max ~500 Ko).' });
    const player = db.pool ? await db.getOrCreatePlayer(username.trim(), (tiktokUsername || username).trim()) : { id: socket.id, username: username.trim(), tiktok_username: (tiktokUsername || username).trim(), avatar_url: null };
    const playerId = player?.id ?? socket.id;
    const avatar = (avatarUrl && typeof avatarUrl === 'string' && (avatarUrl.startsWith('http') || avatarUrl.startsWith('data:'))) ? avatarUrl : (player?.avatar_url || null);
    if (room.players.some(p => p.playerId === playerId || p.socketId === socket.id)) return ack?.({ error: 'Already in room' });
    room.players.push({ socketId: socket.id, playerId, username: player?.username ?? username, tiktokUsername: player?.tiktok_username ?? (tiktokUsername || username), avatarUrl: avatar, isReady: false, score: 0, streak: 0 });
    if (db.pool && room.roomId) await db.addPlayerToRoom(room.roomId, playerId, socket.id);
    socket.join(roomCode);
    touchRoom(room);
    io.to(roomCode).emit('room_updated', { players: getPlayerListForRoom(room) });
    ack?.({ playerId, players: getPlayerListForRoom(room) });
  });

  socket.on('create_bookmarklet_token', (data, ack) => {
    const { code } = data || {};
    const room = getRoomByCode((code || '').toUpperCase());
    if (!room) return ack?.({ error: 'Room not found' });
    const me = room.players.find(p => p.socketId === socket.id);
    if (!me) return ack?.({ error: 'Not in room' });
    cleanupBookmarkletTokens();
    const token = require('crypto').randomBytes(16).toString('hex');
    bookmarkletTokens.set(token, { roomCode: room.code, playerId: me.playerId, socketId: socket.id, createdAt: Date.now() });
    ack?.({ token });
  });

  socket.on('set_ready', async (data, ack) => {
    const { code } = data || {};
    const room = getRoomByCode((code || '').toUpperCase());
    if (!room) return ack?.({ error: 'Room not found' });
    const me = room.players.find(p => p.socketId === socket.id);
    if (!me) return ack?.({ error: 'Not in room' });
    const tiktokUser = (me.tiktokUsername || me.username || '').replace(/^@/, '');
    if (!tiktokUser) return ack?.({ error: 'TikTok username required' });
    me.isReady = true;
    io.to(room.code).emit('room_updated', { players: getPlayerListForRoom(room) });
    ack?.({ status: 'scraping' });

    let result;
    try {
      console.log('[set_ready] Début récupération likes pour @%s…', tiktokUser);
      result = await harvestLikes(tiktokUser, 150);
    } catch (err) {
      console.error('[set_ready] Erreur scraper:', err.message || err);
      me.isReady = false;
      io.to(room.code).emit('room_updated', { players: getPlayerListForRoom(room) });
      const msg = (err.message || String(err)).toLowerCase();
      const friendly = msg.includes('user data') || msg.includes('already in use')
        ? 'Profil Chrome déjà utilisé. Ferme toutes les fenêtres Chrome puis réessaie.'
        : (err.message || 'Erreur lors de la récupération.');
      return ack?.({ error: friendly });
    }

    const count = result.videos?.length ?? 0;
    if (count === 0 && !result.error) console.log('[set_ready] Scraper a renvoyé 0 vidéos pour @%s', tiktokUser);
    if (result.error) {
      me.isReady = false;
      io.to(room.code).emit('room_updated', { players: getPlayerListForRoom(room) });
      console.log('[set_ready] Erreur retournée:', result.error);
      let errMsg = result.error;
      if (process.env.CHROME_DEBUG_URL && /ECONNREFUSED|127\.0\.0\.1:9222/.test(result.error)) {
        errMsg = 'Chrome n\'écoute pas sur le port 9222. Ferme TOUTES les fenêtres Chrome, puis lance uniquement : .\\scripts\\launch-chrome-debug.ps1 — garde cette fenêtre ouverte et réessaie Prêt.';
      }
      return ack?.({ error: errMsg });
    }
    if (count === 0) {
      me.isReady = false;
      io.to(room.code).emit('room_updated', { players: getPlayerListForRoom(room) });
      return ack?.({ error: 'Aucun like récupéré. Vérifie ton @ TikTok et que tes likes sont bien en public.' });
    }
    if (db.pool && me.playerId) await db.saveLikes(me.playerId, result.videos);
    if (me.playerId) {
      const key = (room.code || '').toUpperCase();
      if (!roomLikes.has(key)) roomLikes.set(key, {});
      const list = result.videos.map((url, i) => ({
        id: `mem-${me.playerId}-${i}-${Date.now()}`,
        video_url: url,
        owner_id: me.playerId,
      }));
      roomLikes.get(key)[me.playerId] = list;
      console.log('[set_ready] Stored %s likes for room=%s playerId=%s', list.length, key, me.playerId);
    }
    io.to(room.code).emit('room_updated', { players: getPlayerListForRoom(room) });
    socket.emit('harvest_done', { count });
    ack?.({ ok: true, count });
  });

  socket.on('import_likes', async (data, ack) => {
    const { code, urlsText } = data || {};
    const room = getRoomByCode((code || '').toUpperCase());
    if (!room) return ack?.({ error: 'Room not found' });
    const me = room.players.find(p => p.socketId === socket.id);
    if (!me) return ack?.({ error: 'Not in room' });
    const lines = String(urlsText || '').split(/\n/).map(s => s.trim()).filter(Boolean);
    const urls = [];
    const seen = new Set();
    for (const line of lines) {
      const m = line.match(/https?:\/\/[^\s]+/g);
      if (m) for (const u of m) {
        if (u.includes('/video/') && !seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
    }
    if (urls.length === 0) return ack?.({ error: 'Aucun lien TikTok trouvé (format: .../video/...). Colle un lien par ligne.' });
    const key = (room.code || '').toUpperCase();
    if (db.pool && me.playerId) {
      try {
        await db.saveLikes(me.playerId, urls);
      } catch (err) {
        console.error('[import_likes] saveLikes failed:', err?.message || err);
      }
    }
    if (!roomLikes.has(key)) roomLikes.set(key, {});
    const list = urls.map((url, i) => ({
      id: `mem-${me.playerId}-${i}-${Date.now()}`,
      video_url: url,
      owner_id: me.playerId,
    }));
    roomLikes.get(key)[me.playerId] = list;
    me.isReady = true;
    touchRoom(room);
    io.to(room.code).emit('room_updated', { players: getPlayerListForRoom(room) });
    console.log('[import_likes] Stored %s links for room=%s playerId=%s', list.length, key, me.playerId);
    ack?.({ ok: true, count: list.length });
  });

  socket.on('start_game', async (data, ack) => {
    const roomCode = (data?.code || '').toUpperCase();
    const totalRounds = Math.min(Math.max(parseInt(data?.totalRounds, 10) || 50, 10), 50);
    const room = getRoomByCode(roomCode);
    if (!room) return ack?.({ error: 'Room not found' });
    if (room.hostSocketId !== socket.id) return ack?.({ error: 'Only host can start' });
    if (room.status !== 'lobby') return ack?.({ error: 'Game already started' });
    touchRoom(room);
    const playerIds = room.players.map(p => p.playerId);
    if (!roomPlayed.has(roomCode)) roomPlayed.set(roomCode, new Set());
    const played = roomPlayed.get(roomCode);
    let rounds = [];
    if (db.pool) {
      const fromDb = await db.getVideosForRoom(roomCode, playerIds, totalRounds);
      rounds = fromDb.filter(r => !played.has(r.id));
    }
    if (!rounds.length) {
      const memLikes = roomLikes.get((roomCode || '').toUpperCase()) || {};
      let all = [];
      for (const pid of playerIds) {
        const arr = memLikes[pid] || [];
        for (const v of arr) if (!played.has(v.id)) all.push(v);
      }
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      rounds = all.slice(0, totalRounds);
    }
    if (!rounds.length) {
      const mem = roomLikes.get((roomCode || '').toUpperCase());
      const total = mem ? Object.values(mem).reduce((s, arr) => s + (arr?.length || 0), 0) : 0;
      console.log('[start_game] Aucune vidéo. roomCode=%s playerIds=%s roomLikes total=%s', roomCode, playerIds.length, total);
      return ack?.({ error: 'Aucune vidéo. Clique sur « Prêt » (likes en public sur TikTok), attends le message de succès, puis relance.' });
    }
    room.status = 'preparing';
    room.gameState = {
      rounds,
      currentIndex: 0,
      votes: {},
      roundStartTime: null,
    };
    room.players.forEach(p => { p.score = 0; p.streak = 0; p.correctCount = 0; p.maxStreak = 0; });
    const playersForClient = getPlayerListForRoom(room);
    const roundUrls = rounds.map(r => r.video_url);
    io.to(roomCode).emit('game_preparing', { roundUrls, totalRounds: rounds.length, players: playersForClient });
    ack?.({ ok: true });
    runServerPreload(roomCode, rounds);
  });

  socket.on('preload_done', (data) => {
    const roomCode = (data?.code || '').toUpperCase();
    const room = getRoomByCode(roomCode);
    if (!room || room.status !== 'preparing') return;
    if (room.hostSocketId !== socket.id) return;
    room.status = 'playing';
    const playersForClient = getPlayerListForRoom(room);
    io.to(roomCode).emit('game_started', { players: playersForClient, totalRounds: room.gameState.rounds.length });
  });

  function sendNextRound(roomCode) {
    const room = getRoomByCode(roomCode);
    if (!room?.gameState) return;
    const { rounds, currentIndex } = room.gameState;
    const last = lastNextRoundSent.get(roomCode);
    const now = Date.now();
    if (last && last.index === currentIndex && (now - last.at) < 2500) return;
    lastNextRoundSent.set(roomCode, { index: currentIndex, at: now });
    if (currentIndex >= rounds.length) {
      const totalRoundsPlayed = rounds.length;
      const finalScores = room.players.map(p => ({
        playerId: p.playerId,
        username: p.username,
        score: p.score,
        correctCount: p.correctCount ?? 0,
        maxStreak: p.maxStreak ?? 0,
      }));
      io.to(roomCode).emit('game_over', { scores: finalScores, totalRounds: totalRoundsPlayed });
      serverPreloadCache.delete(roomCode);
      room.status = 'lobby';
      room.gameState = null;
      lastNextRoundSent.delete(roomCode);
      return;
    }
    const round = rounds[currentIndex];
    room.gameState.votes = {};
    room.gameState.roundStartTime = Date.now();
    io.to(roomCode).emit('next_round', {
      roundIndex: currentIndex,
      totalRounds: rounds.length,
      videoUrl: round.video_url,
      ownerId: round.owner_id,
      players: getPlayerListForRoom(room),
    });
  }

  socket.on('submit_vote', (data) => {
    const { code, targetPlayerId, roundIndex } = data || {};
    const room = getRoomByCode((code || '').toUpperCase());
    if (!room?.gameState) return;
    const { rounds, currentIndex, votes } = room.gameState;
    if (roundIndex !== currentIndex) return;
    const currentRound = rounds[currentIndex];
    const ownerId = currentRound.owner_id;
    const isSolo = room.players.length === 1;
    if (!isSolo && socket.id === room.players.find(p => p.playerId === ownerId)?.socketId) return;
    if (votes[socket.id] !== undefined) return;
    const responseTime = room.gameState.roundStartTime ? Date.now() - room.gameState.roundStartTime : 0;
    votes[socket.id] = { targetPlayerId, responseTime };
    const votersExpected = isSolo ? 1 : room.players.length - 1;
    if (Object.keys(votes).length < votersExpected) return;
    const BASE_POINTS = 100;
    const STREAK_BONUS = 50;
    const pointsThisRoundByPlayer = {};
    room.players.forEach(p => {
      const v = votes[p.socketId];
      if (!v) return;
      const correct = v.targetPlayerId === ownerId;
      if (correct) {
        p.streak = (p.streak || 0) + 1;
        p.correctCount = (p.correctCount || 0) + 1;
        p.maxStreak = Math.max(p.maxStreak || 0, p.streak);
        const points = BASE_POINTS + (p.streak - 1) * STREAK_BONUS;
        p.score = (p.score || 0) + points;
        pointsThisRoundByPlayer[p.playerId] = points;
      } else {
        p.streak = 0;
        pointsThisRoundByPlayer[p.playerId] = 0;
      }
    });
    touchRoom(room);
    const roundId = currentRound.id;
    const isDbRound = typeof roundId === 'number';
    if (db.pool && isDbRound) {
      db.recordPlayedVideo(room.code, roundId).catch((err) => console.error('[submit_vote] recordPlayedVideo failed:', err?.message || err));
    }
    const playedSet = roomPlayed.get(room.code);
    if (playedSet) playedSet.add(roundId);
    io.to(room.code).emit('start_reveal', { ownerId, roundIndex });
    const nextIndex = currentIndex + 1;
    const hasNext = nextIndex < rounds.length;
    setTimeout(() => {
      io.to(room.code).emit('reveal_winner', {
        ownerId,
        scores: getPlayerListForRoom(room).map(p => ({
          playerId: p.playerId,
          username: p.username,
          score: p.score,
          streak: p.streak,
          pointsThisRound: pointsThisRoundByPlayer[p.playerId] ?? 0,
        })),
        hasNextRound: hasNext,
      });
      room.gameState.currentIndex = nextIndex;
      setTimeout(() => sendNextRound(room.code), 1500);
    }, 2500);
  });

  socket.on('request_next_round', (data) => {
    const roomCode = (data?.code || '').toUpperCase();
    const room = getRoomByCode(roomCode);
    if (!room?.gameState) return;
    if (room.hostSocketId !== socket.id) return;
    sendNextRound(roomCode);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx === -1) continue;
      room.players.splice(idx, 1);
      if (room.players.length === 0) {
        rooms.delete(code);
      } else {
        if (room.hostSocketId === socket.id) room.hostSocketId = room.players[0].socketId;
        io.to(code).emit('room_updated', { players: getPlayerListForRoom(room) });
      }
      break;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Guess The Like — http://localhost:' + PORT));
