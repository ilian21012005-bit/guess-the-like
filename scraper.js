const { chromium } = require('playwright');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1280, height: 720 };
let _playwrightMissingLogged = false;
function _logPlaywrightMissing(err) {
  const msg = err && (err.message || String(err));
  if (msg && (msg.includes('Executable doesn\'t exist') || msg.includes('chromium'))) {
    if (!_playwrightMissingLogged) {
      _playwrightMissingLogged = true;
      console.warn('[scraper] Chromium non installé (Playwright). Exécuter: npx playwright install chromium');
    }
    return true;
  }
  return false;
}

// Navigateur partagé pour getTikTokMp4Buffer (évite un launch par vidéo, ~5–10 s gagnés par appel).
let _sharedBrowser = null;
let _sharedBrowserPromise = null;
async function _getSharedBrowser() {
  if (_sharedBrowser) return _sharedBrowser;
  if (_sharedBrowserPromise) return _sharedBrowserPromise;
  _sharedBrowserPromise = chromium.launch({ headless: true }).then((b) => {
    _sharedBrowser = b;
    return b;
  }).catch((err) => {
    _sharedBrowserPromise = null;
    throw err;
  });
  return _sharedBrowserPromise;
}

/** Dossier où est sauvegardée la session TikTok (cookies/connexion). */
const SESSION_DIR = path.join(__dirname, '.playwright-tiktok-session');
/** Si défini (ex. ton profil Chrome), on l'utilise pour launchPersistentContext. */
function getSessionDir() {
  const custom = process.env.CHROME_USER_DATA;
  if (custom && require('fs').existsSync(custom)) return path.resolve(custom);
  return SESSION_DIR;
}

/** Si défini (ex. http://localhost:9222), on se connecte à un Chrome déjà ouvert au lieu de lancer un nouveau. */
function getChromeDebugUrl() {
  const url = process.env.CHROME_DEBUG_URL;
  if (!url || !url.startsWith('http')) return null;
  // Forcer IPv4 pour éviter ECONNREFUSED sur ::1 (Windows)
  return url.replace(/\/$/, '').replace(/localhost/i, '127.0.0.1');
}

/**
 * Collecte des liens vidéo : même logique que le script console qui fonctionne chez toi.
 * Tous les <a>, filtre href contient /video/, dédoublonnage avec Set.
 */
function collectVideoLinksFromDOM(page) {
  return page.evaluate(() => {
    const tousLesLiens = Array.from(document.querySelectorAll('a'));
    const liensVideos = tousLesLiens
      .map(a => a.href)
      .filter(href => href && href.includes('/video/'));
    return [...new Set(liensVideos)];
  });
}

/**
 * Récupère les vidéos likées d'un utilisateur TikTok.
 * En mode "session" : utilise un profil Chrome persistant où tu es déjà connecté (comme ton test manuel).
 *
 * @param {string} username - Identifiant TikTok (avec ou sans @)
 * @param {number} limit - Nombre max d'URLs (défaut 100)
 * @param {{ useSession?: boolean, headless?: boolean }} options - useSession: utiliser la session persistante (recommandé). headless: false pour voir le navigateur et te connecter la 1ère fois.
 * @returns {Promise<{ error?: string, videos?: string[] }>}
 */
