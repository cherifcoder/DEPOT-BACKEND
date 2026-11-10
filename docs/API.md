# API — Dépôt Boissons

Référence des points d'entrée HTTP de l'API. L'API est une application Express 5 montée par défaut sur
`http://localhost:4000` (variable `PORT`). Les réponses sont en JSON, sauf les documents binaires
(PDF, XLSX) et les fichiers statiques.

- Préfixe métier : `/api`
- Fichiers téléversés : `/files/...` (public, en lecture seule)
- Santé du service : `GET /health` → `{ "status": "ok", "service": "depot-boissons-api", "time": "..." }`

---

## 1. Conventions

### 1.1 Authentification

Toutes les routes `/api/*` sont protégées par un **JWT d'accès** (`Authorization: Bearer <accessToken>`),
sauf :

| Route | Accès |
| --- | --- |
| `POST /api/auth/login` | public, limité en débit |
| `POST /api/auth/refresh` | public (jeton de rafraîchissement requis) |

Le jeton d'accès dure **15 minutes**. Le jeton de rafraîchissement est opaque, haché en base, à rotation :
chaque rafraîchissement invalide l'ancien jeton. La réutilisation d'un jeton déjà consommé révoque toutes
les sessions de l'utilisateur. `tokenVersion` permet d'invalider immédiatement les jetons d'accès
(déconnexion globale, changement de mot de passe, révocation par un administrateur).

### 1.2 Rôles

Un utilisateur peut cumuler plusieurs rôles.

| Rôle | Portée |
| --- | --- |
| `ADMIN` | accès complet, y compris utilisateurs, audit, paramètres et annulations |
| `VENDEUR` | ventes, encaissements, clients, produits, pertes, livraisons |
| `COMPTABLE` | achats, dépenses, encaissements, livraisons (sans rapports financiers ni exports) |
| `LIVREUR` | livraisons qui lui sont affectées (liste, détail, statut, preuve) |

`ADMIN` est toujours autorisé, même si la route déclare d'autres rôles. Les routes de lecture sans
restriction explicite sont accessibles à tout utilisateur authentifié.

Un utilisateur dont le **seul** rôle est `LIVREUR` ne voit et ne modifie que ses propres livraisons.
La liste est automatiquement filtrée (`mine=true`), et toute tentative d'accès à une livraison d'un
autre livreur renvoie `403 FORBIDDEN`.

### 1.3 Dates, périodes et montants

- Les dates de filtre sont au format `YYYY-MM-DD` (ou ISO 8601). Les réponses utilisent l'ISO 8601 UTC.
- Les listes acceptent `from`, `to`, `period` et parfois `granularity`.
  - `period` : `day`, `week`, `month`, `year`, `custom`, `all`.
  - `custom` exige `from` et `to`.
  - `granularity` (rapports) : `day`, `week`, `month`, `year`.
- Les montants sont des décimaux. En JSON, les `Decimal` Prisma sont sérialisés en **chaîne**
  (par exemple `"12500.00"`) ; les agrégats calculés peuvent être des nombres. Les clients doivent
  convertir avant calcul.

### 1.4 Pagination

Les listes paginées renvoient :

```json
{
  "data": [],
  "meta": { "page": 1, "limit": 20, "total": 0, "totalPages": 1 }
}
```

Paramètres : `page` (défaut `1`) et `limit` (défaut `20`, maximum `100` selon les routes).

### 1.5 Erreurs

