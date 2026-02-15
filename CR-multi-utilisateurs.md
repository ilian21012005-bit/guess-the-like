# Compte-rendu d’analyse : récupération des likes pour plusieurs utilisateurs

**Date :** février 2025  
**Objet :** Comment obtenir le même résultat (récupération des likes TikTok) pour plusieurs joueurs sans que chacun passe par la configuration CHROME_DEBUG_URL.

---

## 1. Situation actuelle

### 1.1 Contrainte TikTok

- L’onglet **« A aimé »** (likes) n’est visible que pour un utilisateur **connecté** à TikTok.
- Sans session (cookies / compte), TikTok redirige ou n’affiche pas le contenu des likes.
- Le scraper doit donc s’exécuter dans un **navigateur où un compte TikTok est déjà connecté**.

### 1.2 Architecture actuelle

| Élément | Rôle |
|--------|------|
| **Serveur (Node + Playwright)** | Reçoit « Prêt » (socket `set_ready`), appelle `harvestLikes(tiktokUsername, 150)`. |
| **Scraper** | Utilise **un seul** navigateur : soit `connectOverCDP(CHROME_DEBUG_URL)` (Chrome déjà ouvert), soit `launchPersistentContext` (profil `.playwright-tiktok-session` ou `CHROME_USER_DATA`). |
| **Flux** | Le navigateur contrôlé par le serveur va sur `tiktok.com/@username`, clique sur l’onglet « A aimé », scroll, collecte les liens `/video/...`. |

Conséquence : **le compte TikTok dont on récupère les likes est celui qui est connecté dans ce navigateur unique**. Pour que « Prêt » fonctionne pour le joueur A, le Chrome connecté (CDP ou profil) doit être connecté en tant que **@mk_swish78** (ou le @ saisi par ce joueur). Un autre joueur B ne peut pas avoir ses likes récupérés par le même Chrome tant qu’il est connecté en A.

### 1.3 Où ça fonctionne aujourd’hui

- **Un seul joueur** sur la machine qui héberge le serveur : il lance `launch-chrome-debug.ps1`, se connecte à TikTok dans ce Chrome, garde la fenêtre ouverte, puis dans l’app clique sur « Prêt ». Le serveur se connecte en CDP à ce Chrome et récupère les likes du compte connecté.
- **Import manuel** : déjà disponible pour tout le monde ; chaque joueur va sur TikTok (dans son propre navigateur), récupère les liens (script en console ou copier-coller), les colle dans la zone « Import manuel » et clique sur « Importer ces liens ». Aucune configuration Chrome côté serveur.

---

## 2. Problème multi-utilisateurs

### 2.1 Plusieurs joueurs, même salon

- **Même machine (ex. soirée sur un PC)**  
  Un seul Chrome « débogage » (port 9222) = un seul compte TikTok connecté. Les autres joueurs ne peuvent pas utiliser « Prêt » avec le scraper actuel sans changer de compte dans ce Chrome à chaque fois (peu pratique).

- **Machines différentes (joueur A = hôte, B et C à distance)**  
  Le serveur tourne chez A. Le Chrome avec le port 9222 est sur la machine de A. Le serveur ne peut **pas** se connecter à un Chrome sur la machine de B ou C (réseau, sécurité). Donc le scraper côté serveur ne peut récupérer que les likes du compte connecté dans le Chrome de A. Pour B et C, le serveur n’a pas accès à leur session TikTok.

### 2.2 Résumé

| Scénario | Scraper « Prêt » (serveur) | Import manuel |
|----------|----------------------------|----------------|
| 1 joueur, serveur en local | ✅ (Chrome debug sur cette machine) | ✅ |
| Plusieurs joueurs, même PC | ⚠️ 1 seul compte par Chrome debug | ✅ (chacun colle ses liens) |
| Plusieurs joueurs, machines différentes | ❌ (serveur n’a pas le Chrome des autres) | ✅ (chacun sur son navigateur) |

Sans modifier le code, la seule solution **générique** pour plusieurs utilisateurs est déjà là : **l’import manuel** (chaque joueur fournit ses liens depuis son propre TikTok).

---

## 3. Pistes pour « multi-users sans étape Chrome par utilisateur »

### 3.1 Option A : Import manuel comme parcours principal

- **Principe :** Ne pas s’appuyer sur le scraper serveur pour les multi-joueurs. Mettre en avant « Import manuel » dans l’UI (instructions claires, lien vers le script console, voire bookmarklet).
- **Avantages :** Aucun changement d’architecture, fonctionne pour N joueurs, sur N machines, sans Chrome debug.
- **Inconvénients :** Chaque joueur doit aller sur TikTok, ouvrir « J’aime », exécuter un script ou copier les liens, puis coller dans l’app (quelques clics en plus).