async function fetchUserLikes(username, limit = 100, options = {}) {
  const { useSession = true, headless: optionHeadless = true } = options;
  const cleanUsername = String(username).replace(/^@/, '').trim();
  if (!cleanUsername) return { error: 'Username vide' };

  const cdpUrl = getChromeDebugUrl();
  const sessionDir = useSession ? getSessionDir() : null;
  const isChromeProfile = useSession && process.env.CHROME_USER_DATA && require('fs').existsSync(process.env.CHROME_USER_DATA);
  const headless = isChromeProfile ? false : optionHeadless;

  let browser;
  let context;
  let page;
  /** true si on s'est connecté à un Chrome existant : on ne ferme pas le contexte à la fin. */
  let connectedViaCdp = false;

  try {
    if (cdpUrl) {
      console.log('[scraper] Connexion à Chrome déjà ouvert:', cdpUrl);
      browser = await chromium.connectOverCDP(cdpUrl);
      context = browser.contexts()[0];
      if (!context) context = await browser.newContext();
      page = context.pages()[0] || await context.newPage();
      connectedViaCdp = true;
    } else if (useSession) {
      console.log('[scraper] Session utilisée:', sessionDir, headless ? '(headless)' : '(fenêtre visible)');
      context = await chromium.launchPersistentContext(sessionDir, {
        headless,
        channel: 'chrome',
        viewport: VIEWPORT,
        userAgent: USER_AGENT,
        locale: 'fr-FR',
        ignoreHTTPSErrors: true,
        args: headless ? [] : ['--no-sandbox'],
      });
      page = context.pages()[0] || await context.newPage();
      if (!page) page = await context.newPage();
    } else {
      browser = await chromium.launch({ headless: optionHeadless });
      context = await browser.newContext({
        userAgent: USER_AGENT,
        viewport: VIEWPORT,
        locale: 'fr-FR',
        ignoreHTTPSErrors: true,
      });
      page = await context.newPage();
    }

    const profileUrl = `https://www.tiktok.com/@${cleanUsername}`;
    let navOk = true;
    try {
      await page.goto(profileUrl, { waitUntil: 'load', timeout: 30000 });
    } catch (e) {
      navOk = false;
      console.warn('[scraper] fetchUserLikes page.goto failed:', e?.message || e);
    }
    if (!navOk) {
      if (connectedViaCdp) await browser?.close(); else { try { if (context) await context.close(); } catch (e2) { console.warn('[scraper] context.close:', e2?.message); } try { if (browser) await browser.close(); } catch (e2) { console.warn('[scraper] browser.close:', e2?.message); } }
      return { error: 'NAVIGATION_FAILED' };
    }
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    if (!finalUrl.includes(cleanUsername)) {
      if (connectedViaCdp) await browser?.close(); else { try { if (context) await context.close(); } catch (e2) { console.warn('[scraper] context.close:', e2?.message); } try { if (browser) await browser.close(); } catch (e2) { console.warn('[scraper] browser.close:', e2?.message); } }
      return { error: 'LOGIN_REQUIRED' };
    }

    // En cas d'erreur evaluate (page pas prête, etc.), on considère le profil comme privé (safe default).
    const isPrivate = await page.evaluate(() => {
      const lock = document.querySelector('[data-e2e="liked-tab-lock"]');
      if (lock) return true;
      const body = (document.body?.innerText || '').toLowerCase();
      if (body.includes("liked videos are private") || body.includes("vidéos aimées sont privées")) return true;
      return false;
    }).catch(() => true);

    if (isPrivate) {
      if (connectedViaCdp) await browser?.close(); else { try { if (context) await context.close(); } catch (e2) { console.warn('[scraper] context.close:', e2?.message); } try { if (browser) await browser.close(); } catch (e2) { console.warn('[scraper] browser.close:', e2?.message); } }
      return { error: 'PRIVACY_LOCKED' };
    }

    let clicked = false;
    const tabSelectors = [
      'a[href*="/liked"]',
      '[data-e2e="user-tab-liked"]',
      '[data-e2e="browse-liked"]',
    ];
    for (const sel of tabSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          clicked = true;
          break;
        }
      } catch (_) {}
    }
    if (!clicked) {
      clicked = await page.evaluate(() => {
        const a = document.querySelector('a[href*="liked"]');
        if (a) { a.click(); return true; }
        const byText = [...document.querySelectorAll('a, div[role="tab"], [data-e2e]')].find(el =>
          /^(liked|j\'aime|a aimé|aimé|favoris)$/i.test((el.textContent || '').trim())
        );
        if (byText) { byText.click(); return true; }
        return false;
      }).catch(() => false);
    }
    if (!clicked) {
      try {
        await page.goto(`https://www.tiktok.com/@${cleanUsername}/liked`, { waitUntil: 'load', timeout: 15000 });
        if (page.url().includes('liked') || page.url().includes(cleanUsername)) clicked = true;
      } catch (_) {}
    }
    if (!clicked) {
      if (connectedViaCdp) await browser?.close(); else { try { if (context) await context.close(); } catch (e2) { console.warn('[scraper] context.close:', e2?.message); } try { if (browser) await browser.close(); } catch (e2) { console.warn('[scraper] browser.close:', e2?.message); } }
      return { error: 'Liked tab not found' };
    }

    await page.waitForTimeout(4000);

    const videos = new Set();
    let noGrowthCount = 0;
    const maxNoGrowth = 12;
    const scrollStep = 600;
    const scrollDelay = 800;

    while (videos.size < limit && noGrowthCount < maxNoGrowth) {
      const links = await collectVideoLinksFromDOM(page);
      const prevSize = videos.size;
      links.forEach(url => videos.add(url));

      if (videos.size === prevSize) noGrowthCount++;
      else noGrowthCount = 0;

      await page.evaluate((step) => window.scrollBy(0, step), scrollStep);
      await page.waitForTimeout(scrollDelay);
    }

    if (connectedViaCdp) await browser?.close(); else { try { if (context) await context.close(); } catch (e2) { console.warn('[scraper] context.close:', e2?.message); } try { if (browser) await browser.close(); } catch (e2) { console.warn('[scraper] browser.close:', e2?.message); } }

    const list = Array.from(videos).slice(0, limit);
    return { videos: list };
  } catch (err) {
    try {
      if (connectedViaCdp) await browser?.close(); else { if (context) await context.close(); if (browser) await browser.close(); }
    } catch (e2) { console.warn('[scraper] cleanup on error:', e2?.message); }
    return { error: err.message || 'SCRAPE_ERROR' };
  }
}

