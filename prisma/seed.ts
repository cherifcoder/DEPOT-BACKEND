import { deflateSync } from 'node:zlib';
import type { Role } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/password.js';
import { dayjs } from '../src/lib/dates.js';
import { createPurchase } from '../src/modules/purchases/purchase.service.js';
import { createSale } from '../src/modules/sales/sale.service.js';
import { createLoss } from '../src/modules/losses/loss.service.js';
import { createExpense } from '../src/modules/expenses/expense.service.js';
import { createManualReceipt } from '../src/modules/receipts/receipt.service.js';
import { createDelivery, updateDeliveryStatus } from '../src/modules/deliveries/delivery.service.js';

/**
 * Jeu de donnees de demonstration.
 * Rejouable : les referentiels sont mis a jour (upsert) et les donnees metier
 * ne sont creees que si elles n'existent pas deja (cle `clientRef` / `seed-*`).
 */

const DEMO_PASSWORD_SUFFIX = '@2026!';

const DEMO_USERS: { fullName: string; email: string; phone: string; roles: Role[]; password: string }[] = [
  { fullName: 'Administrateur Depot', email: 'admin@depot.app', phone: '+225 07 00 00 00 01', roles: ['ADMIN'], password: `Admin${DEMO_PASSWORD_SUFFIX}` },
  { fullName: 'Awa Kone', email: 'vendeur@depot.app', phone: '+225 07 00 00 00 02', roles: ['VENDEUR'], password: `Vendeur${DEMO_PASSWORD_SUFFIX}` },
  { fullName: 'Jean Kouassi', email: 'comptable@depot.app', phone: '+225 07 00 00 00 03', roles: ['COMPTABLE'], password: `Comptable${DEMO_PASSWORD_SUFFIX}` },
  { fullName: 'Moussa Traore', email: 'livreur@depot.app', phone: '+225 07 00 00 00 04', roles: ['LIVREUR'], password: `Livreur${DEMO_PASSWORD_SUFFIX}` },
];

const DEMO_CATEGORIES: { name: string; description: string }[] = [
  { name: 'Sodas', description: 'Boissons gazeuses et limonades' },
  { name: 'Eaux minerales', description: 'Eaux plates et gazeuses' },
  { name: 'Jus et energies', description: 'Jus de fruits, boissons energetiques' },
];

interface DemoProduct {
  sku: string;
  name: string;
  category: string;
  unit: 'BOUTEILLE' | 'CASIER' | 'PACK' | 'CARTON' | 'FUT';
  volumeCl?: number;
  unitsPerPack: number;
  costPrice: number;
  salePriceGros: number;
  salePriceDetail: number;
  minStockQty: number;
}

const DEMO_PRODUCTS: DemoProduct[] = [
  { sku: 'SOD-COCA-1L5', name: 'Coca-Cola 1,5L', category: 'Sodas', unit: 'BOUTEILLE', volumeCl: 150, unitsPerPack: 6, costPrice: 750, salePriceGros: 900, salePriceDetail: 1100, minStockQty: 24 },
  { sku: 'SOD-FANTA-1L5', name: 'Fanta Orange 1,5L', category: 'Sodas', unit: 'BOUTEILLE', volumeCl: 150, unitsPerPack: 6, costPrice: 750, salePriceGros: 900, salePriceDetail: 1100, minStockQty: 24 },
  { sku: 'SOD-SPRITE-1L5', name: 'Sprite 1,5L', category: 'Sodas', unit: 'BOUTEILLE', volumeCl: 150, unitsPerPack: 6, costPrice: 750, salePriceGros: 900, salePriceDetail: 1100, minStockQty: 18 },
  { sku: 'EAU-AWALE-1L5', name: 'Awa 1,5L', category: 'Eaux minerales', unit: 'BOUTEILLE', volumeCl: 150, unitsPerPack: 6, costPrice: 250, salePriceGros: 350, salePriceDetail: 500, minStockQty: 60 },
  { sku: 'EAU-PACK-50', name: 'Pack eau 50cl x12', category: 'Eaux minerales', unit: 'PACK', volumeCl: 50, unitsPerPack: 12, costPrice: 1200, salePriceGros: 1500, salePriceDetail: 1800, minStockQty: 20 },
  { sku: 'JUS-ORANGE-1L', name: 'Jus orange 1L', category: 'Jus et energies', unit: 'BOUTEILLE', volumeCl: 100, unitsPerPack: 12, costPrice: 900, salePriceGros: 1100, salePriceDetail: 1400, minStockQty: 24 },
  { sku: 'ENE-REDBULL-25', name: 'Red Bull 25cl', category: 'Jus et energies', unit: 'BOUTEILLE', volumeCl: 25, unitsPerPack: 24, costPrice: 700, salePriceGros: 900, salePriceDetail: 1200, minStockQty: 48 },
];

