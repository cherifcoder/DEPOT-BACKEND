import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { dayjs, parseRange } from '../../lib/dates.js';
import { toNumber } from '../../lib/money.js';
import { topClients } from '../clients/client.service.js';
import { topSuppliers } from '../suppliers/supplier.service.js';

export const reportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  period: z.enum(['day', 'week', 'month', 'year', 'custom', 'all']).optional(),
  granularity: z.enum(['day', 'week', 'month', 'year']).optional(),
});

type Granularity = 'day' | 'week' | 'month' | 'year';

function chooseGranularity(from: Date, to: Date): Granularity {
  const days = dayjs.utc(to).diff(dayjs.utc(from), 'day');
  if (days <= 45) return 'day';
  if (days <= 180) return 'week';
  if (days <= 730) return 'month';
  return 'year';
}

function keyFor(date: Date | string, granularity: Granularity): string {
  const value = dayjs.utc(date);
  if (granularity === 'year') return value.format('YYYY');
  if (granularity === 'month') return value.format('YYYY-MM');
  if (granularity === 'week') return value.startOf('week').format('YYYY-MM-DD');
  return value.format('YYYY-MM-DD');
}

function bucketKeys(from: Date, to: Date, granularity: Granularity): string[] {
  const keys: string[] = [];
  let cursor = dayjs.utc(from);

  if (granularity === 'week') cursor = cursor.startOf('week');
  if (granularity === 'month') cursor = cursor.startOf('month');
  if (granularity === 'year') cursor = cursor.startOf('year');

  let guard = 0;
  while (cursor.isBefore(dayjs.utc(to).endOf('day')) && guard < 400) {
    keys.push(keyFor(cursor.toDate(), granularity));
    cursor = cursor.add(1, granularity);
    guard += 1;
  }

  if (keys.length === 0) keys.push(keyFor(to, granularity));
  return [...new Set(keys)];
}