/**
 * Alias pour le serveur (utilise la session par défaut).
 */
async function harvestLikes(username, targetCount = 150) {
  return fetchUserLikes(username, targetCount, { useSession: true, headless: true });
}

function unescapeTiktokUrl(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/\\u002F/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseVideoUrlFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(/"playAddr"\s*:\s*"((?:[^"\\]|\\.)*)"/) || html.match(/"downloadAddr"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m || !m[1]) return null;
  const url = unescapeTiktokUrl(m[1]);
  return url && (url.startsWith('http') || url.startsWith('//')) ? url : null;
}

/**
 * Récupère l'URL directe du fichier vidéo (.mp4) à partir d'une page TikTok.
 * Méthode "Roi" : on récupère l'URL du flux pour l'afficher dans un <video> HTML5.
 * @param {string} videoPageUrl - URL complète (ex. https://www.tiktok.com/@user/video/123)
 * @returns {Promise<{ url?: string, error?: string }>}
 */
function getVideoIdFromUrl(pageUrl) {
  const m = String(pageUrl || '').match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

async function getTikTokMp4Url(videoPageUrl) {
  const url = String(videoPageUrl || '').trim();
  if (!url.includes('tiktok.com') || !url.includes('/video/')) return { error: 'URL TikTok invalide' };
  const videoId = getVideoIdFromUrl(url);
  const totalStart = Date.now();

  // Retourne l'URL MP4 extraite du HTML ou null si fetch/parse échoue (pas d'erreur propagée).
  const tryFetch = async (targetUrl) => {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml', 'Referer': 'https://www.tiktok.com/' },
      redirect: 'follow',
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(to);
    if (!res || !res.ok) return null;
    const html = await res.text();
    return parseVideoUrlFromHtml(html);
  };

  if (videoId) {
    const tEmbed0 = Date.now();
    const embedUrl = 'https://www.tiktok.com/embed/v2/' + videoId;
    let embedUrlResult = await tryFetch(embedUrl);
    if (embedUrlResult) console.log('[scraper] fetch embed: ' + (Date.now() - tEmbed0) + ' ms (OK)');
    if (embedUrlResult && (embedUrlResult.startsWith('http') || embedUrlResult.startsWith('//'))) {
      console.log('[scraper] getTikTokMp4Url total: ' + (Date.now() - totalStart) + ' ms (embed)');
      return { url: embedUrlResult.startsWith('//') ? 'https:' + embedUrlResult : embedUrlResult };
    }
  }
  let videoUrl = await tryFetch(url);
  if (!videoUrl && videoId) {
    const embedUrl = 'https://www.tiktok.com/embed/v2/' + videoId;
    videoUrl = await tryFetch(embedUrl);
  }
  if (videoUrl && (videoUrl.startsWith('http') || videoUrl.startsWith('//'))) {
    console.log('[scraper] getTikTokMp4Url total: ' + (Date.now() - totalStart) + ' ms (page)');
    return { url: videoUrl.startsWith('//') ? 'https:' + videoUrl : videoUrl };
  }

  // Playwright : interception réseau pour récupérer l’URL .mp4
  const tPw0 = Date.now();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    console.log('[scraper] Playwright launch: ' + (Date.now() - tPw0) + ' ms');
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 390, height: 844 },
      locale: 'fr-FR',
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' },
    });
    const page = await context.newPage();

    const mp4Urls = [];
    page.on('response', (response) => {
      const u = response.url();
      const ok = response.status() === 200 || response.status() === 206;
      if (ok && u.startsWith('http') && (u.includes('.mp4') || u.includes('/video/') || u.includes('tiktokv') && u.includes('tos'))) {
        mp4Urls.push(u);
      }
    });

    const tryPage = async (pageUrl) => {
      mp4Urls.length = 0;
      let navOk = true;
      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (_) {
        navOk = false;
      }
      if (!navOk) return null;
      await page.waitForTimeout(1500);
      const fromNetwork = mp4Urls[0] || null;
      if (fromNetwork) return fromNetwork;
      return await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v && (v.currentSrc || v.src)) return v.currentSrc || v.src;
        const s = document.querySelector('video source');
        if (s && s.src) return s.src;
        for (const script of document.querySelectorAll('script')) {
          const text = script.textContent || '';
          const m = text.match(/"playAddr"\s*:\s*"((?:[^"\\]|\\.)*)"/) || text.match(/"downloadAddr"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m && m[1]) {
            const u = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\u0026/g, '&');
            if (u.startsWith('http') || u.startsWith('//')) return u;
          }
        }
        return null;
      });
    };

    let found = await tryPage(videoId ? 'https://www.tiktok.com/embed/v2/' + videoId : url);
    if (!found) found = await tryPage(url);

    await context.close();
    await browser.close();

    if (found && (found.startsWith('http') || found.startsWith('//'))) {
      console.log('[scraper] getTikTokMp4Url total: ' + (Date.now() - totalStart) + ' ms (Playwright)');
      return { url: found.startsWith('//') ? 'https:' + found : found };
    }
    console.log('[scraper] getTikTokMp4Url total: ' + (Date.now() - totalStart) + ' ms (non trouvée)');
    return { error: 'URL vidéo non trouvée' };
  } catch (err) {
    try { if (browser) await browser.close(); } catch (e2) { console.warn('[scraper] getTikTokMp4Url browser.close:', e2?.message); }
    if (!_logPlaywrightMissing(err)) {
      console.log('[scraper] getTikTokMp4Url total: ' + (Date.now() - totalStart) + ' ms (erreur: ' + (err.message || err) + ')');
    }
    return { error: err.message || 'EXTRACT_ERROR' };
  }
}