const DEMO_SUPPLIERS = [
  { name: 'SOCOB Distributions', contactName: 'Ibrahim Diallo', phone: '+225 27 20 00 00 10', email: 'contact@socob.example', address: 'Zone industrielle de Yopougon, Abidjan' },
  { name: 'Brassivoire Grossiste', contactName: 'Marie Yao', phone: '+225 27 20 00 00 20', email: 'ventes@brassivoire.example', address: 'Boulevard de Marseille, Abidjan' },
];

const DEMO_CLIENTS = [
  { name: 'Restaurant Chez Awa', phone: '+225 05 00 00 00 11', email: 'chezawa@example.com', address: 'Cocody Angre, Abidjan', creditLimit: 250000 },
  { name: 'Societe SOCIBA', phone: '+225 05 00 00 00 12', email: 'achats@sociba.example', address: 'Plateau, Abidjan', creditLimit: 500000 },
  { name: 'Boutique Le Palmier', phone: '+225 05 00 00 00 13', email: null, address: 'Adjamé, Abidjan', creditLimit: 100000 },
  { name: 'Client de passage', phone: null, email: null, address: null, creditLimit: 0 },
];

const DEMO_EXPENSE_CATEGORIES = [
  { name: 'Loyer', description: 'Loyer du depot et charges locatives' },
  { name: 'Salaires', description: 'Salaires et primes du personnel' },
  { name: 'Carburant', description: 'Carburant des vehicules de livraison' },
  { name: 'Electricite', description: 'Electricite et eau' },
  { name: 'Divers', description: 'Depenses diverses non classees' },
];

// --------------------------------------------------------------- utilitaires

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Genere une image PNG de demonstration (fausse signature). */
function demoSignatureDataUrl(): string {
  const width = 96;
  const height = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;

  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      const wave = Math.abs(Math.sin((x / width) * Math.PI * 3) * 10);
      const ink = Math.abs(y - height / 2 - wave) < 2;
      row[offset] = ink ? 20 : 255;
      row[offset + 1] = ink ? 40 : 255;
      row[offset + 2] = ink ? 90 : 255;
    }
    rows.push(row);
  }

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  return `data:image/png;base64,${png.toString('base64')}`;
}

function daysAgo(days: number): string {
  return dayjs.utc().subtract(days, 'day').format('YYYY-MM-DD');
}

// ---------------------------------------------------------------------- seed

async function seedUsers() {
  const users = new Map<string, string>();

  for (const demo of DEMO_USERS) {
    const passwordHash = await hashPassword(demo.password);
    const user = await prisma.user.upsert({
      where: { email: demo.email },
      update: {
        fullName: demo.fullName,
        phone: demo.phone,
        passwordHash,
        isActive: true,
        mustChangePassword: false,
        deletedAt: null,
      },
      create: {
        fullName: demo.fullName,
        email: demo.email,
        phone: demo.phone,
        passwordHash,
        isActive: true,
        mustChangePassword: false,
      },
    });

    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.createMany({
      data: demo.roles.map((role) => ({ userId: user.id, role })),
    });

    users.set(demo.email, user.id);
  }

  return users;
}

