# Architecture technique

## 1. Vue d'ensemble

```
┌────────────────────────────┐        HTTPS/JWT        ┌───────────────────────────┐
│  Application mobile Expo   │  ───────────────────▶  │  API Express 5            │
│  Expo Router + NativeWind  │  ◀───────────────────  │  TypeScript + Zod         │
│  TanStack Query + Zustand  │      JSON / fichiers   │  Prisma 6                 │
└────────────────────────────┘                        └─────────────┬─────────────┘
                                                                  │ SQL
                                                        ┌─────────▼──────────┐
                                                        │ PostgreSQL 16      │
                                                        └────────────────────┘
                                                                  │
                                                        ┌─────────▼──────────┐
                                                        │ uploads/ (médias)  │
                                                        └────────────────────┘
```

- **Stateless** côté API : l'état de session vit dans PostgreSQL (`refresh_tokens`) et les JWT.
- **Mobile-first** : l'application mobile est le client principal ; les documents PDF/Excel sont générés
  par l'API et partagés via le système natif.
- **Offline-first** : cache TanStack Query persistant + file d'attente d'opérations idempotentes.

## 2. Organisation de l'API

Chaque module suit le même découpage :

| Fichier | Rôle |
|---|---|
| `*.routes.ts` | Déclaration des routes, authentification, rôles, validation du corps, audit |
| `*.service.ts` | Règles métier, schémas Zod, transactions Prisma, calculs |
| `lib/*` | Briques transverses : montants, dates, stock, PDF, Excel, stockage, audit |
| `middleware/*` | `authenticate`, `requireRoles`, `requireAdmin`, audit automatique, erreurs |

Les routes sont montées dans `src/app.ts` sous `/api/...`. Les erreurs sont normalisées :

```json
{
  "error": {
    "code": "VALIDATION_ERROR | NOT_FOUND | CONFLICT | UNAUTHORIZED | FORBIDDEN | ...",
    "message": "Message lisible en français",
    "details": {}
  }
}
```

Les dates sont sérialisées en ISO 8601 UTC. Les `Decimal` Prisma sont sérialisés en chaînes JSON
(`"1500.00"`) ; le client mobile utilise `num()` et `formatMoney()` pour les manipuler.

## 3. Modèle de données

### Utilisateurs et sécurité
- `users` : compte, `must_change_password`, `token_version`, suppression logique (`deleted_at`).
- `user_roles` : un utilisateur peut cumuler plusieurs rôles (unique `user_id + role`).
- `refresh_tokens` : hash SHA-256, expiration, révocation, chaînage `replaced_by` pour détecter la
  réutilisation d'un jeton volé.

### Catalogue et achats
- `products` : SKU unique, unité, prix gros/détail, stock, seuil d'alerte, coût moyen, image.
- `purchases` / `purchase_items` : achat fournisseur, frais de transport, coût unitaire réel.
- `suppliers` : fiche fournisseur, historique via `purchases`.

### Ventes
- `sales` : type `GROS`/`DETAIL`, statut, total, remise, payé, solde, COGS, signature, annulation.
- `sale_items` : quantité, prix appliqué, **coût unitaire figé au moment de la vente** (le COGS reste
  exact même si le coût moyen change plus tard).
- `payments` : encaissements liés à une vente, méthode, référence, opérateur.
- `receipts` : recettes réelles ; un paiement de vente crée automatiquement une recette `VENTE`.

### Logistique et stock
- `deliveries` : vente/client/produit facultatifs, livreur obligatoire, destination, statut, preuve.
- `losses` : quantité, motif, coût unitaire et total valorisés.
- `stock_movements` : journal append-only de toutes les variations avec solde après opération.

### Finances, audit, notifications
- `expense_categories` / `expenses` : catégories archivables, dépenses datées.
- `audit_logs` : immuable (trigger PostgreSQL `audit_logs_immutable`), diff JSON avant/après.
- `notifications` / `push_tokens` : notifications in-app et jetons Expo.
- `system_settings` : en-tête des documents, devise, alertes.

## 4. Flux transactionnels

### 4.1 Création d'une vente

```
Validation Zod
  └─▶ Transaction Serializable (retry sur P2034)
        ├─ Chargement des produits (actifs, non supprimés)
        ├─ Calcul des lignes (prix selon GROS/DETAIL, remise)
        ├─ Contrôle du crédit (client obligatoire, plafond)
        ├─ INSERT sale + sale_items (COGS figé)
        ├─ applyStockChange(-quantité) pour chaque ligne
        └─ Si paiement initial : INSERT payment + receipt
```

- Le prix peut être forcé par le vendeur ; sinon le tarif du produit s'applique.
- Une vente avec solde > 0 exige un client identifié.
- Si le client a un plafond > 0, la dette existante + le nouveau solde est comparée au plafond.
- L'annulation (ADMIN) repasse chaque ligne en stock (`ANNULATION_VENTE`) et passe le statut à `ANNULEE`.

