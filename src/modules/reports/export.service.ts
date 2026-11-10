import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { buildExcel, type ExcelSheet } from '../../lib/excel.js';
import { formatDate, parseRange, type Period } from '../../lib/dates.js';
import { toNumber } from '../../lib/money.js';

export const EXPORT_ENTITIES = [
  'sales',
  'payments',
  'purchases',
  'clients',
  'suppliers',
  'losses',
  'expenses',
  'products',
] as const;

export type ExportEntity = (typeof EXPORT_ENTITIES)[number];

export const EXPORT_LABELS: Record<ExportEntity, string> = {
  sales: 'Ventes',
  payments: 'Paiements',
  purchases: 'Achats',
  clients: 'Clients',
  suppliers: 'Fournisseurs',
  losses: 'Pertes',
  expenses: 'Depenses',
  products: 'Produits',
};

export interface ExportQuery {
  from?: string;
  to?: string;
  period?: Period;
}

async function salesSheet(from: Date, to: Date, sheetName: string): Promise<ExcelSheet> {
  const sales = await prisma.sale.findMany({
    where: { saleDate: { gte: from, lte: to } },
    include: {
      client: { select: { name: true, phone: true } },
      user: { select: { fullName: true } },
      items: { select: { quantity: true } },
    },
    orderBy: { saleDate: 'asc' },
  });

  return {
    name: sheetName,
    title: 'Journal des ventes',
    subtitle: `Periode du ${formatDate(from)} au ${formatDate(to)} - ${sales.length} vente(s)`,
    columns: [
      { header: 'Date', key: 'date', width: 12, type: 'date' },
      { header: 'Reference', key: 'reference', width: 20 },
      { header: 'Client', key: 'client', width: 26 },
      { header: 'Telephone', key: 'phone', width: 16 },
      { header: 'Type', key: 'type', width: 10 },
      { header: 'Statut', key: 'status', width: 14 },
      { header: 'Articles', key: 'items', width: 9, type: 'number' },
      { header: 'Total', key: 'total', width: 15, type: 'money' },
      { header: 'Paye', key: 'paid', width: 15, type: 'money' },
      { header: 'Solde', key: 'balance', width: 15, type: 'money' },
      { header: 'Marge', key: 'margin', width: 15, type: 'money' },
      { header: 'Vendeur', key: 'user', width: 22 },
    ],
    rows: sales.map((sale) => ({
      date: sale.saleDate,
      reference: sale.reference,
      client: sale.client?.name ?? 'Client de passage',
      phone: sale.client?.phone ?? '',
      type: sale.type,
      status: sale.status,
      items: sale.items.reduce((total, item) => total + item.quantity, 0),
      total: toNumber(sale.totalAmount),
      paid: toNumber(sale.paidAmount),
      balance: toNumber(sale.balanceDue),
      margin: toNumber(sale.totalAmount.minus(sale.cogs)),
      user: sale.user.fullName,
    })),
    totals: {
      total: sales.reduce((total, sale) => total + toNumber(sale.totalAmount), 0),
      paid: sales.reduce((total, sale) => total + toNumber(sale.paidAmount), 0),
      balance: sales.reduce((total, sale) => total + toNumber(sale.balanceDue), 0),
    },
  };
}

async function paymentsSheet(from: Date, to: Date): Promise<ExcelSheet> {
  const payments = await prisma.payment.findMany({
    where: { paidAt: { gte: from, lte: to } },
    include: {
      sale: { select: { reference: true, status: true, client: { select: { name: true } } } },
      receivedBy: { select: { fullName: true } },
    },
    orderBy: { paidAt: 'asc' },
  });

  return {
    name: 'Paiements',
    title: 'Journal des encaissements',
    subtitle: `Periode du ${formatDate(from)} au ${formatDate(to)}`,
    columns: [
      { header: 'Date', key: 'date', width: 12, type: 'datetime' },
      { header: 'Vente', key: 'sale', width: 20 },
      { header: 'Client', key: 'client', width: 26 },
      { header: 'Montant', key: 'amount', width: 15, type: 'money' },
      { header: 'Mode', key: 'method', width: 16 },
      { header: 'Reference', key: 'reference', width: 18 },
      { header: 'Encaissement par', key: 'user', width: 22 },
      { header: 'Vente annulee', key: 'cancelled', width: 14 },
    ],
    rows: payments.map((payment) => ({
      date: payment.paidAt,
      sale: payment.sale.reference,
      client: payment.sale.client?.name ?? 'Client de passage',
      amount: toNumber(payment.amount),
      method: payment.method,
      reference: payment.reference ?? '',
      user: payment.receivedBy.fullName,
      cancelled: payment.sale.status === 'ANNULEE' ? 'Oui' : 'Non',
    })),
    totals: { amount: payments.reduce((total, payment) => total + toNumber(payment.amount), 0) },
  };
}