async function seedCatalog() {
  const categories = new Map<string, string>();
  for (const category of DEMO_CATEGORIES) {
    const row = await prisma.productCategory.upsert({
      where: { name: category.name },
      update: { description: category.description },
      create: category,
    });
    categories.set(category.name, row.id);
  }

  const products = new Map<string, string>();
  for (const product of DEMO_PRODUCTS) {
    const row = await prisma.product.upsert({
      where: { sku: product.sku },
      update: {
        name: product.name,
        categoryId: categories.get(product.category) ?? null,
        unit: product.unit,
        volumeCl: product.volumeCl ?? null,
        unitsPerPack: product.unitsPerPack,
        costPrice: product.costPrice,
        salePriceGros: product.salePriceGros,
        salePriceDetail: product.salePriceDetail,
        minStockQty: product.minStockQty,
        isActive: true,
        deletedAt: null,
      },
      create: {
        sku: product.sku,
        name: product.name,
        categoryId: categories.get(product.category) ?? null,
        unit: product.unit,
        volumeCl: product.volumeCl ?? null,
        unitsPerPack: product.unitsPerPack,
        costPrice: product.costPrice,
        salePriceGros: product.salePriceGros,
        salePriceDetail: product.salePriceDetail,
        minStockQty: product.minStockQty,
      },
    });
    products.set(product.sku, row.id);
  }

  return products;
}

/** Retire la categorie biere et archive ses produits (operation rejouable). */
async function removeBeerCatalog() {
  const categories = await prisma.productCategory.findMany();
  const beerCategoryIds = categories
    .filter((category) => {
      const normalized = category.name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
      return normalized === 'biere' || normalized === 'bieres';
    })
    .map((category) => category.id);

  const beerProducts = await prisma.product.findMany({
    where: {
      OR: [
        ...(beerCategoryIds.length > 0 ? [{ categoryId: { in: beerCategoryIds } }] : []),
        { sku: { startsWith: 'BIE-' } },
      ],
    },
    select: { id: true },
  });

  if (beerProducts.length > 0) {
    await prisma.product.updateMany({
      where: { id: { in: beerProducts.map((product) => product.id) } },
      data: { isActive: false, deletedAt: new Date(), categoryId: null },
    });
  }

  if (beerCategoryIds.length > 0) {
    await prisma.productCategory.deleteMany({ where: { id: { in: beerCategoryIds } } });
  }

  if (beerProducts.length > 0 || beerCategoryIds.length > 0) {
    console.log(
      `Categorie biere retiree : ${beerProducts.length} produit(s) archive(s), ${beerCategoryIds.length} categorie(s) supprimee(s).`,
    );
  }
}

async function seedPartners() {
  const suppliers = new Map<string, string>();
  for (const supplier of DEMO_SUPPLIERS) {
    const existing = await prisma.supplier.findFirst({ where: { name: supplier.name, deletedAt: null } });
    const row = existing
      ? await prisma.supplier.update({ where: { id: existing.id }, data: { ...supplier, isActive: true } })
      : await prisma.supplier.create({ data: supplier });
    suppliers.set(supplier.name, row.id);
  }

  const clients = new Map<string, string>();
  for (const client of DEMO_CLIENTS) {
    const existing = await prisma.client.findFirst({ where: { name: client.name, deletedAt: null } });
    const row = existing
      ? await prisma.client.update({ where: { id: existing.id }, data: { ...client, isActive: true } })
      : await prisma.client.create({ data: client });
    clients.set(client.name, row.id);
  }

  const expenseCategories = new Map<string, string>();
  for (const category of DEMO_EXPENSE_CATEGORIES) {
    const row = await prisma.expenseCategory.upsert({
      where: { name: category.name },
      update: { description: category.description },
      create: category,
    });
    expenseCategories.set(category.name, row.id);
  }

  return { suppliers, clients, expenseCategories };
}