Toutes les erreurs ont la même enveloppe :

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Donnees invalides",
    "details": [{ "path": "items.0.quantity", "message": "La quantite doit etre superieure a zero" }]
  }
}
```

| HTTP | Code | Cas |
| --- | --- | --- |
| `400` | `BAD_REQUEST` | requête mal formée, paramètre métier manquant |
| `401` | `UNAUTHORIZED` | jeton absent, expiré ou invalide |
| `403` | `FORBIDDEN` | rôle insuffisant ou ressource d'un autre livreur |
| `404` | `NOT_FOUND` | ressource inexistante |
| `409` | `DUPLICATE` | contrainte d'unicité (SKU, e-mail, `clientRef`…) |
| `409` | `CONFLICT` | conflit métier (stock insuffisant, plafond de crédit, vente annulée…) |
| `422` | `VALIDATION_ERROR` | échec de validation Zod |
| `500` | `INTERNAL_ERROR` | erreur inattendue |

Le détail des erreurs de validation est un tableau `{ path, message }`.

### 1.6 Idempotence hors ligne (`clientRef`)

Les créations de **vente, paiement, perte, dépense, livraison et achat** acceptent un champ optionnel
`clientRef` (chaîne, max 120). Si la même référence est rejouée :

- la ressource existante est renvoyée ;
- la réponse contient `created: false` (au lieu de `true`) ;
- le statut HTTP est `200` au lieu de `201` ;
- aucun doublon de stock, de paiement ou d'écriture comptable n'est créé.

Le client mobile utilise l'identifiant de l'opération de sa file comme `clientRef`.

### 1.7 Fichiers et documents

- Téléversements : `multipart/form-data`. Le champ attendu est indiqué par route (`file`, `photo`).
  Taille maximale : `MAX_UPLOAD_MB` (10 Mo par défaut).
- Images produits, signatures et preuves de livraison sont stockées sur disque et servies sous
  `/files/...`. Les URL renvoyées sont **relatives** ; le client les préfixe avec l'URL de l'API.
- Les PDF/XLSX sont renvoyés en binaire avec `Content-Type` et `Content-Disposition` adaptés.
  Ils nécessitent le même en-tête `Authorization` que les autres routes.

---

## 2. Authentification

| Méthode | Route | Rôles | Description |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | public | Connexion e-mail / mot de passe |
| `POST` | `/api/auth/refresh` | public | Rotation du jeton de rafraîchissement |
| `GET` | `/api/auth/me` | authentifié | Profil et rôles courants |
| `POST` | `/api/auth/logout` | authentifié | Révocation d'un ou de tous les jetons |
| `POST` | `/api/auth/change-password` | authentifié | Changement de mot de passe |

### `POST /api/auth/login`

```json
{ "email": "admin@depot.app", "password": "Admin@2026!" }
```

`200` :

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "9f1c...",
  "user": {
    "id": "6f0e...",
    "fullName": "Administrateur",
    "email": "admin@depot.app",
    "phone": "+225...",
    "avatarUrl": null,
    "isActive": true,
    "mustChangePassword": false,
    "roles": ["ADMIN"],
    "lastLoginAt": "2026-10-23T08:00:00.000Z",
    "createdAt": "2026-10-01T10:00:00.000Z"
  }
}
```

Erreurs : `401 UNAUTHORIZED` (identifiants invalides), `403 FORBIDDEN` (compte désactivé),
`429` (trop de tentatives).

### `POST /api/auth/refresh`

```json
{ "refreshToken": "9f1c..." }
```

Renvoie la même structure que `login`. Un jeton inconnu, expiré, révoqué ou réutilisé renvoie `401`.

### `POST /api/auth/logout`

```json
{ "refreshToken": "9f1c...", "allDevices": false }
```

`204` sans corps. `allDevices: true` révoque toutes les sessions de l'utilisateur.

### `POST /api/auth/change-password`

```json
{ "currentPassword": "Ancien@2026!", "newPassword": "Nouveau@2026!" }
```

`204`. Le mot de passe doit contenir au moins 8 caractères, une lettre et un chiffre.
Toutes les sessions sont révoquées après le changement.

---

## 3. Utilisateurs (ADMIN)

| Méthode | Route | Description |
| --- | --- | --- |
| `GET` | `/api/users` | Liste paginée (`search`, `role`, `isActive`) |
| `GET` | `/api/users/:id` | Détail |
| `POST` | `/api/users` | Création |
| `PATCH` | `/api/users/:id` | Mise à jour |
| `DELETE` | `/api/users/:id` | Désactivation logique |
| `POST` | `/api/users/:id/password` | Réinitialisation du mot de passe |
| `POST` | `/api/users/:id/revoke-sessions` | Révocation de toutes les sessions |

Création :

```json
{
  "fullName": "Awa Kone",
  "email": "awa@depot.app",
  "phone": "+225 07 00 00 00",
  "password": "Vendeur@2026!",
  "roles": ["VENDEUR"],
  "mustChangePassword": true
}
```

Réinitialisation : `{ "newPassword": "..." }` (facultatif). Sans mot de passe fourni, l'API en génère
un et le renvoie une seule fois :

```json
{ "user": { "...": "..." }, "generatedPassword": "Xy7-tR2p" }
```

Règles : le dernier administrateur actif ne peut être ni désactivé ni privé du rôle `ADMIN`.

---

## 4. Produits et stock

