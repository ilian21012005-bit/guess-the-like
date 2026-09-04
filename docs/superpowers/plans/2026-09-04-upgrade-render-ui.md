# WhoLiked Upgrade (Render + UI TikTok + UX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabiliser WhoLiked sur Render, appliquer un thème TikTok noir, puis polir l’UX sans changer les règles métier.

**Architecture:** Upgrade in-place. Backend Express/Socket.io inchangé dans ses responsabilités ; migrations exportables et lancées au boot ; Blueprint Render avec Postgres ; front vanilla (`public/*`) redesigné via tokens CSS + HTML/JS ciblés.

**Tech Stack:** Node 20, Express 5, Socket.io 4, PostgreSQL (`pg`), Playwright, HTML/CSS/JS, Render Blueprint (`render.yaml`).

## Global Constraints

- Bind HTTP : `0.0.0.0:$PORT` (Render)
- Look : fond `#050505`–`#0a0a0a`, accent `#fe2c55`, pas de purple AI / cream / broadsheet
- Pas de rewrite React ; pas de nouvelles règles de jeu
- Phases strictes : Technique → UI → UX
- Commits conventionnels (`feat`, `fix`, `chore`, `docs`, `style`)
- Tests Jest existants doivent rester verts (`npm test`)

## File map

| File | Role |
|------|------|
| `migrations/run.js` | Exporter `runMigrations()` utilisable au boot (sans `process.exit` quand importé) |
| `server.js` | Bind `0.0.0.0`, await migrations avant listen |
| `server.test.js` / nouveau test listen/health | Couvrir health + boot sans DB |
| `render.yaml` | Web + Postgres + `DATABASE_URL` + healthCheckPath |
| `DEPLOY-RENDER.md` | Doc Blueprint |
| `README.md` | Alignement deploy |
| `public/style.css` | Design system TikTok noir + motion |
| `public/index.html` | Structure accueil/lobby allégée |
| `public/app.js` | Banner cold-start, rejoin replié, feedback UX |
| `public/import-landing.html` | Harmoniser thème si présent |

---

### Task 1: Bind `0.0.0.0` + test health

**Files:**
- Modify: `server.js` (listen)
- Modify: `server.test.js` (ajouter test `/health`)

**Interfaces:**
- Produces: serveur écoute sur `0.0.0.0` et `config.PORT` ; `/health` reste `200` + `ok`

- [ ] **Step 1: Ajouter le test health qui doit déjà passer**

Dans `server.test.js`, ajouter :

```js
describe('GET /health', () => {
  it('répond 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });
});
```

- [ ] **Step 2: Modifier le listen**

Remplacer le bloc listen dans `server.js` :

```js
const PORT = config.PORT;
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Guess The Like — http://0.0.0.0:' + PORT);
  });
}
```

- [ ] **Step 3: Lancer les tests**

Run: `npm test`  
Expected: PASS (y compris `/health`)

- [ ] **Step 4: Commit**

```bash
git add server.js server.test.js
git commit -m "fix: bind HTTP server to 0.0.0.0 for Render"
```

---

### Task 2: Migrations exportables + boot

**Files:**
- Modify: `migrations/run.js`
- Modify: `server.js`
- Create: `migrations/run.test.js` (mock pool optionnel) OU tester via unit léger

**Interfaces:**
- Produces: `async function runMigrations(): Promise<void>` — no-op si `pool` est null ; sinon applique les `.sql` non enregistrés dans `migration_history`
- Consumes: `require('./db').pool`

- [ ] **Step 1: Refactorer `migrations/run.js`**

Transformer pour exporter la logique sans exit au import :

