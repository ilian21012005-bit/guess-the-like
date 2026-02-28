const config = require('../config');
const playwrightQueue = require('./playwright-queue');

const SERVER_PRELOAD_WORKERS = config.SERVER_PRELOAD_WORKERS;
const SERVER_PRELOAD_VIDEO_TIMEOUT_MS = config.SERVER_PRELOAD_VIDEO_TIMEOUT_MS;
const PRELOAD_MIN_BEFORE_START = config.PRELOAD_MIN_BEFORE_START;
const PRELOAD_CACHE_MAX_ROOMS = config.PRELOAD_CACHE_MAX_ROOMS || 5;
const PRELOAD_DELAY_BETWEEN_MS = config.PRELOAD_DELAY_BETWEEN_MS || 0;

// roomCode -> { rounds: Array<{buffer, contentType}|null>, createdAt }
const cache = new Map();
const insertionOrder = [];

function evictOldestIfNeeded() {
  while (insertionOrder.length >= PRELOAD_CACHE_MAX_ROOMS && insertionOrder.length > 0) {
    const oldest = insertionOrder.shift();
    if (cache.has(oldest)) {
      cache.delete(oldest);
      console.log('[preload] cache evicted room=%s (max %s rooms)', oldest, PRELOAD_CACHE_MAX_ROOMS);
    }
  }
}

function getCache() {
  return cache;
}

function fetchOneVideoForPreload(pageUrl) {
  const trimmed = pageUrl.trim();
  return new Promise((resolve) => {
    const timeoutPromise = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('TIMEOUT')), SERVER_PRELOAD_VIDEO_TIMEOUT_MS)
    );
    const work = (async () => {
      const fallback = await playwrightQueue.enqueue(trimmed);
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

function runServerPreload(io, getRoomByCode, getPlayerListForRoom, roomCode, rounds) {
  const total = rounds.length;
  evictOldestIfNeeded();
  const cacheEntry = { rounds: new Array(total), createdAt: Date.now() };
  cache.set(roomCode, cacheEntry);
  insertionOrder.push(roomCode);

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
    const entry = cache.get(rc);
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
      console.log('[preload] room %s stats: %s success, %s fail (PLAYWRIGHT_CONCURRENT=%s)', rc, success, fail, config.PLAYWRIGHT_CONCURRENT);
    }
    if (PRELOAD_DELAY_BETWEEN_MS > 0) {
      setTimeout(() => processNext(), PRELOAD_DELAY_BETWEEN_MS);
    } else {
      processNext();
    }
  };

  const workers = Math.min(SERVER_PRELOAD_WORKERS, jobs.length);
  for (let i = 0; i < workers; i++) processNext();
}

function deleteFromCache(roomCode) {
  cache.delete(roomCode);
  const idx = insertionOrder.indexOf(roomCode);
  if (idx !== -1) insertionOrder.splice(idx, 1);
}

module.exports = {
  getCache,
  runServerPreload,
  deleteFromCache,
};