| Méthode | Route | Rôles | Description |
| --- | --- | --- | --- |
| `GET` | `/api/products` | authentifié | Liste paginée |
| `GET` | `/api/products/:id` | authentifié | Détail |
| `GET` | `/api/products/:id/movements` | authentifié | Mouvements de stock paginés |
| `POST` | `/api/products` | VENDEUR, COMPTABLE | Création |
| `PATCH` | `/api/products/:id` | VENDEUR, COMPTABLE | Mise à jour |
| `DELETE` | `/api/products/:id` | VENDEUR, COMPTABLE | Archivage logique |
| `POST` | `/api/products/:id/image` | authentifié | Téléversement de la photo (`file`) |
| `POST` | `/api/products/:id/adjust-stock` | ADMIN | Ajustement manuel |
| `GET` | `/api/products/categories` | authentifié | Catégories |
| `POST` | `/api/products/categories` | ADMIN | Création d'une catégorie |
| `PATCH` | `/api/products/categories/:id` | ADMIN | Mise à jour |
| `DELETE` | `/api/products/categories/:id` | ADMIN | Archivage |

Filtres de liste : `search`, `categoryId`, `lowStock=true|false`, `isActive=true|false`,
`sort=name|stockQty|createdAt|salePriceDetail`, `order=asc|desc`, `page`, `limit`.

Création :

```json
{
  "sku": "COCA-33",
  "name": "Coca-Cola 33 cl",
  "categoryId": "0b6c...",
  "unit": "BOUTEILLE",
  "volumeCl": 33,
  "unitsPerPack": 24,
  "costPrice": 250,
  "salePriceGros": 300,
  "salePriceDetail": 400,
  "minStockQty": 48,
  "initialStockQty": 240,
  "isActive": true
}
```

Unités : `BOUTEILLE`, `CASIER`, `PACK`, `CARTON`, `FUT`, `AUTRE`.

Ajustement :

```json
{ "delta": -6, "note": "Casse constatée en réserve" }
```

`delta` non nul, `note` de 3 à 500 caractères. L'ajustement crée un mouvement de stock avec le motif.

Réponse image : `{ "product": {...}, "image": { "url": "/files/products/...", "filename": "...", "size": 12345, "mimeType": "image/jpeg" } }`.

---

## 5. Fournisseurs et achats

### Fournisseurs

| Méthode | Route | Rôles |
| --- | --- | --- |
| `GET` | `/api/suppliers` | authentifié |
| `GET` | `/api/suppliers/top` | authentifié |
| `GET` | `/api/suppliers/:id` | authentifié |
| `POST` | `/api/suppliers` | COMPTABLE |
| `PATCH` | `/api/suppliers/:id` | COMPTABLE |
| `DELETE` | `/api/suppliers/:id` | COMPTABLE |

Corps : `name` (requis), `contactName`, `phone`, `email`, `address`, `notes`, `isActive`.
`/top` accepte `from`, `to`, `period`, `limit`.

### Achats

| Méthode | Route | Rôles |
| --- | --- | --- |
| `GET` | `/api/purchases` | authentifié |
| `GET` | `/api/purchases/:id` | authentifié |
| `POST` | `/api/purchases` | COMPTABLE |

Un achat est **immuable** (pas de modification ni de suppression). Les frais de transport sont répartis
au prorata de la valeur des lignes et incorporés au coût moyen pondéré du produit.

```json
{
  "supplierId": "1c2d...",
  "purchaseDate": "2026-10-20",
  "transportFees": 25000,
  "notes": "Livraison du matin",
  "clientRef": "purchase-20261020-1",
  "items": [
    { "productId": "0b6c...", "quantity": 240, "unitCost": 250 },
    { "productId": "8a7f...", "quantity": 100, "unitCost": 600 }
  ]
}
```

`201` :

```json
{ "purchase": { "id": "…", "reference": "ACH-20261020-4F2K", "totalAmount": "85000.00", "items": [] }, "created": true }
```

Filtres de liste : `supplierId`, `search`, `from`, `to`, `period`, `page`, `limit`.

---

## 6. Clients

| Méthode | Route | Rôles |
| --- | --- | --- |
| `GET` | `/api/clients` | authentifié |
| `GET` | `/api/clients/top` | ADMIN |
| `GET` | `/api/clients/:id` | authentifié |
| `GET` | `/api/clients/:id/statement.pdf` | authentifié |
| `POST` | `/api/clients` | VENDEUR, COMPTABLE |
| `PATCH` | `/api/clients/:id` | VENDEUR, COMPTABLE |
| `DELETE` | `/api/clients/:id` | VENDEUR, COMPTABLE |