async function seedOperations(
  users: Map<string, string>,
  products: Map<string, string>,
  partners: { suppliers: Map<string, string>; clients: Map<string, string>; expenseCategories: Map<string, string> },
) {
  const existingDemoSales = await prisma.sale.count({ where: { clientRef: { startsWith: 'seed-sale-' } } });
  if (existingDemoSales > 0) {
    console.log('Donnees metier de demonstration deja presentes : etape ignoree.');
    return;
  }

  const adminId = users.get('admin@depot.app');
  const vendeurId = users.get('vendeur@depot.app');
  const comptableId = users.get('comptable@depot.app');
  const livreurId = users.get('livreur@depot.app');

  if (!adminId || !vendeurId || !comptableId || !livreurId) {
    throw new Error('Utilisateurs de demonstration manquants');
  }

  const supplierSocob = partners.suppliers.get('SOCOB Distributions');
  const supplierBrassivoire = partners.suppliers.get('Brassivoire Grossiste');
  const categoryLoyer = partners.expenseCategories.get('Loyer');
  const categorySalaires = partners.expenseCategories.get('Salaires');
  const categoryCarburant = partners.expenseCategories.get('Carburant');
  const categoryElectricite = partners.expenseCategories.get('Electricite');

  if (!supplierSocob || !supplierBrassivoire || !categoryLoyer || !categorySalaires || !categoryCarburant || !categoryElectricite) {
    throw new Error('Referentiels de demonstration manquants');
  }

  const productId = (sku: string): string => {
    const id = products.get(sku);
    if (!id) throw new Error(`Produit de demonstration introuvable : ${sku}`);
    return id;
  };

  // --- Achats (entree de stock + cout moyen pondere)
  await createPurchase(
    {
      supplierId: supplierBrassivoire,
      purchaseDate: daysAgo(45),
      transportFees: 15000,
      notes: 'Approvisionnement initial boissons',
      clientRef: 'seed-purchase-1',
      items: [
        { productId: productId('SOD-COCA-1L5'), quantity: 60, unitCost: 740 },
        { productId: productId('SOD-FANTA-1L5'), quantity: 60, unitCost: 740 },
        { productId: productId('SOD-SPRITE-1L5'), quantity: 60, unitCost: 740 },
      ],
    },
    comptableId,
  );

  await createPurchase(
    {
      supplierId: supplierSocob,
      purchaseDate: daysAgo(30),
      transportFees: 8000,
      notes: 'Sodas, eaux et jus',
      clientRef: 'seed-purchase-2',
      items: [
        { productId: productId('SOD-COCA-1L5'), quantity: 180, unitCost: 720 },
        { productId: productId('SOD-FANTA-1L5'), quantity: 180, unitCost: 720 },
        { productId: productId('SOD-SPRITE-1L5'), quantity: 120, unitCost: 720 },
        { productId: productId('EAU-AWALE-1L5'), quantity: 720, unitCost: 240 },
        { productId: productId('EAU-PACK-50'), quantity: 120, unitCost: 1150 },
        { productId: productId('JUS-ORANGE-1L'), quantity: 144, unitCost: 870 },
        { productId: productId('ENE-REDBULL-25'), quantity: 240, unitCost: 680 },
      ],
    },
    comptableId,
  );

  // --- Ventes
  const clientAwa = partners.clients.get('Restaurant Chez Awa');
  const clientSociba = partners.clients.get('Societe SOCIBA');
  const clientPalmier = partners.clients.get('Boutique Le Palmier');

  if (!clientAwa || !clientSociba || !clientPalmier) throw new Error('Clients de demonstration manquants');

  const signature = demoSignatureDataUrl();

  const sale1 = await createSale(
    {
      clientId: clientSociba,
      type: 'GROS',
      saleDate: daysAgo(12),
      items: [
        { productId: productId('EAU-PACK-50'), quantity: 10, unitPrice: 1500 },
        { productId: productId('SOD-COCA-1L5'), quantity: 36, unitPrice: 900 },
      ],
      discount: 0,
      payment: { amount: 47400, method: 'CASH', reference: null, notes: 'Reglement comptant' },
      dueDate: null,
      notes: 'Livraison au depot SOCIBA',
      clientRef: 'seed-sale-1',
      signatureBase64: signature,
    },
    vendeurId,
  );

  const sale2 = await createSale(
    {
      clientId: clientAwa,
      type: 'DETAIL',
      saleDate: daysAgo(20),
      items: [
        { productId: productId('SOD-FANTA-1L5'), quantity: 24, unitPrice: 1100 },
        { productId: productId('EAU-AWALE-1L5'), quantity: 60, unitPrice: 500 },
      ],
      discount: 2000,
      payment: { amount: 40000, method: 'MOBILE_MONEY', reference: 'MM-2026-0042', notes: null },
      dueDate: daysAgo(2),
      notes: 'Solde a regler par mobile money',
      clientRef: 'seed-sale-2',
      signatureBase64: null,
    },
    vendeurId,
  );

  const sale3 = await createSale(
    {
      clientId: clientPalmier,
      type: 'DETAIL',
      saleDate: daysAgo(6),
      items: [
        { productId: productId('SOD-FANTA-1L5'), quantity: 24, unitPrice: 1100 },
        { productId: productId('JUS-ORANGE-1L'), quantity: 12, unitPrice: 1400 },
        { productId: productId('ENE-REDBULL-25'), quantity: 24, unitPrice: 1200 },
      ],
      discount: 0,
      payment: { amount: 72000, method: 'CASH', reference: null, notes: null },
      dueDate: null,
      notes: null,
      clientRef: 'seed-sale-3',
      signatureBase64: signature,
    },
    vendeurId,
  );

  await createSale(
    {
      clientId: clientSociba,
      type: 'GROS',
      saleDate: daysAgo(45),
      items: [
        { productId: productId('SOD-SPRITE-1L5'), quantity: 24, unitPrice: 1100 },
        { productId: productId('EAU-PACK-50'), quantity: 40, unitPrice: 1500 },
      ],
      discount: 0,
      payment: { amount: 50000, method: 'VIREMENT', reference: 'VIR-8842', notes: 'Acompte' },
      dueDate: daysAgo(5),
      notes: 'Facture echue : relance necessaire',
      clientRef: 'seed-sale-4',
      signatureBase64: null,
    },
    vendeurId,
  );

  await createSale(
    {
      clientId: null,
      type: 'DETAIL',
      saleDate: daysAgo(1),
      items: [
        { productId: productId('SOD-SPRITE-1L5'), quantity: 6, unitPrice: 1100 },
        { productId: productId('EAU-AWALE-1L5'), quantity: 12, unitPrice: 500 },
      ],
      discount: 0,
      payment: { amount: 12600, method: 'CASH', reference: null, notes: 'Client de passage' },
      dueDate: null,
      notes: null,
      clientRef: 'seed-sale-5',
      signatureBase64: null,
    },
    vendeurId,
  );

  // --- Livraisons
  const delivery1 = await createDelivery(
    {
      saleId: sale2.sale.id,
      clientId: clientAwa,
      productId: null,
      quantity: null,
      livreurId,
      destination: 'Cocody Angre, Restaurant Chez Awa',
      scheduledAt: daysAgo(1),
      notes: 'Appeler le gerant avant d arriver',
      clientRef: 'seed-delivery-1',
    },
    vendeurId,
  );

  const delivery2 = await createDelivery(
    {
      saleId: sale3.sale.id,
      clientId: clientPalmier,
      productId: null,
      quantity: null,
      livreurId,
      destination: 'Adjame, Boutique Le Palmier',
      scheduledAt: daysAgo(6),
      notes: null,
      clientRef: 'seed-delivery-2',
    },
    vendeurId,
  );

  await updateDeliveryStatus(delivery2.delivery.id, {
    status: 'LIVRE',
    receiverName: 'Koffi N Guessan',
    signatureBase64: signature,
    notes: 'Livraison conforme, decharge signee',
  });

  // --- Pertes
  await createLoss(
    {
      productId: productId('SOD-FANTA-1L5'),
      quantity: 6,
      reason: 'PERIME',
      lossDate: daysAgo(8),
      notes: 'Lot proche de la date de peremption',
      clientRef: 'seed-loss-1',
    },
    adminId,
  );

  await createLoss(
    {
      productId: productId('EAU-AWALE-1L5'),
      quantity: 3,
      reason: 'ENDOMMAGE',
      lossDate: daysAgo(4),
      notes: 'Bouteilles cassees pendant le transport',
      clientRef: 'seed-loss-2',
    },
    adminId,
  );

  // --- Depenses et recettes manuelles
  await createExpense(
    {
      categoryId: categoryLoyer,
      amount: 150000,
      description: 'Loyer du mois du depot',
      expenseDate: daysAgo(15),
      attachmentUrl: null,
      clientRef: 'seed-expense-1',
    },
    comptableId,
  );

  await createExpense(
    {
      categoryId: categorySalaires,
      amount: 220000,
      description: 'Salaires du personnel (mois en cours)',
      expenseDate: daysAgo(10),
      attachmentUrl: null,
      clientRef: 'seed-expense-2',
    },
    comptableId,
  );

  await createExpense(
    {
      categoryId: categoryCarburant,
      amount: 25000,
      description: 'Carburant camion de livraison',
      expenseDate: daysAgo(7),
      attachmentUrl: null,
      clientRef: 'seed-expense-3',
    },
    comptableId,
  );

  await createExpense(
    {
      categoryId: categoryElectricite,
      amount: 18000,
      description: 'Facture electricite',
      expenseDate: daysAgo(3),
      attachmentUrl: null,
      clientRef: 'seed-expense-4',
    },
    comptableId,
  );

  await createManualReceipt(
    {
      label: 'Encaissement divers (retour emballages)',
      amount: 15000,
      receiptDate: daysAgo(2),
      notes: 'Retour de casiers consignes',
      clientRef: 'seed-receipt-1',
    },
    comptableId,
  );

  console.log(
    `Donnees metier creees : 2 achats, 5 ventes, 2 livraisons, 2 pertes, 4 depenses, 1 recette manuelle (livraison ${delivery1.delivery.reference} en cours).`,
  );
  console.log(`Ventes de demonstration : ${sale1.sale.reference} (${sale1.sale.status}), ${sale3.sale.reference} (${sale3.sale.status}).`);
}

