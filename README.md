# DEPOT-BACKEND — API « Dépôt Boissons »

API REST pour la gestion complète d'un dépôt de boissons : ventes **gros/détail**, achats,
stock, pertes, livraisons, encaissements, dépenses, rapports, exports Excel, audit immuable
et notifications.

- **Stack** : Node.js 24 · Express 5 · TypeScript · Prisma · PostgreSQL · Zod
- **Interface et libellés métier** : français · montants en décimaux (XOF/FCFA), jamais en flottants
- **Application mobile** (Expo) : dépôt [`DEPOT`](https://github.com/cherifcoder/DEPOT)
- **Documentation complète des endpoints** : [`docs/API.md`](docs/API.md)

---

## 1. Modules couverts

| Domaine | Contenu |
| --- | --- |
| **Utilisateurs / sécurité** | JWT d'accès court (15 min) + refresh tokens opaques hachés avec rotation et détection de réutilisation ; rôles `ADMIN`, `VENDEUR`, `COMPTABLE`, `LIVREUR` ; changement de mot de passe obligatoire à la première connexion |
| **Produits / achats** | photos produits, achats fournisseurs **immuables** avec lignes et frais de transport répartis au prorata dans le coût de revient réel (coût moyen pondéré) |
| **Stock** | mouvements journalisés, ajustement manuel (ADMIN), alertes de stock bas |
| **Pertes** | motifs (expiré, endommagé, perdu en transit, autre), valorisation au coût moyen |
| **Ventes** | gros/détail, comptant/partiel/crédit avec plafond contrôlé, factures **PDF/Excel**, signature électronique, annulation (ADMIN) avec restitution du stock, référence idempotente `clientRef` |
| **Finance** | encaissements, dépenses catégorisées, bénéfice net de trésorerie et comptable |
| **Clients / fournisseurs** | historique, encours, plafond de crédit, relevé PDF, classements |
| **Livraisons** | affectation livreur, statuts, bon de livraison PDF, preuve (signature + photo) |
| **Audit** | journal **immuable** (trigger PostgreSQL) : utilisateur, action, entité, diff avant/après, IP, user-agent |
| **Notifications** | in-app + push Expo (stock bas, créances échues, livraisons en retard) |
| **Hors-ligne** | `POST /api/sync/push` rejoue ventes, encaissements, pertes, dépenses et livraisons avec idempotence |
| **Exports** | Excel : ventes, encaissements, achats, clients, fournisseurs, pertes, dépenses, produits |

---

## 2. Démarrage local

### Prérequis
- Node.js ≥ 24
- Une base PostgreSQL (voir les deux options ci-dessous)

### Base de données — Option A : PostgreSQL embarqué (aucune installation)

```bash
npm install
npm run db:local        # télécharge et démarre un PostgreSQL local (data dans .pgdata/)
```

### Base de données — Option B : Docker Compose

```bash
docker compose up postgres -d
```

### Configuration

```bash
cp .env.example .env
# Ajuste DATABASE_URL, JWT_ACCESS_SECRET et JWT_REFRESH_SECRET si besoin
# Générer des secrets : node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Migrations + données de démonstration

```bash
npm run db:deploy        # applique les migrations
npm run db:seed          # charge le jeu de démonstration complet
```

### Lancer l'API

```bash
npm run dev              # http://localhost:4000/health
```

---

## 3. Scripts

| Script | Rôle |
| --- | --- |
| `npm run dev` | API en mode watch (`tsx`) |
| `npm run build` | génère le client Prisma puis compile vers `dist/` |
| `npm start` | lance `dist/index.js` (serveur autonome) |
| `npm run typecheck` | vérification TypeScript |
| `npm test` | tests unitaires et smoke tests (Vitest) |
| `npm run db:local` | PostgreSQL embarqué local |
| `npm run db:start / db:stop / db:status` | contrôle du PostgreSQL embarqué |
| `npm run db:migrate` | migrations en mode dev |
| `npm run db:deploy` | applique les migrations (production) |
| `npm run db:seed` | jeu de démonstration |
| `npm run db:reset` | réinitialise tout (destructif) |

---

## 4. Variables d'environnement

Voir [`.env.example`](.env.example). Les essentielles :

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | connexion PostgreSQL (obligatoire) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | secrets des jetons (≥ 16 caractères) |
| `PUBLIC_BASE_URL` | URL publique servant à construire les liens médias |
| `CORS_ORIGINS` | origines autorisées, séparées par des virgules (`*` = tout) |
| `UPLOAD_DIR` | dossier de stockage des médias |
| `ENABLE_CRON` | planificateur d'alertes (node-cron, serveur autonome uniquement) |
| `EXPO_ACCESS_TOKEN` | jeton d'accès Expo pour les push |

---

## 5. Déploiement sur Vercel

Le dépôt est prêt pour Vercel : [`api/index.ts`](api/index.ts) exporte l'application Express
comme fonction serverless et [`vercel.json`](vercel.json) réécrit toutes les routes vers elle.

### Variables à configurer sur Vercel (Production)

```
DATABASE_URL=postgresql://...      # PostgreSQL hébergé (Neon, Supabase, Vercel Postgres…)
JWT_ACCESS_SECRET=...              # générez une valeur aléatoire longue
JWT_REFRESH_SECRET=...
PUBLIC_BASE_URL=https://<votre-deploiement>.vercel.app
CORS_ORIGINS=*
UPLOAD_DIR=/tmp/depot-uploads      # seul dossier inscriptible en serverless
ENABLE_CRON=false
```

### Migrations et données

Vercel n'exécute pas les migrations ; à lancer une fois depuis une machine de confiance :

```bash
DATABASE_URL="postgresql://..." npm run db:deploy
DATABASE_URL="postgresql://..." npm run db:seed      # données de démonstration (optionnel)
```

### Limitations en serverless

- **Médias éphémères** : `/tmp` n'est pas persistant entre les invocations — les photos,
  signatures et preuves de livraison ne survivent pas. Pour la production, brancher un
  stockage objet (Vercel Blob / S3 / Cloudinary) dans `src/lib/storage.ts`.
- **Planificateur désactivé** : `node-cron` ne tourne pas en serverless (`ENABLE_CRON=false`).
  Les alertes peuvent être déclenchées par un Vercel Cron appelant un endpoint dédié.

### Déployer en CLI

```bash
npm i -g vercel
vercel link            # lie ce dossier au projet Vercel
vercel --prod
```

---

## 6. Docker (serveur autonome)

```bash
docker compose up --build
# API : http://localhost:4000 — migrations appliquées au démarrage
```

---

## 7. CI

GitHub Actions (`.github/workflows/ci.yml`) : typecheck, tests, build, et validation des
migrations + seed sur PostgreSQL 16 à chaque push/PR sur `main`.

---

## 8. Comptes de démonstration

Après `npm run db:seed` :

| Rôle | Identifiant | Mot de passe |
| --- | --- | --- |
| Administrateur | `admin@depot.app` | `Admin@2026!` |
| Vendeur | `vendeur@depot.app` | `Vendeur@2026!` |
| Comptable | `comptable@depot.app` | `Comptable@2026!` |
| Livreur | `livreur@depot.app` | `Livreur@2026!` |

> ⚠️ À changer avant toute utilisation réelle.
