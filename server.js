try { require('dotenv').config(); } catch (e) { console.warn('[env] dotenv non chargé:', e?.message || e); }
const path = require('path');
const http = require('http');
const { Readable } = require('stream');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./config');
const { harvestLikes, getTikTokMp4Url, getTikTokMp4Buffer } = require('./scraper');
const db = require('./db');

const PLAYWRIGHT_CONCURRENT = config.PLAYWRIGHT_CONCURRENT;
let playwrightMissingLogged = false;
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
const SERVER_PRELOAD_WORKERS = config.SERVER_PRELOAD_WORKERS;
const SERVER_PRELOAD_VIDEO_TIMEOUT_MS = config.SERVER_PRELOAD_VIDEO_TIMEOUT_MS;
const PRELOAD_MIN_BEFORE_START = config.PRELOAD_MIN_BEFORE_START;

// Préchargement : appel direct à Playwright (évite getTikTokMp4Url + fetch 403 inutiles).
function fetchOneVideoForPreload(pageUrl) {
  const trimmed = pageUrl.trim();
  return new Promise((resolve) => {
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), SERVER_PRELOAD_VIDEO_TIMEOUT_MS));
    const work = (async () => {
      const fallback = await enqueuePlaywrightFallback(trimmed);
      return fallback.buffer ? { buffer: fallback.buffer, contentType: fallback.contentType || 'video/mp4' } : null;
    })();
    Promise.race([work, timeoutPromise])
      .then(resolve)
      .catch((err) => {
        console.warn('[preload] fetchOneVideoForPreload timeout/erreur:', err?.message || err);
        resolve(null);
      });
  });
}