export async function dashboard(query: z.infer<typeof reportQuerySchema>) {
  const range = parseRange(query, 'month');
  const granularity = query.granularity ?? chooseGranularity(range.from, range.to);
  const whereSale: Prisma.SaleWhereInput = {
    saleDate: { gte: range.from, lte: range.to },
    status: { not: 'ANNULEE' },
  };
  const whereExpense: Prisma.ExpenseWhereInput = { expenseDate: { gte: range.from, lte: range.to } };
  const wherePayment: Prisma.PaymentWhereInput = {
    paidAt: { gte: range.from, lte: range.to },
    sale: { status: { not: 'ANNULEE' } },
  };
  const whereManualReceipt: Prisma.ReceiptWhereInput = {
    receiptDate: { gte: range.from, lte: range.to },
    source: { not: 'VENTE' },
  };

  const [
    sales,
    payments,
    manualReceipts,
    expenses,
    purchases,
    losses,
    salesAgg,
    paymentsAgg,
    receiptsAgg,
    expensesAgg,
    lossesAgg,
    purchasesAgg,
    outstanding,
    overdue,
    lowStockCount,
    pendingDeliveries,
    recentSales,
    lowStockProducts,
    topProductsGrouped,
    expensesByCategoryGrouped,
    lossesByReasonGrouped,
    clientsTop,
    suppliersTop,
  ] = await Promise.all([
    prisma.sale.findMany({ where: whereSale, select: { saleDate: true, totalAmount: true, cogs: true, balanceDue: true } }),
    prisma.payment.findMany({ where: wherePayment, select: { paidAt: true, amount: true } }),
    prisma.receipt.findMany({ where: whereManualReceipt, select: { receiptDate: true, amount: true } }),
    prisma.expense.findMany({ where: whereExpense, select: { expenseDate: true, amount: true } }),
    prisma.purchase.findMany({
      where: { purchaseDate: { gte: range.from, lte: range.to } },
      select: { purchaseDate: true, totalAmount: true },
    }),
    prisma.loss.findMany({ where: { lossDate: { gte: range.from, lte: range.to } }, select: { totalCost: true } }),
    prisma.sale.aggregate({ where: whereSale, _sum: { totalAmount: true, cogs: true, balanceDue: true }, _count: { _all: true } }),
    prisma.payment.aggregate({ where: wherePayment, _sum: { amount: true }, _count: { _all: true } }),
    prisma.receipt.aggregate({ where: whereManualReceipt, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: whereExpense, _sum: { amount: true }, _count: { _all: true } }),
    prisma.loss.aggregate({ where: { lossDate: { gte: range.from, lte: range.to } }, _sum: { totalCost: true } }),
    prisma.purchase.aggregate({ where: { purchaseDate: { gte: range.from, lte: range.to } }, _sum: { totalAmount: true } }),
    prisma.sale.aggregate({
      where: { status: { not: 'ANNULEE' }, balanceDue: { gt: 0 } },
      _sum: { balanceDue: true },
    }),
    prisma.sale.aggregate({
      where: { status: { not: 'ANNULEE' }, balanceDue: { gt: 0 }, dueDate: { lt: new Date() } },
      _sum: { balanceDue: true },
    }),
    prisma.product.count({ where: { deletedAt: null, isActive: true, stockQty: { lte: prisma.product.fields.minStockQty } } }),
    prisma.delivery.count({ where: { status: 'EN_COURS' } }),
    prisma.sale.findMany({
      where: { status: { not: 'ANNULEE' } },
      orderBy: { saleDate: 'desc' },
      take: 5,
      include: {
        client: { select: { id: true, name: true } },
        user: { select: { id: true, fullName: true } },
      },
    }),
    prisma.product.findMany({
      where: { deletedAt: null, isActive: true, stockQty: { lte: prisma.product.fields.minStockQty } },
      orderBy: { stockQty: 'asc' },
      take: 8,
      select: { id: true, name: true, sku: true, stockQty: true, minStockQty: true, imageUrl: true, unit: true },
    }),
    prisma.saleItem.groupBy({
      by: ['productId'],
      where: { sale: whereSale },
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
      take: 6,
    }),
    prisma.expense.groupBy({
      by: ['categoryId'],
      where: whereExpense,
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 8,
    }),
    prisma.loss.groupBy({
      by: ['reason'],
      where: { lossDate: { gte: range.from, lte: range.to } },
      _sum: { totalCost: true, quantity: true },
    }),
    topClients(range.from, range.to, 5),
    topSuppliers(range.from, range.to, 5),
  ]);

  const keys = bucketKeys(range.from, range.to, granularity);
  const empty = () => ({ sales: 0, revenue: 0, cogs: 0, expenses: 0, profit: 0 });
  const buckets = new Map(keys.map((key) => [key, empty()]));

  const getBucket = (date: Date | string) => {
    const key = keyFor(date, granularity);
    if (!buckets.has(key)) buckets.set(key, empty());
    return buckets.get(key)!;
  };

  sales.forEach((sale) => {
    const bucket = getBucket(sale.saleDate);
    bucket.sales += toNumber(sale.totalAmount);
    bucket.cogs += toNumber(sale.cogs);
  });

  payments.forEach((payment) => {
    getBucket(payment.paidAt).revenue += toNumber(payment.amount);
  });

  manualReceipts.forEach((receipt) => {
    getBucket(receipt.receiptDate).revenue += toNumber(receipt.amount);
  });

  expenses.forEach((expense) => {
    getBucket(expense.expenseDate).expenses += toNumber(expense.amount);
  });

  const series = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => ({
      date: key,
      sales: Math.round(bucket.sales * 100) / 100,
      revenue: Math.round(bucket.revenue * 100) / 100,
      cogs: Math.round(bucket.cogs * 100) / 100,
      expenses: Math.round(bucket.expenses * 100) / 100,
      profit: Math.round((bucket.revenue - bucket.expenses - bucket.cogs) * 100) / 100,
    }));

  const revenue = toNumber(paymentsAgg._sum.amount ?? 0) + toNumber(receiptsAgg._sum.amount ?? 0);
  const salesTotal = toNumber(salesAgg._sum.totalAmount ?? 0);
  const cogs = toNumber(salesAgg._sum.cogs ?? 0);
  const expensesTotal = toNumber(expensesAgg._sum.amount ?? 0);
  const salesCount = salesAgg._count._all;

  const productIds = topProductsGrouped.map((entry) => entry.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, sku: true, imageUrl: true, unit: true },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const categories = await prisma.expenseCategory.findMany({
    where: { id: { in: expensesByCategoryGrouped.map((entry) => entry.categoryId) } },
    select: { id: true, name: true },
  });
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  return {
    range,
    granularity,
    kpis: {
      revenue: Math.round(revenue * 100) / 100,
      salesTotal: Math.round(salesTotal * 100) / 100,
      cogs: Math.round(cogs * 100) / 100,
      grossMargin: Math.round((salesTotal - cogs) * 100) / 100,
      expensesTotal: Math.round(expensesTotal * 100) / 100,
      lossesTotal: toNumber(lossesAgg._sum.totalCost ?? 0),
      purchasesTotal: toNumber(purchasesAgg._sum.totalAmount ?? 0),
      netProfit: Math.round((revenue - expensesTotal - cogs) * 100) / 100,
      accountingProfit: Math.round((salesTotal - cogs - expensesTotal) * 100) / 100,
      outstandingReceivables: toNumber(outstanding._sum.balanceDue ?? 0),
      overdueReceivables: toNumber(overdue._sum.balanceDue ?? 0),
      salesCount,
      paymentsCount: paymentsAgg._count._all,
      expensesCount: expensesAgg._count._all,
      averageBasket: salesCount > 0 ? Math.round((salesTotal / salesCount) * 100) / 100 : 0,
      lowStockCount,
      pendingDeliveries,
      lossCount: losses.length,
      purchaseCount: purchases.length,
    },
    series,
    topProducts: topProductsGrouped.map((entry) => ({
      product: productById.get(entry.productId) ?? { id: entry.productId, name: 'Produit supprime', sku: '-', imageUrl: null, unit: null },
      quantity: entry._sum.quantity ?? 0,
      revenue: toNumber(entry._sum.lineTotal ?? 0),
    })),
    expensesByCategory: expensesByCategoryGrouped.map((entry) => ({
      category: categoryById.get(entry.categoryId) ?? { id: entry.categoryId, name: 'Categorie supprimee' },
      amount: toNumber(entry._sum.amount ?? 0),
    })),
    lossesByReason: lossesByReasonGrouped.map((entry) => ({
      reason: entry.reason,
      cost: toNumber(entry._sum.totalCost ?? 0),
      quantity: entry._sum.quantity ?? 0,
    })),
    topClients: clientsTop,
    topSuppliers: suppliersTop,
    recentSales,
    lowStockProducts,
  };
}

