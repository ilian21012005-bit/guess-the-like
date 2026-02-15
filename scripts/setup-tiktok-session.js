/**
 * Ouvre Chrome pour la session TikTok.
 * - Avec CHROME_USER_DATA : utilise ton profil Chrome (tu es déjà connecté). Ferme Chrome avant de lancer.
 * - Sans : ouvre un profil vide (tu dois te connecter ; TikTok peut bloquer "Trop de tentatives").
 *
 * Usage :
 *   set CHROME_USER_DATA=%LOCALAPPDATA%\Google\Chrome\User Data
 *   npm run setup-session
 * (Ferme Chrome avant.)
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SESSION_DIR = path.join(__dirname, '..', '.playwright-tiktok-session');

function getSessionDir() {
  const custom = process.env.CHROME_USER_DATA;
  if (custom && fs.existsSync(custom)) return path.resolve(custom);
  return SESSION_DIR;
}

async function main() {
  const sessionDir = getSessionDir();
  const useChromeProfile = sessionDir !== SESSION_DIR;

  if (useChromeProfile) {
    console.log('Utilisation de ton profil Chrome :', sessionDir);
    console.log('→ Tu es déjà connecté à TikTok. Ferme la fenêtre quand tu as vérifié.\n');
  } else {
    console.log('Profil de session (vide). Si TikTok affiche "Trop de tentatives",');
    console.log('ferme cette fenêtre puis utilise ton profil Chrome :');
    console.log('  set CHROME_USER_DATA=%LOCALAPPDATA%\\Google\\Chrome\\User Data');
    console.log('  npm run setup-session');
    console.log('(Ferme Chrome complètement avant.)\n');
  }

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 720 },
    locale: 'fr-FR',
    args: ['--no-sandbox'],
  });

  let page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.tiktok.com', { waitUntil: 'load', timeout: 30000 });
  console.log('Session utilisée :', sessionDir);
  console.log('Ferme la fenêtre du navigateur quand c\'est bon.\n');

  await context.waitForEvent('close', { timeout: 0 }).catch(() => {});
  try { await context.close(); } catch (_) {}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