async function main() {
  console.log('Seed du depot de boissons...');

  await prisma.systemSetting.upsert({
    where: { id: 'default' },
    update: {
      storeName: 'Depot de Boissons Abidjan',
      address: 'Zone industrielle, Rue des Brasseurs, Abidjan',
      phone: '+225 27 21 00 00 00',
      email: 'contact@depot-boissons.example',
      taxId: 'CI-DEPOT-2026',
      currency: 'XOF',
      invoiceFooter: 'Merci de votre confiance. Les marchandises vendues ne sont ni reprises ni echangees apres 48h.',
      lowStockAlerts: true,
    },
    create: {
      id: 'default',
      storeName: 'Depot de Boissons Abidjan',
      address: 'Zone industrielle, Rue des Brasseurs, Abidjan',
      phone: '+225 27 21 00 00 00',
      email: 'contact@depot-boissons.example',
      taxId: 'CI-DEPOT-2026',
      currency: 'XOF',
      invoiceFooter: 'Merci de votre confiance. Les marchandises vendues ne sont ni reprises ni echangees apres 48h.',
      lowStockAlerts: true,
    },
  });

  const users = await seedUsers();
  const products = await seedCatalog();
  await removeBeerCatalog();
  const partners = await seedPartners();

  await seedOperations(users, products, partners);

  console.log('Seed termine.');
  console.log('Connexion administrateur : admin@depot.app / Admin@2026!');
  console.log('Vendeur : vendeur@depot.app / Vendeur@2026!');
  console.log('Comptable : comptable@depot.app / Comptable@2026!');
  console.log('Livreur : livreur@depot.app / Livreur@2026!');
}

main()
  .catch((error) => {
    console.error('Echec du seed :', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