Corps : `name` (requis), `phone`, `email`, `address`, `creditLimit`, `notes`, `isActive`.

Filtres : `search`, `isActive`, `withDebt=true`, `page`, `limit`.

Le détail renvoie l'historique des ventes, les paiements récents et un bloc `totals` :
`salesCount`, `totalAmount`, `totalPaid`, `outstanding`, `overdue`.

`GET /api/clients/top?period=month&limit=10` :

```json
{
  "data": [
    { "client": { "...": "..." }, "totalAmount": "125000.00", "outstanding": "25000.00", "salesCount": 8 }
  ]
}
```

Le relevé PDF accepte `from`, `to`, `period`.

Un client ayant un encours ne peut pas être archivé (`409 CONFLICT`).

---

## 7. Ventes et encaissements

| Méthode | Route | Rôles | Description |
| --- | --- | --- | --- |
| `GET` | `/api/sales` | authentifié | Liste paginée |
| `GET` | `/api/sales/:id` | authentifié | Détail complet |
| `GET` | `/api/sales/:id/summary` | authentifié | Synthèse pour partage |
| `POST` | `/api/sales` | VENDEUR, COMPTABLE | Création |
| `POST` | `/api/sales/:id/payments` | VENDEUR, COMPTABLE | Encaissement |
| `POST` | `/api/sales/:id/signature` | VENDEUR, COMPTABLE | Signature électronique |
| `POST` | `/api/sales/:id/cancel` | ADMIN | Annulation + restitution du stock |
| `GET` | `/api/sales/:id/invoice.pdf` | authentifié | Facture PDF |
| `GET` | `/api/sales/:id/invoice.xlsx` | authentifié | Facture Excel |
| `POST` | `/api/sales/:id/attachment` | authentifié | Pièce jointe (`file`) |

### Création

```json
{
  "clientId": "1c2d...",
  "type": "DETAIL",
  "items": [
    { "productId": "0b6c...", "quantity": 12 },
    { "productId": "8a7f...", "quantity": 2, "unitPrice": 390 }
  ],
  "discount": 500,
  "payment": { "amount": 5000, "method": "CASH", "reference": null, "notes": null },
  "dueDate": "2026-11-20",
  "saleDate": "2026-10-23",
  "notes": "Livraison à la boutique",
  "clientRef": "sale-20261023-001",
  "signatureBase64": "data:image/png;base64,..."
}
```

Règles métier :

- `type` : `GROS` ou `DETAIL` (défaut `DETAIL`). Sans `unitPrice`, le prix de vente du produit
  correspondant au type est appliqué.
- Une vente à crédit (`payment` absent, `null` ou montant inférieur au total) **exige un client**
  et contrôle le plafond : `encours + reste à payer ≤ creditLimit`.
- Le stock est décrémenté dans une transaction sérialisée ; un stock insuffisant renvoie `409`.
- Le COGS est figé par ligne à partir du coût moyen pondéré courant.
- `discount` s'applique au total, jamais en dessous de zéro.

`201` :

```json
{
  "sale": {
    "id": "…",
    "reference": "VTE-20261023-K7M2P",
    "type": "DETAIL",
    "status": "PARTIELLE",
    "saleDate": "2026-10-23T00:00:00.000Z",
    "dueDate": "2026-11-20T00:00:00.000Z",
    "subtotal": "7100.00",
    "discount": "500.00",
    "totalAmount": "6600.00",
    "paidAmount": "5000.00",
    "balanceDue": "1600.00",
    "cogs": "3900.00",
    "client": { "id": "…", "name": "Boutique Chez Awa", "phone": "…" },
    "user": { "id": "…", "fullName": "Vendeur" },
    "items": [
      {
        "id": "…",
        "productId": "…",
        "quantity": 12,
        "unitPrice": "400.00",
        "lineTotal": "4800.00",
        "unitCost": "250.00",
        "product": { "id": "…", "name": "Coca-Cola 33 cl" }
      }
    ],
    "payments": [],
    "deliveries": []
  },
  "created": true
}
```

Statuts : `EN_ATTENTE`, `PARTIELLE`, `PAYEE`, `ANNULEE`.

Filtres de liste : `search`, `status`, `type`, `clientId`, `userId`, `hasBalance=true`,
`from`, `to`, `period`, `page`, `limit`.

### Encaissement

```json
{ "amount": 1600, "method": "MOBILE_MONEY", "reference": "MM-77812", "notes": null, "paidAt": "2026-10-24", "clientRef": "payment-001" }
```

