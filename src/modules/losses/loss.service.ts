import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { applyStockChange } from '../../lib/stock.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { makeReference } from '../../lib/reference.js';
import { round2 } from '../../lib/money.js';
import { dayjs, parseRange, type Period } from '../../lib/dates.js';
import { dateSchema, optionalText, uuidSchema } from '../../http.js';
import { notifyRoles } from '../notifications/notification.service.js';

export const createLossSchema = z.object({
  productId: uuidSchema,
  quantity: z.coerce.number().int().positive('Quantite requise').max(1_000_000),
  reason: z.enum(['PERIME', 'ENDOMMAGE', 'PERDU_TRANSPORT', 'AUTRE']),
  lossDate: dateSchema.optional(),
  notes: optionalText(1000),
  clientRef: z.string().trim().min(1).max(120).optional().nullable(),
});

export const lossListQuerySchema = z.object({
  productId: uuidSchema.optional(),
  reason: z.enum(['PERIME', 'ENDOMMAGE', 'PERDU_TRANSPORT', 'AUTRE']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  period: z.enum(['day', 'week', 'month', 'year', 'custom', 'all']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const lossInclude = {
  product: { select: { id: true, name: true, sku: true, unit: true, imageUrl: true } },
  user: { select: { id: true, fullName: true } },
} satisfies Prisma.LossInclude;

export async function listLosses(query: z.infer<typeof lossListQuerySchema>) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const hasRange = Boolean(query.from || query.to || query.period);
  const range = hasRange ? parseRange(query) : null;

  const where: Prisma.LossWhereInput = {
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.reason ? { reason: query.reason } : {}),
    ...(range ? { lossDate: { gte: range.from, lte: range.to } } : {}),
  };

  const [total, losses] = await Promise.all([
    prisma.loss.count({ where }),
    prisma.loss.findMany({
      where,
      include: lossInclude,
      orderBy: { lossDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: losses,
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function createLoss(input: z.infer<typeof createLossSchema>, actorId: string) {
  if (input.clientRef) {
    const existing = await prisma.loss.findUnique({ where: { clientRef: input.clientRef }, include: lossInclude });
    if (existing) return { loss: existing, created: false };
  }

  const lossDate = input.lossDate ? dayjs.utc(input.lossDate).toDate() : new Date();

  const loss = await serializableTransaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id: input.productId, deletedAt: null } });
    if (!product) throw ApiError.badRequest('Produit introuvable');

    const unitCost = round2(product.costPrice);
    const totalCost = round2(unitCost.times(input.quantity));

    const created = await tx.loss.create({
      data: {
        reference: makeReference('PRT', lossDate),
        productId: product.id,
        quantity: input.quantity,
        reason: input.reason,
        unitCost,
        totalCost,
        lossDate,
        notes: input.notes ?? null,
        userId: actorId,
        clientRef: input.clientRef ?? null,
      },
    });

    await applyStockChange(tx, {
      productId: product.id,
      delta: -input.quantity,
      type: 'PERTE',
      unitCost,
      referenceType: 'loss',
      referenceId: created.id,
      userId: actorId,
      note: `Perte ${input.reason} (${created.reference})`,
    });

    return tx.loss.findUniqueOrThrow({ where: { id: created.id }, include: lossInclude });
  });

  void notifyRoles(['ADMIN', 'COMPTABLE'], {
    type: 'PERTE',
    title: 'Nouvelle perte enregistree',
    body: `${loss.quantity} x ${loss.product.name} - ${input.reason} (${Number(loss.totalCost).toLocaleString('fr-FR')} ${loss.product.unit})`,
    data: { lossId: loss.id, productId: loss.productId },
  }).catch(() => undefined);

  return { loss, created: true };
}

export async function deleteLoss(id: string) {
  return serializableTransaction(async (tx) => {
    const loss = await tx.loss.findUnique({ where: { id }, include: lossInclude });
    if (!loss) throw ApiError.notFound('Perte introuvable');

    await applyStockChange(tx, {
      productId: loss.productId,
      delta: loss.quantity,
      type: 'RETOUR',
      unitCost: loss.unitCost,
      referenceType: 'loss',
      referenceId: loss.id,
      userId: loss.userId,
      note: `Annulation perte ${loss.reference}`,
    });

    await tx.loss.delete({ where: { id } });
    return loss;
  });
}

export async function lossSummary(query: { from?: string; to?: string; period?: Period }) {
  const range = parseRange(query, 'month');
  const where: Prisma.LossWhereInput = { lossDate: { gte: range.from, lte: range.to } };

  const [totals, byReason, byProduct] = await Promise.all([
    prisma.loss.aggregate({ where, _sum: { totalCost: true, quantity: true }, _count: { _all: true } }),
    prisma.loss.groupBy({ by: ['reason'], where, _sum: { totalCost: true, quantity: true }, _count: { _all: true } }),
    prisma.loss.groupBy({
      by: ['productId'],
      where,
      _sum: { totalCost: true, quantity: true },
      orderBy: { _sum: { totalCost: 'desc' } },
      take: 10,
    }),
  ]);

  const products = await prisma.product.findMany({
    where: { id: { in: byProduct.map((entry) => entry.productId) } },
    select: { id: true, name: true, sku: true },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  return {
    range,
    totalCost: totals._sum.totalCost ?? 0,
    totalQuantity: totals._sum.quantity ?? 0,
    count: totals._count._all,
    byReason: byReason.map((entry) => ({
      reason: entry.reason,
      totalCost: entry._sum.totalCost ?? 0,
      quantity: entry._sum.quantity ?? 0,
      count: entry._count._all,
    })),
    byProduct: byProduct.map((entry) => ({
      product: byId.get(entry.productId) ?? { id: entry.productId, name: 'Produit supprime', sku: '-' },
      totalCost: entry._sum.totalCost ?? 0,
      quantity: entry._sum.quantity ?? 0,
    })),
  };
}