function runServerPreload(roomCode, rounds) {
  const total = rounds.length;
  const cacheEntry = { rounds: new Array(total), createdAt: Date.now() };
  serverPreloadCache.set(roomCode, cacheEntry);
  const room = getRoomByCode(roomCode);
  if (!room) return;
  const minBeforeStart = Math.min(PRELOAD_MIN_BEFORE_START, total);
  let completed = 0;
  let gameStartedEmitted = false;
  const jobs = rounds.map((r, i) => ({ roomCode, index: i, url: r.video_url }));
  const processNext = async () => {
    const job = jobs.shift();
    if (!job) return;
    const { roomCode: rc, index, url } = job;
    const t0 = Date.now();
    console.log('[preload] round %s/%s start', index + 1, total);
    let result = await fetchOneVideoForPreload(url);
    if (!result && index < minBeforeStart) {
      result = await fetchOneVideoForPreload(url);
    }
    const elapsed = Date.now() - t0;
    const entry = serverPreloadCache.get(rc);
    if (entry) {
      entry.rounds[index] = result;
      if (result) {
        console.log('[preload] round %s/%s done in %s ms', index + 1, total, elapsed);
      } else {
        console.warn('[preload] round %s/%s failed after %s ms url=%s', index + 1, total, elapsed, (url || '').slice(0, 80));
      }
    }
    completed++;
    if (completed % 10 === 0) {
      const mem = process.memoryUsage();
      console.log('[preload] memory heapUsed=%s MB rss=%s MB (after %s/%s)', Math.round(mem.heapUsed / 1024 / 1024), Math.round(mem.rss / 1024 / 1024), completed, total);
    }
    io.to(rc).emit('preload_progress', { roomCode: rc, loaded: completed, total });
    if (completed >= minBeforeStart && !gameStartedEmitted) {
      const r = getRoomByCode(rc);
      if (r && r.status === 'preparing') {
        gameStartedEmitted = true;
        r.status = 'playing';
        const playersForClient = getPlayerListForRoom(r);
        io.to(rc).emit('game_started', { players: playersForClient, totalRounds: total });
      }
    }
    if (completed === total && entry) {
      const success = entry.rounds.filter(Boolean).length;
      const fail = total - success;
      console.log('[preload] room %s stats: %s success, %s fail (PLAYWRIGHT_CONCURRENT=%s)', rc, success, fail, PLAYWRIGHT_CONCURRENT);
    }
    processNext();
  };
  const workers = Math.min(SERVER_PRELOAD_WORKERS, jobs.length);
  for (let i = 0; i < workers; i++) processNext();
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
// polling en premier pour mieux passer les proxies (ex. Render) ; websocket en upgrade.
const io = new Server(server, {
  cors: { origin: config.ALLOWED_ORIGIN },
  transports: ['polling', 'websocket'],
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => { res.status(200).end('ok'); });

const videoRateLimit = new Map();
function checkVideoRateLimit(ip) {
  const now = Date.now();
  let bucket = videoRateLimit.get(ip) || { count: 0, resetAt: now + config.VIDEO_RATE_LIMIT_WINDOW_MS };
  if (now >= bucket.resetAt) bucket = { count: 0, resetAt: now + config.VIDEO_RATE_LIMIT_WINDOW_MS };
  bucket.count++;
  videoRateLimit.set(ip, bucket);
  return bucket.count <= config.VIDEO_RATE_LIMIT_MAX;
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
  const body = req.body != null ? req.body : {};
  const { token, urls } = body;
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
  emitRoomUpdated(room);
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
        console.log('[tiktok-video] cache hit room=%s index=%s', roomCode, index);
        res.setHeader('Content-Type', cached.contentType || 'video/mp4');
        res.setHeader('Content-Length', cached.buffer.length);
        return res.status(200).end(cached.buffer);
      }
      console.warn('[tiktok-video] cache miss (null) room=%s index=%s url=%s', roomCode, index, (pageUrl || '').trim().slice(0, 120));
    }
  }
  let trimmed = pageUrl.trim();
  try {
    if (trimmed.includes('%')) trimmed = decodeURIComponent(trimmed);
  } catch (_) {
    console.warn('[tiktok-video] URL mal formée (decodeURIComponent):', pageUrl.slice(0, 80));
    return res.status(400).end();
  }
  let hostOk = false;
  try {
    const u = new URL(trimmed);
    const host = (u.hostname || '').toLowerCase();
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com') || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') hostOk = true;
  } catch (_) {
    // Si new URL échoue mais que la chaîne ressemble à TikTok, on autorise (fallback intentionnel).
  }
  if (!hostOk && !/tiktok\.com/.test(trimmed)) {
    console.warn('[tiktok-video] 403 URL non autorisée. Début reçu:', pageUrl.slice(0, 80));
    return res.status(403).end();
  }
  if (!hostOk) hostOk = true;
  const t0 = Date.now();
  const VIDEO_EXTRACT_TIMEOUT_MS = config.VIDEO_EXTRACT_TIMEOUT_MS;
  let responseSent = false;
  function sendOnce(status, body) {
    if (responseSent) return;
    responseSent = true;
    if (body !== undefined) res.status(status).end(body);
    else res.status(status).end();
  }
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), VIDEO_EXTRACT_TIMEOUT_MS));
  const usePlaywrightDirect = config.USE_PLAYWRIGHT_DIRECT;
  const work = (async () => {
    if (usePlaywrightDirect) {
      console.log('[tiktok-video] mode direct Playwright (USE_PLAYWRIGHT_DIRECT)');
      const fallback = await enqueuePlaywrightFallback(trimmed);
      if (fallback.buffer && !responseSent) {
        responseSent = true;
        res.setHeader('Content-Type', fallback.contentType || 'video/mp4');
        res.setHeader('Content-Length', fallback.buffer.length);
        res.status(200).end(fallback.buffer);
      } else if (!responseSent) sendOnce(fallback.error ? 504 : 404);
      return;
    }
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
    console.log('[tiktok-video] fetch CDN: ' + r.status + ' (' + (Date.now() - t0) + ' ms)');
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
      const errMsg = fallback.error || '';
      if (errMsg.includes('Executable doesn\'t exist') || errMsg.includes('chromium')) {
        if (!playwrightMissingLogged) {
          playwrightMissingLogged = true;
          console.warn('[tiktok-video] Secours Playwright indisponible (Chromium non installé). Vidéos en 403 sur cet hébergement.');
        }
      } else {
        console.warn('[tiktok-video] secours Playwright échec:', errMsg);
      }
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
    if (responseSent) return;
    if (err && err.message === 'TIMEOUT') {
      console.warn('[tiktok-video] timeout après ' + VIDEO_EXTRACT_TIMEOUT_MS + ' ms — fallback URL TikTok.');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).end(JSON.stringify({ fallbackUrl: trimmed, error: 'TIMEOUT' }));
    }
    console.error('[tiktok-video] erreur inattendue:', err?.message || err);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).end(JSON.stringify({ fallbackUrl: trimmed, error: err?.message || 'UNKNOWN' }));
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