Méthodes : `CASH`, `MOBILE_MONEY`, `VIREMENT`, `CHEQUE`, `AUTRE`.

`201` :

```json
{
  "payment": { "id": "…", "amount": "1600.00", "method": "MOBILE_MONEY", "paidAt": "…" },
  "sale": { "id": "…", "status": "PAYEE", "paidAmount": "6600.00", "balanceDue": "0.00" },
  "created": true
}
```

Chaque encaissement crée automatiquement une **recette** de source `VENTE`, utilisée par les rapports
de trésorerie. Un paiement ne peut pas dépasser le reste à payer (`409`).

### Signature

```json
{ "signatureBase64": "data:image/png;base64,iVBORw0KGgo..." }
```

La chaîne est enregistrée comme image et l'URL `signatureUrl` est stockée sur la vente avec `signedAt`.
`signatureBase64` peut aussi être fourni directement à la création de la vente.

### Annulation

```json
{ "reason": "Erreur de saisie sur les quantités" }
```

Réservé à `ADMIN`. La vente passe en `ANNULEE`, le stock est restitué et un mouvement de stock est
enregistré. Une vente déjà annulée renvoie `409`.

### Synthèse

`GET /api/sales/:id/summary` renvoie les informations nécessaires au partage WhatsApp/e-mail
(référence, client, total, payé, reste, articles, vendeur, signature).

---

## 8. Pertes

| Méthode | Route | Rôles |
| --- | --- | --- |
| `GET` | `/api/losses` | authentifié |
| `GET` | `/api/losses/summary` | authentifié |
| `POST` | `/api/losses` | VENDEUR, COMPTABLE |
| `DELETE` | `/api/losses/:id` | ADMIN |

```json
{
  "productId": "0b6c...",
  "quantity": 6,
  "reason": "PERIME",
  "lossDate": "2026-10-22",
  "notes": "DLUO dépassée",
  "clientRef": "loss-001"
}
```

Motifs : `PERIME`, `ENDOMMAGE`, `PERDU_TRANSPORT`, `AUTRE`.

`201` : `{ "loss": { "...": "...", "reference": "PER-20261022-…", "totalCost": "1500.00" }, "created": true }`.

La création déduit immédiatement le stock et valorise la perte au coût moyen. La suppression
(`ADMIN`) **restaure le stock** et reste tracée dans l'audit.

`/summary` accepte `from`, `to`, `period` et renvoie le coût total, la quantité, la répartition par
motif et le top 10 des produits perdus.

---

## 9. Dépenses et catégories

| Méthode | Route | Rôles |
| --- | --- | --- |
| `GET` | `/api/expenses` | authentifié |
| `GET` | `/api/expenses/summary` | authentifié |
| `POST` | `/api/expenses` | COMPTABLE |
| `PATCH` | `/api/expenses/:id` | COMPTABLE |
| `DELETE` | `/api/expenses/:id` | COMPTABLE |
| `GET` | `/api/expenses/categories` | authentifié |
| `POST` | `/api/expenses/categories` | COMPTABLE |
| `PATCH` | `/api/expenses/categories/:id` | COMPTABLE |
| `DELETE` | `/api/expenses/categories/:id` | ADMIN |

Dépense :

```json
{
  "categoryId": "9e8d...",
  "amount": 15000,
  "description": "Carburant camion",
  "expenseDate": "2026-10-23",
  "attachmentUrl": null,
  "clientRef": "expense-001"
}
```

`201` : `{ "expense": { "...": "..." }, "created": true }`.

Catégorie : `{ "name": "Transport", "description": "Carburant et péages" }`. Une catégorie utilisée
ne peut pas être supprimée : elle est archivée (`isArchived`). La liste accepte `includeArchived=true`.

`/summary` accepte `from`, `to`, `period` et renvoie le total, le nombre et la répartition par catégorie.

---

## 10. Encaissements (recettes)

| Méthode | Route | Rôles |
| --- | --- | --- |
| `GET` | `/api/receipts` | authentifié |
| `GET` | `/api/receipts/summary` | authentifié |
| `POST` | `/api/receipts` | COMPTABLE |
| `DELETE` | `/api/receipts/:id` | ADMIN |

Les recettes de source `VENTE` sont créées automatiquement par les encaissements. Cette route sert
aux recettes manuelles (apport, recette diverse).

