/**
 * Configuration centralisée : variables d'environnement + valeurs par défaut.
 * En prod (Render), définir les variables dans l'interface. En local, les défauts ci-dessous s'appliquent.
 */
try { require('dotenv').config(); } catch (e) { /* dotenv optionnel */ }

function envInt(name, defaultVal) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultVal;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? defaultVal : n;
}

function envBool(name) {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

module.exports = {
  // CORS / sécurité
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*',

  // Playwright / preload
  PLAYWRIGHT_CONCURRENT: envInt('PLAYWRIGHT_CONCURRENT', 2),
  SERVER_PRELOAD_WORKERS: envInt('SERVER_PRELOAD_WORKERS', 2),
  SERVER_PRELOAD_VIDEO_TIMEOUT_MS: envInt('SERVER_PRELOAD_VIDEO_TIMEOUT_MS', 120000),
  PRELOAD_MIN_BEFORE_START: envInt('PRELOAD_MIN_BEFORE_START', 2),
  PRELOAD_INITIAL_VIDEOS: envInt('PRELOAD_INITIAL_VIDEOS', 50),
  PRELOAD_CACHE_MAX_ROOMS: envInt('PRELOAD_CACHE_MAX_ROOMS', 5),

  // Timeouts TikTok
  TIKTOK_NAV_TIMEOUT_MS: envInt('TIKTOK_NAV_TIMEOUT_MS', 30000),
  VIDEO_EXTRACT_TIMEOUT_MS: envInt('VIDEO_EXTRACT_TIMEOUT_MS', 30000),

  // Mode vidéo : 1 = fetch direct Playwright (pas getTikTokMp4Url + fetch)
  USE_PLAYWRIGHT_DIRECT: envBool('USE_PLAYWRIGHT_DIRECT'),

  // Rate limit API vidéo
  VIDEO_RATE_LIMIT_WINDOW_MS: envInt('VIDEO_RATE_LIMIT_WINDOW_MS', 120000),
  VIDEO_RATE_LIMIT_MAX: envInt('VIDEO_RATE_LIMIT_MAX', 80),

  // Serveur
  PORT: envInt('PORT', 3000),

  // Optionnel : dev / debug Chrome
  CHROME_DEBUG_URL: process.env.CHROME_DEBUG_URL || null,
  CHROME_USER_DATA: process.env.CHROME_USER_DATA || null,
};