export async function salesReport(query: z.infer<typeof reportQuerySchema>) {
  const range = parseRange(query, 'month');
  const granularity = query.granularity ?? chooseGranularity(range.from, range.to);

  const sales = await prisma.sale.findMany({
    where: { saleDate: { gte: range.from, lte: range.to } },
    select: { saleDate: true, totalAmount: true, paidAmount: true, balanceDue: true, cogs: true, status: true, type: true },
  });

  const buckets = new Map<string, { sales: number; paid: number; balance: number; count: number; cancelled: number }>();
  const ensure = (key: string) => {
    if (!buckets.has(key)) buckets.set(key, { sales: 0, paid: 0, balance: 0, count: 0, cancelled: 0 });
    return buckets.get(key)!;
  };

  sales.forEach((sale) => {
    const bucket = ensure(keyFor(sale.saleDate, granularity));
    bucket.count += 1;
    if (sale.status === 'ANNULEE') {
      bucket.cancelled += 1;
      return;
    }
    bucket.sales += toNumber(sale.totalAmount);
    bucket.paid += toNumber(sale.paidAmount);
    bucket.balance += toNumber(sale.balanceDue);
  });

  const series = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => ({
      date,
      ...bucket,
      sales: Math.round(bucket.sales * 100) / 100,
      paid: Math.round(bucket.paid * 100) / 100,
      balance: Math.round(bucket.balance * 100) / 100,
    }));

  const valid = sales.filter((sale) => sale.status !== 'ANNULEE');
  const totalSales = valid.reduce((total, sale) => total + toNumber(sale.totalAmount), 0);
  const totalPaid = valid.reduce((total, sale) => total + toNumber(sale.paidAmount), 0);
  const totalCogs = valid.reduce((total, sale) => total + toNumber(sale.cogs), 0);

  return {
    range,
    granularity,
    series,
    totals: {
      sales: Math.round(totalSales * 100) / 100,
      paid: Math.round(totalPaid * 100) / 100,
      balance: Math.round((totalSales - totalPaid) * 100) / 100,
      cogs: Math.round(totalCogs * 100) / 100,
      margin: Math.round((totalSales - totalCogs) * 100) / 100,
      count: valid.length,
      cancelled: sales.length - valid.length,
      averageBasket: valid.length > 0 ? Math.round((totalSales / valid.length) * 100) / 100 : 0,
      grossSales: valid.filter((sale) => sale.type === 'GROS').reduce((total, sale) => total + toNumber(sale.totalAmount), 0),
      detailSales: valid.filter((sale) => sale.type === 'DETAIL').reduce((total, sale) => total + toNumber(sale.totalAmount), 0),
    },
  };
}

