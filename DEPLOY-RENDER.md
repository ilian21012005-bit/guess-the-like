# Mettre Guess The Like en ligne sur Render

## 1. Mettre le projet sur GitHub

1. Crée un compte sur [github.com](https://github.com) si besoin.
2. Crée un **nouveau dépôt** (New repository), par ex. `guess-the-like`.
3. Dans le dossier du projet (PowerShell ou terminal) :

```bash
cd d:\Who-liked
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TON_USERNAME/guess-the-like.git
git push -u origin main
```

(Remplace `TON_USERNAME` par ton pseudo GitHub.)

---

## 2. Créer le service sur Render

1. Va sur **[render.com](https://render.com)** et crée un compte (ou connecte-toi avec GitHub).
2. Clique sur **Dashboard** → **New +** → **Web Service**.
3. **Connect a repository** : autorise Render à accéder à GitHub, puis choisis le repo `guess-the-like`.
4. Remplis comme suit :

| Champ | Valeur |
|-------|--------|
| **Name** | `guess-the-like` (ou ce que tu veux) |
| **Region** | Choisis le plus proche (ex. Frankfurt) |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | **Free** |

5. Clique sur **Create Web Service**.

---

## 3. Attendre le premier déploiement

- Render va cloner le repo, lancer `npm install` puis `npm start`.
- La première fois peut prendre **2–5 minutes** (surtout à cause de Playwright si installé).
- Quand le statut est **Live** en vert, le site est en ligne.

---

## 4. Récupérer l’URL

- En haut de la page du service, tu vois l’URL du type :  
  **`https://guess-the-like-xxxx.onrender.com`**
- Partage ce lien : toi et ton ami vous y connectez pour jouer.

---

## 5. (Optionnel) Base de données PostgreSQL

Sans base de données, le jeu utilise la **mémoire** : les salles et les likes marchent, mais tout est perdu au redémarrage du service.

Pour une base gratuite sur Render :

1. **Dashboard** → **New +** → **PostgreSQL**.
2. Crée une base (garde le **Internal Database URL**).
3. Dans ton **Web Service** → **Environment** → **Add Environment Variable** :
   - **Key** : `DATABASE_URL`
   - **Value** : colle l’**Internal Database URL** de la base.
4. Redéploie (manuel ou au prochain push).

(Pour que la BDD soit utilisée, il faut que ton code lise `DATABASE_URL` et que les scripts type `db:init` aient été exécutés ou que le schéma soit appliqué.)

---

## Résumé

1. Repo GitHub avec le code.
2. Render → New Web Service → repo → Build : `npm install`, Start : `npm start`.
3. Utiliser l’URL fournie par Render pour jouer avec un ami.

En **Free**, le service peut s’endormir après ~15 min sans visite ; le premier chargement après ça peut prendre 30–60 secondes.