async function purchasesSheet(from: Date, to: Date): Promise<ExcelSheet> {
  const purchases = await prisma.purchase.findMany({
    where: { purchaseDate: { gte: from, lte: to } },
    include: {
      supplier: { select: { name: true, phone: true } },
      user: { select: { fullName: true } },
      items: { select: { quantity: true } },
    },
    orderBy: { purchaseDate: 'asc' },
  });

  return {
    name: 'Achats',
    title: 'Journal des achats',
    subtitle: `Periode du ${formatDate(from)} au ${formatDate(to)}`,
    columns: [
      { header: 'Date', key: 'date', width: 12, type: 'date' },
      { header: 'Reference', key: 'reference', width: 20 },
      { header: 'Fournisseur', key: 'supplier', width: 28 },
      { header: 'Telephone', key: 'phone', width: 16 },
      { header: 'Articles', key: 'items', width: 10, type: 'number' },
      { header: 'Sous-total', key: 'subtotal', width: 15, type: 'money' },
      { header: 'Transport', key: 'transport', width: 14, type: 'money' },
      { header: 'Total', key: 'total', width: 15, type: 'money' },
      { header: 'Saisi par', key: 'user', width: 22 },
    ],
    rows: purchases.map((purchase) => ({
      date: purchase.purchaseDate,
      reference: purchase.reference,
      supplier: purchase.supplier.name,
      phone: purchase.supplier.phone ?? '',
      items: purchase.items.reduce((total, item) => total + item.quantity, 0),
      subtotal: toNumber(purchase.subtotal),
      transport: toNumber(purchase.transportFees),
      total: toNumber(purchase.totalAmount),
      user: purchase.user.fullName,
    })),
    totals: {
      subtotal: purchases.reduce((total, purchase) => total + toNumber(purchase.subtotal), 0),
      transport: purchases.reduce((total, purchase) => total + toNumber(purchase.transportFees), 0),
      total: purchases.reduce((total, purchase) => total + toNumber(purchase.totalAmount), 0),
    },
  };
}

