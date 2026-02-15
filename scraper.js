const { chromium } = require('playwright');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1280, height: 720 };

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
    await page.goto(profileUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    if (!finalUrl.includes(cleanUsername)) {
      if (connectedViaCdp) await browser?.close(); else { try { if (context) await context.close(); } catch(_){} try { if (browser) await browser.close(); } catch(_){} }
      return { error: 'LOGIN_REQUIRED' };
    }

    const isPrivate = await page.evaluate(() => {
      const lock = document.querySelector('[data-e2e="liked-tab-lock"]');
      if (lock) return true;
      const body = (document.body?.innerText || '').toLowerCase();
      if (body.includes("liked videos are private") || body.includes("vidéos aimées sont privées")) return true;
      return false;
    }).catch(() => true);

    if (isPrivate) {
      if (connectedViaCdp) await browser?.close(); else { try { if (context) await context.close(); } catch(_){} try { if (browser) await browser.close(); } catch(_){} }
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
      if (connectedViaCdp) await browser?.close(); else { try { if (context) await context.close(); } catch(_){} try { if (browser) await browser.close(); } catch(_){} }
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

    if (connectedViaCdp) await browser?.close(); else { try { if (context) await context.close(); } catch(_){} try { if (browser) await browser.close(); } catch(_){} }

    const list = Array.from(videos).slice(0, limit);
    return { videos: list };
  } catch (err) {
    try {
      if (connectedViaCdp) await browser?.close(); else { if (context) await context.close(); if (browser) await browser.close(); }
    } catch (_) {}
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
    const embedUrl = 'https://www.tiktok.com/embed/v2/' + videoId;
    let embedUrlResult = await tryFetch(embedUrl);
    if (embedUrlResult && (embedUrlResult.startsWith('http') || embedUrlResult.startsWith('//'))) {
      return { url: embedUrlResult.startsWith('//') ? 'https:' + embedUrlResult : embedUrlResult };
    }
  }
  let videoUrl = await tryFetch(url);
  if (!videoUrl && videoId) {
    const embedUrl = 'https://www.tiktok.com/embed/v2/' + videoId;
    videoUrl = await tryFetch(embedUrl);
  }
  if (videoUrl && (videoUrl.startsWith('http') || videoUrl.startsWith('//'))) {
    return { url: videoUrl.startsWith('//') ? 'https:' + videoUrl : videoUrl };
  }

  // Playwright : interception réseau pour récupérer l’URL .mp4
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
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
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3500);
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
      return { url: found.startsWith('//') ? 'https:' + found : found };
    }
    return { error: 'URL vidéo non trouvée' };
  } catch (err) {
    try { if (browser) await browser.close(); } catch (_) {}
    return { error: err.message || 'EXTRACT_ERROR' };
  }
}

module.exports = { fetchUserLikes, harvestLikes, getTikTokMp4Url, SESSION_DIR };