```js
try { require('dotenv').config(); } catch (_) {}
const { pool } = require('../db');
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname);
const TABLE = 'migration_history';

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getApplied(client) {
  const r = await client.query(`SELECT name FROM ${TABLE}`);
  return new Set((r.rows || []).map((row) => row.name));
}

async function recordApplied(client, name) {
  await client.query(`INSERT INTO ${TABLE} (name) VALUES ($1)`, [name]);
}

/**
 * Applique les migrations idempotentes.
 * No-op si pool (DATABASE_URL) absent.
 */
async function runMigrations() {
  if (!pool) {
    console.log('[migrate] Pas de DATABASE_URL — skip.');
    return;
  }
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    console.log('[migrate] Aucune migration .sql.');
    return;
  }
  await ensureMigrationTable(pool);
  const applied = await getApplied(pool);
  for (const file of files) {
    const name = path.basename(file, '.sql');
    if (applied.has(name)) {
      console.log('[migrate] Skip:', file);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = sql
      .split(';')
      .map((s) => s.replace(/--[^\n]*/g, '').trim())
      .filter((s) => s.length > 0);
    for (const st of statements) {
      await pool.query(st + ';');
    }
    await recordApplied(pool, name);
    console.log('[migrate] Appliquée:', file);
  }
  console.log('[migrate] Terminé.');
}

module.exports = { runMigrations };

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e.message || e);
      if (e.code === 'ENOTFOUND' || e.message?.includes('getaddrinfo')) {
        console.error('\n→ Utilise l’URL EXTERNE de la base (Render → Connections → External Database URL).');
      }
      process.exit(1);
    });
}
```

- [ ] **Step 2: Boot async dans `server.js`**

Remplacer le démarrage :

```js
const { runMigrations } = require('./migrations/run');

const PORT = config.PORT;

async function start() {
  try {
    await runMigrations();
  } catch (e) {
    console.error('[migrate] Échec:', e.message || e);
    process.exit(1);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Guess The Like — http://0.0.0.0:' + PORT);
  });
}

if (process.env.NODE_ENV !== 'test') {
  start();
}
```

- [ ] **Step 3: Vérifier CLI migrations**

Run: `node -e "const m=require('./migrations/run'); console.log(typeof m.runMigrations)"`  
Expected: `function`

Run: `npm test`  
Expected: PASS (pas de listen en test)

- [ ] **Step 4: Commit**

```bash
git add migrations/run.js server.js
git commit -m "feat: run DB migrations automatically on server boot"
```

---

### Task 3: Blueprint Render (web + Postgres)

**Files:**
- Modify: `render.yaml`
- Modify: `DEPLOY-RENDER.md`
- Modify: `README.md` (section deploy courte)

**Interfaces:**
- Produces: Blueprint avec `databases` + `DATABASE_URL` via `fromDatabase` + `healthCheckPath: /health`

- [ ] **Step 1: Réécrire `render.yaml`**

```yaml
# Déploiement Render — Guess The Like (Blueprint)
# Dashboard → New → Blueprint → connecter ce repo

databases:
  - name: guess-the-like-db
    plan: basic-256mb

services:
  - type: web
    name: guess-the-like
    runtime: node
    plan: free
    buildCommand: npm install && npx playwright install chromium
    startCommand: npx playwright install chromium && node server.js
    healthCheckPath: /health
    envVars:
      - key: NODE_VERSION
        value: "20"
      - key: USE_PLAYWRIGHT_DIRECT
        value: "1"
      - key: PLAYWRIGHT_CONCURRENT
        value: "1"
      - key: DATABASE_URL
        fromDatabase:
          name: guess-the-like-db
          property: connectionString
```

Note: si le plan DB gratuit est encore dispo sur le compte, remplacer `basic-256mb` par `free` ; sinon garder `basic-256mb` et documenter le coût. `PLAYWRIGHT_CONCURRENT=1` pour limiter l’OOM free tier.

- [ ] **Step 2: Réécrire `DEPLOY-RENDER.md`**

Contenu minimal :

1. Push GitHub
2. Render → New → Blueprint → sélectionner le repo
3. Appliquer le Blueprint (crée web + Postgres)
4. Attendre Live → ouvrir l’URL
5. Cold start free ~30–60s
6. Si Playwright OOM : monter de plan ou baisser concurrency
7. Free Postgres expire après 30 jours (si plan free)

- [ ] **Step 3: Commit**

```bash
git add render.yaml DEPLOY-RENDER.md README.md
git commit -m "chore: wire Render Blueprint with Postgres and healthcheck"
```

---

### Task 4: Dépendances + cold-start copy (fin Phase 1)

**Files:**
- Modify: `package.json` / `package-lock.json` (patch/minor sûrs)
- Modify: `public/index.html` (hint cold start)
- Modify: `public/app.js` (textes banner déconnexion / réveil)

