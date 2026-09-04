# Mettre Guess The Like en ligne sur Render (Blueprint)

Ce dépôt inclut un `render.yaml` qui provisionne le **service web** et une **base PostgreSQL** en une seule étape.

## 1. Pousser le code sur GitHub

1. Crée un compte sur [github.com](https://github.com) si besoin.
2. Crée un **nouveau dépôt** (ex. `guess-the-like`).
3. Pousse le code :

```bash
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TON_USERNAME/guess-the-like.git
git push -u origin main
```

(Remplace `TON_USERNAME` par ton pseudo GitHub.)

## 2. Appliquer le Blueprint Render

1. Va sur **[render.com](https://render.com)** et connecte-toi (GitHub recommandé).
2. **Dashboard** → **New +** → **Blueprint**.
3. Sélectionne le repo `guess-the-like`.
4. Render détecte `render.yaml` et affiche les ressources à créer :
   - **Web Service** `guess-the-like` (Node, plan Free)
   - **PostgreSQL** `guess-the-like-db` (plan `free` par défaut dans `render.yaml`)
5. Clique sur **Apply** pour provisionner web + Postgres.

`DATABASE_URL` est injectée automatiquement via `fromDatabase`. Les migrations SQL s’appliquent au démarrage du serveur.

> **Plan DB :** le Blueprint utilise `free` pour Postgres. Si ce plan n'est plus disponible sur ton compte Render, remplace `free` par `basic-256mb` dans `render.yaml` (coût mensuel selon la grille Render).

## 3. Attendre le déploiement

- Premier déploiement : **2–5 minutes** (npm install + Playwright Chromium).
- Quand le statut est **Live**, le site est en ligne.
- L’URL ressemble à : `https://guess-the-like-xxxx.onrender.com`

## 4. Cold start (plan Free web)

Le service web Free s’endort après ~15 min sans visite. Le premier chargement après inactivité peut prendre **30–60 secondes**.

## 5. Dépannage Playwright / mémoire

- `PLAYWRIGHT_CONCURRENT=1` limite l’usage RAM sur le tier Free (512 MB).
- Si le build ou le runtime échoue (OOM), options :
  - monter le plan du web service ;
  - ou retirer `&& npx playwright install chromium` du `buildCommand` / `startCommand` (scraping Playwright indisponible).

## 6. Postgres Free — expiration

Les bases Postgres **Free** sur Render expirent après **30 jours**. Sauvegarde ou migre vers un plan payant avant expiration si tu veux conserver les données.

## Résumé

1. Repo GitHub avec le code.
2. Render → **New → Blueprint** → repo → **Apply**.
3. Ouvre l’URL Render pour jouer avec un ami.
