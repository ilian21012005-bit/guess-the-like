# Plan & Cahier des charges — Guess The Like

Alternative gratuite et multiplateforme à WhoLiked : jeu multi-joueurs en temps réel pour deviner qui a liké un TikTok.

---

## 1. Objectif

- **Jeu** : en groupe, chacun devine qui a liké le TikTok affiché (propriétaire du like ne vote pas).
- **Multiplateforme** : PC + mobile via un même site web (PWA possible).
- **Gratuit** : pas d’API payante, scraping des likes quand le profil est en public.
- **Vie privée** : les joueurs peuvent remettre leurs likes en privé après la collecte.

---

## 2. Règles

- **Lobby** : créer une partie (code) ou rejoindre avec code + pseudo.
- **Préparation** : « Passez vos likes en public → Prêt » → le serveur scrape → « Vous pouvez repasser en privé ».
- **Partie** : 50 TikToks par partie, aléatoires parmi les likes des joueurs.
- **Round** : décompte 3-2-1 → vidéo en boucle → vote (sauf propriétaire) → révélation roulette → scores.
- **Scoring** : base + rapidité + streak. Fin : podium → retour lobby (TikToks déjà joués gardés en base).

---

## 3. Stack

- Backend : Node.js, Express, Socket.io, Playwright, PostgreSQL
- Frontend : HTML/CSS/JS (responsive, PC + mobile)