**Interfaces:**
- Produces: deps à jour sans breaking ; messages cold-start clairs

- [ ] **Step 1: Mettre à jour les deps raisonnablement**

```bash
npm outdated
npm update
npm test
```

Expected: tests PASS. Ne pas major-bump Express/Socket.io/Jest sans besoin.

- [ ] **Step 2: Copy cold-start**

Dans `index.html`, remplacer le hint :

```html
<p class="hint">Hébergement gratuit (Render) : au réveil le serveur peut prendre 30–60 s. Garde cet onglet ouvert ; le bouton Rejoindre se réactive dès que la connexion est OK.</p>
```

Dans `app.js` `socket.on('disconnect')` :

```js
banner.textContent = roomCode
  ? 'Connexion perdue. Reconnexion automatique… Si ça dure, recharge la page.'
  : 'Serveur en cours de réveil (jusqu’à ~1 min)…';
```

Et au début si `!socket.connected` au load, s’assurer que le banner dit la même chose (déjà via `setConnectionStatus(false)` — mettre le texte par défaut dans le HTML) :

```html
<div id="reconnect-banner" class="reconnect-banner hidden">Serveur en cours de réveil (jusqu’à ~1 min)…</div>
```

- [ ] **Step 3: Tests + commit**

```bash
npm test
git add package.json package-lock.json public/index.html public/app.js
git commit -m "chore: refresh deps and clarify Render cold-start messaging"
```

---

### Task 5: Design tokens + base CSS TikTok noir (Phase 2)

**Files:**
- Modify: `public/style.css` (`:root` + `body` + boutons + cards)

**Interfaces:**
- Produces: variables CSS listées ci-dessous utilisées partout

- [ ] **Step 1: Remplacer `:root` et fond body**

```css
:root {
  --bg: #050505;
  --bg-elevated: #0a0a0a;
  --bg-card: #121212;
  --text: #f5f5f5;
  --text-muted: #8a8a8a;
  --accent: #fe2c55;
  --accent-strong: #e11d48;
  --accent-soft: rgba(254, 44, 85, 0.15);
  --success: #25f4ee;
  --error: #ff4d6d;
  --border: rgba(255, 255, 255, 0.08);
  --shadow: 0 8px 32px rgba(0, 0, 0, 0.55);
  --shadow-soft: 0 16px 48px rgba(0, 0, 0, 0.65);
  --radius: 1rem;
  --radius-sm: 0.75rem;
}

body {
  margin: 0;
  font-family: 'Outfit', -apple-system, sans-serif;
  background:
    radial-gradient(ellipse 80% 50% at 50% -20%, rgba(254, 44, 85, 0.12), transparent),
    var(--bg);
  color: var(--text);
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1rem;
  padding-bottom: max(1rem, env(safe-area-inset-bottom));
  font-weight: 400;
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 2: Harmoniser boutons / inputs / cards**

- Boutons primaires : `background: var(--accent)` ; hover `var(--accent-strong)`
- Inputs : `background: #1a1a1a` ; focus border accent
- `.card` : `background: var(--bg-card)` ; border `var(--border)`
- Remplacer anciennes couleurs `#252525`, `#e8a0b8`, `#d47394` par les tokens

- [ ] **Step 3: Motion de base**

```css
.screen {
  animation: screen-in 0.35s ease-out;
}
@keyframes screen-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
button:not(:disabled):active {
  transform: scale(0.98);
}
#btn-start:not(.hidden) {
  animation: pulse-ready 1.6s ease-in-out infinite;
}
@keyframes pulse-ready {
  0%, 100% { box-shadow: 0 0 0 0 rgba(254, 44, 85, 0.45); }
  50% { box-shadow: 0 0 0 10px rgba(254, 44, 85, 0); }
}
```

- [ ] **Step 4: Commit**

```bash
git add public/style.css
git commit -m "style: apply TikTok black design tokens and motion"
```

---

### Task 6: Accueil brand + theme-color (Phase 2)

**Files:**
- Modify: `public/index.html`
- Modify: `public/manifest.json` (theme_color / background_color)
- Modify: `public/import-landing.html` (aligner couleurs si hardcodées)

- [ ] **Step 1: Hero brand**