```json
{
  "label": "Apport de trésorerie",
  "amount": 50000,
  "receiptDate": "2026-10-23",
  "notes": "Fonds de caisse",
  "clientRef": "receipt-001"
}
```

`201` : `{ "receipt": { "...": "..." }, "created": true }`.

Sources : `VENTE`, `MANUEL`, `AUTRE`. Filtres : `source`, `search`, `from`, `to`, `period`, `page`, `limit`.

`/summary` renvoie `range`, `totalAmount`, `count` et `bySource` (`source`, `amount`, `count`).

---

## 11. Livraisons

| Méthode | Route | Rôles | Description |
| --- | --- | --- | --- |
| `GET` | `/api/deliveries` | authentifié | Liste (livreur : ses livraisons) |
| `GET` | `/api/deliveries/stats` | authentifié | Statistiques |
| `GET` | `/api/deliveries/livreurs` | authentifié | Livreurs actifs |
| `GET` | `/api/deliveries/:id` | authentifié | Détail |
| `GET` | `/api/deliveries/:id/slip.pdf` | authentifié | Bon de livraison PDF |
| `POST` | `/api/deliveries` | VENDEUR, COMPTABLE, LIVREUR | Création |
| `PATCH` | `/api/deliveries/:id/status` | VENDEUR, COMPTABLE, LIVREUR | Changement de statut |
| `PATCH` | `/api/deliveries/:id/assign` | VENDEUR, COMPTABLE | Affectation |
| `POST` | `/api/deliveries/:id/proof` | VENDEUR, COMPTABLE, LIVREUR | Preuve de livraison (multipart) |

### Création

Liée à une vente :

```json
{
  "saleId": "…",
  "livreurId": "…",
  "destination": "Boutique Chez Awa — Cocody",
  "scheduledAt": "2026-10-24T09:00:00.000Z",
  "notes": "Appeler avant d'arriver",
  "clientRef": "delivery-001"
}
```

Ou hors vente, avec un produit :

```json
{
  "clientId": "…",
  "productId": "…",
  "quantity": 12,
  "livreurId": "…",
  "destination": "Yopougon — marché",
  "clientRef": "delivery-002"
}
```

Il faut **soit** `saleId`, **soit** `productId` + `quantity`. Un livreur qui crée une livraison
devient automatiquement le livreur affecté.

`201` : `{ "delivery": { "...": "...", "reference": "LIV-20261024-…", "status": "EN_COURS" }, "created": true }`.

Statuts : `EN_COURS`, `LIVRE`, `ANNULE`.

### Statut

```json
{ "status": "LIVRE", "receiverName": "Awa Kone", "signatureBase64": "data:image/png;base64,...", "notes": null }
```

### Preuve de livraison

`multipart/form-data` :

| Champ | Type | Requis |
| --- | --- | --- |
| `photo` | fichier image | recommandé |
| `receiverName` | texte | recommandé |
| `signatureBase64` | texte (data URI) | l'un des deux |
| `notes` | texte | non |

Au moins une signature **ou** une photo est exigée. La livraison passe automatiquement à `LIVRE`,
`deliveredAt` est horodaté, `signatureUrl` et `photoProofUrl` sont renseignés.

### Affectation

```json
{ "livreurId": "…" }
```

Filtres de liste : `search`, `status`, `livreurId`, `clientId`, `saleId`, `mine=true`,
`from`, `to`, `period`, `page`, `limit`. Pour un livreur seul, `mine` est forcé.

`/stats` accepte `from`, `to`, `period` et renvoie `range`, `total`, `lateCount`, `byStatus`.

`/livreurs` renvoie `{ "data": [{ "id": "…", "fullName": "…", "phone": "…" }] }`.

---

## 12. Rapports et tableaux de bord

| Méthode | Route | Rôles | Description |
| --- | --- | --- | --- |
| `GET` | `/api/reports/dashboard` | ADMIN | KPI, séries, tops |
| `GET` | `/api/reports/sales` | ADMIN | Rapport des ventes |
| `GET` | `/api/reports/receivables` | ADMIN | Créances |
| `GET` | `/api/reports/inventory` | authentifié | État du stock |

Paramètres communs : `from`, `to`, `period`, `granularity`.

### Tableau de bord