async function clientsSheet(): Promise<ExcelSheet> {
  const clients = await prisma.client.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
  const totals = await prisma.sale.groupBy({
    by: ['clientId'],
    where: { status: { not: 'ANNULEE' } },
    _sum: { totalAmount: true, balanceDue: true },
    _count: { _all: true },
  });
  const byClient = new Map(totals.map((entry) => [entry.clientId, entry]));

  return {
    name: 'Clients',
    title: 'Repertoire clients et encours',
    subtitle: `${clients.length} client(s)`,
    columns: [
      { header: 'Nom', key: 'name', width: 30 },
      { header: 'Telephone', key: 'phone', width: 16 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Adresse', key: 'address', width: 32 },
      { header: 'Ventes', key: 'sales', width: 10, type: 'number' },
      { header: 'Total achats', key: 'total', width: 16, type: 'money' },
      { header: 'Encours', key: 'balance', width: 16, type: 'money' },
      { header: 'Plafond credit', key: 'limit', width: 16, type: 'money' },
    ],
    rows: clients.map((client) => {
      const aggregate = byClient.get(client.id);
      return {
        name: client.name,
        phone: client.phone ?? '',
        email: client.email ?? '',
        address: client.address ?? '',
        sales: aggregate?._count._all ?? 0,
        total: toNumber(aggregate?._sum.totalAmount ?? 0),
        balance: toNumber(aggregate?._sum.balanceDue ?? 0),
        limit: toNumber(client.creditLimit),
      };
    }),
  };
}

async function suppliersSheet(): Promise<ExcelSheet> {
  const suppliers = await prisma.supplier.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
  const totals = await prisma.purchase.groupBy({
    by: ['supplierId'],
    _sum: { totalAmount: true },
    _count: { _all: true },
  });
  const bySupplier = new Map(totals.map((entry) => [entry.supplierId, entry]));

  return {
    name: 'Fournisseurs',
    title: 'Repertoire fournisseurs',
    subtitle: `${suppliers.length} fournisseur(s)`,
    columns: [
      { header: 'Nom', key: 'name', width: 30 },
      { header: 'Contact', key: 'contact', width: 24 },
      { header: 'Telephone', key: 'phone', width: 16 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Achats', key: 'purchases', width: 10, type: 'number' },
      { header: 'Volume total', key: 'total', width: 18, type: 'money' },
    ],
    rows: suppliers.map((supplier) => {
      const aggregate = bySupplier.get(supplier.id);
      return {
        name: supplier.name,
        contact: supplier.contactName ?? '',
        phone: supplier.phone ?? '',
        email: supplier.email ?? '',
        purchases: aggregate?._count._all ?? 0,
        total: toNumber(aggregate?._sum.totalAmount ?? 0),
      };
    }),
  };
}

async function lossesSheet(from: Date, to: Date): Promise<ExcelSheet> {
  const losses = await prisma.loss.findMany({
    where: { lossDate: { gte: from, lte: to } },
    include: { product: { select: { name: true, sku: true } }, user: { select: { fullName: true } } },
    orderBy: { lossDate: 'asc' },
  });

  return {
    name: 'Pertes',
    title: 'Journal des pertes',
    subtitle: `Periode du ${formatDate(from)} au ${formatDate(to)}`,
    columns: [
      { header: 'Date', key: 'date', width: 12, type: 'date' },
      { header: 'Reference', key: 'reference', width: 20 },
      { header: 'Produit', key: 'product', width: 32 },
      { header: 'SKU', key: 'sku', width: 16 },
      { header: 'Quantite', key: 'quantity', width: 10, type: 'number' },
      { header: 'Motif', key: 'reason', width: 18 },
      { header: 'Cout unitaire', key: 'unitCost', width: 15, type: 'money' },
      { header: 'Cout total', key: 'totalCost', width: 15, type: 'money' },
      { header: 'Saisi par', key: 'user', width: 22 },
    ],
    rows: losses.map((loss) => ({
      date: loss.lossDate,
      reference: loss.reference,
      product: loss.product.name,
      sku: loss.product.sku,
      quantity: loss.quantity,
      reason: loss.reason,
      unitCost: toNumber(loss.unitCost),
      totalCost: toNumber(loss.totalCost),
      user: loss.user.fullName,
    })),
    totals: { totalCost: losses.reduce((total, loss) => total + toNumber(loss.totalCost), 0) },
  };
}

async function expensesSheet(from: Date, to: Date): Promise<ExcelSheet> {
  const expenses = await prisma.expense.findMany({
    where: { expenseDate: { gte: from, lte: to } },
    include: { category: { select: { name: true } }, user: { select: { fullName: true } } },
    orderBy: { expenseDate: 'asc' },
  });

  return {
    name: 'Depenses',
    title: 'Journal des depenses',
    subtitle: `Periode du ${formatDate(from)} au ${formatDate(to)}`,
    columns: [
      { header: 'Date', key: 'date', width: 12, type: 'date' },
      { header: 'Categorie', key: 'category', width: 22 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'Montant', key: 'amount', width: 16, type: 'money' },
      { header: 'Saisi par', key: 'user', width: 22 },
    ],
    rows: expenses.map((expense) => ({
      date: expense.expenseDate,
      category: expense.category.name,
      description: expense.description,
      amount: toNumber(expense.amount),
      user: expense.user.fullName,
    })),
    totals: { amount: expenses.reduce((total, expense) => total + toNumber(expense.amount), 0) },
  };
}

async function productsSheet(): Promise<ExcelSheet> {
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    include: { category: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });

  return {
    name: 'Produits',
    title: 'Inventaire des produits',
    subtitle: `${products.length} reference(s)`,
    columns: [
      { header: 'SKU', key: 'sku', width: 18 },
      { header: 'Nom', key: 'name', width: 34 },
      { header: 'Categorie', key: 'category', width: 20 },
      { header: 'Unite', key: 'unit', width: 12 },
      { header: 'Stock', key: 'stock', width: 10, type: 'number' },
      { header: 'Stock min', key: 'min', width: 10, type: 'number' },
      { header: 'Cout unitaire', key: 'cost', width: 15, type: 'money' },
      { header: 'Prix gros', key: 'gros', width: 15, type: 'money' },
      { header: 'Prix detail', key: 'detail', width: 15, type: 'money' },
      { header: 'Valeur stock', key: 'value', width: 16, type: 'money' },
    ],
    rows: products.map((product) => ({
      sku: product.sku,
      name: product.name,
      category: product.category?.name ?? 'Sans categorie',
      unit: product.unit,
      stock: product.stockQty,
      min: product.minStockQty,
      cost: toNumber(product.costPrice),
      gros: toNumber(product.salePriceGros),
      detail: toNumber(product.salePriceDetail),
      value: toNumber(product.costPrice.times(product.stockQty)),
    })),
  };
}

export async function buildExport(
  entity: ExportEntity,
  query: ExportQuery,
): Promise<{ buffer: Buffer; filename: string }> {
  const range = parseRange(query, 'month');
  let sheet: ExcelSheet;

  switch (entity) {
    case 'sales':
      sheet = await salesSheet(range.from, range.to, 'Ventes');
      break;
    case 'payments':
      sheet = await paymentsSheet(range.from, range.to);
      break;
    case 'purchases':
      sheet = await purchasesSheet(range.from, range.to);
      break;
    case 'clients':
      sheet = await clientsSheet();
      break;
    case 'suppliers':
      sheet = await suppliersSheet();
      break;
    case 'losses':
      sheet = await lossesSheet(range.from, range.to);
      break;
    case 'expenses':
      sheet = await expensesSheet(range.from, range.to);
      break;
    case 'products':
      sheet = await productsSheet();
      break;
    default:
      throw new Error(`Export inconnu : ${String(entity)}`);
  }

  return {
    buffer: await buildExcel([sheet]),
    filename: `${entity}-${range.from.toISOString().slice(0, 10)}-${range.to.toISOString().slice(0, 10)}.xlsx`,
  };
}