Sur `#screen-home` :

```html
<section id="screen-home" class="screen">
  <p class="brand-mark">WhoLiked</p>
  <h1 class="sr-only">WhoLiked</h1>
  <p class="subtitle">Devine qui a liké ce TikTok</p>
  <!-- card existante -->
```

CSS :

```css
.brand-mark {
  font-size: clamp(2.4rem, 10vw, 3.2rem);
  font-weight: 700;
  letter-spacing: -0.04em;
  margin: 0 0 0.35rem;
  background: linear-gradient(135deg, #fff 30%, var(--accent));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); border: 0;
}
```

- [ ] **Step 2: meta theme-color `#050505`** ; `manifest.json` idem

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/style.css public/manifest.json public/import-landing.html
git commit -m "style: strengthen WhoLiked brand hero and theme colors"
```

---

### Task 7: UX accueil — rejoin replié + erreurs (Phase 3)

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

- [ ] **Step 1: Rejoin en `<details>`**

Remplacer `.rejoin-box` par :

```html
<details class="rejoin-box">
  <summary class="rejoin-title">Tu as quitté par erreur ?</summary>
  <p class="rejoin-desc">Même code salon + même pseudo pour revenir.</p>
  <input type="text" id="rejoin-code" placeholder="Code du salon" maxlength="8" class="code-input" />
  <input type="text" id="rejoin-username" placeholder="Ton pseudo" maxlength="50" />
  <button type="button" id="btn-rejoin">Revenir dans la partie</button>
  <p id="rejoin-error" class="error small"></p>
</details>
```

- [ ] **Step 2: Messages d’erreur plus clairs dans `app.js`**

Pour create/join/rejoin, normaliser :

- code vide → `Entre un code salon (ex. ABC123).`
- pseudo vide → `Choisis un pseudo.`
- erreurs serveur : afficher `res.error` tel quel si string, sinon fallback `Impossible de rejoindre. Réessaie.`

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: collapse rejoin UI and clarify home error messages"
```

---

### Task 8: UX lobby + partie (Phase 3)

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

- [ ] **Step 1: Lobby — badges joueur**

Dans le rendu liste joueurs (`app.js` où `#lobby-players` est rempli), afficher un badge :

- `Prêt` si le joueur a marqué prêt / likes importés (selon champs existants `ready` / likes count)
- sinon `En attente`

Inspecter `room_updated` / `getPlayerListForRoom` pour les champs réels (`likesCount`, `ready`, etc.) et les utiliser — ne pas inventer de nouveaux events socket.

- [ ] **Step 2: Partie — polish visuel**

CSS :

- `#countdown-number` plus grand, accent
- `#vote-buttons .vote-btn` pleine largeur tactile (min-height 48px)
- `#screen-reveal` : avatar roulette avec ring accent
- `#scores-inline` / podium : accent sur #1

- [ ] **Step 3: Retirer emoji décoratifs superflu** (boutons Copier → texte « Copier » sans 📋 si présent en double ; garder volume si fonctionnel)

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: polish lobby status badges and in-game visual feedback"
```

---

### Task 9: Vérification finale

**Files:** aucun nouveau (sauf fix si échec)

- [ ] **Step 1: `npm test`** — Expected: PASS
- [ ] **Step 2: Smoke checklist manuelle**
  - `/health` → ok
  - Accueil dark + brand
  - Créer / rejoindre (si DB dispo)
  - Banner cold-start si déconnecté
- [ ] **Step 3: Push + redéploiement Render** (Blueprint sync ou redeploy manuel)
- [ ] **Step 4: Commit vide interdit** — si fixes, commit `fix: …`

---

## Spec coverage checklist

| Spec item | Task |
|-----------|------|
| Bind 0.0.0.0 | 1 |
| render.yaml + Postgres + health | 3 |
| Migrations au boot | 2 |
| Deps | 4 |
| Cold-start UX | 4, 7 |
| Docs Deploy | 3 |
| UI TikTok noir | 5, 6 |
| Accueil brand | 6 |
| Rejoin secondaire | 7 |
| Lobby / partie polish | 8 |
| Tests verts | 1, 2, 4, 9 |

## Execution handoff

Plan ready. Choose execution mode before coding.