### 4.2 Encaissement

Transaction Serializable : vérifie que la vente n'est pas annulée, que le montant ne dépasse pas le solde,
insère le paiement, met à jour `paid_amount`/`balance_due`/`status`, puis crée la recette correspondante.

### 4.3 Achat et coût de revient

Les frais de transport sont répartis au prorata de la valeur des lignes. Le coût unitaire « landed » est
calculé ligne par ligne, puis le coût moyen pondéré du produit est recalculé :

```
nouveauCoût = (stockActuel × coûtActuel + quantitéEntrante × coûtLanded) / (stockActuel + quantitéEntrante)
```

Le stock est incrémenté et un mouvement `ACHAT` est journalisé. Les achats sont immuables.

### 4.4 Pertes

Création d'une perte dans une transaction : contrôle du stock disponible, valorisation au coût moyen,
décrément du stock et mouvement `PERTE`. La suppression (ADMIN) réintègre le stock.

### 4.5 Livraison et preuve

La preuve (`POST /api/deliveries/:id/proof`) est un `multipart/form-data` :

- `photo` : photo du colis (facultative mais recommandée) ;
- `receiverName` : nom du réceptionnaire (obligatoire) ;
- `signatureBase64` : data URL PNG (obligatoire côté mobile) ;
- `notes` : commentaire libre.

La signature est écrite dans `uploads/signatures`, la photo dans `uploads/deliveries`. La livraison passe
automatiquement à `LIVRE` avec `deliveredAt`. L'opération est auditée avec les URLs des preuves.

## 5. Stock et COGS

- Toute variation passe par `applyStockChange` (transaction obligatoire).
- Le stock ne peut pas devenir négatif sauf `allowNegative` explicite.
- Chaque mouvement conserve `balance_after`, `unit_cost`, `reference_type`/`reference_id`.
- Le COGS d'une vente est la somme des `unit_cost × quantity` des lignes, figé à la création.
- Le bénéfice net affiché est un indicateur de trésorerie :
  `recettes encaissées − dépenses − COGS`. Le bénéfice comptable est aussi calculé
  (`ventes − COGS − dépenses`) pour la comparaison.

## 6. Audit immuable

Deux niveaux :

1. **Applicatif** : middleware sur les mutations réussies + appels explicites `setAudit` avec diff
   avant/après (vente, paiement, stock, livraison, paramètres…).
2. **Base de données** : trigger `prevent_audit_log_mutation()` qui rejette tout `UPDATE`/`DELETE` sur
   `audit_logs`. Les logs ne peuvent donc être ni modifiés ni supprimés, même par l'API.

Les payloads sont nettoyés : clés sensibles supprimées, base64 remplacé, chaînes tronquées, profondeur
limitée. Chaque entrée contient l'utilisateur, l'action, l'entité, l'ID, l'IP et le user-agent.

## 7. Authentification

1. `POST /api/auth/login` vérifie bcrypt, crée un access JWT (15 min) et un refresh token opaque
   (48 octets aléatoires, hash SHA-256 en base).
2. L'access token contient `sub`, `roles`, `tokenVersion` ; `authenticate` vérifie la version en base.
3. `POST /api/auth/refresh` fait tourner le refresh token : l'ancien est révoqué et chaîné au nouveau.
   La réutilisation d'un ancien jeton révoque toute la famille (détection de vol).
4. `POST /api/auth/change-password` revoque tous les refresh tokens et incrémente `tokenVersion`.
5. `POST /api/auth/logout` révoque le refresh token fourni (ou tous les appareils avec `allDevices`).

## 8. Synchronisation hors-ligne

### Côté mobile

- Les requêtes de lecture sont mises en cache par TanStack Query et persistées dans AsyncStorage.
- Les mutations critiques (vente, paiement, perte, dépense, livraison) interceptent les erreurs réseau et
  appellent `queueOperation(entity, payload)`.
- Chaque opération reçoit un `clientRef` égal à son identifiant local. La file est persistée dans
  AsyncStorage (`depot.offline-queue.v1`) et survit à la fermeture de l'application.
- Les réglages `offlineEnabled` et `autoSync` sont persistés dans `useOfflineStore`. Si le mode hors-ligne
  est désactivé, `queueOperation` renvoie `null` et l'écran affiche « Connexion requise ».
- `useOfflineStore.flush()` envoie les opérations par lots de 50 à `POST /api/sync/push`.
- La synchronisation automatique est déclenchée : au retour de `NetInfo`, quand l'application repasse au
  premier plan (`AppState.active`), à chaque changement de file et toutes les 60 secondes tant que
  l'application est ouverte.
- Une opération en échec est retentée automatiquement jusqu'à 5 fois. Au-delà, elle reste dans la file
  avec son erreur et peut être relancée via « Synchroniser maintenant » (relance forcée).
- Après un envoi réussi, le cache TanStack Query est invalidé pour rafraîchir les écrans avec les données
  serveur.
