# Design — Upgrade WhoLiked (Render + UI TikTok noir + UX)

Date: 2026-09-04  
Approche retenue: **upgrade in-place** (pas de rewrite React)

## Contexte

WhoLiked (guess-the-like) est un jeu multi-joueurs temps réel : deviner qui a liké un TikTok. Stack actuelle : Node/Express, Socket.io, Playwright, PostgreSQL, front HTML/CSS/JS vanilla. Déploiement cible : **Render**.

Objectifs utilisateur : faire marcher l’app à nouveau, refonte visuelle plus sombre (style TikTok), et améliorer UX/gameplay — le tout en phases.

## Décisions produit

| Choix | Décision |
|-------|----------|
| Priorité | A+B+C, phasé |
| Ordre | 1 Technique → 2 UI → 3 UX/gameplay |
| Hébergement | Render |
| Look | Noir profond type TikTok, accent rose/rouge |
| Stack | Inchangée (vanilla front, Express backend) |

## Architecture

Aucun changement d’architecture majeure. Améliorations ciblées :

- Backend : `server.js`, `config.js`, `render.yaml`, migrations au boot, healthcheck
- Front : `public/index.html`, `public/style.css`, `public/app.js` (+ pages satellites si besoin)
- Docs : `DEPLOY-RENDER.md`, `README.md` alignés sur le Blueprint

## Phase 1 — Technique (Render stable)

### Objectifs

- Service web joignable et stable sur Render
- Postgres branché via Blueprint
- Schéma DB appliqué sans étape manuelle fragile
- Healthcheck pour le load balancer Render

### Changements

1. **Bind HTTP** : `server.listen(PORT, '0.0.0.0', …)` (contrainte Render)
2. **`render.yaml`** :
   - service web Node existant
   - base Postgres (`fromDatabase` → `DATABASE_URL`)
   - healthCheckPath `/health` (endpoint déjà présent)
   - env utiles (`NODE_VERSION`, `USE_PLAYWRIGHT_DIRECT`, `PLAYWRIGHT_CONCURRENT` adaptés free tier)
3. **Migrations au démarrage** : si `DATABASE_URL` défini, appliquer les migrations avant d’écouter (idempotent)
4. **Dépendances** : mise à jour raisonnable (`npm outdated` / patch-minor), tests Jest verts
5. **Cold start** : message UI plus clair quand le free tier se réveille (~30–60s)
6. **Docs** : `DEPLOY-RENDER.md` basé Blueprint (plus le parcours manuel obsolète)

### Hors scope phase 1

- Refonte visuelle
- Nouvelles règles de jeu
- Passage à un plan Render payant (sauf si Playwright OOM documenté)

## Phase 2 — UI TikTok noir

### Direction visuelle

- Fond quasi noir (`#050505` → `#0a0a0a`)
- Accent rose TikTok-like (`#fe2c55` + hover plus clair)
- Surfaces : bordures `rgba(255,255,255,0.08)`, ombres profondes, cartes légères uniquement pour interactions
- Typo Outfit (ou équivalent déjà chargé), brand **WhoLiked** hero sur l’accueil
- Motion : transitions écrans, feedback boutons, pulse “Prêt”, révélation vote
- Mobile-first, max-width ~420px, safe-area

### Anti-patterns à éviter

- Thème purple AI, cream/terracotta, broadsheet
- Cards partout, overlays badges sur hero
- Trop d’emojis décoratifs

### Fichiers principaux

- `public/style.css` : tokens `:root`, redesign composants
- `public/index.html` : structure/accueil allégé, accessibilité
- `public/app.js` : classes/états pour animations si besoin

## Phase 3 — UX / gameplay

### Objectifs

Fluidifier sans changer les règles métier (lobby → import likes → rounds → votes → scores).

### Améliorations

1. **Accueil** : CTA créer/rejoindre prioritaires ; bloc rejoin secondaire/replié
2. **Lobby** : code salon, liste joueurs, étapes import plus lisibles ; états “importé / prêt”
3. **Partie** : countdown, zone vote, révélation et scores plus nets
4. **Erreurs** : messages utiles (code invalide, import vide, salon introuvable)
5. **Cold start Render** : banner + retry soft déjà présents, copy améliorée

### Hors scope phase 3

- Nouvelles règles (nouveau scoring, nouveaux modes)
- Auth utilisateurs
- Rewrite front

## Tests & validation

- `npm test` (Jest) après changements backend
- Smoke manuel local si possible ; validation finale sur URL Render
- Checklist UI : home, lobby, round, vote, scores, mobile viewport

## Risques

| Risque | Mitigation |
|--------|------------|
| Playwright OOM sur free tier | Garder `PLAYWRIGHT_CONCURRENT` bas ; documenter fallback |
| Free Postgres expire (30j) | Documenté dans deploy |
| Cold start 15 min | UX banner + hint accueil |
| Scope “tout améliorer” | Phases strictes ; pas de features hors spec |

## Critères de succès

1. Déploiement Render Live + `/health` OK + DB connectée
2. UI noire TikTok cohérente sur tous les écrans
3. Parcours créer → rejoindre → lobby → partie plus clair et mobile-friendly
4. Tests existants toujours verts
