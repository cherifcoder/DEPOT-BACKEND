import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { applyPurchaseStock } from '../../lib/stock.js';
import { makeReference } from '../../lib/reference.js';
import { round2, sum } from '../../lib/money.js';
import { dayjs, parseRange } from '../../lib/dates.js';
import { dateSchema, moneySchema, optionalText, uuidSchema } from '../../http.js';

export const purchaseItemInputSchema = z.object({
  productId: uuidSchema,
  quantity: z.coerce.number().int().positive().max(1_000_000),
  unitCost: moneySchema,
});

export const createPurchaseSchema = z.object({
  supplierId: uuidSchema,
  purchaseDate: dateSchema.optional(),
  transportFees: moneySchema.optional().default(0),
  notes: optionalText(2000),
  clientRef: z.string().trim().min(1).max(120).optional().nullable(),
  items: z.array(purchaseItemInputSchema).min(1, 'Ajoutez au moins une ligne d achat'),
});

export const purchaseListQuerySchema = z.object({
  supplierId: uuidSchema.optional(),
  search: z.string().trim().max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  period: z.enum(['day', 'week', 'month', 'year', 'custom', 'all']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const purchaseInclude = {
  supplier: true,
  user: { select: { id: true, fullName: true } },
  items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } },
} satisfies Prisma.PurchaseInclude;

export async function listPurchases(query: z.infer<typeof purchaseListQuerySchema>) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const hasRange = Boolean(query.from || query.to || query.period);
  const range = hasRange ? parseRange(query) : null;

  const where: Prisma.PurchaseWhereInput = {
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(range ? { purchaseDate: { gte: range.from, lte: range.to } } : {}),
    ...(query.search
      ? {
          OR: [
            { reference: { contains: query.search, mode: 'insensitive' } },
            { supplier: { name: { contains: query.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [total, purchases] = await Promise.all([
    prisma.purchase.count({ where }),
    prisma.purchase.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true, phone: true } },
        user: { select: { id: true, fullName: true } },
        _count: { select: { items: true } },
      },
      orderBy: { purchaseDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: purchases,
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function getPurchase(id: string) {
  const purchase = await prisma.purchase.findUnique({ where: { id }, include: purchaseInclude });
  if (!purchase) throw ApiError.notFound('Achat introuvable');
  return purchase;
}

export async function createPurchase(input: z.infer<typeof createPurchaseSchema>, actorId: string) {
  if (input.clientRef) {
    const existing = await prisma.purchase.findUnique({ where: { clientRef: input.clientRef }, include: purchaseInclude });
    if (existing) return { purchase: existing, created: false };
  }

  const productIds = input.items.map((item) => item.productId);
  if (new Set(productIds).size !== productIds.length) {
    throw ApiError.badRequest('Un produit apparait plusieurs fois : regroupez les quantites');
  }

  const purchaseDate = input.purchaseDate ? dayjs.utc(input.purchaseDate).toDate() : new Date();

  const purchase = await serializableTransaction(async (tx) => {
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, deletedAt: null } });
    if (!supplier) throw ApiError.badRequest('Fournisseur introuvable ou archive');

    const products = await tx.product.findMany({
      where: { id: { in: productIds }, deletedAt: null },
    });
    if (products.length !== productIds.length) throw ApiError.badRequest('Un ou plusieurs produits sont introuvables');
    const productById = new Map(products.map((product) => [product.id, product]));

    const lines = input.items.map((item) => {
      if (!productById.has(item.productId)) throw ApiError.badRequest('Produit introuvable');
      const unitCost = round2(item.unitCost);
      return {
        productId: item.productId,
        quantity: item.quantity,
        unitCost,
        lineTotal: round2(unitCost.times(item.quantity)),
      };
    });

    const subtotal = sum(lines.map((line) => line.lineTotal));
    const transportFees = round2(input.transportFees ?? 0);
    const totalAmount = round2(subtotal.plus(transportFees));

    // Repartition des frais de transport au prorata pour un cout de revient juste.
    const landedCosts = lines.map((line) => {
      const share = subtotal.greaterThan(0)
        ? round2(transportFees.times(line.lineTotal).div(subtotal))
        : round2(transportFees.div(lines.length));
      const landedUnitCost = round2(line.lineTotal.plus(share).div(line.quantity));
      return { ...line, landedUnitCost, transportShare: share };
    });

    const created = await tx.purchase.create({
      data: {
        reference: makeReference('ACH', purchaseDate),
        supplierId: supplier.id,
        userId: actorId,
        purchaseDate,
        subtotal,
        transportFees,
        totalAmount,
        notes: input.notes ?? null,
        clientRef: input.clientRef ?? null,
        items: {
          create: landedCosts.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitCost: line.unitCost,
            lineTotal: line.lineTotal,
          })),
        },
      },
    });

    for (const line of landedCosts) {
      await applyPurchaseStock(tx, {
        productId: line.productId,
        quantity: line.quantity,
        unitCost: line.landedUnitCost,
        userId: actorId,
        purchaseId: created.id,
      });
    }

    return tx.purchase.findUniqueOrThrow({ where: { id: created.id }, include: purchaseInclude });
  });

  return { purchase, created: true };
}

/** Achat immuable : on n'autorise ni modification ni suppression (tracabilite comptable). */
export async function purchaseTotals(from: Date, to: Date) {
  const totals = await prisma.purchase.aggregate({
    where: { purchaseDate: { gte: from, lte: to } },
    _sum: { totalAmount: true, transportFees: true },
    _count: { _all: true },
  });

  return {
    totalAmount: totals._sum.totalAmount ?? 0,
    transportFees: totals._sum.transportFees ?? 0,
    count: totals._count._all,
  };
}