export async function receivablesReport() {
  const sales = await prisma.sale.findMany({
    where: { status: { not: 'ANNULEE' }, balanceDue: { gt: 0 } },
    include: { client: { select: { id: true, name: true, phone: true, creditLimit: true } } },
    orderBy: { dueDate: 'asc' },
  });

  const today = dayjs.utc().startOf('day');
  const byClient = new Map<
    string,
    {
      client: { id: string; name: string; phone: string | null; creditLimit: number };
      total: number;
      current: number;
      overdue30: number;
      overdue60: number;
      overdue90: number;
      salesCount: number;
      oldestDueDate: string | null;
    }
  >();

  sales.forEach((sale) => {
    const key = sale.clientId ?? 'walk-in';
    if (!byClient.has(key)) {
      byClient.set(key, {
        client: {
          id: key,
          name: sale.client?.name ?? 'Client de passage',
          phone: sale.client?.phone ?? null,
          creditLimit: toNumber(sale.client?.creditLimit ?? 0),
        },
        total: 0,
        current: 0,
        overdue30: 0,
        overdue60: 0,
        overdue90: 0,
        salesCount: 0,
        oldestDueDate: null,
      });
    }

    const entry = byClient.get(key)!;
    const balance = toNumber(sale.balanceDue);
    entry.total += balance;
    entry.salesCount += 1;

    const due = sale.dueDate ? dayjs.utc(sale.dueDate).startOf('day') : today;
    const overdueDays = Math.max(0, today.diff(due, 'day'));

    if (overdueDays <= 0) entry.current += balance;
    else if (overdueDays <= 30) entry.overdue30 += balance;
    else if (overdueDays <= 60) entry.overdue60 += balance;
    else entry.overdue90 += balance;

    if (sale.dueDate && (!entry.oldestDueDate || dayjs.utc(sale.dueDate).isBefore(dayjs.utc(entry.oldestDueDate)))) {
      entry.oldestDueDate = sale.dueDate.toISOString();
    }
  });

  const rows = [...byClient.values()]
    .map((entry) => ({
      ...entry,
      total: Math.round(entry.total * 100) / 100,
      current: Math.round(entry.current * 100) / 100,
      overdue30: Math.round(entry.overdue30 * 100) / 100,
      overdue60: Math.round(entry.overdue60 * 100) / 100,
      overdue90: Math.round(entry.overdue90 * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    data: rows,
    totals: {
      outstanding: Math.round(rows.reduce((total, row) => total + row.total, 0) * 100) / 100,
      overdue: Math.round(rows.reduce((total, row) => total + row.overdue30 + row.overdue60 + row.overdue90, 0) * 100) / 100,
      clients: rows.length,
    },
  };
}

export async function inventoryReport() {
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    include: { category: { select: { id: true, name: true } } },
    orderBy: { name: 'asc' },
  });

  let stockValue = 0;
  let retailValue = 0;
  let totalUnits = 0;
  const byCategory = new Map<string, { name: string; stockValue: number; units: number; products: number }>();

  products.forEach((product) => {
    const cost = toNumber(product.costPrice);
    const retail = toNumber(product.salePriceDetail);
    const value = cost * product.stockQty;
    const retailTotal = retail * product.stockQty;

    stockValue += value;
    retailValue += retailTotal;
    totalUnits += product.stockQty;

    const key = product.category?.id ?? 'uncategorized';
    if (!byCategory.has(key)) {
      byCategory.set(key, { name: product.category?.name ?? 'Sans categorie', stockValue: 0, units: 0, products: 0 });
    }
    const entry = byCategory.get(key)!;
    entry.stockValue += value;
    entry.units += product.stockQty;
    entry.products += 1;
  });

  const lowStock = products.filter((product) => product.stockQty <= product.minStockQty);
  const outOfStock = products.filter((product) => product.stockQty <= 0);

  return {
    totals: {
      products: products.length,
      totalUnits,
      stockValue: Math.round(stockValue * 100) / 100,
      retailValue: Math.round(retailValue * 100) / 100,
      potentialMargin: Math.round((retailValue - stockValue) * 100) / 100,
      lowStockCount: lowStock.length,
      outOfStockCount: outOfStock.length,
    },
    byCategory: [...byCategory.values()]
      .map((entry) => ({ ...entry, stockValue: Math.round(entry.stockValue * 100) / 100 }))
      .sort((a, b) => b.stockValue - a.stockValue),
    lowStock: lowStock
      .sort((a, b) => a.stockQty - b.stockQty)
      .map((product) => ({
        id: product.id,
        name: product.name,
        sku: product.sku,
        stockQty: product.stockQty,
        minStockQty: product.minStockQty,
        unit: product.unit,
        imageUrl: product.imageUrl,
        costPrice: product.costPrice,
      })),
  };
}