/**
 * Récupère le binaire de la vidéo MP4 via Playwright (contexte navigateur) pour contourner le 403 du CDN TikTok.
 * Plus lent que getTikTokMp4Url + fetch, à utiliser en secours quand le CDN bloque.
 * @param {string} videoPageUrl - URL de la page TikTok (ex. https://www.tiktok.com/@user/video/123)
 * @returns {Promise<{ buffer?: Buffer, contentType?: string, error?: string }>}
 */
async function getTikTokMp4Buffer(videoPageUrl) {
  const url = String(videoPageUrl || '').trim();
  if (!url.includes('tiktok.com') || !url.includes('/video/')) return { error: 'URL TikTok invalide' };
  const videoId = getVideoIdFromUrl(url);
  const pageUrl = videoId ? 'https://www.tiktok.com/embed/v2/' + videoId : url;
  let context;
  try {
    const browser = await _getSharedBrowser();
    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 390, height: 844 },
      locale: 'fr-FR',
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' },
    });
    const page = await context.newPage();
    const mp4Urls = [];
    page.on('response', (response) => {
      const u = response.url();
      const ok = response.status() === 200 || response.status() === 206;
      if (ok && u.startsWith('http') && (u.includes('.mp4') || u.includes('/video/') || (u.includes('tiktokv') && u.includes('tos')))) {
        mp4Urls.push(u);
      }
    });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);
    let mp4Url = mp4Urls[0] || null;
    if (!mp4Url) {
      mp4Url = await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v && (v.currentSrc || v.src)) return v.currentSrc || v.src;
        const s = document.querySelector('video source');
        if (s && s.src) return s.src;
        for (const script of document.querySelectorAll('script')) {
          const text = script.textContent || '';
          const m = text.match(/"playAddr"\s*:\s*"((?:[^"\\]|\\.)*)"/) || text.match(/"downloadAddr"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m && m[1]) {
            const u = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\u0026/g, '&');
            if (u.startsWith('http') || u.startsWith('//')) return u.startsWith('//') ? 'https:' + u : u;
          }
        }
        return null;
      });
    }
    if (!mp4Url) {
      await context.close();
      return { error: 'URL vidéo non trouvée' };
    }

    const fullMp4Url = mp4Url.startsWith('//') ? 'https:' + mp4Url : mp4Url;
    // Même contexte que la page TikTok → Referer/cookies cohérents, évite 403 CDN
    let response = await context.request.get(fullMp4Url, { timeout: 60000 });
    if (!response.ok() && response.status() === 403) {
      await new Promise(r => setTimeout(r, 1500));
      response = await context.request.get(fullMp4Url, { timeout: 60000 });
    }
    if (!response.ok() && response.status() === 403 && pageUrl !== url) {
      // Réessayer avec la page complète au lieu de l'embed (parfois autre CDN / autre URL)
      mp4Urls.length = 0;
      let fallbackNavOk = true;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (_) {
        fallbackNavOk = false;
      }
      if (!fallbackNavOk) {
        await context.close();
        return { error: 'URL vidéo non trouvée' };
      }
      await page.waitForTimeout(1500);
      let mp4Url2 = mp4Urls[0] || null;
      if (!mp4Url2) {
        mp4Url2 = await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v && (v.currentSrc || v.src)) return v.currentSrc || v.src;
          const s = document.querySelector('video source');
          if (s && s.src) return s.src;
          for (const script of document.querySelectorAll('script')) {
            const text = script.textContent || '';
            const m = text.match(/"playAddr"\s*:\s*"((?:[^"\\]|\\.)*)"/) || text.match(/"downloadAddr"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m && m[1]) {
              const u = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\u0026/g, '&');
              if (u.startsWith('http') || u.startsWith('//')) return u.startsWith('//') ? 'https:' + u : u;
            }
          }
          return null;
        });
      }
      if (mp4Url2) {
        const full2 = mp4Url2.startsWith('//') ? 'https:' + mp4Url2 : mp4Url2;
        response = await context.request.get(full2, { timeout: 60000 });
      }
    }
    const ok = response.ok();
    const contentType = response.headers()['content-type'] || 'video/mp4';
    const buffer = await response.body();
    await context.close();

    if (!ok) {
      return { error: 'CDN retourne ' + response.status() };
    }
    return { buffer, contentType };
  } catch (err) {
    try { if (context) await context.close(); } catch (e2) { console.warn('[scraper] getTikTokMp4Buffer context.close:', e2?.message); }
    console.error('[scraper] getTikTokMp4Buffer error:', err?.message || err);
    _logPlaywrightMissing(err);
    return { error: err.message || 'BUFFER_ERROR' };
  }
}

module.exports = { fetchUserLikes, harvestLikes, getTikTokMp4Url, getTikTokMp4Buffer, SESSION_DIR };