- Le panneau de réglages hors-ligne reste accessible même si les paramètres serveur ne sont pas
  disponibles localement.

> Limite : il s'agit d'une synchronisation en arrière-plan dans le processus applicatif. Aucune tâche
> native d'arrière-plan n'est planifiée lorsque l'application est complètement fermée ; la file reprend
> automatiquement au prochain démarrage.

### Côté API

`POST /api/sync/push` rejoue chaque opération dans le service métier correspondant, avec le même
`clientRef`. Les contraintes `UNIQUE` sur `client_ref` garantissent qu'un rejeu ne crée pas de doublon :
le service renvoie la ressource existante avec `created: false`.

Réponse :

```json
{
  "results": [
    { "id": "op-...", "entity": "sale", "ok": true, "resourceId": "...", "created": true }
  ],
  "succeeded": 1,
  "failed": 0,
  "serverTime": "2026-10-23T12:00:00.000Z"
}
```

## 9. Médias et documents

- `lib/storage.ts` expose une interface simple (écriture, URL publique). L'implémentation actuelle écrit
  dans `UPLOAD_DIR` et sert les fichiers via `GET /files/...`.
- Les URLs stockées sont **relatives** (`/files/products/uuid.jpg`), ce qui permet de changer de domaine.
  Le mobile les résout avec `mediaUrl()`.
- PDF : `pdf-lib` (facture, bon de livraison, relevé client) avec logo et en-tête paramétrables.
- Excel : `exceljs` (exports globaux et facture Excel).

## 10. Notifications

- `lib/push.ts` appelle l'API Expo Push par `fetch` (aucun SDK supplémentaire).
- Le job planifié (`jobs/notification.job.ts`, cron) détecte :
  - stock sous le seuil,
  - créances échues,
  - livraisons en retard.
- Les notifications sont écrites en base puis poussées aux jetons `push_tokens` actifs.
- L'application enregistre son jeton au démarrage et affiche les notifications in-app.

## 11. Application mobile

### Navigation (Expo Router)

```
app/
├─ (auth)/login
├─ (app)/
│  ├─ (tabs)/            tableau de bord, ventes, livraisons, stock, finances
│  ├─ sales/             liste, nouvelle vente, détail + encaissement + signature
│  ├─ deliveries/        nouvelle livraison, détail + preuve
│  ├─ products/          nouveau produit, fiche + mouvements
│  ├─ purchases/         achats + nouvel achat
│  ├─ losses/            pertes
│  ├─ expenses/          dépenses + catégories
│  ├─ receipts/          recettes
│  ├─ clients/           liste, création, fiche + historique
│  ├─ suppliers/         liste, création, fiche + achats
│  ├─ users/             gestion des comptes (ADMIN)
│  ├─ audit/             journal (ADMIN)
│  ├─ settings/          paramètres (lecture seule hors ADMIN)
│  ├─ notifications
│  └─ change-password
```

### État et données

- `zustand` : session (`store/auth.ts`) et file hors-ligne (`store/offline.ts`).
- `TanStack Query` : toutes les lectures, invalidation ciblée après mutation.
- `NativeWind` : styles utilitaires Tailwind.
- `victory-native` (Skia) : graphique recettes/dépenses.
- `react-native-signature-canvas` : signature tactile.
- `expo-image-picker` : photo produit et preuve de livraison.
- `expo-secure-store` : session sur mobile ; AsyncStorage en secours et sur le web.

## 12. Points d'extension

| Besoin | Point d'entrée |
|---|---|
| Stockage objet (S3/GCS) | `apps/api/src/lib/storage.ts` |
| Nouvelles catégories de dépenses | données, aucune migration |
| Nouveau type de notification | enum Prisma + service/job |
| Nouveau rapport | `modules/reports` + entrée d'export |
| Nouvel écran mobile | fichier dans `app/(app)/...` + `Stack.Screen` |
| Multi-dépôts | ajouter `depotId` aux tables métier et filtrer dans les services |

## 13. Qualité et intégration continue

| Contrôle | Commande locale | CI |
|---|---|---|
| Types API | `npm --prefix apps/api run typecheck` | oui |
| Types mobile | `npm --prefix apps/mobile run typecheck` | oui |
| Tests API (Vitest) | `npm --prefix apps/api test` | oui |
| Build API | `npm --prefix apps/api run build` | oui |
| Diagnostic Expo | `cd apps/mobile && npx expo-doctor` | oui |
| Bundle web | `npx expo export --platform web` | oui |
| Migrations + seed PostgreSQL | nécessite une base locale | oui, service `postgres:16-alpine` |

Le workflow `.github/workflows/ci.yml` exécute ces contrôles sur chaque `push` vers `main` et sur les
`pull_request`. Le job base de données applique `prisma migrate deploy`, rejoue `prisma db seed`, puis
vérifie que les tables principales contiennent des données.

La référence HTTP complète (routes, corps, erreurs, synchronisation) se trouve dans
[`docs/API.md`](API.md).

