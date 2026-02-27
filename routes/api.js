const { Readable } = require('stream');

function register(app, deps) {
  const {
    config,
    getTikTokMp4Url,
    playwrightEnqueue,
    checkVideoRateLimit,
    getRoomByCode,
    getPreloadCache,
    bookmarkletTokens,
    roomLikes,
    io,
    emitRoomUpdated,
    setPlaywrightMissingLogged,
  } = deps;

  app.get('/health', (req, res) => {
    res.status(200).end('ok');
  });

  app.post('/api/import-likes-from-bookmarklet', (req, res) => {
    const body = req.body != null ? req.body : {};
    const { token, urls } = body;
    deps.cleanupBookmarkletTokens();
    const data = token ? bookmarkletTokens.get(token) : null;
    if (!data) return res.status(400).json({ error: 'Lien expiré ou invalide. Régénère le lien dans le lobby.' });
    bookmarkletTokens.delete(token);
    const room = getRoomByCode(data.roomCode);
    if (!room) return res.status(400).json({ error: 'Salon introuvable.' });
    const me = room.players.find((p) => p.playerId === data.playerId || p.socketId === data.socketId);
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

  app.get('/api/tiktok-video', async (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!checkVideoRateLimit(ip)) return res.status(429).json({ error: 'Trop de requêtes.' });
    const pageUrl = req.query.url;
    if (!pageUrl || typeof pageUrl !== 'string') return res.status(400).end();
    const serverPreloadCache = getPreloadCache();
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
    } catch (_) {}
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
        const fallback = await playwrightEnqueue(trimmed);
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
      if (result.error || !result.url) {
        sendOnce(404);
        return;
      }
      const mp4Url = result.url.startsWith('//') ? 'https:' + result.url : result.url;
      const controller = new AbortController();
      const fetchTimeoutMs = Math.min(4000, VIDEO_EXTRACT_TIMEOUT_MS - (Date.now() - t0) - 2000);
      const to = setTimeout(() => controller.abort(), fetchTimeoutMs);
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: trimmed.split('?')[0] || 'https://www.tiktok.com/',
        Origin: 'https://www.tiktok.com',
        Accept: '*/*',
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
        const fallback = await playwrightEnqueue(trimmed);
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
        const fallback = await playwrightEnqueue(trimmed);
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
        if (errMsg.includes("Executable doesn't exist") || errMsg.includes('chromium')) {
          if (!deps.getPlaywrightMissingLogged()) {
            setPlaywrightMissingLogged(true);
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
        Referer: 'https://www.tiktok.com/',
        Accept: '*/*',
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
}

module.exports = { register };