```json
{
  "range": { "from": "2026-10-01T00:00:00.000Z", "to": "2026-10-31T23:59:59.999Z", "period": "month" },
  "granularity": "day",
  "kpis": {
    "revenue": 512000,
    "salesTotal": 640000,
    "cogs": 380000,
    "grossMargin": 260000,
    "expensesTotal": 75000,
    "lossesTotal": 12000,
    "purchasesTotal": 410000,
    "netProfit": 57000,
    "accountingProfit": 185000,
    "outstandingReceivables": 128000,
    "overdueReceivables": 24000,
    "salesCount": 48,
    "paymentsCount": 52,
    "expensesCount": 14,
    "averageBasket": 13333.33,
    "lowStockCount": 3,
    "pendingDeliveries": 5,
    "lossCount": 6,
    "purchaseCount": 4
  },
  "series": [{ "key": "2026-10-23", "sales": 12, "revenue": 85000, "expenses": 15000, "cogs": 51000, "profit": 19000 }],
  "topProducts": [{ "product": { "id": "…", "name": "…" }, "quantity": 120, "revenue": 48000 }],
  "expensesByCategory": [{ "category": { "id": "…", "name": "Transport" }, "amount": 15000 }],
  "lossesByReason": [{ "reason": "PERIME", "cost": 1500, "quantity": 6 }],
  "topClients": [],
  "topSuppliers": []
}
```

**Formules financières**

- `revenue` = encaissements réels (paiements de ventes + recettes manuelles).
- `netProfit` = `revenue − expensesTotal − cogs` (bénéfice net de trésorerie).
- `accountingProfit` = `salesTotal − cogs − expensesTotal` (bénéfice comptable).
- `grossMargin` = `salesTotal − cogs`.

### Créances

`/api/reports/receivables` renvoie le total des encours, la part échue et la liste des clients concernés.

### Stock

`/api/reports/inventory` renvoie la valorisation du stock, les produits sous le seuil et les mouvements
récents.

---

## 13. Exports Excel

`GET /api/exports/:entity.xlsx` — rôle `ADMIN`.

Entités disponibles : `sales`, `payments`, `purchases`, `clients`, `suppliers`, `losses`, `expenses`,
`products`.