function getPlayerListForRoom(room, playableCounts = null) {
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
    playableCount: playableCounts && playableCounts[p.playerId] !== undefined ? playableCounts[p.playerId] : null,
  }));
}

async function getRoomUpdatedPayload(room) {
  const playerIds = room.players.map(p => p.playerId);
  let playableCounts = {};
  if (db.pool && playerIds.length) {
    try {
      playableCounts = await db.getPlayableVideoCount(playerIds);
    } catch (_) {}
  }
  return { players: getPlayerListForRoom(room, playableCounts) };
}

function emitRoomUpdated(room) {
  getRoomUpdatedPayload(room).then((payload) => io.to(room.code).emit('room_updated', payload));
}

io.on('connection', (socket) => {
  socket.on('create_room', async (data, ack) => {
    const { username, tiktokUsername, avatarUrl } = data || {};
    if (!username?.trim()) return ack?.({ error: 'Username required' });
    let player = { id: socket.id, username: username.trim(), tiktok_username: (tiktokUsername || username).trim(), avatar_url: null };
    if (db.pool) {
      try {
        player = await db.getOrCreatePlayer(username.trim(), (tiktokUsername || username).trim()) || player;
      } catch (err) {
        console.error('[create_room] getOrCreatePlayer failed:', err?.message || err);
        return ack?.({ error: 'Erreur base de données. Réessaie ou lance sans DATABASE_URL.' });
      }
    }
    const playerId = player?.id ?? socket.id;
    if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.length > 500000) return ack?.({ error: 'Image de profil trop lourde (max ~500 Ko).' });
    const avatar = (avatarUrl && typeof avatarUrl === 'string' && (avatarUrl.startsWith('http') || avatarUrl.startsWith('data:'))) ? avatarUrl : (player?.avatar_url || null);
    let code = generateCode();
    while (rooms.has(code)) code = generateCode();
    let roomId = null;
    if (db.pool) {
      try {
        const created = await db.createRoom(code);
        if (created) roomId = created.id;
      } catch (err) {
        console.error('[create_room] createRoom failed:', err?.message || err);
        return ack?.({ error: 'Erreur base de données. Réessaie.' });
      }
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
    if (db.pool && roomId) {
      try {
        await db.addPlayerToRoom(roomId, playerId, socket.id);
      } catch (err) {
        console.error('[create_room] addPlayerToRoom failed:', err?.message || err);
        rooms.delete(code);
        return ack?.({ error: 'Erreur base de données. Réessaie.' });
      }
    }
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
    let player = { id: socket.id, username: username.trim(), tiktok_username: (tiktokUsername || username).trim(), avatar_url: null };
    if (db.pool) {
      try {
        player = await db.getOrCreatePlayer(username.trim(), (tiktokUsername || username).trim()) || player;
      } catch (err) {
        console.error('[join_room] getOrCreatePlayer failed:', err?.message || err);
        return ack?.({ error: 'Erreur base de données. Réessaie ou lance sans DATABASE_URL.' });
      }
    }
    const playerId = player?.id ?? socket.id;
    const avatar = (avatarUrl && typeof avatarUrl === 'string' && (avatarUrl.startsWith('http') || avatarUrl.startsWith('data:'))) ? avatarUrl : (player?.avatar_url || null);
    if (room.players.some(p => p.playerId === playerId || p.socketId === socket.id)) return ack?.({ error: 'Already in room' });
    room.players.push({ socketId: socket.id, playerId, username: player?.username ?? username, tiktokUsername: player?.tiktok_username ?? (tiktokUsername || username), avatarUrl: avatar, isReady: false, score: 0, streak: 0 });
    if (db.pool && room.roomId) {
      try {
        await db.addPlayerToRoom(room.roomId, playerId, socket.id);
      } catch (err) {
        console.error('[join_room] addPlayerToRoom failed:', err?.message || err);
        room.players.pop();
        return ack?.({ error: 'Erreur base de données. Réessaie.' });
      }
    }
    socket.join(roomCode);
    touchRoom(room);
    emitRoomUpdated(room);
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
    emitRoomUpdated(room);
    ack?.({ status: 'scraping' });

    let result;
    try {
      console.log('[set_ready] Début récupération likes pour @%s…', tiktokUser);
      result = await harvestLikes(tiktokUser, 150);
    } catch (err) {
      console.error('[set_ready] Erreur scraper:', err.message || err);
      me.isReady = false;
      emitRoomUpdated(room);
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
      emitRoomUpdated(room);
      console.log('[set_ready] Erreur retournée:', result.error);
      let errMsg = result.error;
      if (config.CHROME_DEBUG_URL && /ECONNREFUSED|127\.0\.0\.1:9222/.test(result.error)) {
        errMsg = 'Chrome n\'écoute pas sur le port 9222. Ferme TOUTES les fenêtres Chrome, puis lance uniquement : .\\scripts\\launch-chrome-debug.ps1 — garde cette fenêtre ouverte et réessaie Prêt.';
      }
      return ack?.({ error: errMsg });
    }
    if (count === 0) {
      me.isReady = false;
      emitRoomUpdated(room);
      return ack?.({ error: 'Aucun like récupéré. Vérifie ton @ TikTok et que tes likes sont bien en public.' });
    }
    if (db.pool && me.playerId) {
      try {
        await db.saveLikes(me.playerId, result.videos);
      } catch (err) {
        console.error('[set_ready] saveLikes failed:', err?.message || err);
        // On continue : les likes sont quand même stockés en mémoire ci-dessous.
      }
    }
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
    emitRoomUpdated(room);
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
    emitRoomUpdated(room);
    console.log('[import_likes] Stored %s links for room=%s playerId=%s', list.length, key, me.playerId);
    ack?.({ ok: true, count: list.length });
  });

  socket.on('start_game', async (data, ack) => {
    const roomCode = (data?.code || '').toUpperCase();
    const totalRounds = Math.min(Math.max(parseInt(data?.totalRounds, 10) || config.PRELOAD_INITIAL_VIDEOS, 10), config.PRELOAD_INITIAL_VIDEOS);
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
      try {
        const fromDb = await db.getVideosForRoom(roomCode, playerIds, totalRounds);
        rounds = fromDb.filter(r => !played.has(r.id));
      } catch (err) {
        console.error('[start_game] getVideosForRoom failed:', err?.message || err);
        // Fallback sur les likes en mémoire.
      }
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
      let playableCounts = {};
      if (db.pool && playerIds.length) {
        try {
          playableCounts = await db.getPlayableVideoCount(playerIds);
        } catch (_) {}
      }
      const parts = room.players.map((p) => {
        const n = playableCounts[p.playerId] ?? 0;
        return `${p.username} : ${n} vidéo(s) jouable(s)`;
      });
      const msg = parts.length
        ? `Aucune vidéo pour lancer cette partie. ${parts.join(' — ')}. Choisis ce nombre de manches ou moins, ou importe plus de liens TikTok.`
        : 'Aucune vidéo. Importe des liens TikTok dans le lobby (voir les 3 étapes ci-dessus).';
      return ack?.({ error: msg, playableCounts });
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
    const preloadTotal = rounds.length;
    io.to(roomCode).emit('game_preparing', { roundUrls, totalRounds: rounds.length, preloadTotal, players: playersForClient });
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

  socket.on('video_play_failed', (data) => {
    const { code, roundIndex, videoUrl } = data || {};
    const roomCode = (code || '').toUpperCase();
    console.warn('[video] client signale lecture impossible round=%s url=%s room=%s', roundIndex, (videoUrl || '').slice(0, 120), roomCode);
  });

  socket.on('submit_vote', (data) => {
    const { code, targetPlayerId, roundIndex } = data || {};
    const room = getRoomByCode((code || '').toUpperCase());
    if (!room?.gameState) return;
    const { rounds, currentIndex, votes } = room.gameState;
    if (roundIndex !== currentIndex) return;
    const currentRound = rounds[currentIndex];
    const ownerId = currentRound.owner_id;
    const connectedPlayers = room.players.filter(p => p.socketId);
    const isSolo = connectedPlayers.length === 1;
    if (!isSolo && socket.id === room.players.find(p => p.playerId === ownerId)?.socketId) return;
    if (votes[socket.id] !== undefined) return;
    const responseTime = room.gameState.roundStartTime ? Date.now() - room.gameState.roundStartTime : 0;
    votes[socket.id] = { targetPlayerId, responseTime };
    const connectedNonOwner = room.players.filter(p => p.socketId && String(p.playerId) !== String(ownerId));
    const votersExpected = isSolo ? 1 : connectedNonOwner.length;
    if (Object.keys(votes).length < votersExpected) return;
    const BASE_POINTS = 100;
    const STREAK_BONUS = 50;
    const pointsThisRoundByPlayer = {};
    room.players.forEach(p => {
      const v = p.socketId ? votes[p.socketId] : null;
      if (!v) {
        pointsThisRoundByPlayer[p.playerId] = 0;
        return;
      }
      const correct = String(v.targetPlayerId) === String(ownerId);
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
      const p = room.players.find(pl => pl.socketId === socket.id);
      if (!p) continue;
      p.socketId = null;
      const connected = room.players.filter(pl => pl.socketId);
      if (connected.length === 0) {
        rooms.delete(code);
      } else {
        if (room.hostSocketId === socket.id) room.hostSocketId = connected[0].socketId;
        emitRoomUpdated(room);
      }
      break;
    }
  });

  socket.on('rejoin_room', (data, ack) => {
    const { code, playerId } = data || {};
    const roomCode = (code || '').toUpperCase().trim();
    const room = getRoomByCode(roomCode);
    if (!room) return ack?.({ error: 'Room not found' });
    const me = room.players.find(p => String(p.playerId) === String(playerId));
    if (!me) return ack?.({ error: 'Player not in this room' });
    if (me.socketId) return ack?.({ error: 'Already connected' });
    me.socketId = socket.id;
    socket.join(roomCode);
    touchRoom(room);
    const { rounds, currentIndex } = room.gameState || {};
    const currentRound = rounds && rounds[currentIndex];
    ack?.({
      ok: true,
      playerId: me.playerId,
      players: getPlayerListForRoom(room),
      reconnected: true,
      isHost: room.hostSocketId === socket.id,
      gameState: room.status === 'playing' || room.status === 'preparing' ? {
        roundIndex: currentIndex,
        totalRounds: rounds?.length || 0,
        videoUrl: currentRound?.video_url,
        ownerId: currentRound?.owner_id,
      } : null,
    });
    emitRoomUpdated(room);
    if (room.status === 'playing' && currentRound) {
      socket.emit('next_round', {
        roundIndex: currentIndex,
        totalRounds: rounds.length,
        videoUrl: currentRound.video_url,
        ownerId: currentRound.owner_id,
        players: getPlayerListForRoom(room),
      });
    }
  });
});

const PORT = config.PORT;
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => console.log('Guess The Like — http://localhost:' + PORT));
}
module.exports = { app, server };