### 3.2 Option B : Extension navigateur

- **Principe :** Une extension Chrome (ou autre) avec permission sur `tiktok.com`. Sur la page « J’aime », l’extension lit les liens `a[href*="/video/"]`, les déduplique et les envoie au serveur (ou les met dans le presse-papier pour collage dans l’app).
- **Avantages :** Un clic « Envoyer mes likes » depuis TikTok, pas de CDP ni de script à copier-coller.
- **Inconvénients :** Développement et maintenance d’une extension, publication (Chrome Web Store) ou chargement en mode développeur ; chaque joueur doit l’installer.

### 3.3 Option C : Plusieurs sessions Chrome côté serveur (multi-profils / multi-ports)

- **Principe :** Sur la machine du serveur, lancer plusieurs Chrome (ou contextes) avec des profils différents (`.chrome-debug-profile`, `.chrome-debug-profile-2`, …) ou plusieurs ports (9222, 9223, …). Chaque joueur « enregistre » une fois sa session (se connecte à TikTok dans le Chrome du port qui lui est assigné). Le serveur, selon le joueur qui clique « Prêt », se connecte au bon port / bon profil.
- **Avantages :** Expérience « Prêt » sans aller sur TikTok pour importer.
- **Inconvénients :** Ne marche que si le serveur est sur une machine où l’on peut ouvrir plusieurs Chrome (souvent : partie en local). Pour des joueurs distants, ils n’ont pas accès à ces Chrome. Gestion des profils (qui est connecté où), scripts de lancement (plusieurs ports), plus complexe.

### 3.4 Option D : API / reverse-engineering TikTok

- **Principe :** Utiliser une API non officielle ou des requêtes réseau (type `item_list`, etc.) pour récupérer les likes avec des cookies/tokens d’un compte. Le serveur stockerait alors des tokens par joueur (après une auth une fois).
- **Avantages :** Pas de navigateur à lancer pour le scrape.
- **Inconvénients :** Fragile (changements TikTok), possiblement contre les conditions d’utilisation, gestion des tokens et de la sécurité. Hors périmètre du scraper actuel.

---

## 4. Synthèse et recommandation

- **Contrainte de fond :** Les likes ne sont visibles que dans une session où l’utilisateur est connecté. Le serveur n’a accès qu’à **une** session navigateur (celle de la machine où il tourne, via CDP ou profil). Il ne peut pas « être connecté » à la place du joueur B sur la machine de B.

- **Pour plusieurs utilisateurs sans que chacun configure CHROME_DEBUG_URL :**
  - **Recommandation à court terme :** Utiliser et valoriser **l’import manuel** pour tous les joueurs autres que celui qui utilise le Chrome debug. Documenter clairement le parcours (aller sur TikTok → onglet J’aime → script en console ou copier les liens → coller dans l’app). Aucune modification technique nécessaire.
  - **Évolution possible :** Développer une **extension navigateur** (option B) pour simplifier la collecte des liens côté utilisateur et l’envoi (ou copie) vers l’app, tout en restant dans le cadre « chaque joueur est connecté dans son propre navigateur ».

- **Scraper serveur (Prêt + Chrome debug)** reste la solution adaptée pour **un joueur** (ou un seul compte) sur la machine qui héberge le serveur ; il n’est pas réaliste de l’étendre à « N utilisateurs distants » sans que chacun n’ait une étape équivalente (import manuel ou extension) dans son propre navigateur.

---

## 5. Conclusion

Pour arriver au **même résultat** (récupération des likes) pour **plusieurs utilisateurs** sans que chacun passe par la configuration CHROME_DEBUG_URL :

1. **Ne rien modifier** : l’**import manuel** est déjà la solution multi-utilisateurs (chaque joueur colle ses liens depuis TikTok).
2. **Amélioration possible (hors scope actuel)** : une **extension navigateur** qui, sur la page « J’aime » TikTok, récupère les liens et les envoie ou les copie pour l’app, pour un parcours plus fluide que le copier-coller du script en console.

Le scraper serveur (Playwright + CDP) restera pertinent pour le cas « un compte / une machine serveur » ; pour les autres joueurs, le flux « données depuis leur navigateur (import ou extension) » reste la seule option réaliste sans centraliser leurs identifiants/sessions TikTok sur le serveur.