Paramètres : `from`, `to`, `period` (selon l'entité), plus `search`, `status`, etc. lorsque l'entité
le permet. Le fichier est renvoyé en pièce jointe, nommé automatiquement.

Exemple :

```http
GET /api/exports/sales.xlsx?period=month
Authorization: Bearer <token>
```

---

## 14. Journal d'audit (ADMIN)

| Méthode | Route | Description |
| --- | --- | --- |
| `GET` | `/api/audit-logs` | Liste paginée |
| `GET` | `/api/audit-logs/:id` | Détail |
| `GET` | `/api/audit-logs/filters` | Utilisateurs et entités disponibles |

Filtres : `userId`, `action`, `entity`, `search`, `from`, `to`, `period`, `page`, `limit`.

Actions : `CREATE`, `UPDATE`, `DELETE`, `EXECUTE`, `LOGIN`, `LOGOUT`, `LOGIN_FAILED`.

Chaque entrée contient l'utilisateur (nom, e-mail), l'action, l'entité, l'identifiant concerné,
les états `before` / `after` (JSON assaini, données sensibles masquées), l'adresse IP, l'agent utilisateur
et l'horodatage. Le journal est **immuable** : une modification ou suppression est bloquée par un trigger
PostgreSQL.

---

## 15. Notifications

| Méthode | Route | Description |
| --- | --- | --- |
| `GET` | `/api/notifications` | Liste paginée + `unreadCount` |
| `PATCH` | `/api/notifications/:id/read` | Marquer comme lue |
| `POST` | `/api/notifications/read-all` | Tout marquer comme lu |
| `POST` | `/api/notifications/push-tokens` | Enregistrer un jeton Expo |
| `DELETE` | `/api/notifications/push-tokens` | Supprimer un jeton |

Filtres : `unread=true`, `page`, `limit`.

Jeton push : `{ "token": "ExponentPushToken[...]", "platform": "android" }`
(`android`, `ios` ou `web`). Les notifications sont envoyées via l'API Expo Push.

---

## 16. Paramètres de l'entreprise

| Méthode | Route | Rôles |
| --- | --- | --- |
| `GET` | `/api/settings` | authentifié |
| `PUT` | `/api/settings` | ADMIN |
| `POST` | `/api/settings/logo` | ADMIN |

```json
{
  "storeName": "Dépôt Boissons du Plateau",
  "address": "Abidjan — Plateau",
  "phone": "+225 27 00 00 00",
  "email": "contact@depot.app",
  "logoUrl": "/files/settings/logo-....png",
  "taxId": "CI-2026-001",
  "currency": "XOF",
  "invoiceFooter": "Merci de votre confiance",
  "lowStockAlerts": true
}
```

`POST /api/settings/logo` attend un fichier dans le champ `file` et renvoie les paramètres à jour.

---

## 17. Téléversements génériques

| Méthode | Route | Corps | Réponse |
| --- | --- | --- | --- |
| `POST` | `/api/uploads/image` | `multipart/form-data` avec `file` | `{ url, filename, size, mimeType }` |
| `POST` | `/api/uploads/signature` | `{ signatureBase64 }` | `{ url, filename, size, mimeType }` |

Les deux routes renvoient `201`. Les images sont contrôlées (type MIME et taille) et enregistrées
dans le dossier `receipts` des médias. Pour une photo produit, préférez
`POST /api/products/:id/image` qui associe directement l'image au produit.

---

## 18. Synchronisation hors ligne

### `POST /api/sync/push`

Rejoue jusqu'à **50** opérations dans l'ordre. Chaque opération porte un identifiant local unique,
utilisé comme `clientRef` par défaut.

```json
{
  "operations": [
    { "id": "op-1", "entity": "sale", "payload": { "clientId": "…", "items": [ { "productId": "…", "quantity": 3 } ], "payment": { "amount": 1200, "method": "CASH" } } },
    { "id": "op-2", "entity": "loss", "payload": { "productId": "…", "quantity": 1, "reason": "ENDOMMAGE" } }
  ]
}
```

Entités : `sale`, `payment`, `loss`, `expense`, `delivery`.

Droits requis (identiques aux routes directes, `ADMIN` toujours autorisé) :

| Entité | Rôles |
| --- | --- |
| `sale` | VENDEUR, COMPTABLE |
| `payment` | VENDEUR, COMPTABLE |
| `loss` | VENDEUR, COMPTABLE |
| `expense` | COMPTABLE |
| `delivery` | VENDEUR, COMPTABLE, LIVREUR |

Chaque opération est indépendante : un échec n'annule pas les suivantes.

```json
{
  "results": [
    { "id": "op-1", "entity": "sale", "ok": true, "resourceId": "…", "created": true },
    { "id": "op-2", "entity": "loss", "ok": false, "error": { "code": "NOT_FOUND", "message": "Produit introuvable" } }
  ],
  "succeeded": 1,
  "failed": 1,
  "serverTime": "2026-10-23T10:15:00.000Z"
}
```

Une opération rejouée renvoie `ok: true` et `created: false` sans effet de bord.

### `GET /api/sync/pull?since=2026-10-23T08:00:00.000Z`

Synchronisation descendante. Sans `since`, renvoie un instantané initial (100 dernières ventes,
livraisons en cours/livrées, etc.).

```json
{
  "serverTime": "2026-10-23T10:20:00.000Z",
  "since": "2026-10-23T08:00:00.000Z",
  "products": [],
  "categories": [],
  "clients": [],
  "sales": [],
  "deliveries": [],
  "settings": { "...": "..." }
}
```

Les produits et clients supprimés logiquement sont inclus afin que le client puisse les retirer de
son cache. Les ventes incluent client, vendeur, lignes, paiements et livraisons liées.

---

## 19. Fichiers statiques

`GET /files/<dossier>/<fichier>` sert les images produits, signatures, preuves de livraison et logos.
Ces URL sont publiques (pas de JWT) mais non listables. Elles sont mises en cache 7 jours.

---

## 20. Contrat côté mobile

Le client Expo centralise les appels dans `apps/mobile/src/lib/api.ts`. Il gère automatiquement :

- l'ajout du jeton `Authorization` ;
- le rafraîchissement transparent sur `401`, avec file d'attente pour éviter les rafraîchissements
  concurrents ;
- la conversion des erreurs en `ApiError { status, code, details }` ;
- le téléchargement authentifié des PDF/XLSX pour partage (e-mail, WhatsApp, etc.).

La file hors ligne (`apps/mobile/src/store/offline.ts`) envoie les opérations par lots de 50. Elle est
vidée automatiquement à la reconnexion, au retour de l'application au premier plan, à chaque changement
de file et toutes les 60 secondes tant que l'application est ouverte. Les échecs sont retentés jusqu'à
5 fois ; au-delà, l'opération reste dans la file et peut être relancée manuellement depuis la bannière ou
les réglages. Le mode hors-ligne et la sauvegarde automatique sont configurables dans les réglages.
