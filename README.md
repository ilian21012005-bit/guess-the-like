# Guess The Like

Jeu multi-joueurs en temps réel : devine qui a liké le TikTok. Alternative gratuite et multiplateforme à WhoLiked.

## Prérequis

- Node.js 18+
- PostgreSQL (pour stocker les likes et l’historique des parties)
- Navigateur récent (PC ou mobile)

## Installation

```bash
npm install
npx playwright install chromium
```

Créer un fichier `.env` à la racine (voir `.env.example`) :

```
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/guess_the_like
```

Créer la base PostgreSQL puis lancer le schéma :

```bash
createdb guess_the_like
npm run db:init
```

## Lancer l’app

```bash
npm start
```

Ouvre http://localhost:3000

## Récupération des likes (session TikTok)

Sans être connecté, TikTok ne montre pas l’onglet « A aimé ». Le scraper utilise une **session Chrome** (comme quand tu testes en manuel, connecté).

### Option la plus fiable : Chrome déjà ouvert (débogage distant)

Tu gardes **Chrome ouvert** avec ton compte TikTok. Le script se connecte à cette fenêtre au lieu d’en lancer une deuxième (évite l’erreur « Target closed » / exit 21).

1. À la racine du projet, exécute **en premier** (tu peux laisser ton Chrome habituel ouvert) :  
   `.\scripts\launch-chrome-debug.ps1`  
   Une fenêtre Chrome **séparée** s’ouvre (profil dédié dans `.chrome-debug-profile`). **La première fois**, connecte-toi à TikTok dans cette fenêtre et garde-la ouverte.
   - Pour vérifier que le port 9222 est actif : ouvre `http://127.0.0.1:9222/json/version` dans un navigateur ; tu dois voir une page JSON.
2. Dans un **autre** terminal (PowerShell) :
   ```powershell
   cd D:\Who-liked
   $env:CHROME_DEBUG_URL = "http://127.0.0.1:9222"
   npm start
   ```
3. Ouvre http://localhost:3000, crée une partie, indique ton @ TikTok, clique sur **Prêt**.  
   Le script se connecte à ton Chrome ouvert et récupère les likes (un nouvel onglet peut s’ouvrir puis se fermer).

Tu peux réutiliser le même Chrome à chaque fois ; pas besoin de le fermer.

### Option alternative : profil Chrome (user data)

Si tu préfères ne pas utiliser le débogage distant :

1. **Ferme Chrome complètement** (sinon erreur « Target closed » / exit 21).
2. Définis la variable (une fois par terminal) :
   - **PowerShell** : `$env:CHROME_USER_DATA = "$env:LOCALAPPDATA\Google\Chrome\User Data"`
   - **CMD** : `set CHROME_USER_DATA=%LOCALAPPDATA%\Google\Chrome\User Data`
3. Lance `npm start`, crée une partie, mets ton @ TikTok, clique sur **Prêt**.  
   Une fenêtre Chrome s’ouvrira le temps de la récupération.

### Option alternative : profil dédié (se connecter dans la fenêtre)

Sans `CHROME_USER_DATA` :

```bash
npm run setup-session
```

Une fenêtre Chrome s’ouvre. Connecte-toi à TikTok puis ferme. Les cookies sont dans `.playwright-tiktok-session/`. Si TikTok affiche *« Trop de tentatives »*, attends quelques heures ou utilise l’option recommandée ci-dessus.

- Tes likes doivent rester **publics** le temps du clic sur « Prêt ».

## Utilisation

1. **Créer une partie** : pseudo + @ TikTok (optionnel) → tu reçois un code.
2. **Rejoindre** : les autres entrent le code et leur pseudo.
3. **Likes en public** : lance `npm run setup-session` une fois si besoin, puis dans le jeu clique sur **Prêt**. Le serveur récupère les likes ; après ça, tu peux repasser en **privé**.
4. L’**hôte** lance la partie. 50 TikToks sont tirés au hasard parmi les likes du groupe.
5. Chaque round : décompte 3-2-1 → vidéo en boucle → tout le monde vote (sauf le propriétaire du like) → révélation avec effet roulette → scores.
6. Après 50 rounds : podium puis retour au lobby pour rejouer (les TikToks déjà joués ne reviennent pas).

## Sans base de données

Sans `DATABASE_URL`, le lobby et les salons fonctionnent. Tu peux lancer une partie en solo : les likes sont stockés en mémoire après « Prêt », ou tu peux lancer sans « Prêt » pour 3 rounds démo (lien « Ouvrir sur TikTok » pour regarder la vidéo).

## Erreurs dans la console du navigateur

- **runtime.lastError: message port closed** → vient d’une extension (ex. bloqueur de pub), pas de l’app. À ignorer.
- **tiktok.com/embed/v2/… 400** → tu avais les anciennes vidéos démo ; redémarre le serveur (`npm start`). En mode démo, l’embed n’est plus chargé, seul le lien « Ouvrir sur TikTok » s’affiche.
- **tiktokv.eu / tiktokw.eu ERR_BLOCKED_BY_CLIENT** → requêtes TikTok bloquées par une extension (vie privée / pub). L’embed peut quand même fonctionner. À ignorer si le jeu marche.
- **Permissions policy: unload** → émane de l’iframe TikTok, pas de notre code.

## Licence

Projet personnel / BUT Informatique.
